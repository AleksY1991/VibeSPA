import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScope } from '@vibespa/core';
import type { Scope } from '@vibespa/contracts';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import type { RxJsonSchema } from 'rxdb';
import { getCollection } from './adapter.js';
import { BatchWriteError, createLocalStore, HistoryConflictError, type JournalEntry } from './index.js';

interface Note { id: string; title: string; done: boolean }
interface Rows { notes: Note; archive: Note }
const schema: RxJsonSchema<Note> = {
  version: 0, primaryKey: 'id', type: 'object',
  properties: {
    id: { type: 'string', maxLength: 100 },
    title: { type: 'string' }, done: { type: 'boolean' },
  },
  required: ['id', 'title', 'done'], additionalProperties: false,
};
const scopes: Scope[] = [];
const scope = (): Scope => { const value = createScope(); scopes.push(value); return value; };
let sequence = 0;
const name = (): string => `vibespastore${Date.now()}${sequence++}`;
const note = (id: string, title = id): Note => ({ id, title, done: false });
const open = () => createLocalStore<Rows>({
  name: name(), schemas: { notes: schema, archive: schema },
  scope: scope(), storage: getRxStorageMemory(),
});
afterEach(async () => { await Promise.all(scopes.splice(0).map(owner => owner.dispose())); });

describe('the durable write boundary', () => {
  it('captures the submitted document before yielding to the write queue', async () => {
    const store = await open();
    const document = note('a', 'submitted');
    const pending = store.batch({ gestureId: 'submit', writes: [{ collection: 'notes', kind: 'put', document }] });
    document.title = 'edited after submission';
    await pending;
    expect((await store.document('notes', 'a')).read()?.title).toBe('submitted');
  });

  it('reduces repeated row intentions into one write and bulk-writes each collection once', async () => {
    const store = await open();
    const notes = vi.spyOn(getCollection(store, 'notes').storageInstance, 'bulkWrite');
    const archive = vi.spyOn(getCollection(store, 'archive').storageInstance, 'bulkWrite');
    const result = await store.batch({ gestureId: 'capture', writes: [
      { collection: 'notes', kind: 'put', document: note('a', 'first') },
      { collection: 'notes', kind: 'put', document: note('b') },
      { collection: 'notes', kind: 'put', document: note('a', 'last') },
      { collection: 'archive', kind: 'put', document: note('c') },
    ] });
    expect(notes).toHaveBeenCalledTimes(1);
    expect(notes.mock.calls[0]?.[0]).toHaveLength(2);
    expect(archive).toHaveBeenCalledTimes(1);
    expect(result.changes).toHaveLength(3);
    expect((await store.document('notes', 'a')).read()?.title).toBe('last');
  });

  it('retains successful rows and usable undo when schema validation partially refuses a batch', async () => {
    const store = await open();
    const command = store.batch({ gestureId: 'partial', writes: [
      { collection: 'notes', kind: 'put', document: note('valid') },
      { collection: 'notes', kind: 'put', document: { ...note('invalid'), done: 'wrong' } as unknown as Note },
    ] });
    await expect(command).rejects.toBeInstanceOf(BatchWriteError);
    const error = await command.then(() => { throw new Error('Expected a partial batch error.'); }, value => value as BatchWriteError);
    expect(error.applied.changes.map(change => change.id)).toEqual(['valid']);
    expect((await store.document('notes', 'valid')).read()).toEqual(note('valid'));
    await store.history.undo();
    expect((await store.document('notes', 'valid')).read()).toBeNull();
  });

  it('opens the same IndexedDB working copy after close without a remote connection', async () => {
    const databaseName = name();
    const options = { name: databaseName, schemas: { notes: schema } };
    const first = await createLocalStore<{ notes: Note }>({ ...options, scope: scope() });
    await first.batch({ gestureId: 'offline', writes: [{ collection: 'notes', kind: 'put', document: note('persisted') }] });
    await first.close();
    const second = await createLocalStore<{ notes: Note }>({ ...options, scope: scope() });
    expect((await second.document('notes', 'persisted')).read()).toEqual(note('persisted'));
    expect(second.history.state.read().canUndo).toBe(false);
  });

  it('applies schema defaults before no-op detection and protects final fields', async () => {
    type DefaultNote = Omit<Note, 'done'> & { done?: boolean };
    const defaultSchema: RxJsonSchema<DefaultNote> = {
      version: 0, primaryKey: 'id', type: 'object',
      properties: {
        id: { type: 'string', maxLength: 100 }, title: { type: 'string', final: true }, done: { type: 'boolean', default: false },
      }, required: ['id', 'title'], additionalProperties: false,
    };
    const store = await createLocalStore<{ notes: DefaultNote }>({
      name: name(), schemas: { notes: defaultSchema }, scope: scope(), storage: getRxStorageMemory(),
    });
    const writes = vi.spyOn(getCollection(store, 'notes').storageInstance, 'bulkWrite');
    const document = { id: 'a', title: 'stable' };
    await store.batch({ gestureId: 'default', writes: [{ collection: 'notes', kind: 'put', document }] });
    const noop = await store.batch({ gestureId: 'noop', writes: [{ collection: 'notes', kind: 'put', document }] });
    expect(noop.changes).toEqual([]);
    expect(writes).toHaveBeenCalledTimes(1);
    await expect(store.batch({ gestureId: 'forbidden', writes: [
      { collection: 'notes', kind: 'put', document: { ...document, title: 'changed' } },
    ] })).rejects.toThrow();
    expect((await store.document('notes', 'a')).read()).toEqual({ ...document, done: false });
  });

  it('lets RxDB derive a composite primary key before identifying the batch row', async () => {
    interface CompositeNote { id?: string; group: string; key: string }
    const compositeSchema: RxJsonSchema<CompositeNote> = {
      version: 0, primaryKey: { key: 'id', fields: ['group', 'key'], separator: '|' }, type: 'object',
      properties: {
        id: { type: 'string', maxLength: 100 }, group: { type: 'string', maxLength: 40 }, key: { type: 'string', maxLength: 40 },
      }, required: ['group', 'key'], additionalProperties: false,
    };
    const store = await createLocalStore<{ notes: CompositeNote }>({
      name: name(), schemas: { notes: compositeSchema }, scope: scope(), storage: getRxStorageMemory(),
    });
    await store.batch({ gestureId: 'composite', writes: [{ collection: 'notes', kind: 'put', document: { group: 'a', key: 'b' } }] });
    expect((await store.document('notes', 'a|b')).read()).toEqual({ id: 'a|b', group: 'a', key: 'b' });
  });
});

