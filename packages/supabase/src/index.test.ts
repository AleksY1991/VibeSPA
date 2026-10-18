import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Cleanup, Scope } from '@vibespa/contracts';
import { createScope } from '@vibespa/core/scope';
import type { LocalStore } from '@vibespa/local-first';
import type { RxReplicationWriteToMasterRow, WithDeleted } from 'rxdb';
import { syncSupabase } from './index.js';

const stock = vi.hoisted(() => ({ replicate: vi.fn(), collection: vi.fn() }));
vi.mock('rxdb/plugins/replication-supabase', () => ({ replicateSupabase: stock.replicate }));
vi.mock('@vibespa/local-first/adapter', () => ({ getCollection: stock.collection }));

interface Note { id: string; text: string; tags: string[] }
interface Rows { notes: Note }
let auth: ReturnType<typeof authClient>;
let client: SupabaseClient;
const store = {} as LocalStore<Rows>;
const table = { collection: 'notes', tableName: 'notes' } as const;

function authClient(userId: string | null = 'account-a') {
  let notify: ((event: string, session: { user: { id: string } } | null) => void) | undefined;
  const unsubscribe = vi.fn();
  const getSession = vi.fn(async () => ({ data: { session: userId ? { user: { id: userId } } : null }, error: null }));
  const onAuthStateChange = vi.fn((listener: typeof notify) => {
    notify = listener;
    return { data: { subscription: { unsubscribe } } };
  });
  return {
    client: { auth: { getSession, onAuthStateChange } } as unknown as SupabaseClient,
    getSession, onAuthStateChange, unsubscribe,
    change(id: string | null, event = 'SIGNED_IN') { notify?.(event, id ? { user: { id } } : null); },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function scope(): Scope {
  const controller = new AbortController();
  const cleanups = new Set<Cleanup>();
  let disposed: Promise<void> | undefined;
  return {
    signal: controller.signal,
    defer(cleanup) {
      if (controller.signal.aborted) throw new Error('Scope disposed.');
      cleanups.add(cleanup);
      return () => { cleanups.delete(cleanup); };
    },
    dispose() {
      if (disposed) return disposed;
      controller.abort();
      disposed = Promise.all([...cleanups].reverse().map(cleanup => cleanup())).then(() => undefined);
      return disposed;
    },
  };
}

function subject<T>() {
  const listeners = new Set<(value: T) => void>();
  return {
    subscribe(listener: (value: T) => void) {
      listeners.add(listener);
      return { unsubscribe() { listeners.delete(listener); } };
    },
    next(value: T) { for (const listener of [...listeners]) listener(value); },
    count: () => listeners.size,
  };
}

function replica() {
  const initial = deferred<void>();
  const handler = vi.fn(async (_rows: RxReplicationWriteToMasterRow<Note>[]): Promise<WithDeleted<Note>[]> => []);
  return {
    initial,
    push: { handler },
    active$: subject<boolean>(),
    error$: subject<unknown>(),
    start: vi.fn(async () => undefined),
    cancel: vi.fn(async (): Promise<void> => undefined),
    awaitInitialReplication: vi.fn(() => initial.promise),
  };
}

async function configure(state = replica(), lifetime = scope()) {
  stock.replicate.mockReturnValue(state);
  return { state, lifetime, sync: await syncSupabase({ store, scope: lifetime, accountId: 'account-a', client, tables: [table] }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  auth = authClient();
  client = auth.client;
  stock.collection.mockReturnValue({ database: { multiInstance: false } });
});

describe('stock Supabase adapter wiring', () => {
  it('uses the supplied client and automatic pull/push with stable account checkpoint identifiers', async () => {
    const first = await configure();
    const options = stock.replicate.mock.calls[0]![0] as Record<string, unknown>;
    expect(stock.collection).toHaveBeenCalledWith(store, 'notes');
    expect(options).toMatchObject({
      client, tableName: 'notes', modifiedField: '_modified', deletedField: '_deleted',
      live: true, autoStart: false, waitForLeadership: false,
      pull: { batchSize: 100 }, push: { batchSize: 100 }, retryTime: 5_000,
    });

    await vi.waitFor(() => expect(first.state.start).toHaveBeenCalledOnce());
    const firstIdentifier = options.replicationIdentifier;
    await first.sync.cancel();
    const second = await configure();
    expect(stock.replicate.mock.calls[1]![0].replicationIdentifier).toBe(firstIdentifier);
    await second.sync.cancel();
    const third = await syncSupabase({ store, scope: scope(), accountId: 'account-b', client: authClient('account-b').client, tables: [table] });
    expect(stock.replicate.mock.calls[2]![0].replicationIdentifier).not.toBe(firstIdentifier);
    await third.cancel();
  });

  it('reports initial completion, activity, and refusal errors without claiming online status', async () => {
    const { sync, state } = await configure();
    const observed = vi.fn();
    const stop = sync.status.subscribe(observed);
    expect(observed).not.toHaveBeenCalled();
    expect(sync.status.read()).toMatchObject({ phase: 'starting', active: false, initialSyncComplete: false });
    await vi.waitFor(() => expect(sync.status.read().phase).toBe('running'));
    state.active$.next(true);
    expect(sync.status.read().active).toBe(true);
    const refusal = { code: '23514', message: 'CHECK constraint refused the row' };
    state.error$.next(refusal);
    expect(sync.status.read().errors).toEqual([{ collection: 'notes', tableName: 'notes', error: refusal }]);
    state.active$.next(false);
    expect(sync.status.read().errors[0]!.error).toBe(refusal);
    expect(sync.status.read().initialSyncComplete).toBe(false);
    state.initial.resolve();
    await sync.awaitInitialSync();
    expect(sync.status.read().initialSyncComplete).toBe(true);
    stop();
    await sync.cancel();
  });

  it('preserves typed local and conflict rows while encoding cloned stock HTTP/CAS requests', async () => {
    const state = replica();
    const stockPush = state.push.handler;
    const remote: WithDeleted<Note> = { id: 'n1', text: 'remote', tags: ['remote'], _deleted: false };
    stockPush.mockResolvedValue([remote]);
    stock.replicate.mockReturnValue(state);
    const encodeRequest = vi.fn((document: Readonly<WithDeleted<Note>>) => {
      document.tags.push('request-only');
      return { ...document, tags: `{${document.tags.join(',')}}` };
    });
    const sync = await syncSupabase({ store, scope: scope(), accountId: 'account-a', client, tables: [{ ...table, encodeRequest }] });
    const local: WithDeleted<Note> = { id: 'n1', text: 'local', tags: ['a'], _deleted: false };
    const master: WithDeleted<Note> = { id: 'n1', text: 'old', tags: ['a', 'b'], _deleted: false };
    const result = await state.push.handler([{ newDocumentState: local, assumedMasterState: master }]);
    expect(stockPush).toHaveBeenCalledWith([{
      newDocumentState: { ...local, tags: '{a,request-only}' },
      assumedMasterState: { ...master, tags: '{a,b,request-only}' },
    }]);
    expect(local.tags).toEqual(['a']);
    expect(master.tags).toEqual(['a', 'b']);
    expect(result[0]).toBe(remote);
    expect(remote.tags).toEqual(['remote']);
    expect(encodeRequest).toHaveBeenCalledTimes(2);
    await sync.cancel();
  });

  it('retains the configured modified column and batching', async () => {
    const state = replica();
    stock.replicate.mockReturnValue(state);
    const sync = await syncSupabase({
      store, scope: scope(), accountId: 'account-a', client, namespace: 'backend-one', batchSize: 50, retryTime: 2_000,
      tables: [{ ...table, modifiedField: 'updated_at' }],
    });
    expect(stock.replicate.mock.calls[0]![0]).toMatchObject({
      modifiedField: 'updated_at', deletedField: '_deleted', retryTime: 2_000,
      pull: { batchSize: 50 }, push: { batchSize: 50 },
    });
    await sync.cancel();
  });
});

describe('account lifetime', () => {
  it('rejects unauthenticated and mismatched clients before constructing replication', async () => {
    const unauthenticated = authClient(null);
    await expect(syncSupabase({
      store, scope: scope(), accountId: 'account-a', client: unauthenticated.client, tables: [table],
    })).rejects.toThrow(/authenticated session/);
    expect(unauthenticated.unsubscribe).toHaveBeenCalledOnce();
    const mismatched = authClient('account-b');
    await expect(syncSupabase({
      store, scope: scope(), accountId: 'account-a', client: mismatched.client, tables: [table],
    })).rejects.toThrow(/does not match/);
    expect(mismatched.unsubscribe).toHaveBeenCalledOnce();
    expect(stock.replicate).not.toHaveBeenCalled();
  });

  it('keeps same-account token refresh running and cancels on signout or account replacement', async () => {
    const first = await configure();
    auth.change('account-a', 'TOKEN_REFRESHED');
    expect(first.state.cancel).not.toHaveBeenCalled();
    auth.change('account-b');
    await first.sync.cancel();
    expect(first.state.cancel).toHaveBeenCalledOnce();
    expect(auth.unsubscribe).toHaveBeenCalledOnce();
    expect(first.sync.status.read().phase).toBe('stopped');
    const second = await configure();
    auth.change(null, 'SIGNED_OUT');
    await second.sync.cancel();
    expect(second.state.cancel).toHaveBeenCalledOnce();
  });

  it('cancels once, rejects pending initial sync, and removes state subscriptions on scope disposal', async () => {
    const { sync, state, lifetime } = await configure();
    await vi.waitFor(() => expect(state.start).toHaveBeenCalledOnce());
    const observed = vi.fn();
    sync.status.subscribe(observed);
    await lifetime.dispose();
    await expect(sync.awaitInitialSync()).rejects.toMatchObject({ name: 'AbortError' });
    expect(state.cancel).toHaveBeenCalledOnce();
    expect(sync.status.read()).toMatchObject({ phase: 'stopped', active: false, initialSyncComplete: false });
    expect(state.active$.count()).toBe(0);
    expect(state.error$.count()).toBe(0);
    observed.mockClear();
    state.error$.next(new Error('late old account error'));
    state.active$.next(true);
    state.initial.resolve();
    await Promise.resolve();
    expect(observed).not.toHaveBeenCalled();
    await sync.cancel();
    expect(state.cancel).toHaveBeenCalledOnce();
  });

  it('keeps scope cleanup registered until an overlapping explicit cancellation finishes', async () => {
    const state = replica();
    const finished = deferred<void>();
    state.cancel.mockImplementation(() => finished.promise);
    const { sync, lifetime } = await configure(state);
    const cancellation = sync.cancel();
    let disposed = false;
    const disposal = lifetime.dispose().then(() => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);
    finished.resolve();
    await Promise.all([cancellation, disposal]);
    expect(state.cancel).toHaveBeenCalledOnce();
  });

  it('waits for every table cancellation before allowing storage close after a cancellation failure', async () => {
    const lifetime = createScope();
    const closeStorage = vi.fn();
    lifetime.defer(closeStorage);
    const failure = new Error('first replication cancellation failed');
    const first = replica();
    first.cancel.mockRejectedValue(failure);
    const second = replica();
    const secondFinished = deferred<void>();
    second.cancel.mockImplementation(() => secondFinished.promise);
    stock.replicate.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const sync = await syncSupabase({
      store: {} as LocalStore<{ notes: Note; archive: Note }>, scope: lifetime, accountId: 'account-a', client,
      tables: [table, { collection: 'archive', tableName: 'archive' }],
    });
    const cancellation = sync.cancel();
    let cancellationSettled = false;
    const canceledResult = cancellation.then(
      () => { cancellationSettled = true; return null; },
      error => { cancellationSettled = true; return error as unknown; },
    );
    const disposalResult = lifetime.dispose().catch((error: unknown) => error);
    expect(sync.cancel()).toBe(cancellation);
    await new Promise<void>(resolve => { setImmediate(resolve); });
    expect(first.cancel).toHaveBeenCalledOnce();
    expect(second.cancel).toHaveBeenCalledOnce();
    expect(cancellationSettled).toBe(false);
    expect(closeStorage).not.toHaveBeenCalled();
    secondFinished.resolve();
    const [cancellationError, disposalError] = await Promise.all([canceledResult, disposalResult]);
    expect(cancellationError).toBeInstanceOf(AggregateError);
    expect((cancellationError as AggregateError).errors).toEqual([failure]);
    expect(disposalError).toBeInstanceOf(AggregateError);
    expect((disposalError as AggregateError).errors).toEqual([cancellationError]);
    expect(closeStorage).toHaveBeenCalledOnce();
  });

  it('finishes cancellation and notifies remaining subscribers when a status observer throws', async () => {
    const { sync, state, lifetime } = await configure();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const observed = vi.fn();
    try {
      sync.status.subscribe(() => { throw new Error('broken observer'); });
      sync.status.subscribe(observed);
      await lifetime.dispose();
      expect(state.cancel).toHaveBeenCalledOnce();
      expect(observed).toHaveBeenCalledWith(expect.objectContaining({ phase: 'stopped' }));
      expect(logged).toHaveBeenCalled();
    } finally { logged.mockRestore(); }
  });

  it('never starts after its account scope ends while waiting for database leadership', async () => {
    const leadership = deferred<void>();
    stock.collection.mockReturnValue({ database: { multiInstance: true, waitForLeadership: () => leadership.promise } });
    const { sync, state, lifetime } = await configure();
    await lifetime.dispose();
    leadership.resolve();
    await Promise.resolve();
    expect(state.start).not.toHaveBeenCalled();
    await expect(sync.awaitInitialSync()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('reports startup failures through readiness and observable errors', async () => {
    const state = replica();
    const failure = new Error('realtime channel startup failed');
    state.start.mockRejectedValue(failure);
    const { sync } = await configure(state);
    await expect(sync.awaitInitialSync()).rejects.toBe(failure);
    expect(sync.status.read().errors).toEqual([{ collection: 'notes', tableName: 'notes', error: failure }]);
    await sync.cancel();
  });

  it('rejects invalid configurations before constructing any replication', async () => {
    const lifetime = scope();
    await lifetime.dispose();
    await expect(syncSupabase({ store, scope: lifetime, accountId: 'a', client, tables: [table] })).rejects.toThrow(/scope has ended/);
    await expect(syncSupabase({ store, scope: scope(), accountId: ' ', client, tables: [table] })).rejects.toThrow(/accountId/);
    await expect(syncSupabase({ store, scope: scope(), accountId: 'a', client, tables: [table, table] })).rejects.toThrow(/configured twice/);
    expect(stock.replicate).not.toHaveBeenCalled();
  });
});
