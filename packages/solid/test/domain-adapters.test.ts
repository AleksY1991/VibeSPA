import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import type { RxJsonSchema } from 'rxdb';
import type {
  AdapterBatch, AdapterContext, CommandIdentity, DomainAdapterSession, IncomingChange,
} from '../src/domain/types.js';
import { createRestDomainAdapter } from '../src/domain/rest.js';
import { createRxDbDomainAdapter } from '../../local-first/src/solidAdapter.js';

interface Note { id: string; title: string; done: boolean }
const note = (id: string, title = id): Note => ({ id, title, done: false });
const identity = (sequence = 1): CommandIdentity => ({
  generation: 'session-one', sequence, gestureId: `gesture-${sequence}`, origin: 'user',
});
const batch = (sequence = 1, expectedVersion = 0, rows = [note('a')]): AdapterBatch<Note> => ({
  identity: identity(sequence), label: 'Edit notes',
  writes: rows.map(document => ({ id: document.id, document, expectedVersion, localRevision: sequence })),
});
const schema: RxJsonSchema<Note> = {
  version: 0, primaryKey: 'id', type: 'object',
  properties: {
    id: { type: 'string', maxLength: 100 }, title: { type: 'string' }, done: { type: 'boolean' },
  },
  required: ['id', 'title', 'done'], additionalProperties: false,
};
const sessions: DomainAdapterSession<Note>[] = [];
const cancellations: AbortController[] = [];
function context() {
  const cancellation = new AbortController();
  cancellations.push(cancellation);
  const changes: IncomingChange<Note>[] = [];
  const port: AdapterContext<Note> = {
    generation: 'session-one', signal: cancellation.signal,
    receive(change) { changes.push(change); return { accepted: change.rows.map(row => row.id), refused: [] }; },
  };
  return { port, cancellation, changes };
}
let databaseSequence = 0;
const databaseName = () => `soliddomain${Date.now()}${++databaseSequence}`;
afterEach(async () => {
  cancellations.splice(0).forEach(cancellation => { cancellation.abort(); });
  await Promise.all(sessions.splice(0).map(session => session.close()));
});