describe('semantic history', () => {
  it('keeps a compound gesture across collections intact through undo and redo', async () => {
    const store = await open();
    const journal: JournalEntry[] = [];
    store.journal.subscribe(entry => journal.push(entry));
    await store.batch({ gestureId: 'collect', label: 'Collect notes', writes: [
      { collection: 'notes', kind: 'put', document: note('a') },
      { collection: 'archive', kind: 'put', document: note('b') },
    ] });
    const undone = await store.history.undo();
    expect(undone?.gestureId).toBe('collect');
    expect(undone?.changes).toHaveLength(2);
    expect((await store.document('notes', 'a')).read()).toBeNull();
    expect((await store.document('archive', 'b')).read()).toBeNull();
    await store.history.redo();
    expect((await store.document('notes', 'a')).read()).toEqual(note('a'));
    expect(journal.map(entry => [entry.gestureId, entry.origin])).toEqual([
      ['collect', 'command'], ['collect', 'undo'], ['collect', 'redo'],
    ]);
  });

  it('merges consecutive commands with the same gesture and retains an initial absence', async () => {
    const store = await open();
    await store.batch({ gestureId: 'typing', writes: [{ collection: 'notes', kind: 'put', document: note('a', 'one') }] });
    await store.batch({ gestureId: 'typing', writes: [{ collection: 'notes', kind: 'put', document: note('a', 'two') }] });
    await store.history.undo();
    expect((await store.document('notes', 'a')).read()).toBeNull();
    expect(store.history.state.read().canUndo).toBe(false);
    await store.history.redo();
    expect((await store.document('notes', 'a')).read()?.title).toBe('two');
  });

  it('does not overwrite a newer replicated value or journal a remote pull', async () => {
    const store = await open();
    const observed: JournalEntry[] = [];
    store.journal.subscribe(entry => observed.push(entry));
    await store.batch({ gestureId: 'mine', writes: [{ collection: 'notes', kind: 'put', document: note('a', 'mine') }] });
    // This infrastructure write simulates RxDB replication; the command door does not observe it.
    await getCollection(store, 'notes').bulkUpsert([note('a', 'server')]);
    await expect(store.history.undo()).rejects.toBeInstanceOf(HistoryConflictError);
    expect((await store.document('notes', 'a')).read()?.title).toBe('server');
    expect(observed.map(entry => entry.gestureId)).toEqual(['mine']);
  });

  it('preserves an intervening remote value when the same gesture continues afterward', async () => {
    const store = await open();
    await store.batch({ gestureId: 'typing', writes: [{ collection: 'notes', kind: 'put', document: note('a', 'first') }] });
    await getCollection(store, 'notes').bulkUpsert([note('a', 'server')]);
    await store.batch({ gestureId: 'typing', writes: [{ collection: 'notes', kind: 'put', document: note('a', 'last') }] });
    await store.history.undo();
    expect((await store.document('notes', 'a')).read()?.title).toBe('server');
    await expect(store.history.undo()).rejects.toBeInstanceOf(HistoryConflictError);
  });
});

