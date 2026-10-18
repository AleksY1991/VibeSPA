import type { Readable, Scope } from '@vibespa/contracts';
import {
  createRxDatabase, fillObjectDataBeforeInsert, rxStorageWriteErrorToRxError,
  type BulkWriteRow, type MangoQuery, type RxCollection, type RxDocumentData,
  type RxJsonSchema, type RxQuery,
} from 'rxdb';
import { getRxStorageDexie } from 'rxdb/plugins/storage-dexie';
import { wrappedValidateAjvStorage } from 'rxdb/plugins/validate-ajv';
import { deepEqual } from 'rxdb/plugins/utils';
import { registerBridge } from './bridge.js';
import {
  BatchWriteError, HistoryConflictError,
  type BatchCommand, type HistoryState, type JournalChange, type JournalEntry,
  type LocalStore, type RowMap, type StoreOptions,
} from './types.js';

type Row = Record<string, unknown>;
type InternalWrite =
  | { readonly collection: string; readonly kind: 'put'; readonly document: object }
  | { readonly collection: string; readonly kind: 'delete'; readonly id: string };
type InternalCommand = Omit<BatchCommand<Record<string, Row>>, 'writes'> & {
  readonly writes: readonly InternalWrite[];
};
interface RowIntent { readonly collection: string; readonly id: string; readonly after: Row | null }
interface PreparedRow { readonly change: JournalChange; readonly row: BulkWriteRow<Row> }

function documentValue(row: RxDocumentData<Row> | undefined): Row | null {
  if (!row || row._deleted) return null;
  const value: Row = { ...row };
  delete value._meta;
  delete value._rev;
  delete value._attachments;
  delete value._deleted;
  return structuredClone(value);
}

function immutable<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

function announce<T>(listeners: ReadonlySet<(value: T) => void>, value: T): void {
  for (const listener of [...listeners]) {
    if (!listeners.has(listener)) continue;
    // An observer cannot turn an already durable write into a rejected command.
    try { listener(value); } catch (error) { console.error('VibeSPA store observer failed', error); }
  }
}