describe('REST connector', () => {
  it('uses the same domain batch and explicit receipt protocol without an entity cache', async () => {
    const test = context();
    const transport = vi.fn(async (request, signal) => {
      expect(signal).toBe(test.port.signal);
      if (request.method === 'GET') return { status: 200, body: [{ id: 'a', version: 2, document: note('a') }] };
      const submitted = request.body as AdapterBatch<Note>;
      return { status: 200, body: {
        identity: submitted.identity,
        rows: [{ id: 'a', ok: true, version: 3, document: note('a', 'Server normalized') }],
      } };
    });
    const session = await createRestDomainAdapter<Note>({ endpoint: '/notes/', transport }).open(test.port);
    sessions.push(session);
    expect(await session.load()).toEqual([{ id: 'a', version: 2, document: note('a') }]);
    const submitted = batch(1, 2);
    expect(await session.save(submitted)).toEqual({
      identity: submitted.identity,
      rows: [{ id: 'a', ok: true, version: 3, document: note('a', 'Server normalized') }],
    });
    expect(transport.mock.calls.map(call => call[0])).toEqual([
      { method: 'GET', path: '/notes' }, { method: 'POST', path: '/notes/commands', body: submitted },
    ]);
  });

  it('reports transport rejection and releases push admission at cancellation', async () => {
    const test = context();
    let incoming!: AdapterContext<Note>;
    const stop = vi.fn();
    const refused = vi.fn();
    const session = await createRestDomainAdapter<Note>({
      endpoint: '/notes', transport: async () => ({ status: 503, body: null }),
      subscribe(port) { incoming = port; return stop; }, onRefused: refused,
    }).open(test.port);
    sessions.push(session);
    await expect(session.save(batch())).rejects.toThrow('failed (503)');
    incoming.receive({ generation: 'session-one', changeId: 'one', origin: 'adapter', rows: [{ id: 'a', version: 1, document: note('a') }] });
    expect(test.changes).toHaveLength(1);
    test.cancellation.abort();
    expect(stop).toHaveBeenCalledOnce();
    const admission = incoming.receive({ generation: 'session-one', changeId: 'two', origin: 'adapter', rows: [{ id: 'b', version: 1, document: note('b') }] });
    expect(admission).toEqual({ accepted: [], refused: ['b'] });
    expect(test.changes).toHaveLength(1);
    await expect(session.load()).rejects.toMatchObject({ name: 'AbortError' });
    await session.close();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('rejects a late HTTP result from an ended session', async () => {
    const test = context();
    let respond!: (value: { status: number; body: unknown }) => void;
    const response = new Promise<{ status: number; body: unknown }>(resolve => { respond = resolve; });
    const session = await createRestDomainAdapter<Note>({ endpoint: '/notes', transport: () => response }).open(test.port);
    sessions.push(session);
    const loading = session.load();
    const refused = expect(loading).rejects.toMatchObject({ name: 'AbortError' });
    test.cancellation.abort();
    respond({ status: 200, body: [{ id: 'a', version: 1, document: note('a') }] });
    await refused;
    expect(test.changes).toEqual([]);
  });
});

describe('isolated non-SQL RxDB connector', () => {
  it('stores native envelopes, loads them, and returns the original receipt for a duplicate command', async () => {
    const test = context();
    const session = await createRxDbDomainAdapter<Note>({ name: databaseName(), storage: getRxStorageMemory(), schema }).open(test.port);
    sessions.push(session);
    expect(await session.load()).toEqual([]);
    const saved = await session.save(batch());
    expect(saved).toEqual({ identity: identity(), rows: [{ id: 'a', ok: true, version: 1, document: note('a') }] });
    expect(await session.save(batch(1, 0, [note('a', 'Response-loss retry')]))).toEqual(saved);
    expect(await session.load()).toEqual([{ id: 'a', version: 1, document: note('a') }]);
    expect(test.changes).toHaveLength(1);
    expect(test.changes[0]).toMatchObject({ command: identity(), origin: 'adapter', rows: [{ id: 'a', version: 1 }] });
    // Only protocol methods escape, never a writable RxCollection or RxDocument.
    expect(Object.keys(session).sort()).toEqual(['close', 'load', 'save']);
  });

  it('preserves partial acceptance, rejects stale CAS writes, and versions tombstones', async () => {
    const test = context();
    const session = await createRxDbDomainAdapter<Note>({ name: databaseName(), storage: getRxStorageMemory(), schema }).open(test.port);
    sessions.push(session);
    const invalid = { ...note('b'), done: 'wrong' } as unknown as Note;
    const partial = await session.save(batch(1, 0, [note('a'), invalid]));
    expect(partial.rows[0]).toEqual({ id: 'a', ok: true, version: 1, document: note('a') });
    expect(partial.rows[1]).toMatchObject({ id: 'b', ok: false });
    expect(await session.load()).toEqual([{ id: 'a', version: 1, document: note('a') }]);
    const updated = await session.save(batch(2, 1, [note('a', 'Second')]));
    expect(updated.rows[0]).toMatchObject({ id: 'a', ok: true, version: 2 });
    const stale = await session.save(batch(3, 1, [note('a', 'Stale')]));
    expect(stale.rows).toEqual([{ id: 'a', ok: false, error: 'Version conflict for a.' }]);
    expect(await session.load()).toEqual([{ id: 'a', version: 2, document: note('a', 'Second') }]);
    const deleted = await session.save({
      identity: identity(4), label: 'Remove', writes: [{ id: 'a', expectedVersion: 2, localRevision: 4, document: null }],
    });
    expect(deleted.rows).toEqual([{ id: 'a', ok: true, version: 3, document: null }]);
    expect(await session.load()).toEqual([{ id: 'a', version: 3, document: null }]);
  });

  it('keeps cancellation and incoming refusals explicit', async () => {
    const test = context();
    const refusal = vi.fn();
    test.port.receive = change => ({ accepted: [], refused: change.rows.map(row => row.id) });
    const session = await createRxDbDomainAdapter<Note>({
      name: databaseName(), storage: getRxStorageMemory(), schema, onRefused: refusal,
    }).open(test.port);
    sessions.push(session);
    await session.save(batch());
    expect(refusal).toHaveBeenCalledOnce();
    expect(refusal.mock.calls[0]?.[1]).toEqual({ accepted: [], refused: ['a'] });
    test.cancellation.abort();
    await expect(session.load()).rejects.toMatchObject({ name: 'AbortError' });
    await expect(session.save(batch(2, 1))).rejects.toMatchObject({ name: 'AbortError' });
    await session.close();
    await session.close();
  });

  it('hydrates persisted envelopes in a replacement session without leaking a database handle', async () => {
    const first = context();
    const options = { name: databaseName(), storage: getRxStorageMemory(), schema };
    const adapter = createRxDbDomainAdapter<Note>(options);
    const firstSession = await adapter.open(first.port);
    sessions.push(firstSession);
    await firstSession.save(batch());
    first.cancellation.abort();
    await firstSession.close();
    const next = context();
    const nextSession = await adapter.open({ ...next.port, generation: 'replacement' });
    sessions.push(nextSession);
    expect(await nextSession.load()).toEqual([{ id: 'a', version: 1, document: note('a') }]);
    await expect(firstSession.load()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('closes a storage instance that arrives after opening was canceled', async () => {
    const test = context();
    const memory = getRxStorageMemory();
    const opened: { closed: boolean }[] = [];
    let signalOpening!: () => void;
    let release!: () => void;
    const began = new Promise<void>(resolve => { signalOpening = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const storage: typeof memory = {
      ...memory,
      async createStorageInstance(params) {
        const instance = await memory.createStorageInstance(params);
        const observed = { closed: false };
        const close = instance.close.bind(instance);
        instance.close = async () => { await close(); observed.closed = true; };
        opened.push(observed);
        if (opened.length === 1) { signalOpening(); await blocked; }
        return instance;
      },
    };
    const opening = createRxDbDomainAdapter<Note>({ name: databaseName(), storage, schema }).open(test.port);
    const refused = expect(opening).rejects.toMatchObject({ name: 'AbortError' });
    await began;
    test.cancellation.abort();
    release();
    await refused;
    expect(opened.length).toBeGreaterThan(0);
    expect(opened.every(instance => instance.closed)).toBe(true);
  });
});