describe('narrow scoped reads', () => {
  it('does not notify a subscriber released by an earlier subscriber during emission', async () => {
    const store = await open();
    const source = await store.document('notes', 'a');
    let unsubscribeSecond = (): void => undefined;
    source.subscribe(() => { unsubscribeSecond(); });
    const second = vi.fn();
    unsubscribeSecond = source.subscribe(second);
    await store.batch({ gestureId: 'add', writes: [{ collection: 'notes', kind: 'put', document: note('a') }] });
    expect(second).not.toHaveBeenCalled();
  });

  it('does not notify later subscribers after an earlier subscriber disposes the view', async () => {
    const store = await open();
    const view = scope();
    const source = await store.document('notes', 'a', view);
    source.subscribe(() => { void view.dispose(); });
    const second = vi.fn();
    source.subscribe(second);
    await store.batch({ gestureId: 'add', writes: [{ collection: 'notes', kind: 'put', document: note('a') }] });
    expect(second).not.toHaveBeenCalled();
  });

  it('settles owned native query caches before a completed command can be read again', async () => {
    const store = await open();
    const document = await store.document('notes', 'a');
    const rows = await store.query('notes', { selector: { done: false } });
    await store.batch({ gestureId: 'add', writes: [{ collection: 'notes', kind: 'put', document: note('a') }] });
    expect(document.read()).toEqual(note('a'));
    expect(rows.read()).toEqual([note('a')]);
    await store.batch({ gestureId: 'complete', writes: [
      { collection: 'notes', kind: 'put', document: { ...document.read()!, done: true } },
    ] });
    expect(document.read()?.done).toBe(true);
    expect(rows.read()).toEqual([]);
    await store.history.undo();
    expect(document.read()?.done).toBe(false);
    expect(rows.read()).toEqual([note('a')]);
  });

  it('subscribes to a single document and releases it with its view scope', async () => {
    const store = await open();
    const view = scope();
    const source = await store.document('notes', 'a', view);
    const listener = vi.fn();
    source.subscribe(listener);
    await store.batch({ gestureId: 'other', writes: [{ collection: 'notes', kind: 'put', document: note('b') }] });
    await store.batch({ gestureId: 'mine', writes: [{ collection: 'notes', kind: 'put', document: note('a') }] });
    await vi.waitFor(() => expect(listener).toHaveBeenLastCalledWith(note('a')));
    await view.dispose();
    const count = listener.mock.calls.length;
    await store.batch({ gestureId: 'later', writes: [{ collection: 'notes', kind: 'put', document: note('a', 'later') }] });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(listener).toHaveBeenCalledTimes(count);
    expect(() => source.read()).toThrow();
  });

  it('closes storage on account disposal and refuses further writes', async () => {
    const account = scope();
    const store = await createLocalStore<{ notes: Note }>({
      name: name(), schemas: { notes: schema }, scope: account, storage: getRxStorageMemory(),
    });
    const collection = getCollection(store, 'notes');
    await account.dispose();
    expect(collection.closed).toBe(true);
    await expect(store.batch({ gestureId: 'stale', writes: [{ collection: 'notes', kind: 'put', document: note('a') }] })).rejects.toThrow();
  });

  it('cancels reads before waiting for dependents to release storage', async () => {
    const account = scope();
    const store = await createLocalStore<{ notes: Note }>({
      name: name(), schemas: { notes: schema }, scope: account, storage: getRxStorageMemory(),
    });
    const document = await store.document('notes', 'a');
    const collection = getCollection(store, 'notes');
    let release!: () => void;
    const dependent = new Promise<void>(resolve => { release = resolve; });
    account.defer(() => dependent);
    const disposing = account.dispose();
    expect(() => document.read()).toThrow();
    expect(collection.closed).toBe(false);
    release();
    await disposing;
    expect(collection.closed).toBe(true);
  });
});
