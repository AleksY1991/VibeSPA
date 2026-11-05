import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { RxCollection, WithDeleted } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { FeatureType } from '@vibespa/contracts';
import { createSolidSystem } from '@vibespa/solid/module';
import type { AccountIdentity } from '../contracts/account';
import type { Intention } from '../contracts/focus';
import { createSupabaseApplication, supabaseApplicationModules } from './createSupabaseApplication';

const stock = vi.hoisted(() => ({ replicate: vi.fn() }));
vi.mock('rxdb/plugins/replication-supabase', () => ({ replicateSupabase: stock.replicate }));

type Captured = {
  collection: RxCollection<Intention>;
  pull: { modifier: (row: Record<string, unknown>) => WithDeleted<Intention> };
};

function subject<T>() {
  const listeners = new Set<(value: T) => void>();
  return {
    subscribe(listener: (value: T) => void) { listeners.add(listener); return { unsubscribe() { listeners.delete(listener); } }; },
    next(value: T) { for (const listener of [...listeners]) listener(value); },
  };
}
function replica(onCancel: () => void) {
  return {
    push: { handler: vi.fn(async () => []) },
    active$: subject<boolean>(), error$: subject<unknown>(),
    conflict$: subject<{ input: { newDocumentState: unknown; realMasterState: unknown }; output: unknown }>(),
    start: vi.fn(async () => undefined),
    cancel: vi.fn(async () => { onCancel(); }),
    awaitInitialReplication: () => new Promise<void>(() => undefined),
  };
}
function auth(userId: string | null) {
  let notify: ((event: string, session: { user: { id: string } } | null) => void) | undefined;
  const client = { auth: {
    getSession: async () => ({ data: { session: userId ? { user: { id: userId } } : null }, error: null }),
    onAuthStateChange(listener: typeof notify) { notify = listener; return { data: { subscription: { unsubscribe() { notify = undefined; } } } }; },
  } } as unknown as SupabaseClient;
  const port = { requestLink: vi.fn(async (_email: string) => undefined), signOut: vi.fn(async () => { notify?.('SIGNED_OUT', null); }) };
  return { client, port };
}
async function delivered(read: () => { phase: string }) {
  await vi.waitFor(() => { expect(read().phase).toBe('idle'); });
}

