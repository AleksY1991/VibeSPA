// Regression: real Solid keyed rows recompute only for rows whose record changed.
// Rows are rendered with Solid's own <For keyed> (via createComponent, no JSX) and
// each row counts how often its title computation runs.
import 'fake-indexeddb/auto';
import { render } from '@solidjs/web';
import { createComponent, createRenderEffect, flush, For, untrack, type Accessor } from 'solid-js';
import { createScope, defineFeatureModule, FeatureType } from '@vibespa/core';
import { createLocalStore } from '@vibespa/local-first';
import { getCollection } from '@vibespa/local-first/adapter';
import { createSolidSystem, moduleAccessor } from '@vibespa/solid/module';
import { createSolidDomain } from '@vibespa/solid/domain';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applicationModules, createApplication } from './composition/createApplication';

interface Row { readonly id: string; readonly title: string; readonly done: boolean }

const settle = async (rounds = 6) => {
  for (let index = 0; index < rounds; index += 1) await new Promise(resolve => setTimeout(resolve, 0));
  flush();
};

/** Render Solid's keyed For over `rows` and count each row's title computation. */
function renderKeyedRows(rows: Accessor<readonly Row[]>) {
  const runs = new Map<string, number>();
  const target = document.createElement('ul');
  document.body.append(target);
  const dispose = render(() => createComponent(For, {
    get each() { return rows(); },
    keyed: (row: Row) => row.id,
    children: (row: Accessor<Row>) => {
      const id = untrack(() => row().id);
      const item = document.createElement('li');
      item.dataset.id = id;
      createRenderEffect(() => { runs.set(id, (runs.get(id) ?? 0) + 1); return row().title; }, title => { item.textContent = title; });
      return item;
    },
  } as never), target);
  const take = (ids: readonly string[]) => {
    const counts = Object.fromEntries(ids.map(id => [id, runs.get(id) ?? 0]));
    runs.clear();
    return counts;
  };
  const text = () => Object.fromEntries([...target.querySelectorAll('li')].map(item => [item.dataset.id, item.textContent]));
  return { take, text, dispose };
}

/** Wait for an asynchronous RxDB emission to reach the rendered rows. */
async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 50 && !condition(); attempt += 1) await settle(2);
  expect(condition()).toBe(true);
}

beforeEach(async () => {
  for (const database of await indexedDB.databases()) {
    await new Promise(resolve => {
      const request = indexedDB.deleteDatabase(database.name!);
      request.onsuccess = request.onerror = request.onblocked = resolve;
    });
  }
  document.body.innerHTML = '';
});
afterEach(() => { document.body.innerHTML = ''; });

