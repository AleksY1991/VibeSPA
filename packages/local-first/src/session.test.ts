import { describe, expect, it, vi } from 'vitest';
import {
  createRxDbSyncController,
  type RxDbSyncScope,
  type RxDbSyncScopeValue,
  type RxDbSyncSession,
} from '@vibespa/local-first/session';

interface TestDatabase {
  readonly name: string;
  readonly remove: ReturnType<typeof vi.fn>;
}

function scope(accountId: string): RxDbSyncScope {
  return { accountId };
}

function makeScopeSource(initial: RxDbSyncScopeValue) {
  let value = initial;
  const listeners = new Set<() => void>();

  return {
    read: () => value,
    subscribe: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    set(next: RxDbSyncScopeValue): void {
      value = next;
      for (const listener of [...listeners]) listener();
    },
    notify(): void {
      for (const listener of [...listeners]) listener();
    },
  };
}

function makeSession(name: string, events?: string[]): RxDbSyncSession<TestDatabase> {
  const database: TestDatabase = { name, remove: vi.fn() };
  return {
    database,
    stop: vi.fn(async () => {
      events?.push(`stop:${name}`);
    }),
  };
}

describe('createRxDbSyncController', () => {
  it('maps normalized scope metadata without restarting on workspace filter changes', async () => {
    const source = makeScopeSource({ accountId: 'account-a', sessionKey: 'login-1', workspaceId: 'filter-a' });
    const session = makeSession('account-a');
    const openSession = vi.fn(async () => session);
    const mapScope = vi.fn((identity: RxDbSyncScope) => ({ ...identity, workspaceId: identity.accountId }));
    const controller = createRxDbSyncController({ scopeSource: source, openSession, mapScope });
    controller.initialize();
    await controller.whenSettled();

    expect(mapScope).toHaveBeenCalledWith({ accountId: 'account-a', sessionKey: 'login-1' });
    const openedScope = controller.getSnapshot().scope;
    expect(openedScope).toEqual({ accountId: 'account-a', sessionKey: 'login-1', workspaceId: 'account-a' });
    expect(Object.isFrozen(openedScope)).toBe(true);

    source.set({ accountId: 'account-a', sessionKey: 'login-1', workspaceId: 'filter-b' });
    await controller.whenSettled();
    expect(openSession).toHaveBeenCalledOnce();
    expect(session.stop).not.toHaveBeenCalled();
    expect(controller.getSnapshot().scope).toBe(openedScope);
    await controller.dispose();
  });

  it('reopens the same account on Auth session replacement but keeps token refresh local', async () => {
    const source = makeScopeSource({ accountId: 'account-a', sessionKey: 'login-1' });
    const events: string[] = [];
    const outgoing = makeSession('login-1', events);
    const incoming = makeSession('login-2', events);
    const signals: AbortSignal[] = [];
    const openSession = vi.fn(async (next: RxDbSyncScope, context: { signal: AbortSignal }) => {
      signals.push(context.signal);
      events.push(`open:${next.sessionKey}`);
      return next.sessionKey === 'login-1' ? outgoing : incoming;
    });
    const controller = createRxDbSyncController({ scopeSource: source, openSession });
    controller.initialize();
    await controller.whenSettled();

    source.set({ accountId: 'account-a', sessionKey: 'login-1' });
    await controller.whenSettled();
    expect(openSession).toHaveBeenCalledOnce();
    expect(signals[0]!.aborted).toBe(false);

    source.set({ accountId: 'account-a', sessionKey: 'login-2' });
    expect(signals[0]!.aborted).toBe(true);
    expect(controller.getSnapshot().database).toBeNull();
    await controller.whenSettled();
    expect(events).toEqual(['open:login-1', 'stop:login-1', 'open:login-2']);
    expect(controller.getSnapshot().database).toBe(incoming.database);
    expect(outgoing.database.remove).not.toHaveBeenCalled();
    await controller.dispose();
  });

  it('seeds the account and ignores same-account refreshes', async () => {
    const source = makeScopeSource(scope('account-a'));
    const session = makeSession('account-a');
    const openSession = vi.fn(async () => session);
    const controller = createRxDbSyncController({ scopeSource: source, openSession });

    controller.initialize();

    expect(source.subscribe).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'opening',
      scope: scope('account-a'),
      database: null,
    });

    await controller.whenSettled();
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      scope: scope('account-a'),
      database: session.database,
      error: null,
    });

    const openedScope = controller.getSnapshot().scope;
    source.notify();
    source.set(scope('account-a'));
    source.set({ accountId: 'account-a' });
    controller.initialize();
    await controller.whenSettled();

    expect(openSession).toHaveBeenCalledOnce();
    expect(session.stop).not.toHaveBeenCalled();
    expect(source.subscribe).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().scope).toBe(openedScope);
    expect(Object.isFrozen(openedScope)).toBe(true);
    await controller.dispose();
  });

  it('stops the outgoing session before opening the next, and revokes the database synchronously', async () => {
    const events: string[] = [];
    const source = makeScopeSource(scope('account-a'));
    const sessions = {
      'account-a': makeSession('account-a', events),
      'account-b': makeSession('account-b', events),
    };
    const openSession = vi.fn(async (next: RxDbSyncScope) => {
      events.push(`open:${next.accountId}`);
      return sessions[next.accountId as keyof typeof sessions];
    });
    const controller = createRxDbSyncController({ scopeSource: source, openSession });

    controller.initialize();
    await controller.whenSettled();

    source.set(scope('account-b'));

    expect(controller.getSnapshot()).toMatchObject({
      phase: 'opening',
      scope: scope('account-b'),
      database: null,
    });

    await controller.whenSettled();
    expect(events).toEqual(['open:account-a', 'stop:account-a', 'open:account-b']);
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      database: sessions['account-b'].database,
    });
    await controller.dispose();
  });

  it('fails soft, retries on the next same-scope notification, and closes without removing on logout', async () => {
    const source = makeScopeSource(scope('account-a'));
    const openError = new Error('indexeddb unavailable');
    const session = makeSession('retry-success');
    const openSession = vi.fn(async () => {
      if (openSession.mock.calls.length === 1) throw openError;
      return session;
    });
    const controller = createRxDbSyncController({ scopeSource: source, openSession });

    controller.initialize();
    await controller.whenSettled();
    expect(controller.getSnapshot()).toEqual({
      phase: 'error',
      scope: scope('account-a'),
      database: null,
      error: openError,
    });

    source.notify();
    await controller.whenSettled();
    expect(openSession).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().phase).toBe('ready');

    source.set(null);
    expect(controller.getSnapshot()).toEqual({
      phase: 'idle',
      scope: null,
      database: null,
      error: null,
    });
    await controller.whenSettled();

    expect(session.stop).toHaveBeenCalledOnce();
    expect(session.database.remove).not.toHaveBeenCalled();
    await controller.dispose();
  });

  it('reopens the account after logout and relogin', async () => {
    const source = makeScopeSource({ accountId: 'account-a' });
    const session = makeSession('fixed-database');
    const openSession = vi.fn(async () => session);
    const controller = createRxDbSyncController({ scopeSource: source, openSession });
    controller.initialize();
    await controller.whenSettled();
    const previousScope = controller.getSnapshot().scope;
    source.set(null);
    source.set({ accountId: 'account-a' });
    expect(controller.getSnapshot().database).toBeNull();
    await controller.whenSettled();
    expect(openSession).toHaveBeenCalledTimes(2);
    expect(session.stop).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().database).toBe(session.database);
    expect(controller.getSnapshot().scope).not.toBe(previousScope);
    expect(controller.getSnapshot().scope?.accountId).toBe('account-a');
    expect(session.database.remove).not.toHaveBeenCalled();
    await controller.dispose();
  });

  it('aborts an opening account and closes its late result before publishing the next', async () => {
    const source = makeScopeSource({ accountId: 'account-a' });
    const events: string[] = [];
    const outgoing = makeSession('account-a', events);
    const incoming = makeSession('account-b', events);
    let resolve!: (session: RxDbSyncSession<TestDatabase>) => void;
    let signal!: AbortSignal;
    const pending = new Promise<RxDbSyncSession<TestDatabase>>((done) => { resolve = done; });
    const openSession = vi.fn(async (next: RxDbSyncScope, context: { signal: AbortSignal }) => {
      events.push(`open:${next.accountId}`);
      if (next.accountId === 'account-a') {
        signal = context.signal;
        return pending;
      }
      return incoming;
    });
    const controller = createRxDbSyncController({ scopeSource: source, openSession });
    const published: TestDatabase[] = [];
    const stop = controller.subscribe((snapshot) => {
      if (snapshot.database) published.push(snapshot.database);
    });
    controller.initialize();
    await vi.waitFor(() => expect(openSession).toHaveBeenCalledOnce());
    source.set({ accountId: 'account-b' });
    expect(signal.aborted).toBe(true);
    expect(controller.getSnapshot().database).toBeNull();
    resolve(outgoing);
    await controller.whenSettled();
    expect(events).toEqual(['open:account-a', 'stop:account-a', 'open:account-b']);
    expect(published).toEqual([incoming.database]);
    stop();
    await controller.dispose();
  });
});
