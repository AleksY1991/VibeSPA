import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRxDatabase } from 'rxdb';
import type { RxCollection, RxDatabase, RxDocumentData, RxJsonSchema } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { wrappedValidateAjvStorage } from 'rxdb/plugins/validate-ajv';
import type {
  AdapterBatch, AdapterContext, CommandIdentity, DomainAdapterSession, IncomingChange,
} from '@vibespa/solid/domain';
import { createRxCollectionDomainAdapter, type DomainCollection, type RowAdoption } from './collectionAdapter.js';

interface Note { id: string; title: string; done: boolean }
type Notes = RxCollection<Note>;
const note = (id: string, title = id, done = false): Note => ({ id, title, done });
const identity = (sequence = 1): CommandIdentity => ({
  generation: 'session-one', sequence, gestureId: `gesture-${sequence}`, origin: 'user',
});
const batch = (sequence: number, expectedVersion: number, rows: (Note | { id: string; document: null })[]): AdapterBatch<Note> => ({
  identity: identity(sequence), label: 'Edit notes',
  writes: rows.map(row => 'document' in row
    ? { id: row.id, document: null, expectedVersion, localRevision: sequence }
    : { id: row.id, document: row, expectedVersion, localRevision: sequence }),
});
const schema: RxJsonSchema<Note> = {
  version: 0, primaryKey: 'id', type: 'object',
  properties: { id: { type: 'string', maxLength: 100 }, title: { type: 'string', maxLength: 20 }, done: { type: 'boolean' } },
  required: ['id', 'title', 'done'], additionalProperties: false,
};

// A native collection with a reactivity type still satisfies the adapter's port.
type AssertAssignable<T extends DomainCollection<Note>> = T;
export type NativeCollectionIsAccepted = AssertAssignable<RxCollection<Note, object, object, object, () => unknown>>;

const databases: Pick<RxDatabase, 'close'>[] = [];
const sessions: DomainAdapterSession<Note>[] = [];
const cancellations: AbortController[] = [];
let sequence = 0;
afterEach(async () => {
  cancellations.splice(0).forEach(cancellation => { cancellation.abort(); });
  await Promise.all(sessions.splice(0).map(session => session.close()));
  await Promise.all(databases.splice(0).map(database => database.close()));
});

async function open(options: { pageSize?: number; onAdopted?: (adoption: RowAdoption<Note>) => void; onIncomingError?: (error: unknown) => void } = {}) {
  const database = await createRxDatabase<{ notes: Notes }>({
    name: `collectionadapter${Date.now()}${++sequence}`,
    storage: wrappedValidateAjvStorage({ storage: getRxStorageMemory() }),
    multiInstance: false,
  });
  databases.push(database);
  await database.addCollections({ notes: { schema } });
  const collection = database.notes;
  const cancellation = new AbortController();
  cancellations.push(cancellation);
  const changes: IncomingChange<Note>[] = [];
  const port: AdapterContext<Note> = {
    generation: 'session-one', signal: cancellation.signal,
    receive(change) { changes.push(change); return { accepted: change.rows.map(row => row.id), refused: [] }; },
  };
  const session = await createRxCollectionDomainAdapter<Note>({ collection, ...options }).open(port);
  sessions.push(session);
  const durable = async (id: string) => (await collection.storageInstance.findDocumentsById([id], true))[0];
  return { database, collection, session, cancellation, changes, port, durable };
}