describe('keyed row computations', () => {
  it('keep unrelated playground rows at zero across insert, move, remove and undo', async () => {
    const system = createSolidSystem({ id: 'row-computations', modules: applicationModules });
    try {
      const app = await createApplication(system, { adapter: null });
      for (const title of ['Alpha', 'Beta', 'Gamma']) await app.focus.commands.add(title);
      const id = (title: string) => app.focus.pending().find(row => row.title === title)!.id;
      const [alpha, beta, gamma] = [id('Alpha'), id('Beta'), id('Gamma')];
      const view = renderKeyedRows(app.focus.pending);
      await settle();
      expect(view.take([alpha, beta, gamma])).toEqual({ [alpha]: 1, [beta]: 1, [gamma]: 1 });

      await app.focus.commands.add('Delta');
      await settle();
      expect(view.take([alpha, beta, gamma])).toEqual({ [alpha]: 0, [beta]: 0, [gamma]: 0 });

      await app.focus.commands.toggle(alpha);
      await settle();
      expect(view.take([beta, gamma])).toEqual({ [beta]: 0, [gamma]: 0 });

      await app.focus.commands.remove(id('Delta'));
      await settle();
      expect(view.take([beta, gamma])).toEqual({ [beta]: 0, [gamma]: 0 });

      await app.focus.commands.undo();
      await settle();
      expect(view.take([beta, gamma])).toEqual({ [beta]: 0, [gamma]: 0 });
      view.dispose();
    } finally {
      await system.dispose();
    }
  });

  it('retains Solid row identity and recomputes only the changed title field', async () => {
    const system = createSolidSystem({ id: 'solid-row-title-change' });
    interface Rows {
      readonly rows: Accessor<readonly Row[]>;
      readonly commands: { rename(id: string, title: string): Promise<void>; toggle(id: string): Promise<void> };
    }
    const provider = defineFeatureModule<FeatureType.Feature, Record<string, never>, Rows>({
      id: 'solid-rows', kind: FeatureType.Feature, title: 'Solid rows', description: 'Owns rows in Solid.',
      contract: { inputs: {}, exports: { rows: 'Read-only rows.', commands: 'Named mutations.' } },
      load: async () => (_inputs, scope) => {
        const owner = createSolidDomain<Row>(scope, { generation: 'rows' });
        owner.commit({ gestureId: 'seed', label: 'Seed rows', writes: ['a', 'b', 'c'].map(id => ({
          kind: 'put', document: { id, title: id.toUpperCase(), done: false },
        })) });
        return {
          rows: () => owner.view.rows,
          commands: scope.commands({
            rename: async (id: string, title: string) => {
              const row = owner.view.rows.find(item => item.id === id)!;
              owner.commit({ gestureId: 'rename', label: 'Rename row', writes: [{ kind: 'put', document: { ...row, title } }] });
            },
            toggle: async (id: string) => {
              const row = owner.view.rows.find(item => item.id === id)!;
              owner.commit({ gestureId: 'toggle', label: 'Toggle row', writes: [{ kind: 'put', document: { ...row, done: !row.done } }] });
            },
          }),
        };
      },
    });
    try {
      const rows = (await system.start(provider, {})).exports;
      const original = rows.rows()[1];
      const view = renderKeyedRows(rows.rows);
      await settle();
      view.take(['a', 'b', 'c']);

      await rows.commands.rename('b', 'B renamed');
      await settle();
      expect(rows.rows()[1]).toBe(original);
      expect(view.text()).toEqual({ a: 'A', b: 'B renamed', c: 'C' });
      expect(view.take(['a', 'b', 'c'])).toEqual({ a: 0, b: 1, c: 0 });

      // Changing the same record's other field leaves its title computation idle.
      await rows.commands.toggle('b');
      await settle();
      expect(rows.rows()[1]).toBe(original);
      expect(view.take(['a', 'b', 'c'])).toEqual({ a: 0, b: 0, c: 0 });
      view.dispose();
    } finally { await system.dispose(); }
  });

  it('retain legacy RxDB-owned row identity when one title changes', async () => {
    const owner = createScope();
    const system = createSolidSystem({ id: 'row-title-change' });
    try {
      const store = await createLocalStore<{ notes: Row }>({
        name: `row-title-change-${crypto.randomUUID()}`,
        scope: owner,
        storage: getRxStorageMemory(),
        schemas: { notes: {
          version: 0, primaryKey: 'id', type: 'object',
          properties: { id: { type: 'string', maxLength: 100 }, title: { type: 'string' }, done: { type: 'boolean' } },
          required: ['id', 'title', 'done'],
        } },
      });
      const put = (id: string, title: string) => ({ collection: 'notes' as const, kind: 'put' as const, document: { id, title, done: false } });
      await store.batch({ gestureId: 'seed', writes: [put('a', 'A'), put('b', 'B'), put('c', 'C')] });
      const query = await store.query('notes', { sort: [{ id: 'asc' }] });
      const reader = await system.start(defineFeatureModule<FeatureType.Store, Record<string, never>, { rows: Accessor<readonly Row[]> }>({
        id: 'notes-reader', kind: FeatureType.Store, title: 'Notes reader', description: 'Exposes notes as an accessor.',
        contract: { inputs: {}, exports: { rows: 'Notes ordered by id.' } },
        load: async () => (_inputs, scope) => ({ rows: moduleAccessor(scope, query) }),
      }), {});
      const view = renderKeyedRows(reader.exports.rows);
      await settle();
      view.take(['a', 'b', 'c']);

      await store.batch({ gestureId: 'rename', writes: [put('b', 'B renamed')] });
      await settle();
      expect(view.take(['a', 'b', 'c'])).toEqual({ a: 0, b: 1, c: 0 });

      await store.batch({ gestureId: 'insert', writes: [put('d', 'D')] });
      await settle();
      expect(view.take(['a', 'b', 'c'])).toEqual({ a: 0, b: 0, c: 0 });
      view.dispose();
    } finally {
      await system.dispose();
      await owner.dispose();
    }
  });

  it('retain legacy RxDB-owned row identity for incoming writes outside store.batch', async () => {
    const owner = createScope();
    const system = createSolidSystem({ id: 'row-incoming' });
    try {
      const store = await createLocalStore<{ notes: Row }>({
        name: `row-incoming-${crypto.randomUUID()}`,
        scope: owner,
        storage: getRxStorageMemory(),
        schemas: { notes: {
          version: 0, primaryKey: 'id', type: 'object',
          properties: { id: { type: 'string', maxLength: 100 }, title: { type: 'string' }, done: { type: 'boolean' } },
          required: ['id', 'title', 'done'],
        } },
      });
      // Seed through the write gate; the writes under test bypass it.
      await store.batch({ gestureId: 'seed', writes: ['a', 'b', 'c'].map(id => ({
        collection: 'notes' as const, kind: 'put' as const, document: { id, title: id.toUpperCase(), done: false },
      })) });
      const query = await store.query('notes', { sort: [{ id: 'asc' }] });
      const reader = await system.start(defineFeatureModule<FeatureType.Store, Record<string, never>, { rows: Accessor<readonly Row[]> }>({
        id: 'incoming-reader', kind: FeatureType.Store, title: 'Incoming reader', description: 'Exposes notes as an accessor.',
        contract: { inputs: {}, exports: { rows: 'Notes ordered by id.' } },
        load: async () => (_inputs, scope) => ({ rows: moduleAccessor(scope, query) }),
      }), {});
      const view = renderKeyedRows(reader.exports.rows);
      await settle();
      view.take(['a', 'b', 'c']);
      const history = store.history.state.read();
      // A local RxDB write, as replication would apply it: no command, no store.batch.
      const collection = getCollection(store, 'notes');

      await collection.incrementalUpsert({ id: 'b', title: 'B from remote', done: false });
      await until(() => view.text().b === 'B from remote');
      expect(reader.exports.rows().find(row => row.id === 'b')?.title).toBe('B from remote');
      expect(view.take(['a', 'b', 'c'])).toEqual({ a: 0, b: 1, c: 0 });

      await collection.insert({ id: 'd', title: 'D from remote', done: false });
      await until(() => view.text().d === 'D from remote');
      expect(view.take(['a', 'b', 'c'])).toEqual({ a: 0, b: 0, c: 0 });

      await (await collection.findOne('c').exec())!.remove();
      await until(() => !('c' in view.text()));
      expect(view.take(['a', 'b'])).toEqual({ a: 0, b: 0 });

      // Incoming writes are not local gestures: history is unchanged.
      expect(store.history.state.read()).toBe(history);
      view.dispose();
    } finally {
      await system.dispose();
      await owner.dispose();
    }
  });
});