export async function createLocalStore<Rows extends RowMap<Rows>>(
  options: StoreOptions<Rows>,
): Promise<LocalStore<Rows>> {
  const limit = options.historyLimit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('historyLimit must be a non-negative integer.');
  const assertOpen = (): void => {
    options.scope.signal.throwIfAborted();
    if (closed) throw new Error('This local store is closed.');
  };
  let closed = false;
  assertOpen();
  const database = await createRxDatabase<Record<string, RxCollection<Row>>>({
    name: options.name,
    storage: wrappedValidateAjvStorage({ storage: options.storage ?? getRxStorageDexie() }),
    multiInstance: options.multiInstance ?? false,
  });
  try {
    assertOpen();
    const creators = Object.fromEntries(Object.entries(options.schemas).map(([name, schema]) => [name, {
      schema: schema as RxJsonSchema<Row>, autoMigrate: false,
      conflictHandler: {
        isEqual: (left: object, right: object) => deepEqual(left, right),
        resolve: async (input: { readonly realMasterState: Row & { _deleted: boolean } }) => input.realMasterState,
      },
    }]));
    await database.addCollections(creators);
  } catch (error) {
    await database.close();
    throw error;
  }

  let pending: Promise<unknown> = Promise.resolve();
  let closing: Promise<void> | undefined;
  const stops = new Set<() => void>();
  const queries = new Map<RxQuery<Row>, number>();
  const journalListeners = new Set<(entry: JournalEntry) => void>();
  const historyListeners = new Set<(value: HistoryState) => void>();
  const undo: JournalEntry[] = [];
  const redo: JournalEntry[] = [];
  let historyState: HistoryState = Object.freeze({ canUndo: false, canRedo: false, undoLabel: null, redoLabel: null });

  const collectionOf = (name: string): RxCollection<Row> => {
    assertOpen();
    const collection = database.collections[name];
    if (!collection) throw new Error(`Unknown collection: ${name}`);
    return collection;
  };
  const publishHistory = (): void => {
    historyState = Object.freeze({
      canUndo: undo.length > 0, canRedo: redo.length > 0,
      undoLabel: undo.at(-1)?.label ?? null, redoLabel: redo.at(-1)?.label ?? null,
    });
    announce(historyListeners, historyState);
  };
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    try { assertOpen(); } catch (error) { return Promise.reject(error); }
    const result = pending.then(() => { assertOpen(); return operation(); });
    pending = result.catch(() => undefined);
    return result;
  };

  /** Consecutive writes under one semantic gesture keep their first before-value. */
  const remember = (entry: JournalEntry): void => {
    if (!limit || !entry.changes.length) return;
    const previous = undo.at(-1);
    const previousChanges = new Map(previous?.changes.map(change => [`${change.collection}\0${change.id}`, change]));
    const continuous = entry.changes.every(change => {
      const existing = previousChanges.get(`${change.collection}\0${change.id}`);
      return !existing || deepEqual(existing.after, change.before);
    });
    if (previous?.gestureId === entry.gestureId && continuous) {
      const changes = previousChanges;
      for (const change of entry.changes) {
        const key = `${change.collection}\0${change.id}`;
        const existing = changes.get(key);
        changes.set(key, { ...change, before: existing ? existing.before : change.before });
      }
      undo[undo.length - 1] = immutable({ ...entry, changes: [...changes.values()] });
    } else {
      undo.push(entry);
      if (undo.length > limit) undo.shift();
    }
    redo.length = 0;
    publishHistory();
  };

  const normalize = (writes: readonly InternalWrite[]): Map<string, RowIntent[]> => {
    const intents = new Map<string, Map<string, RowIntent>>();
    for (const write of writes) {
      const collection = collectionOf(write.collection);
      const input = write.kind === 'put' ? structuredClone(write.document) as Row : null;
      if (input && Object.keys(input).some(key => ['_rev', '_meta', '_attachments', '_deleted'].includes(key))) {
        throw new Error('Commands must contain domain fields only; RxDB owns document metadata.');
      }
      const row = input ? documentValue(fillObjectDataBeforeInsert(collection.schema, input)) : null;
      const id = write.kind === 'delete' ? write.id : row?.[collection.schema.primaryPath];
      if (typeof id !== 'string' || !id.length) throw new Error(`A ${write.collection} write requires its string primary key.`);
      const byId = intents.get(write.collection) ?? new Map<string, RowIntent>();
      byId.set(id, { collection: write.collection, id, after: row });
      intents.set(write.collection, byId);
    }
    return new Map([...intents].map(([name, values]) => [name, [...values.values()]]));
  };

  const apply = async (
    command: InternalCommand, origin: JournalEntry['origin'], expected?: ReadonlyMap<string, object | null>,
  ): Promise<JournalEntry> => {
    if (!command.gestureId.trim()) throw new Error('A write requires a semantic gestureId.');
    const intents = normalize(command.writes);
    const prepared = new Map<string, PreparedRow[]>();
    // Preflight every collection before mutation, including replay divergence guards.
    for (const [name, rows] of intents) {
      const collection = collectionOf(name);
      const documents = await collection.storageInstance.findDocumentsById(rows.map(row => row.id), true);
      const stored = new Map(documents.map(row => [row[collection.schema.primaryPath], row]));
      const output: PreparedRow[] = [];
      for (const intent of rows) {
        const previous = stored.get(intent.id);
        const before = documentValue(previous);
        const key = `${name}\0${intent.id}`;
        if (expected?.has(key) && !deepEqual(before, expected.get(key))) throw new HistoryConflictError(name, intent.id);
        if (deepEqual(before, intent.after)) continue;
        if (!intent.after && !previous) continue;
        const document = intent.after
          ? { ...fillObjectDataBeforeInsert(collection.schema, intent.after),
            ...(previous ? { _rev: previous._rev, _meta: previous._meta, _attachments: previous._attachments } : {}) }
          : { ...previous, _deleted: true };
        if (previous) collection.schema.validateChange(previous, document);
        output.push({
          row: { ...(previous ? { previous } : {}), document: document as RxDocumentData<Row> },
          change: { collection: name, id: intent.id, before, after: documentValue(document as RxDocumentData<Row>) },
        });
      }
      prepared.set(name, output);
    }
    const changes: JournalChange[] = [];
    const failures: unknown[] = [];
    for (const [name, rows] of prepared) {
      if (!rows.length) continue;
      try {
        assertOpen();
        const result = await collectionOf(name).storageInstance.bulkWrite(rows.map(row => row.row), `vibespa:${origin}:${command.gestureId}`);
        const errors = new Map(result.error.map(error => [error.documentId, error]));
        for (const preparedRow of rows) {
          const error = errors.get(preparedRow.change.id);
          if (error) failures.push(error.status === 409 && expected
            ? new HistoryConflictError(name, preparedRow.change.id) : rxStorageWriteErrorToRxError(error));
          else changes.push(preparedRow.change);
        }
      } catch (error) { failures.push(error); }
      if (failures.length) break;
    }
    // A completed command is immediately readable by the next queued action.
    // Execute only already-owned native queries for the collections that changed.
    if (changes.length && !closed && !options.scope.signal.aborted) {
      const changed = new Set(changes.map(change => change.collection));
      try {
        await Promise.all([...queries.keys()].filter(query => changed.has(query.collection.name)).map(query => query.exec()));
      } catch (error) { failures.push(error); }
    }
    const entry = immutable({ gestureId: command.gestureId, label: command.label ?? command.gestureId, origin, changes });
    if (origin === 'command' && command.history !== 'exclude') remember(entry);
    if (changes.length) announce(journalListeners, entry);
    if (failures.length) throw new BatchWriteError(entry, failures);
    return entry;
  };

  const replay = (direction: 'undo' | 'redo'): Promise<JournalEntry | null> => enqueue(async () => {
    const from = direction === 'undo' ? undo : redo;
    const to = direction === 'undo' ? redo : undo;
    const entry = from.at(-1);
    if (!entry) return null;
    const expected = new Map<string, object | null>();
    const writes: InternalWrite[] = entry.changes.map(change => {
      const target = direction === 'undo' ? change.before : change.after;
      expected.set(`${change.collection}\0${change.id}`, direction === 'undo' ? change.after : change.before);
      return target
        ? { collection: change.collection, kind: 'put', document: target }
        : { collection: change.collection, kind: 'delete', id: change.id };
    });
    try {
      const result = await apply({ gestureId: entry.gestureId, label: entry.label, writes }, direction, expected);
      from.pop();
      to.push(entry);
      publishHistory();
      return result;
    } catch (error) {
      // A partial cross-collection replay cannot safely be retried as one gesture.
      if (error instanceof BatchWriteError && error.applied.changes.length) {
        undo.length = 0;
        redo.length = 0;
        publishHistory();
      }
      throw error;
    }
  });

  const makeQuerySource = async <T>(query: RxQuery<Row>, read: () => T, scope: Scope): Promise<Readable<T>> => {
    assertOpen();
    scope.signal.throwIfAborted();
    await query.exec();
    assertOpen();
    scope.signal.throwIfAborted();
    const listeners = new Set<(value: T) => void>();
    // Keep the native query current; read() uses RxDB's cache, not a second store.
    const subscription = query.$.subscribe(() => {
      if (!scope.signal.aborted && !closed) announce(listeners, read());
    });
    queries.set(query, (queries.get(query) ?? 0) + 1);
    let stopped = false;
    let unregisterQuery = (): void => undefined;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      subscription.unsubscribe(); listeners.clear(); stops.delete(stop);
      const references = (queries.get(query) ?? 1) - 1;
      if (references) queries.set(query, references);
      else queries.delete(query);
      scope.signal.removeEventListener('abort', stop);
      unregisterQuery();
    };
    stops.add(stop);
    try {
      unregisterQuery = scope.defer(stop);
      scope.signal.addEventListener('abort', stop, { once: true });
    } catch (error) { stop(); throw error; }
    const assertQuery = (): void => {
      assertOpen(); scope.signal.throwIfAborted();
      if (stopped) throw new Error('This query scope is disposed.');
    };
    return Object.freeze({
      read: () => { assertQuery(); return read(); },
      subscribe: (listener: (value: T) => void) => {
        assertQuery(); listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    });
  };

  let unregister = (): void => undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    options.scope.signal.removeEventListener('abort', abort);
    for (const stop of [...stops]) stop();
    journalListeners.clear();
    historyListeners.clear();
    undo.length = 0;
    redo.length = 0;
    closing = pending.then(async () => {
      undo.length = 0;
      redo.length = 0;
      await database.close();
    });
    // Keep ownership registered while a manual close overlaps account disposal.
    void closing.then(() => unregister(), () => unregister());
    return closing;
  };
  const abort = (): void => {
    // Cancellation stops readers now. Scope disposal closes storage after later
    // dependents (such as replication) have completed their reverse-order cleanup.
    for (const stop of [...stops]) stop();
    journalListeners.clear();
    historyListeners.clear();
  };

  const store: LocalStore<Rows> = Object.freeze({
    query: async <Name extends Extract<keyof Rows, string>>(name: Name, mango?: MangoQuery<Rows[Name]>, scope = options.scope) => {
      const query = collectionOf(name).find((mango ?? {}) as MangoQuery<Row>);
      return makeQuerySource(query, () => (query._result?.documents ?? []).map(doc => immutable(structuredClone(doc.toJSON())) as Readonly<Rows[Name]>), scope);
    },
    document: async <Name extends Extract<keyof Rows, string>>(name: Name, id: string, scope = options.scope) => {
      const query = collectionOf(name).findOne(id);
      return makeQuerySource(query, () => {
        const document = query._result?.documents[0];
        return document ? immutable(structuredClone(document.toJSON())) as Readonly<Rows[Name]> : null;
      }, scope);
    },
    batch: (command: BatchCommand<Rows>) => {
      // Capture the submitted intent before yielding to the asynchronous queue.
      // Callers may continue editing their own mutable document objects.
      let snapshot: BatchCommand<Rows>;
      try { snapshot = structuredClone(command); }
      catch (error) { return Promise.reject(error); }
      return enqueue(() => apply(snapshot, 'command'));
    },
    journal: Object.freeze({ subscribe: (listener: (entry: JournalEntry) => void) => {
      assertOpen(); journalListeners.add(listener); return () => { journalListeners.delete(listener); };
    } }),
    history: Object.freeze({
      state: Object.freeze({ read: () => { assertOpen(); return historyState; }, subscribe: (listener: (value: HistoryState) => void) => {
        assertOpen(); historyListeners.add(listener); return () => { historyListeners.delete(listener); };
      } }),
      undo: () => replay('undo'), redo: () => replay('redo'),
    }),
    close,
  });
  registerBridge(store, name => collectionOf(name) as unknown as RxCollection<object>);
  try {
    assertOpen();
    unregister = options.scope.defer(close);
    options.scope.signal.addEventListener('abort', abort, { once: true });
  }
  catch (error) { await close(); throw error; }
  return store;
}
