import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Scope } from '@vibespa/contracts';
import { createScope } from '@vibespa/core/scope';
import type { RxCollection, RxReplicationWriteToMasterRow, WithDeleted } from 'rxdb';
import { syncSupabaseCollections, type SupabaseConflict } from './collections.js';

const stock = vi.hoisted(() => ({ replicate: vi.fn() }));
vi.mock('rxdb/plugins/replication-supabase', () => ({ replicateSupabase: stock.replicate }));

interface Intention { id: string; title: string; done: boolean }
interface Rows { intentions: Intention }
type Options = Record<string, unknown> & {
  replicationIdentifier: string;
  pull: { batchSize: number; modifier?: (row: Record<string, unknown>) => WithDeleted<Intention> };
};
const table = { collection: 'intentions', tableName: 'intentions', serverColumns: ['owner_id'] } as const;
const collection = {
  database: { multiInstance: false },
  schema: { primaryPath: 'id', jsonSchema: { properties: { id: {}, title: {}, done: {} } } },
} as unknown as RxCollection<Intention>;
const collections = { intentions: collection };

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
  const handler = vi.fn(async (_rows: RxReplicationWriteToMasterRow<Intention>[]): Promise<WithDeleted<Intention>[]> => []);
  return {
    push: { handler },
    active$: subject<boolean>(),
    error$: subject<unknown>(),
    conflict$: subject<{ input: { newDocumentState: unknown; realMasterState: unknown }; output: unknown }>(),
    start: vi.fn(async () => undefined),
    cancel: vi.fn(async (): Promise<void> => undefined),
    awaitInitialReplication: vi.fn(() => new Promise<void>(() => undefined)),
  };
}
function client(userId: string | null = 'account-a'): SupabaseClient {
  return { auth: {
    getSession: async () => ({ data: { session: userId ? { user: { id: userId } } : null }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
  } } as unknown as SupabaseClient;
}
/** supabase-js replaces `auth` with this throwing Proxy when `accessToken` is set. */
function accessTokenClient(): SupabaseClient {
  return { auth: new Proxy({}, { get: (_, prop) => {
    throw new Error(`Supabase Client is configured with the accessToken option, accessing supabase.auth.${String(prop)} is not possible`);
  } }) } as unknown as SupabaseClient;
}
async function start(options:{ scope?: Scope; onConflict?: (conflict: SupabaseConflict) => void } = {}) {
  const state = replica();
  stock.replicate.mockReturnValue(state);
  const sync = await syncSupabaseCollections<Rows>({
    collections, scope: options.scope ?? createScope(), accountId: 'account-a', client: client(),
    tables: [table],
    ...(options.onConflict ? { onConflict: options.onConflict } : {}),
  });
  return { state, sync, options: stock.replicate.mock.calls.at(-1)![0] as Options };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('Supabase replication into native collections', () => {
  it('replicates the supplied collection with the stable account identifier', async () => {
    const { sync, options } = await start();
    expect(options).toMatchObject({
      collection, tableName: 'intentions', modifiedField: '_modified', deletedField: '_deleted',
      live: true, autoStart: false, replicationIdentifier: 'vibespa:default:account-a:intentions:intentions',
    });
    await sync.cancel();
  });

  it('strips server-only columns from pulled rows without mutating the input', async () => {
    const { sync, options } = await start();
    const pulled = { id: 'a', title: 'A', done: false, owner_id: 'account-a', _deleted: false };
    expect(options.pull.modifier!(pulled)).toEqual({ id: 'a', title: 'A', done: false, _deleted: false });
    expect(pulled.owner_id).toBe('account-a');
    await sync.cancel();
  });

  it('adds no pull modifier when a table has no server columns', async () => {
    stock.replicate.mockReturnValue(replica());
    const sync = await syncSupabaseCollections<Rows>({
      collections, scope: createScope(), accountId: 'account-a', client: client(),
      tables: [{ collection: 'intentions', tableName: 'intentions' }],
    });
    expect((stock.replicate.mock.calls[0]![0] as Options).pull).toEqual({ batchSize: 100 });
    await sync.cancel();
  });

  it('composes encodeRequest inside the conflict stripping wrapper', async () => {
    const state = replica();
    const stockPush = state.push.handler;
    stockPush.mockResolvedValue([{ id: 'a', title: 'server', done: true, owner_id: 'account-a', _deleted: false } as WithDeleted<Intention>]);
    stock.replicate.mockReturnValue(state);
    const sync = await syncSupabaseCollections<Rows>({
      collections, scope: createScope(), accountId: 'account-a', client: client(),
      tables: [{ ...table, encodeRequest: row => ({ ...row, title: `encoded ${row.title}` }) }],
    });
    const local = { id: 'a', title: 'local', done: false, _deleted: false };
    const result = await state.push.handler([{ newDocumentState: local }]);
    expect(stockPush).toHaveBeenCalledWith([{ newDocumentState: { ...local, title: 'encoded local' }, assumedMasterState: undefined }]);
    expect(result).toEqual([{ id: 'a', title: 'server', done: true, _deleted: false }]);
    expect(local.title).toBe('local');
    await sync.cancel();
  });

  it('reports only conflicts whose content changed, contains observer failures, and stops at cancel', async () => {
    const conflicts: SupabaseConflict[] = [];
    const { state, sync } = await start({ onConflict: conflict => { conflicts.push(conflict); } });
    const meta = { _rev: '2-x', _meta: { lwt: 1 }, _attachments: {} };
    state.conflict$.next({
      input: { newDocumentState: { id: 'a', title: 'local', done: false, _deleted: false }, realMasterState: {} },
      output: { id: 'a', title: 'server', done: false, _deleted: false, ...meta },
    });
    state.conflict$.next({
      input: { newDocumentState: { id: 'b', title: 'same', done: false, _deleted: false }, realMasterState: {} },
      output: { id: 'b', title: 'same', done: false, _deleted: false, ...meta },
    });
    expect(conflicts).toEqual([{
      collection: 'intentions', tableName: 'intentions', id: 'a',
      proposed: { id: 'a', title: 'local', done: false, _deleted: false },
      resolved: { id: 'a', title: 'server', done: false, _deleted: false },
    }]);
    await sync.cancel();
    expect(state.conflict$.count()).toBe(0);

    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failing = await start({ onConflict: () => { throw new Error('observer failed'); } });
    failing.state.conflict$.next({
      input: { newDocumentState: { id: 'a', title: 'local', done: false, _deleted: false }, realMasterState: {} },
      output: { id: 'a', title: 'server', done: false, _deleted: false },
    });
    expect(logged).toHaveBeenCalledWith('Supabase conflict observer failed.', expect.any(Error));
    logged.mockRestore();
    await failing.sync.cancel();
  });

  it.each([['id'], ['_deleted'], ['_modified'], ['title'], [' ']])('rejects server column %j before replication', async column => {
    await expect(syncSupabaseCollections<Rows>({
      collections, scope: createScope(), accountId: 'account-a', client: client(),
      tables: [{ ...table, serverColumns: [column] }],
    })).rejects.toThrow(/server/i);
    expect(stock.replicate).not.toHaveBeenCalled();
  });

  it('refuses a missing collection and a mismatched account before replication', async () => {
    await expect(syncSupabaseCollections<Rows>({
      collections: {} as typeof collections, scope: createScope(), accountId: 'account-a', client: client(), tables: [table],
    })).rejects.toThrow('not supplied');
    await expect(syncSupabaseCollections<Rows>({
      collections, scope: createScope(), accountId: 'account-a', client: client('account-b'), tables: [table],
    })).rejects.toThrow(/does not match/);
    expect(stock.replicate).not.toHaveBeenCalled();
  });

  it('replicates through an access-token client without touching client.auth until the scope ends', async () => {
    const state = replica();
    stock.replicate.mockReturnValue(state);
    const scope = createScope();
    const tokenClient = accessTokenClient();
    const sync = await syncSupabaseCollections<Rows>({
      collections, scope, accountId: 'telegram-7', client: tokenClient, authentication: 'access-token', tables: [table],
    });
    const options = stock.replicate.mock.calls[0]![0] as Options & { client: unknown };
    expect(options.client).toBe(tokenClient);
    expect(options.replicationIdentifier).toBe('vibespa:default:telegram-7:intentions:intentions');
    await vi.waitFor(() => expect(state.start).toHaveBeenCalledOnce());
    await scope.dispose();
    expect(state.cancel).toHaveBeenCalledOnce();
    expect(sync.status.read().phase).toBe('stopped');
  });

  it('refuses an access-token client in session mode and an unknown authentication mode', async () => {
    await expect(syncSupabaseCollections<Rows>({
      collections, scope: createScope(), accountId: 'account-a', client: accessTokenClient(), tables: [table],
    })).rejects.toThrow(/not possible/);
    await expect(syncSupabaseCollections<Rows>({
      collections, scope: createScope(), accountId: 'account-a', client: client(), tables: [table],
      authentication: 'jwt' as never,
    })).rejects.toThrow(/authentication/);
    expect(stock.replicate).not.toHaveBeenCalled();
  });

  it('cancels replication when its account scope is disposed', async () => {
    const scope = createScope();
    const { state, sync } = await start({ scope });
    await scope.dispose();
    expect(state.cancel).toHaveBeenCalledOnce();
    expect(sync.status.read().phase).toBe('stopped');
  });
});
