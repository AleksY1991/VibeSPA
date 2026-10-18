import { createRxDatabase, type RxCollection } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { BehaviorSubject, Subject } from 'rxjs';
import { createRoot, flush, type Accessor } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import {
  beginRxBatch, bindRxDocument, bindRxField, bindRxValue, cachedRxDocuments,
  createSolidRxReactivityFactory, forgetRxPublication, isRxBatchActive, publishRxValue,
  SolidRxReactivityFactory, waitForRxBatches, type SolidRxReactivityLambda,
} from '@vibespa/solid/rxdb';
import { beginRxBatch as beginPublicBatch } from '@vibespa/solid/rxdb-batch';

describe('native RxDB Solid bindings', () => {
  it('retains native values, accepts synchronous emissions, and releases its subscription', () => {
    const initial = {};
    const first = {};
    const next = {};
    const observable = new BehaviorSubject(first);
    const mounted = createRoot(dispose => ({
      read: SolidRxReactivityFactory.fromObservable(observable, initial, {} as never), dispose,
    }));
    flush();
    expect(mounted.read()).toBe(first);
    expect(observable.observed).toBe(true);
    observable.next(next);
    flush();
    expect(mounted.read()).toBe(next);
    mounted.dispose();
    expect(observable.observed).toBe(false);
  });

  it('rejects ownerless subscriptions', () => {
    const observable = new Subject<number>();
    expect(() => SolidRxReactivityFactory.fromObservable(observable, 0, {} as never))
      .toThrow('RxDB $$ bindings must be created inside a Solid owner');
    expect(observable.observed).toBe(false);
  });

  it('preserves callable initial and emitted values without invoking them', () => {
    const initial = vi.fn(() => 1);
    const next = vi.fn(() => 2);
    const observable = new Subject<typeof initial>();
    const mounted = createRoot(dispose => ({
      read: SolidRxReactivityFactory.fromObservable(observable, initial, {} as never), dispose,
    }));
    expect(mounted.read()).toBe(initial);
    observable.next(next);
    flush();
    expect(mounted.read()).toBe(next);
    expect(initial).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    mounted.dispose();
  });

  it('supports configurable equality while the default accepts every native reference', () => {
    const first = { id: 1 };
    const equivalent = { id: 1 };
    const changed = { id: 2 };
    const observable = new Subject<typeof first>();
    const equals = vi.fn((left: unknown, right: unknown) =>
      (left as typeof first).id === (right as typeof first).id);
    const custom = createSolidRxReactivityFactory({ name: 'product.rows', equals });
    const mounted = createRoot(dispose => ({
      custom: custom.fromObservable(observable, first, {} as never),
      standard: SolidRxReactivityFactory.fromObservable(observable, first, {} as never), dispose,
    }));
    observable.next(equivalent);
    flush();
    expect(mounted.custom()).toBe(first);
    expect(mounted.standard()).toBe(equivalent);
    expect(equals).toHaveBeenCalledWith(first, equivalent);
    observable.next(changed);
    flush();
    expect(mounted.custom()).toBe(changed);
    expect(mounted.standard()).toBe(changed);
    mounted.dispose();
  });

  it('reads each native getter once and preserves all document readiness types', () => {
    const loading = Symbol('loading');
    const value: Accessor<string | null | undefined | typeof loading> = () => loading;
    const getter = vi.fn(() => value);
    const source = { get $$() { return getter(); } };
    const read = bindRxValue(source);
    expect(read).toBe(value);
    expect(read()).toBe(loading);
    expect(read()).toBe(loading);
    expect(getter).toHaveBeenCalledTimes(1);
    const document: Accessor<string | null | undefined | typeof loading> = bindRxDocument(source);
    expect(document).toBe(value);
    const field = { get$$: vi.fn(() => value) };
    expect(bindRxField(field, 'label')).toBe(value);
    expect(field.get$$).toHaveBeenCalledExactlyOnceWith('label');
  });

  it('uses only the native revision cache and respects cached tombstones', () => {
    const row = { _deleted: false };
    const document = {};
    const cache = {
      getLatestDocumentDataIfExists: vi.fn(() => row as typeof row | undefined),
      getCachedRxDocument: vi.fn(() => document),
    };
    expect(cachedRxDocuments(cache, 'known')).toEqual([document]);
    cache.getLatestDocumentDataIfExists.mockReturnValue({ _deleted: true });
    expect(cachedRxDocuments(cache, 'deleted')).toEqual([]);
    cache.getLatestDocumentDataIfExists.mockReturnValue(undefined);
    expect(cachedRxDocuments(cache, 'unknown')).toBeUndefined();
    expect(cache.getCachedRxDocument).toHaveBeenCalledTimes(1);
  });

  it('drops pending emissions when their Solid owner is disposed', () => {
    const database = {};
    const observable = new Subject<number>();
    const mounted = createRoot(dispose => ({
      read: SolidRxReactivityFactory.fromObservable(observable, 0, database as never), dispose,
    }));
    const finish = beginRxBatch(database);
    observable.next(1);
    flush();
    expect(mounted.read()).toBe(0);
    mounted.dispose();
    expect(observable.observed).toBe(false);
    finish();
    flush();
    expect(mounted.read()).toBe(0);
  });

  it('keeps native query/document identity and follows command, external, and batched writes', async () => {
    type Note = { id: string; label: string };
    const database = await createRxDatabase<{
      notes: RxCollection<Note, object, object, unknown, SolidRxReactivityLambda>;
    }, unknown, unknown, SolidRxReactivityLambda>({
      name: `solid_rx_${crypto.randomUUID().replaceAll('-', '')}`,
      storage: getRxStorageMemory(), multiInstance: false,
      reactivity: SolidRxReactivityFactory,
    });
    let dispose = () => {};
    let finish = () => {};
    try {
      await database.addCollections({ notes: { schema: {
        version: 0, primaryKey: 'id', type: 'object',
        properties: { id: { type: 'string', maxLength: 100 }, label: { type: 'string' } },
        required: ['id', 'label'], additionalProperties: false,
      } } });
      const inserted = await database.notes.insert({ id: 'note', label: 'Initial' });
      const query = database.notes.find();
      const mounted = createRoot(release => ({
        rows: bindRxValue(query),
        document: bindRxDocument(database.notes.findOne('note')),
        label: bindRxField<string>(inserted, 'label'), dispose: release,
      }));
      dispose = mounted.dispose;
      await vi.waitFor(() => {
        flush();
        expect(mounted.rows()).toHaveLength(1);
        expect(mounted.document()).toBe(inserted);
      });
      expect(mounted.rows()![0]).toBe((await query.exec())[0]);

      // A UI command writes the native RxDB document; subscriptions publish it back.
      const rename = (label: string) => inserted.getLatest().incrementalPatch({ label });
      await rename('Command');
      await vi.waitFor(() => { flush(); expect(mounted.label()).toBe('Command'); });
      expect(mounted.document()!.get('label')).toBe('Command');

      // Replication and other writers enter through the same RxDB change stream.
      await database.notes.bulkUpsert([{ id: 'note', label: 'External' }]);
      await vi.waitFor(() => { flush(); expect(mounted.label()).toBe('External'); });

      finish = beginRxBatch(database);
      await rename('First write');
      await rename('Final write');
      await query.exec();
      flush();
      expect(mounted.label()).toBe('External');
      expect(mounted.rows()![0]!.get('label')).toBe('External');
      finish();
      await vi.waitFor(() => {
        flush();
        expect(mounted.label()).toBe('Final write');
        expect(mounted.rows()![0]!.get('label')).toBe('Final write');
      });
      expect(query.refCount$.observed).toBe(true);
      dispose();
      expect(query.refCount$.observed).toBe(false);
    } finally {
      finish();
      dispose();
      await database.close();
    }
  });
});

