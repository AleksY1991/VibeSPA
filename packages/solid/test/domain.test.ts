import { createEffect, createRoot, createStore, flush } from 'solid-js';
import { describe, expect, it } from 'vitest';
import { defineFeatureModule, external, FeatureType } from '@vibespa/core';
import type { ModuleContext } from '@vibespa/core/module';
import { createSolidSystem } from '../src/module.js';
import { createSolidDomain } from '../src/domain.js';
import type { AdapterBatch, AdapterContext, DomainAdapter, DomainOwner, RemoteRow, SaveReceipt } from '../src/domain.js';

interface Row { id: string; title: string; done: boolean; details: { tags: string[]; rank: number } }
const row = (id: string, title = id): Row => ({ id, title, done: false, details: { tags: ['one'], rank: 1 } });
const put = (document: Row) => ({ kind: 'put' as const, document });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  return { promise: new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; }), resolve, reject };
}
function ack(batch: AdapterBatch<Row>, normalize = (row: Row) => row): SaveReceipt<Row> {
  return { identity: batch.identity, rows: batch.writes.map(write => ({ id: write.id, ok: true,
    version: write.expectedVersion + 1, document: write.document && normalize(write.document) })) };
}
async function harness(adapter?: DomainAdapter<Row>, generation = 'session-1') {
  const system = createSolidSystem({ id: generation });
  let owner!: DomainOwner<Row>;
  let scope!: ModuleContext;
  const module = defineFeatureModule<FeatureType.Feature, { generation: string }, { readonly owner: DomainOwner<Row> }>({
    id: 'domain', kind: FeatureType.Feature, title: 'Domain', description: 'Owns the test domain.',
    contract: { inputs: { generation: 'Session generation.' }, exports: { owner: 'Private test seam.' } },
    load: async () => (inputs, context) => {
      scope = context;
      owner = createSolidDomain(context, { generation: inputs.generation, adapter });
      // Test harness deliberately captures private owner; production exports reads
      // and named commands only (see playground focus).
      return { owner };
    },
  });
  await system.start(module, { generation: external(generation) });
  let nextGesture = 0;
  return { system, owner, scope, commit: (...rows: Row[]) => owner.commit({ gestureId: `gesture-${++nextGesture}`, label: 'Edit', writes: rows.map(put) }) };
}
function controlled(initial: readonly RemoteRow<Row>[] = []) {
  let context!: AdapterContext<Row>;
  const batches: AdapterBatch<Row>[] = [];
  const responses: ReturnType<typeof deferred<SaveReceipt<Row>>>[] = [];
  let closed = 0;
  const adapter: DomainAdapter<Row> = {
    async open(current) {
      context = current;
      return {
        load: async () => initial,
        save(batch) { batches.push(batch); const response = deferred<SaveReceipt<Row>>(); responses.push(response); return response.promise; },
        close() { closed++; },
      };
    },
  };
  return { adapter, batches, responses, context: () => context, closed: () => closed };
}
async function tick() { for (let index = 0; index < 12; index++) await Promise.resolve(); }