describe('the Supabase playground composition', () => {
  it('starts only the account module while signed out and validates link requests', async () => {
    const { client, port } = auth(null);
    const system = createSolidSystem({ id: 'supabase-signed-out', modules: supabaseApplicationModules });
    try {
      const application = await createSupabaseApplication(system, { client, auth: port, identity: null });
      expect(application.signedIn).toBeUndefined();
      expect(system.snapshot.read().modules.map(module => [module.id, module.kind])).toEqual([['account', FeatureType.Service]]);
      expect(application.account.identity).toBeNull();
      expect(await application.account.commands.requestLink('not an address')).toEqual({ ok: false, message: 'Enter a valid email address.' });
      expect(application.account.link()).toEqual({ phase: 'failed', message: 'Enter a valid email address.' });
      expect(port.requestLink).not.toHaveBeenCalled();
      expect(await application.account.commands.requestLink(' Me@Example.com ')).toEqual({ ok: true });
      expect(port.requestLink).toHaveBeenCalledWith('me@example.com');
      expect(application.account.link()).toEqual({ phase: 'sent', email: 'me@example.com' });
      port.requestLink.mockRejectedValueOnce(new Error('Email rate limit exceeded'));
      expect(await application.account.commands.requestLink('me@example.com')).toEqual({ ok: false, message: 'Email rate limit exceeded' });
      expect(JSON.stringify(system.snapshot.read())).not.toContain('me@example.com');
    } finally { await system.dispose(); }
  });

  it('persists flat rows, admits pulled rows, reports replacements and cancels replication before closing', async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const identity: AccountIdentity = { userId, email: 'private@example.com' };
    const { client, port } = auth(userId);
    let state!: ReturnType<typeof replica>;
    let captured!: Captured;
    const closedAtCancel: boolean[] = [];
    stock.replicate.mockImplementation((options: Captured) => {
      captured = options;
      state = replica(() => { closedAtCancel.push(options.collection.database.closed); });
      return state;
    });
    const system = createSolidSystem({ id: 'supabase-signed-in', modules: supabaseApplicationModules });
    try {
      const application = await createSupabaseApplication(system, {
        client, auth: port, identity, storage: getRxStorageMemory(), multiInstance: false,
      });
      const { focus, sync } = application.signedIn!;
      const snapshot = system.snapshot.read();
      expect(snapshot.modules.map(module => [module.id, module.kind, module.state])).toEqual([
        ['account', FeatureType.Service, 'ready'],
        ['supabase-storage', FeatureType.Store, 'ready'],
        ['title-policy', FeatureType.Policy, 'ready'],
        ['intentions-data', FeatureType.Data, 'ready'],
        ['focus', FeatureType.Feature, 'ready'],
      ]);
      expect(snapshot.modules.find(module => module.id === 'intentions-data')?.dependencies).toEqual(['supabase-storage', 'title-policy']);
      expect(stock.replicate).toHaveBeenCalledWith(expect.objectContaining({
        tableName: 'intentions', modifiedField: '_modified', deletedField: '_deleted',
        replicationIdentifier: `vibespa:vibespa-playground:${userId}:intentions:intentions`,
      }));

      expect(await focus.commands.add('Write locally')).toEqual({ ok: true });
      await delivered(focus.delivery);
      const local = focus.pending().find(item => item.title === 'Write locally')!;
      const stored = await captured.collection.storageInstance.findDocumentsById([local.id], true);
      expect(stored[0]).toMatchObject({ id: local.id, title: 'Write locally', done: false, _deleted: false });
      expect(Object.keys(stored[0]!).filter(key => !key.startsWith('_')).sort()).toEqual(['done', 'id', 'title']);

      // A replication pull: the server row arrives with its owner column, which
      // the configured modifier strips before RxDB stores it.
      const { _deleted, ...pulled } = captured.pull.modifier({
        id: 'remote-1', title: 'From another device', done: false, owner_id: userId, _deleted: false,
      });
      expect(_deleted).toBe(false);
      await captured.collection.upsert(pulled);
      await vi.waitFor(() => { expect(focus.pending().map(item => item.title)).toContain('From another device'); });

      expect(sync.replaced()).toBeNull();
      state.conflict$.next({
        input: { newDocumentState: { id: local.id, title: 'Write locally', done: false, _deleted: false }, realMasterState: {} },
        output: { id: local.id, title: 'Server version', done: false, _deleted: false },
      });
      // Solid accessors settle in a microtask.
      await vi.waitFor(() => { expect(sync.replaced()).toEqual({ count: 1 }); });
      await sync.commands.dismiss();
      await vi.waitFor(() => { expect(sync.replaced()).toBeNull(); });

      const serialized = JSON.stringify(system.snapshot.read());
      for (const secret of ['private@example.com', 'Write locally', 'From another device']) expect(serialized).not.toContain(secret);

      await application.dispose();
      expect(state.cancel).toHaveBeenCalledOnce();
      expect(closedAtCancel).toEqual([false]);
      expect(captured.collection.database.closed).toBe(true);
    } finally { await system.dispose(); }
  });

  it('stops replication when the account signs out', async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const { client, port } = auth(userId);
    let state!: ReturnType<typeof replica>;
    stock.replicate.mockImplementation(() => { state = replica(() => undefined); return state; });
    const system = createSolidSystem({ id: 'supabase-sign-out', modules: supabaseApplicationModules });
    try {
      const application = await createSupabaseApplication(system, {
        client, auth: port, identity: { userId, email: null }, storage: getRxStorageMemory(), multiInstance: false,
      });
      expect(await application.account.commands.signOut()).toEqual({ ok: true });
      await vi.waitFor(() => { expect(state.cancel).toHaveBeenCalledOnce(); });
      await vi.waitFor(() => { expect(application.signedIn!.sync.status().phase).toBe('stopped'); });
    } finally { await system.dispose(); }
  });
});