describe('RxDB publication batches', () => {
  it('shares publication state across both public package subpaths', () => {
    const database = {};
    const observable = new Subject<number>();
    const mounted = createRoot(dispose => ({
      read: SolidRxReactivityFactory.fromObservable(observable, 0, database as never), dispose,
    }));
    const finish = beginPublicBatch(database);
    try {
      observable.next(1);
      flush();
      expect(mounted.read()).toBe(0);
      expect(isRxBatchActive(database)).toBe(true);
      finish();
      flush();
      expect(mounted.read()).toBe(1);
    } finally {
      finish();
      mounted.dispose();
    }
  });

  it('nests, keeps each binding latest, and releases each lease once', () => {
    const database = {};
    const first = {};
    const second = {};
    const published: number[] = [];
    const outer = beginRxBatch(database);
    const inner = beginRxBatch(database);
    publishRxValue(database, first, () => published.push(1));
    publishRxValue(database, first, () => published.push(2));
    publishRxValue(database, second, () => published.push(3));
    outer();
    outer();
    expect(isRxBatchActive(database)).toBe(true);
    expect(published).toEqual([]);
    inner();
    inner();
    expect(isRxBatchActive(database)).toBe(false);
    expect(published).toEqual([2, 3]);
  });

  it('isolates databases and allows pending bindings to be forgotten', async () => {
    const firstDatabase = {};
    const secondDatabase = {};
    const disposed = {};
    const publish = vi.fn();
    const finish = beginRxBatch(firstDatabase);
    publishRxValue(firstDatabase, disposed, publish);
    forgetRxPublication(firstDatabase, disposed);
    publishRxValue(secondDatabase, {}, publish);
    expect(publish).toHaveBeenCalledTimes(1);
    await waitForRxBatches(secondDatabase);
    finish();
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('waits for the final nested release and for a batch started during publication', async () => {
    const database = {};
    const finish = beginRxBatch(database);
    const nested = beginRxBatch(database);
    let followup = () => {};
    publishRxValue(database, {}, () => { followup = beginRxBatch(database); });
    let settled = false;
    const waiting = waitForRxBatches(database).then(() => { settled = true; });
    finish();
    await Promise.resolve();
    expect(settled).toBe(false);
    nested();
    await Promise.resolve();
    expect(settled).toBe(false);
    followup();
    await waiting;
    expect(settled).toBe(true);
  });

  it('publishes remaining bindings and releases waiters after a publication failure', async () => {
    const database = {};
    const finish = beginRxBatch(database);
    const failure = new Error('publish failed');
    const next = vi.fn();
    publishRxValue(database, {}, () => { throw failure; });
    publishRxValue(database, {}, next);
    const waiting = waitForRxBatches(database);
    expect(finish).toThrow(failure);
    expect(next).toHaveBeenCalledOnce();
    await waiting;
    expect(isRxBatchActive(database)).toBe(false);
    finish();
  });
});
