import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { createScope } from '@vibespa/core';
import type { Scope } from '@vibespa/contracts';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import type { RxJsonSchema } from 'rxdb';
import { getCollection } from './adapter.js';
import { createLocalStore } from './index.js';

interface Note { id: string; title: string; done: boolean }
interface Rows { notes: Note; archive: Note }
const schema: RxJsonSchema<Note> = {
  version: 0, primaryKey: 'id', type: 'object',
  properties: { id: { type: 'string', maxLength: 100 }, title: { type: 'string' }, done: { type: 'boolean' } },
  required: ['id', 'title', 'done'], additionalProperties: false,
};
const scopes: Scope[] = [];
let sequence = 0;
const open = () => { const scope = createScope(); scopes.push(scope); return createLocalStore<Rows>({
  name: `identity${Date.now()}${sequence++}`, schemas: { notes: schema, archive: schema }, scope, storage: getRxStorageMemory(),
}); };
const put = (collection: 'notes' | 'archive', id: string, title: string) =>
  ({ collection, kind: 'put' as const, document: { id, title, done: false } });
afterEach(async () => { await Promise.all(scopes.splice(0).map(scope => scope.dispose())); });

describe('read identity follows RxDB identity', () => {
  it('returns the same result until RxDB reports a changed result set', async () => {
    const store = await open();
    await store.batch({ gestureId: 'seed', writes: [put('notes', 'a', 'A'), put('notes', 'b', 'B')] });
    const notes = await store.query('notes', { sort: [{ id: 'asc' }] });
    expect(notes.read()).toBe(notes.read());
    const emissions: unknown[] = [];
    const stop = notes.subscribe(value => emissions.push(value));
    await store.batch({ gestureId: 'elsewhere', writes: [put('archive', 'x', 'X')] });
    expect(emissions).toHaveLength(0);
    stop();
  });

  it('keeps unchanged rows and replaces only a changed row', async () => {
    const store = await open();
    await store.batch({ gestureId: 'seed', writes: [put('notes', 'a', 'A'), put('notes', 'b', 'B')] });
    const notes = await store.query('notes', { sort: [{ id: 'asc' }] });
    const document = await store.document('notes', 'a');
    const [a1, b1] = notes.read();
    const single1 = document.read();
    await store.batch({ gestureId: 'rename', writes: [put('notes', 'b', 'B2')] });
    const [a2, b2] = notes.read();
    expect(a2).toBe(a1);
    expect(b2).not.toBe(b1);
    expect(b2?.title).toBe('B2');
    expect(document.read()).toBe(single1);
    expect(Object.isFrozen(notes.read())).toBe(true);
    expect(Object.isFrozen(a2)).toBe(true);
  });

  it('still notifies existing subscribers after a public read() observes a new result first', async () => {
    const store = await open();
    await store.batch({ gestureId: 'seed', writes: [put('notes', 'a', 'A')] });
    // Delay RxDB's live emission so the store's post-write refresh is observed by
    // read() strictly before subscribers are notified.
    (getCollection(store, 'notes') as unknown as { liveQueryUpdateThrottleTime: number }).liveQueryUpdateThrottleTime = 40;
    const notes = await store.query('notes', { sort: [{ id: 'asc' }] });
    const emissions: unknown[] = [];
    const stop = notes.subscribe(value => emissions.push(value));
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(emissions).toHaveLength(0);
    await store.batch({ gestureId: 'add', writes: [put('notes', 'b', 'B')] });
    // The batch refreshed the query, so read() already returns the new result.
    const observed = notes.read();
    expect(observed.map(row => row.id)).toEqual(['a', 'b']);
    expect(emissions).toHaveLength(0);
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(emissions).toEqual([observed]);
    expect(emissions[0]).toBe(observed);
    stop();
  });
});
