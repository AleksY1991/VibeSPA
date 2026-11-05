import { getChangedDocumentsSince } from 'rxdb';
import type { BulkWriteRow, RxDocumentData, RxStorageInstance } from 'rxdb';
import { createRevision, getHeightOfRevision } from 'rxdb/plugins/utils';
import type {
  AdapterBatch, AdapterWrite, CommandIdentity, DomainAdapter, DomainRow,
  IncomingChange, RemoteRow, RowReceipt,
} from '@vibespa/solid/domain';

/** The part of an open, application-owned RxCollection this adapter uses. A
 * native `RxCollection<Row>` satisfies it, including one created with a
 * reactivity factory. The adapter never closes the collection or database. */
export interface DomainCollection<Row> {
  readonly name: string;
  readonly schema: { readonly primaryPath: string };
  readonly database: { readonly token: string; readonly closed: boolean };
  readonly storageInstance: RxStorageInstance<Row, unknown, unknown, unknown>;
}

/** A submitted proposal replaced by the durable row (adopt-on-conflict). */
export interface RowAdoption<Row> {
  readonly id: string;
  readonly identity: CommandIdentity;
  readonly proposed: Row | null;
  readonly adopted: Row | null;
  readonly version: number;
}

export interface RxCollectionDomainAdapterOptions<Row extends DomainRow> {
  /** Flat, replication-compatible rows with primary key `id`. */
  readonly collection: DomainCollection<Row>;
  /** Load page size; defaults to 500. */
  readonly pageSize?: number;
  /** Observer only: the durable row replaced a submitted proposal. */
  readonly onAdopted?: (adoption: RowAdoption<Row>) => void;
  /** Observer only: an incoming durable change could not be admitted. */
  readonly onIncomingError?: (error: unknown) => void;
}

type Stored<Row> = RxDocumentData<Row>;
interface Version { revision: string; height: number; value: number }
interface Own { readonly revision: string; readonly command: CommandIdentity; readonly fingerprint: string }

const WRITE_CONTEXT = 'vibespa-solid-domain';
const METADATA = new Set(['_rev', '_meta', '_attachments', '_deleted']);

function sameCommand(left: CommandIdentity, right: CommandIdentity): boolean {
  return left.generation === right.generation && left.sequence === right.sequence
    && left.gestureId === right.gestureId && left.origin === right.origin;
}

function abortError(): DOMException {
  return new DOMException('This RxDB collection adapter session is closed.', 'AbortError');
}

/** A plain JSON copy of the business fields. RxDB metadata stays adapter-private. */
function toDomain<Row>(document: Stored<Row> | undefined): Row | null {
  if (!document || document._deleted) return null;
  const business: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) if (!METADATA.has(key)) business[key] = value;
  return JSON.parse(JSON.stringify(business)) as Row;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Business content identity, including deletion state. */
const fingerprint = (row: unknown): string => row === null ? '∅' : stable(row);

/** Solid persistence connector over an application-owned native RxDB collection.
 *
 * Unlike `createRxDbDomainAdapter`, the collection keeps flat rows that stock
 * RxDB replication (for example `replicateSupabase`) can replicate. Every durable
 * change, including replication pulls and other tabs, is admitted through the
 * owner's restricted port. Versions are per adapter session and advance with
 * RxDB revision height. Own writes are tagged as echoes when both their
 * predicted revision and their content match.
 *
 * Conflict policy: adopt. When the durable row changed after the owner's
 * baseline, the adapter returns the durable row with `adopted: true` and calls
 * `onAdopted`, instead of refusing the command. Stock replication already
 * resolves remote conflicts server-wins after local acceptance; this applies
 * the same outcome at the local boundary. */