describe('Solid-owned domain capability', () => {
  it('works without an adapter, owns input payloads, and exposes deeply readonly live records', async () => {
    const test = await harness();
    const input = row('one');
    test.commit(input);
    const rows = test.owner.view.rows;
    const item = rows[0]!;
    input.details.tags.push('external');
    input.title = 'external';
    expect(item.title).toBe('one');
    expect(item.details.tags).toEqual(['one']);
    expect(() => Reflect.set(item, 'title', 'bad')).toThrow('readonly');
    expect(() => Reflect.set(item.details, 'rank', 99)).toThrow('readonly');
    expect(() => (item.details.tags as string[]).push('bad')).toThrow('readonly');
    expect(() => Reflect.deleteProperty(item, 'title')).toThrow('readonly');
    expect(() => Object.defineProperty(item, 'done', { value: true })).toThrow('readonly');
    expect(() => Object.setPrototypeOf(item, null)).toThrow('readonly');
    expect(() => Object.freeze(item)).toThrow('readonly');
    const descriptor = Object.getOwnPropertyDescriptor(item, 'details')!;
    expect(() => Reflect.set(descriptor.value, 'rank', 2)).toThrow('readonly');
    const [, recovered] = createStore(rows as Row[]);
    // Solid may create a separate foreign store around the facade. It must
    // never recover the original store's mutation authority.
    recovered(draft => { draft[0]!.details.tags.push('bad'); });
    flush();
    expect(item.details.tags).toEqual(['one']);
    expect(JSON.parse(JSON.stringify(rows))).toEqual([row('one')]);
    expect(Object.keys(rows)).toEqual(['0']);
    expect([...rows][0]).toBe(item);
    expect(test.owner.view.delivery().phase).toBe('memory');
    await test.system.dispose();
  });

  it('retains row/nested identity and invalidates only fields and lists that changed', async () => {
    const test = await harness();
    test.commit(row('one'), row('two'));
    const first = test.owner.view.rows[0]!;
    const second = test.owner.view.rows[1]!;
    const details = first.details;
    const seen = { first: 0, second: 0, rank: 0, list: 0 };
    const stop = createRoot(dispose => {
      createEffect(() => test.owner.view.rows[0]!.title, () => { seen.first++; });
      createEffect(() => test.owner.view.rows[1]!.title, () => { seen.second++; });
      createEffect(() => first.details.rank, () => { seen.rank++; });
      createEffect(() => test.owner.view.rows.map(item => item.id).join(','), () => { seen.list++; });
      return dispose;
    });
    flush();
    test.commit({ ...row('one'), title: 'changed' });
    flush();
    expect(test.owner.view.rows[0]).toBe(first);
    expect(test.owner.view.rows[1]).toBe(second);
    expect(first.details).toBe(details);
    expect(seen).toEqual({ first: 2, second: 1, rank: 1, list: 1 });
    stop();
    await test.system.dispose();
  });

  it('validates the entire gesture before any state changes and coalesces repeated row writes', async () => {
    const test = await harness();
    expect(() => test.commit(row('one'), { ...row('bad'), details: new Date() } as unknown as Row)).toThrow('plain');
    expect(test.owner.view.rows).toHaveLength(0);
    const receipt = test.commit(row('one'), row('one', 'last'));
    expect(receipt.applied).toEqual(['one']);
    expect(test.owner.view.rows[0]!.title).toBe('last');
    test.owner.undo();
    expect(test.owner.view.rows).toHaveLength(0);
    test.owner.redo();
    expect(test.owner.view.rows[0]!.title).toBe('last');
    await test.system.dispose();
  });

  it('applies local commands synchronously while saving FIFO with one identity per gesture', async () => {
    const transport = controlled();
    const test = await harness(transport.adapter);
    await test.owner.settled();
    const first = test.commit(row('one'));
    expect(test.owner.view.rows[0]!.title).toBe('one');
    const second = test.commit(row('one', 'newer'));
    expect(test.owner.view.rows[0]!.title).toBe('newer');
    expect(transport.batches).toHaveLength(1);
    expect(first.identity.sequence).toBe(1);
    expect(second.identity.sequence).toBe(2);
    transport.responses[0]!.resolve(ack(transport.batches[0]!, item => ({ ...item, title: 'OLD NORMALIZATION' })));
    await tick();
    expect(test.owner.view.rows[0]!.title).toBe('newer');
    expect(transport.batches[1]!.writes[0]!.expectedVersion).toBe(1);
    transport.responses[1]!.resolve(ack(transport.batches[1]!, item => ({ ...item, title: 'NEWER' })));
    await test.owner.settled();
    expect(test.owner.view.rows[0]!.title).toBe('NEWER');
    expect(test.owner.view.delivery()).toEqual({ phase: 'idle', pending: 0, error: null });
    expect(test.owner.view.history().canUndo).toBe(true);
    test.owner.undo();
    expect(test.owner.view.rows[0]!.title).toBe('one');
    transport.responses[2]!.resolve(ack(transport.batches[2]!));
    await test.owner.settled();
    expect(transport.batches[2]!.identity).toMatchObject({ origin: 'undo', gestureId: second.identity.gestureId, sequence: 3 });
    await test.system.dispose();
  });

  it('keeps failed edits, blocks later delivery, and retries only failed rows with original identity', async () => {
    const transport = controlled();
    const test = await harness(transport.adapter);
    await test.owner.settled();
    const receipt = test.commit(row('one'), row('two'));
    const batch = transport.batches[0]!;
    transport.responses[0]!.resolve({ identity: batch.identity, rows: [ack(batch).rows[0]!, { id: 'two', ok: false, error: 'denied' }] });
    await test.owner.settled();
    expect(test.owner.view.rows).toHaveLength(2);
    expect(test.owner.view.delivery()).toEqual({ phase: 'failed', pending: 1, error: 'two: denied' });
    test.commit(row('one', 'later'));
    expect(transport.batches).toHaveLength(1);
    test.owner.retry();
    expect(transport.batches[1]!.identity).toEqual(receipt.identity);
    expect(transport.batches[1]!.writes.map(write => write.id)).toEqual(['two']);
    transport.responses[1]!.resolve(ack(transport.batches[1]!));
    await tick();
    expect(transport.batches[2]!.writes[0]!.expectedVersion).toBe(1);
    transport.responses[2]!.resolve(ack(transport.batches[2]!));
    await test.owner.settled();
    await test.system.dispose();
  });

  it('contains thrown delivery/invalid receipt failures without rolling back local admission', async () => {
    const transport = controlled();
    const test = await harness(transport.adapter);
    await test.owner.settled();
    test.commit(row('one'));
    transport.responses[0]!.reject(new Error('offline'));
    await test.owner.settled();
    expect(test.owner.view.delivery().error).toBe('offline');
    test.owner.retry();
    const batch = transport.batches[1]!;
    transport.responses[1]!.resolve({ ...ack(batch), identity: { ...batch.identity, generation: 'old-session' } });
    await test.owner.settled();
    expect(test.owner.view.delivery().error).toContain('identity');
    expect(test.owner.view.rows[0]!.title).toBe('one');
    test.owner.retry();
    transport.responses[2]!.resolve(ack(transport.batches[2]!));
    await test.owner.settled();
    await test.system.dispose();
  });

  it('admits incoming revisions without echo/history entries and guards concurrent local intent and history', async () => {
    const transport = controlled([{ id: 'one', version: 1, document: row('one') }]);
    const test = await harness(transport.adapter);
    await test.owner.settled();
    expect(test.owner.view.history()).toEqual({ canUndo: false, canRedo: false });
    const local = test.commit(row('one', 'local'));
    const context = transport.context();
    const incoming = { generation: context.generation, origin: 'adapter' as const, changeId: 'remote-2', rows: [{ id: 'one', version: 2, document: row('one', 'remote') }] };
    expect(context.receive(incoming)).toEqual({ accepted: [], refused: ['one'] });
    expect(context.receive({ ...incoming, changeId: 'echo', command: local.identity })).toEqual({ accepted: [], refused: [] });
    expect(test.owner.view.rows[0]!.title).toBe('local');
    transport.responses[0]!.resolve(ack(transport.batches[0]!));
    await test.owner.settled();
    const external = { ...incoming, rows: [{ id: 'one', version: 3, document: row('one', 'remote') }] };
    expect(context.receive(external)).toEqual({ accepted: ['one'], refused: [] });
    expect(context.receive(external)).toEqual({ accepted: [], refused: [] });
    expect(context.receive({ ...incoming, changeId: 'stale' })).toEqual({ accepted: [], refused: [] });
    expect(transport.batches).toHaveLength(1);
    expect(() => test.owner.undo()).toThrow('History conflict');
    await test.system.dispose();
  });

  it('treats an adopted durable receipt as an external revision for history', async () => {
    const transport = controlled();
    const test = await harness(transport.adapter);
    await test.owner.settled();
    test.commit(row('one'));
    transport.responses[0]!.resolve(ack(transport.batches[0]!));
    await test.owner.settled();
    test.commit(row('one', 'proposed'));
    const batch = transport.batches[1]!;
    transport.responses[1]!.resolve({ identity: batch.identity, rows: [{
      id: 'one', ok: true, adopted: true, version: 3, document: row('one', 'server'),
    }] });
    await test.owner.settled();
    expect(test.owner.view.rows[0]!.title).toBe('server');
    expect(test.owner.view.delivery()).toEqual({ phase: 'idle', pending: 0, error: null });
    // Undo would otherwise write the pre-gesture value over the adopted row.
    expect(() => test.owner.undo()).toThrow('History conflict');
    expect(transport.batches).toHaveLength(2);
    // A later local edit is ordinary intent with the adopted CAS baseline.
    test.commit(row('one', 'later'));
    expect(transport.batches[2]!.writes[0]!.expectedVersion).toBe(3);
    transport.responses[2]!.resolve(ack(transport.batches[2]!));
    await test.owner.settled();
    expect(test.owner.view.rows[0]!.title).toBe('later');
    test.owner.undo();
    expect(test.owner.view.rows[0]!.title).toBe('server');
    transport.responses[3]!.resolve(ack(transport.batches[3]!));
    await test.owner.settled();
    await test.system.dispose();
  });

  it('never lets an adopted receipt overwrite a newer local edit', async () => {
    const transport = controlled();
    const test = await harness(transport.adapter);
    await test.owner.settled();
    test.commit(row('one', 'proposed'));
    test.commit(row('one', 'newer'));
    const batch = transport.batches[0]!;
    transport.responses[0]!.resolve({ identity: batch.identity, rows: [{
      id: 'one', ok: true, adopted: true, version: 2, document: row('one', 'server'),
    }] });
    await tick();
    expect(test.owner.view.rows[0]!.title).toBe('newer');
    expect(transport.batches[1]!.writes[0]!.expectedVersion).toBe(2);
    transport.responses[1]!.resolve(ack(transport.batches[1]!));
    await test.owner.settled();
    expect(test.owner.view.rows[0]!.title).toBe('newer');
    await test.system.dispose();
  });

  it('preserves gesture history across multiple undo/redo and clears redo on new intent', async () => {
    const test = await harness();
    test.commit(row('one'));
    test.commit(row('two'));
    test.commit(row('one', 'changed'));
    test.owner.undo();
    test.owner.undo();
    test.owner.undo();
    expect(test.owner.view.rows).toHaveLength(0);
    test.owner.redo();
    test.owner.redo();
    test.owner.redo();
    expect(test.owner.view.rows.map(item => item.title)).toEqual(['changed', 'two']);
    test.owner.undo();
    test.commit(row('three'));
    expect(test.owner.view.history().canRedo).toBe(false);
    await test.system.dispose();
  });

  it('never forgives an external equal-content revision while undoing an unrelated gesture', async () => {
    const transport = controlled();
    const test = await harness(transport.adapter);
    await test.owner.settled();
    test.commit(row('one'));
    transport.responses[0]!.resolve(ack(transport.batches[0]!));
    await test.owner.settled();
    transport.context().receive({ generation: 'session-1', origin: 'adapter', changeId: 'same-data-new-revision',
      rows: [{ id: 'one', version: 2, document: row('one') }] });
    test.commit(row('two'));
    transport.responses[1]!.resolve(ack(transport.batches[1]!));
    await test.owner.settled();
    test.owner.undo();
    transport.responses[2]!.resolve(ack(transport.batches[2]!));
    await test.owner.settled();
    expect(() => test.owner.undo()).toThrow('History conflict');
    await test.system.dispose();
  });

  it('resolves prehydration CAS conflicts only through explicit whole-row keepLocal with new identities', async () => {
    const initial = deferred<readonly RemoteRow<Row>[]>();
    let version = 1;
    let loads = 0;
    const batches: AdapterBatch<Row>[] = [];
    const adapter: DomainAdapter<Row> = { open: async () => ({
      load: () => ++loads === 1 ? initial.promise : Promise.resolve([{ id: 'one', version, document: row('one', 'remote') }]),
      save: async batch => {
        batches.push(batch);
        return { identity: batch.identity, rows: batch.writes.map(write => write.expectedVersion === version
          ? { id: write.id, ok: true, version: ++version, document: write.document }
          : { id: write.id, ok: false, error: 'CAS conflict' }) };
      }, close() {},
    }) };
    const test = await harness(adapter);
    const local = test.commit(row('one', 'local'));
    initial.resolve([{ id: 'one', version, document: row('one', 'remote') }]);
    await test.owner.settled();
    expect(test.owner.view.delivery().error).toContain('CAS conflict');
    test.owner.retry();
    await test.owner.settled();
    expect(batches[1]!.identity).toEqual(local.identity);
    expect(batches[1]!.writes[0]!.expectedVersion).toBe(0);
    test.owner.keepLocal();
    await test.owner.settled();
    expect(batches[2]!.identity).toMatchObject({ origin: 'rebase', gestureId: local.identity.gestureId });
    expect(batches[2]!.identity.sequence).toBeGreaterThan(local.identity.sequence);
    expect(batches[2]!.writes[0]!.expectedVersion).toBe(1);
    expect(test.owner.view.rows[0]!.title).toBe('local');
    expect(test.owner.view.delivery().phase).toBe('idle');
    test.owner.undo();
    await test.owner.settled();
    expect(test.owner.view.rows).toHaveLength(0);
    expect(test.owner.view.history().canUndo).toBe(false);
    await test.system.dispose();
  });

  it('freezes transport authority and validates exact own echoes before admitting changes', async () => {
    let context!: AdapterContext<Row>;
    const adapter: DomainAdapter<Row> = { open: async port => {
      context = port;
      return { load: async () => [], save: async batch => {
        expect(Object.isFrozen(batch)).toBe(true);
        expect(Reflect.set(batch.identity, 'sequence', 99)).toBe(false);
        expect(Reflect.set(batch.writes[0]!, 'localRevision', 99)).toBe(false);
        return ack(batch);
      }, close() {} };
    } };
    const test = await harness(adapter);
    await test.owner.settled();
    const receipt = test.commit(row('one'));
    await test.owner.settled();
    expect(() => context.receive({ generation: 'session-1', changeId: 'forged', origin: 'adapter', rows: [],
      command: { ...receipt.identity, gestureId: 'different' } })).toThrow('Unknown own-command');
    await test.system.dispose();
  });

  it('publishes compound gestures atomically and rejects non-JSON nested array behavior', async () => {
    const test = await harness();
    const observed: string[] = [];
    const stop = createRoot(dispose => {
      createEffect(() => test.owner.view.rows.map(item => item.title).join(','), value => { observed.push(value); });
      return dispose;
    });
    flush();
    test.commit(row('one'), row('two'));
    expect(observed).toEqual(['', 'one,two']);
    const getter = ['x'];
    Object.defineProperty(getter, '0', { get: () => 'side effect' });
    expect(() => test.commit({ ...row('bad'), details: { tags: getter, rank: 1 } })).toThrow('getters');
    const iterator = ['x'];
    iterator[Symbol.iterator] = function* () { yield 'side effect'; return undefined; };
    expect(() => test.commit({ ...row('bad'), details: { tags: iterator, rank: 1 } })).toThrow('JSON arrays');
    expect(test.owner.view.rows).toHaveLength(2);
    stop();
    await test.system.dispose();
  });

  it('joins canceled acquisition, releases the arriving session and rejects callbacks into a replacement generation', async () => {
    const acquisition = deferred<Awaited<ReturnType<DomainAdapter<Row>['open']>>>();
    let oldContext!: AdapterContext<Row>;
    let closed = 0;
    const old = await harness({ open: context => { oldContext = context; return acquisition.promise; } }, 'old');
    const closing = old.system.dispose();
    acquisition.resolve({ load: async () => [], save: async batch => ack(batch), close() { closed++; } });
    await closing;
    expect(closed).toBe(1);
    const replacement = await harness(undefined, 'replacement');
    replacement.commit(row('replacement'));
    expect(oldContext.receive({ generation: 'old', origin: 'adapter', changeId: 'late',
      rows: [{ id: 'replacement', version: 1, document: row('replacement', 'stale') }] }).refused).toEqual(['replacement']);
    expect(replacement.owner.view.rows[0]!.title).toBe('replacement');
    expect(old.owner.view.rows).toHaveLength(0);
    await replacement.system.dispose();
  });

  it('joins an accepted save at cancellation and never admits its late normalization into Solid', async () => {
    const transport = controlled();
    const test = await harness(transport.adapter);
    await test.owner.settled();
    test.commit(row('one', 'accepted'));
    const closing = test.system.dispose();
    transport.responses[0]!.resolve(ack(transport.batches[0]!, item => ({ ...item, title: 'late' })));
    await closing;
    expect(test.owner.view.rows[0]!.title).toBe('accepted');
    expect(transport.closed()).toBe(1);
  });

  it('refetches a newer remote revision refused between backend acceptance and its local receipt', async () => {
    let context!: AdapterContext<Row>;
    const remote: { current?: RemoteRow<Row> } = {};
    const response = deferred<SaveReceipt<Row>>();
    let batch!: AdapterBatch<Row>;
    let failRefresh = false;
    const test = await harness({ open: async port => {
      context = port;
      return {
        load: async () => {
          if (failRefresh) throw new Error('refresh offline');
          return remote.current ? [remote.current] : [];
        },
        save: sent => { batch = sent; return response.promise; }, close() {},
      };
    } });
    await test.owner.settled();
    test.commit(row('one', 'local A'));
    remote.current = { id: 'one', version: 2, document: row('one', 'remote B') };
    expect(context.receive({ generation: context.generation, origin: 'adapter', changeId: 'foreign-B', rows: [remote.current] }).refused).toEqual(['one']);
    failRefresh = true;
    response.resolve(ack(batch, item => ({ ...item, title: 'old normalization A' })));
    await test.owner.settled();
    expect(test.owner.view.rows[0]!.title).toBe('local A');
    expect(test.owner.view.delivery()).toEqual({ phase: 'failed', pending: 0, error: 'refresh offline' });
    failRefresh = false;
    test.owner.retry();
    await test.owner.settled();
    expect(test.owner.view.rows[0]!.title).toBe('remote B');
    expect(test.owner.view.delivery().phase).toBe('idle');
    expect(() => test.owner.undo()).toThrow('History conflict');
    await test.system.dispose();
  });

  it('preserves edits during hydration, makes conflict visible, and closes late acquired adapters', async () => {
    const load = deferred<readonly RemoteRow<Row>[]>();
    const adapter: DomainAdapter<Row> = { open: async () => ({ load: () => load.promise,
      save: async batch => ({ identity: batch.identity, rows: batch.writes.map(write => ({ id: write.id, ok: false, error: 'version conflict' })) }), close() {} }) };
    const test = await harness(adapter);
    test.commit(row('one', 'early local'));
    load.resolve([{ id: 'one', version: 1, document: row('one', 'hydrated') }]);
    await test.owner.settled();
    expect(test.owner.view.rows[0]!.title).toBe('early local');
    expect(test.owner.view.delivery().error).toContain('version conflict');
    await expect(test.system.dispose()).rejects.toThrow('cleanup');

    const transport = controlled();
    const acquired = deferred<Awaited<ReturnType<DomainAdapter<Row>['open']>>>();
    const opening: DomainAdapter<Row> = { open: context => { void transport.adapter.open(context).then(acquired.resolve); return acquired.promise; } };
    const late = await harness(opening, 'late');
    await late.owner.settled();
    const context = transport.context();
    await late.system.dispose();
    expect(context.receive({ generation: 'late', origin: 'adapter', changeId: 'stale', rows: [{ id: 'late', version: 1, document: row('late') }] }).refused).toEqual(['late']);
    expect(late.owner.view.rows).toHaveLength(0);
    expect(transport.closed()).toBe(1);
  });
});
