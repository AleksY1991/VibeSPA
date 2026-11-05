import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRxDatabase } from 'rxdb';
import type { RxCollection, RxDatabase, RxJsonSchema } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { defineFeatureModule, external, FeatureType } from '@vibespa/core';
import { createSolidSystem } from '../src/module.js';
import { createSolidDomain } from '../src/domain.js';
import type { DomainOwner } from '../src/domain.js';
import { createRxCollectionDomainAdapter, type RowAdoption } from '../../local-first/src/collectionAdapter.js';

interface Note { id: string; title: string; done: boolean }
const note = (id: string, title = id): Note => ({ id, title, done: false });
const schema: RxJsonSchema<Note> = {
  version: 0, primaryKey: 'id', type: 'object',
  properties: { id: { type: 'string', maxLength: 100 }, title: { type: 'string' }, done: { type: 'boolean' } },
  required: ['id', 'title', 'done'], additionalProperties: false,
};
const databases: Pick<RxDatabase, 'close'>[] = [];
let sequence = 0;
afterEach(async () => { await Promise.all(databases.splice(0).map(database => database.close())); });

async function harness(seed: Note[] = []) {
  const database = await createRxDatabase<{ notes: RxCollection<Note> }>({
    name: `soliddomaincollection${Date.now()}${++sequence}`, storage: getRxStorageMemory(), multiInstance: false,
  });
  databases.push(database);
  await database.addCollections({ notes: { schema } });
  if (seed.length) await database.notes.bulkInsert(seed);
  const adoptions: RowAdoption<Note>[] = [];
  const adapter = createRxCollectionDomainAdapter<Note>({ collection: database.notes, onAdopted: adoption => { adoptions.push(adoption); } });
  const system = createSolidSystem({ id: `collection-${sequence}` });
  let owner!: DomainOwner<Note>;
  const module = defineFeatureModule<FeatureType.Feature, { generation: string }, { readonly owner: DomainOwner<Note> }>({
    id: 'notes', kind: FeatureType.Feature, title: 'Notes', description: 'Owns test notes.',
    contract: { inputs: { generation: 'Session generation.' }, exports: { owner: 'Private test seam.' } },
    load: async () => (inputs, context) => {
      owner = createSolidDomain(context, { generation: inputs.generation, adapter });
      return { owner };
    },
  });
  await system.start(module, { generation: external(`generation-${sequence}`) });
  await owner.settled();
  let gesture = 0;
  const commit = (...rows: Note[]) => owner.commit({ gestureId: `gesture-${++gesture}`, label: 'Edit', writes: rows.map(document => ({ kind: 'put' as const, document })) });
  const durable = async (id: string) => (await database.notes.storageInstance.findDocumentsById([id], true))[0];
  return { database, collection: database.notes, system, owner, commit, durable, adoptions };
}
const titles = (owner: DomainOwner<Note>) => owner.view.rows.map(row => row.title);

describe('Solid owner over a native RxDB collection', () => {
  it('hydrates, persists flat rows, and ignores its own echoes', async () => {
    const test = await harness([note('seed')]);
    expect(titles(test.owner)).toEqual(['seed']);
    test.commit(note('a'));
    await test.owner.settled();
    expect(test.owner.view.delivery()).toEqual({ phase: 'idle', pending: 0, error: null });
    expect(await test.durable('a')).toMatchObject({ ...note('a'), _deleted: false });
    expect(titles(test.owner)).toEqual(['seed', 'a']);
    await test.system.dispose();
    // The adapter never closes the application-owned collection.
    expect(test.database.closed).toBe(false);
    expect(await test.collection.count().exec()).toBe(2);
  });

  it('admits a live foreign write such as a replication pull', async () => {
    const test = await harness();
    await test.collection.insert(note('pulled'));
    await vi.waitFor(() => { expect(titles(test.owner)).toEqual(['pulled']); });
    expect(test.owner.view.history().canUndo).toBe(false);
    await test.system.dispose();
  });

  it('adopts the durable row over a refused local proposal and keeps undo honest', async () => {
    const test = await harness([note('a')]);
    const storage = test.collection.storageInstance;
    const write = storage.bulkWrite.bind(storage);
    storage.bulkWrite = async () => { storage.bulkWrite = write; throw new Error('disk busy'); };
    test.commit(note('a', 'local'));
    await test.owner.settled();
    expect(test.owner.view.delivery().phase).toBe('failed');
    await test.collection.upsert(note('a', 'server'));
    expect(titles(test.owner)).toEqual(['local']);
    test.owner.retry();
    await test.owner.settled();
    expect(titles(test.owner)).toEqual(['server']);
    expect(test.owner.view.delivery()).toEqual({ phase: 'idle', pending: 0, error: null });
    expect(test.adoptions).toEqual([expect.objectContaining({ id: 'a', proposed: note('a', 'local'), adopted: note('a', 'server') })]);
    expect(() => test.owner.undo()).toThrow('History conflict');
    test.commit(note('a', 'later'));
    await test.owner.settled();
    expect(await test.durable('a')).toMatchObject({ title: 'later' });
    expect(titles(test.owner)).toEqual(['later']);
    await test.system.dispose();
  });
});