export function createRxCollectionDomainAdapter<Row extends DomainRow>(
  options: RxCollectionDomainAdapterOptions<Row>,
): DomainAdapter<Row> {
  const pageSize = options.pageSize ?? 500;
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error('pageSize must be a positive integer.');
  const { collection } = options;
  return {
    async open(context) {
      context.signal.throwIfAborted();
      if (collection.schema.primaryPath !== 'id') {
        throw new Error(`Collection ${collection.name} must use the primary key "id".`);
      }
      if (collection.database.closed) throw new Error(`Collection ${collection.name} belongs to a closed database.`);
      const storage = collection.storageInstance;
      const versions = new Map<string, Version>();
      const own = new Map<string, Own>();
      let retained: { identity: CommandIdentity; rows: Map<string, RowReceipt<Row>> } | undefined;
      let closed = false;
      let closing: Promise<void> | undefined;
      let changeSequence = 0;
      let saveTail: Promise<unknown> = Promise.resolve();
      const operations = new Set<Promise<unknown>>();

      const assertOpen = (): void => {
        context.signal.throwIfAborted();
        if (closed) throw abortError();
      };
      const track = <Result>(operation: Promise<Result>): Promise<Result> => {
        operations.add(operation);
        return operation.finally(() => { operations.delete(operation); });
      };
      const report = (error: unknown): void => {
        try {
          if (options.onIncomingError) options.onIncomingError(error);
          else console.error('Unable to admit an incoming RxDB change.', error);
        } catch (observerError) { console.error('RxDB incoming-error observer failed.', observerError); }
      };

      /** Advance only for a newer durable revision; return the stored version for stale reads. */
      const observe = (document: Stored<Row>): Version => {
        const height = getHeightOfRevision(document._rev);
        const previous = versions.get(document.id);
        if (previous && (previous.height > height || previous.revision === document._rev)) return previous;
        const next = { revision: document._rev, height, value: (previous?.value ?? 0) + 1 };
        versions.set(document.id, next);
        return next;
      };
      /** Receipts must exceed the submitted baseline, even when no write was needed. */
      const receiptVersion = (id: string, expected: number): number => {
        const entry = versions.get(id) ?? { revision: '', height: 0, value: 0 };
        if (entry.value <= expected) entry.value = expected + 1;
        versions.set(id, entry);
        return entry.value;
      };
      const isOwn = (document: Stored<Row>): Own | undefined => {
        const entry = own.get(document.id);
        return entry && entry.revision === document._rev && entry.fingerprint === fingerprint(toDomain(document))
          ? entry : undefined;
      };

      const subscription = storage.changeStream().subscribe(bulk => {
        if (closed || context.signal.aborted) return;
        let command: CommandIdentity | undefined;
        let rows: RemoteRow<Row>[] = [];
        const publish = (): void => {
          if (!rows.length) return;
          const change: IncomingChange<Row> = {
            generation: context.generation, origin: 'adapter',
            changeId: `${bulk.id}:${++changeSequence}`, rows, ...(command ? { command } : {}),
          };
          rows = [];
          try { context.receive(change); } catch (error) { report(error); }
        };
        for (const event of bulk.events) {
          const document = event.documentData as Stored<Row>;
          const mine = isOwn(document);
          const next = mine?.command;
          const pendingOwn = own.get(document.id);
          // A foreign revision supersedes our last write for this row.
          if (!mine && pendingOwn && getHeightOfRevision(document._rev) >= getHeightOfRevision(pendingOwn.revision)) {
            own.delete(document.id);
          }
          if (rows.some(row => row.id === document.id)
            || (next !== command && (!next || !command || !sameCommand(next, command)))) publish();
          command = next;
          const version = observe(document);
          if (version.revision !== document._rev) continue;
          rows.push({ id: document.id, version: version.value, document: toDomain(document) });
        }
        publish();
      });
      const stop = (): void => { subscription.unsubscribe(); };
      context.signal.addEventListener('abort', stop, { once: true });

      const readCurrent = async (ids: readonly string[]): Promise<Map<string, Stored<Row>>> => {
        const read = async (keys: readonly string[]) => new Map((await storage.findDocumentsById([...keys], true))
          .map(row => [row.id, row as Stored<Row>]));
        const stale = (rows: Map<string, Stored<Row>>) => [...rows.values()]
          .filter(row => (versions.get(row.id)?.height ?? 0) > getHeightOfRevision(row._rev)).map(row => row.id);
        const rows = await read(ids);
        assertOpen();
        const outdated = stale(rows);
        if (outdated.length) {
          for (const [id, row] of await read(outdated)) rows.set(id, row);
          assertOpen();
          if (stale(rows).length) throw new Error('The durable read is older than an observed revision. Retry to refresh.');
        }
        return rows;
      };

      const save = async (batch: AdapterBatch<Row>) => {
        assertOpen();
        if (!retained || !sameCommand(retained.identity, batch.identity)) {
          retained = { identity: batch.identity, rows: new Map() };
        }
        const receipts = new Map<string, RowReceipt<Row>>();
        const adoptions: RowAdoption<Row>[] = [];
        const current = await readCurrent(batch.writes.map(write => write.id));
        const writes: { write: AdapterWrite<Row>; row: BulkWriteRow<Row> }[] = [];
        const adopt = (write: AdapterWrite<Row>, durable: Stored<Row> | undefined): void => {
          if (durable) observe(durable);
          const document = toDomain(durable);
          const version = receiptVersion(write.id, write.expectedVersion);
          const replaced = fingerprint(document) !== fingerprint(write.document);
          receipts.set(write.id, { id: write.id, ok: true, version, document, ...(replaced ? { adopted: true as const } : {}) });
          if (replaced) adoptions.push({ id: write.id, identity: batch.identity, proposed: write.document, adopted: document, version });
        };
        const accept = (write: AdapterWrite<Row>, durable: Stored<Row> | undefined): void => {
          if (durable) observe(durable);
          receipts.set(write.id, { id: write.id, ok: true, version: receiptVersion(write.id, write.expectedVersion), document: toDomain(durable) });
        };

        for (const write of batch.writes) {
          const accepted = retained.rows.get(write.id);
          if (accepted) { receipts.set(write.id, accepted); continue; }
          const durable = current.get(write.id);
          const mine = durable && isOwn(durable);
          if (mine && sameCommand(mine.command, batch.identity)) { accept(write, durable); continue; }
          const version = durable ? observe(durable) : versions.get(write.id);
          if ((version?.value ?? 0) !== write.expectedVersion) { adopt(write, durable); continue; }
          if (fingerprint(toDomain(durable)) === fingerprint(write.document)) { accept(write, durable); continue; }
          const base = write.document ?? toDomain(durable)!;
          const document = {
            ...JSON.parse(JSON.stringify(base)) as Row,
            _deleted: write.document === null,
            _attachments: durable?._attachments ?? {},
            _meta: durable ? { ...durable._meta } : { lwt: 0 },
            // RxDB's wrapped storage recomputes the same value from `previous`.
            _rev: createRevision(collection.database.token, durable),
          } as Stored<Row>;
          own.set(write.id, { revision: document._rev, command: batch.identity, fingerprint: fingerprint(write.document) });
          writes.push({ write, row: durable ? { previous: durable, document } : { document } });
        }

        if (writes.length) {
          // A thrown write keeps its own entries: a retry with the same identity
          // recognizes a row that did land before the failure was reported.
          const result = await storage.bulkWrite(writes.map(entry => entry.row), WRITE_CONTEXT);
          assertOpen();
          const errors = new Map(result.error.map(error => [error.documentId, error]));
          const written = writes.filter(({ write }) => !errors.has(write.id));
          const saved = written.length ? await readCurrent(written.map(({ write }) => write.id)) : new Map<string, Stored<Row>>();
          for (const { write } of writes) {
            const error = errors.get(write.id);
            if (!error) {
              const durable = saved.get(write.id);
              if (!durable) throw new Error(`Durable row missing after a successful write: ${write.id}`);
              // A foreign write can land between ours and this read; its content wins.
              if (isOwn(durable)) accept(write, durable); else adopt(write, durable);
              continue;
            }
            own.delete(write.id);
            if (error.status === 409) adopt(write, error.documentInDb as Stored<Row>);
            else receipts.set(write.id, { id: write.id, ok: false, error: `Durable storage refused row (${error.status}).` });
          }
        }

        const rows = batch.writes.map(write => receipts.get(write.id)!);
        for (const receipt of rows) if (receipt.ok) retained.rows.set(receipt.id, receipt);
        for (const adoption of adoptions) {
          try { options.onAdopted?.(adoption); }
          catch (error) { console.error('RxDB adoption observer failed.', error); }
        }
        return { identity: batch.identity, rows };
      };

      return {
        load() {
          return track((async () => {
            assertOpen();
            const rows = new Map<string, RemoteRow<Row>>();
            let checkpoint: unknown;
            while (true) {
              const page = await getChangedDocumentsSince(storage, pageSize, checkpoint);
              assertOpen();
              for (const document of page.documents as Stored<Row>[]) {
                const version = observe(document);
                // A newer stream revision can arrive while this page awaits.
                if (version.revision === document._rev) {
                  rows.set(document.id, { id: document.id, version: version.value, document: toDomain(document) });
                }
              }
              checkpoint = page.checkpoint;
              if (page.documents.length < pageSize) break;
            }
            return [...rows.values()];
          })());
        },
        save(batch) {
          const saved = saveTail.then(() => save(batch));
          saveTail = saved.catch(() => undefined);
          return track(saved);
        },
        close() {
          if (closing) return closing;
          closed = true;
          context.signal.removeEventListener('abort', stop);
          stop();
          closing = Promise.allSettled([...operations]).then(() => undefined);
          return closing;
        },
      };
    },
  };
}