describe('native RxDB collection connector', () => {
  it('loads flat rows in pages with versioned tombstones and no RxDB metadata', async () => {
    const test = await open({ pageSize: 2 });
    await test.collection.bulkInsert([note('a'), note('b'), note('c'), note('d')]);
    await (await test.collection.findOne('b').exec())!.remove();
    const rows = await test.session.load();
    expect(rows.map(row => row.id).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(rows.find(row => row.id === 'b')).toEqual({ id: 'b', version: 2, document: null });
    expect(rows.find(row => row.id === 'a')).toEqual({ id: 'a', version: 1, document: note('a') });
    for (const row of rows) if (row.document) expect(Object.keys(row.document).sort()).toEqual(['done', 'id', 'title']);
  });

  it('returns one row when it changes while later pages are read', async () => {
    const test = await open({ pageSize: 1 });
    await test.collection.bulkInsert([note('a'), note('b')]);
    // Memory storage pages changed documents through query().
    const storage = test.collection.storageInstance;
    const original = storage.query.bind(storage);
    let calls = 0;
    storage.query = async query => {
      if (++calls === 2) await test.collection.upsert(note('a', 'moved'));
      return original(query);
    };
    const rows = await test.session.load();
    expect(rows.map(row => row.id).sort()).toEqual(['a', 'b']);
    expect(rows.find(row => row.id === 'a')).toEqual({ id: 'a', version: 2, document: note('a', 'moved') });
  });

  it('writes flat rows, tags its own echoes, and keeps versions monotonic through deletion', async () => {
    const test = await open();
    expect(await test.session.load()).toEqual([]);
    expect(await test.session.save(batch(1, 0, [note('a')]))).toEqual({
      identity: identity(1), rows: [{ id: 'a', ok: true, version: 1, document: note('a') }],
    });
    expect(test.changes).toHaveLength(1);
    expect(test.changes[0]).toMatchObject({ command: identity(1), rows: [{ id: 'a', version: 1, document: note('a') }] });
    const stored = await test.durable('a');
    expect(stored).toMatchObject({ ...note('a'), _deleted: false });
    expect((await test.session.save(batch(2, 1, [note('a', 'second')]))).rows[0]).toMatchObject({ ok: true, version: 2 });
    expect((await test.session.save(batch(3, 2, [{ id: 'a', document: null }]))).rows[0])
      .toEqual({ id: 'a', ok: true, version: 3, document: null });
    expect(await test.durable('a')).toMatchObject({ _deleted: true });
    expect((await test.session.save(batch(4, 3, [note('a', 'again')]))).rows[0])
      .toEqual({ id: 'a', ok: true, version: 4, document: note('a', 'again') });
    expect(await test.session.load()).toEqual([{ id: 'a', version: 4, document: note('a', 'again') }]);
    expect(test.changes.every(change => change.command)).toBe(true);
  });

  it('admits foreign durable writes such as replication pulls without a command', async () => {
    const test = await open();
    await test.session.load();
    await test.collection.insert(note('remote'));
    await test.collection.upsert(note('remote', 'pulled', true));
    expect(test.changes.map(change => change.command)).toEqual([undefined, undefined]);
    expect(test.changes.map(change => change.rows)).toEqual([
      [{ id: 'remote', version: 1, document: note('remote') }],
      [{ id: 'remote', version: 2, document: note('remote', 'pulled', true) }],
    ]);
  });

  it('adopts a durable row that changed after the owner baseline', async () => {
    const adopted = vi.fn<(adoption: RowAdoption<Note>) => void>();
    const test = await open({ onAdopted: adopted });
    await test.session.save(batch(1, 0, [note('a')]));
    await test.collection.upsert(note('a', 'server'));
    const before = await test.durable('a');
    const receipt = await test.session.save(batch(2, 1, [note('a', 'local')]));
    expect(receipt.rows).toEqual([{ id: 'a', ok: true, adopted: true, version: 2, document: note('a', 'server') }]);
    expect((await test.durable('a'))!._rev).toBe(before!._rev);
    expect(adopted).toHaveBeenCalledExactlyOnceWith({
      id: 'a', identity: identity(2), proposed: note('a', 'local'), adopted: note('a', 'server'), version: 2,
    });
  });

  it('does not mistake a racing write with the same revision for its own echo', async () => {
    const adopted = vi.fn<(adoption: RowAdoption<Note>) => void>();
    const test = await open({ onAdopted: adopted });
    await test.session.save(batch(1, 0, [note('a')]));
    const storage = test.collection.storageInstance;
    const original = storage.bulkWrite.bind(storage);
    storage.bulkWrite = async (rows, context) => {
      storage.bulkWrite = original;
      // The same database token produces the same next revision as our write.
      const previous = rows[0]!.previous as RxDocumentData<Note>;
      await original([{ previous, document: { ...previous, title: 'replicated' } }], 'replication');
      return original(rows, context);
    };
    const receipt = await test.session.save(batch(2, 1, [note('a', 'local')]));
    const race = test.changes.at(-1)!;
    expect(race.command).toBeUndefined();
    expect(race.rows).toEqual([{ id: 'a', version: 2, document: note('a', 'replicated') }]);
    expect(receipt.rows).toEqual([{ id: 'a', ok: true, adopted: true, version: 2, document: note('a', 'replicated') }]);
    expect(adopted).toHaveBeenCalledOnce();
    expect(await test.durable('a')).toMatchObject({ title: 'replicated' });
  });

  it('advances the version for a write that needs no durable change', async () => {
    const test = await open();
    await test.session.save(batch(1, 0, [note('a')]));
    const rev = (await test.durable('a'))!._rev;
    expect((await test.session.save(batch(2, 1, [note('a')]))).rows).toEqual([{ id: 'a', ok: true, version: 2, document: note('a') }]);
    expect((await test.durable('a'))!._rev).toBe(rev);
    expect((await test.session.save(batch(3, 2, [note('a', 'next')]))).rows[0]).toMatchObject({ ok: true, version: 3 });
  });

  it('returns the original receipt for a retried command, including after a lost read', async () => {
    const test = await open();
    const first = await test.session.save(batch(1, 0, [note('a')]));
    expect(await test.session.save(batch(1, 0, [note('a', 'retry payload')]))).toEqual(first);
    const storage = test.collection.storageInstance;
    const read = storage.findDocumentsById.bind(storage);
    let reads = 0;
    storage.findDocumentsById = async (ids, deleted) => {
      if (++reads === 2) throw new Error('read lost');
      return read(ids, deleted);
    };
    await expect(test.session.save(batch(2, 1, [note('a', 'second')]))).rejects.toThrow('read lost');
    const retried = await test.session.save(batch(2, 1, [note('a', 'second')]));
    expect(retried.rows).toEqual([{ id: 'a', ok: true, version: 2, document: note('a', 'second') }]);
    expect(test.changes.filter(change => change.rows.some(row => row.document?.title === 'second'))).toHaveLength(1);
  });

  it('reports partial storage refusal per row', async () => {
    const test = await open();
    const invalid = note('b', 'this title is far too long for the schema');
    const receipt = await test.session.save(batch(1, 0, [note('a'), invalid]));
    expect(receipt.rows[0]).toEqual({ id: 'a', ok: true, version: 1, document: note('a') });
    expect(receipt.rows[1]).toEqual({ id: 'b', ok: false, error: 'Durable storage refused row (422).' });
    expect(await test.durable('b')).toBeUndefined();
  });

  it('versions a delete of an absent row below a later foreign insert', async () => {
    const test = await open();
    expect((await test.session.save(batch(1, 0, [{ id: 'x', document: null }]))).rows)
      .toEqual([{ id: 'x', ok: true, version: 1, document: null }]);
    await test.collection.insert(note('x', 'foreign'));
    expect(test.changes.at(-1)!.rows).toEqual([{ id: 'x', version: 2, document: note('x', 'foreign') }]);
  });

  it('stops at cancellation and close without closing the collection', async () => {
    const test = await open();
    await test.session.save(batch(1, 0, [note('a')]));
    const seen = test.changes.length;
    test.cancellation.abort();
    await test.collection.insert(note('after'));
    expect(test.changes).toHaveLength(seen);
    await expect(test.session.load()).rejects.toMatchObject({ name: 'AbortError' });
    await expect(test.session.save(batch(2, 1, [note('a', 'late')]))).rejects.toMatchObject({ name: 'AbortError' });
    await test.session.close();
    await test.session.close();
    expect(test.database.closed).toBe(false);
    expect(await test.collection.count().exec()).toBe(2);
  });

  it('contains observer and admission failures', async () => {
    const incoming = vi.fn();
    const test = await open({
      onAdopted() { throw new Error('observer failed'); },
      onIncomingError: incoming,
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await test.session.save(batch(1, 0, [note('a')]));
    await test.collection.upsert(note('a', 'server'));
    await expect(test.session.save(batch(2, 1, [note('a', 'local')]))).resolves.toMatchObject({ rows: [{ adopted: true }] });
    expect(errors).toHaveBeenCalledWith('RxDB adoption observer failed.', expect.any(Error));
    test.port.receive = () => { throw new Error('invalid row'); };
    await test.collection.insert(note('bad'));
    expect(incoming).toHaveBeenCalledWith(expect.objectContaining({ message: 'invalid row' }));
    errors.mockRestore();
  });

  it('refuses a collection whose primary key is not id', async () => {
    const database = await createRxDatabase<{ keyed: RxCollection<{ key: string }> }>({
      name: `collectionadapterkey${Date.now()}${++sequence}`, storage: getRxStorageMemory(), multiInstance: false,
    });
    databases.push(database);
    await database.addCollections({ keyed: { schema: {
      version: 0, primaryKey: 'key', type: 'object', properties: { key: { type: 'string', maxLength: 10 } }, required: ['key'],
    } } });
    const adapter = createRxCollectionDomainAdapter({ collection: database.keyed as unknown as DomainCollection<Note> });
    await expect(adapter.open({ generation: 'g', signal: new AbortController().signal, receive: () => ({ accepted: [], refused: [] }) }))
      .rejects.toThrow('primary key "id"');
  });
});
