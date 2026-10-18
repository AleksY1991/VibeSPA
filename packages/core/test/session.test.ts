import { describe, expect, it } from 'vitest';
import type { Readable, Scope } from '@vibespa/contracts';
import { createSource } from '../src/readable.js';
import { createScope } from '../src/scope.js';
import { createSessionHost } from '../src/session.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((fulfill, fail) => {
    resolve = fulfill;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('createSessionHost', () => {
  it('subscribes before reading and eagerly opens the current identity', async () => {
    const calls: string[] = [];
    const identity: Readable<string | null> = {
      subscribe: () => {
        calls.push('subscribe');
        return () => { calls.push('unsubscribe'); };
      },
      read: () => { calls.push('read'); return 'alice'; },
    };
    const scope = createScope();
    const host = createSessionHost({ identity, scope, open: (account) => `db:${account}` });
    expect(calls).toEqual(['subscribe', 'read']);
    expect(host.state.read()).toEqual({ phase: 'opening', identity: 'alice', value: null, error: null });
    await host.whenSettled();
    expect(host.state.read()).toEqual({ phase: 'ready', identity: 'alice', value: 'db:alice', error: null });
    await scope.dispose();
    expect(calls).toEqual(['subscribe', 'read', 'unsubscribe']);
    expect(host.state.read().phase).toBe('idle');
  });

  it('releases observation when the owner cancels during subscription installation', async () => {
    const owner = createScope();
    let ownerDisposal: Promise<void> | undefined;
    let stopped = 0;
    let reads = 0;
    const identity: Readable<string | null> = {
      subscribe: () => {
        ownerDisposal = owner.dispose();
        return () => { stopped += 1; };
      },
      read: () => { reads += 1; return 'alice'; },
    };
    const host = createSessionHost({ identity, scope: owner, open: (account) => account });
    await ownerDisposal;
    expect(stopped).toBe(1);
    expect(reads).toBe(0);
    expect(host.state.read().phase).toBe('idle');
    await host.dispose();
  });

  it('cancels and clears outgoing values immediately, then awaits closing before opening', async () => {
    const identity = createSource<string | null>('alice');
    const closing = deferred<void>();
    const closeStarted = deferred<void>();
    const events: string[] = [];
    let outgoingSignal: AbortSignal | undefined;
    const host = createSessionHost({
      identity: identity.source,
      scope: createScope(),
      open: (account, scope) => {
        events.push(`open:${account}`);
        if (account === 'alice') outgoingSignal = scope.signal;
        scope.defer(async () => {
          events.push(`close:${account}`);
          if (account === 'alice') {
            closeStarted.resolve();
            await closing.promise;
          }
        });
        return account;
      },
    });
    await host.whenSettled();
    identity.set('bob');
    expect(outgoingSignal?.aborted).toBe(true);
    expect(host.state.read()).toEqual({ phase: 'opening', identity: 'bob', value: null, error: null });
    await closeStarted.promise;
    expect(events).toEqual(['open:alice', 'close:alice']);
    closing.resolve();
    await host.whenSettled();
    expect(events).toEqual(['open:alice', 'close:alice', 'open:bob']);
    expect(host.state.read().value).toBe('bob');
    await host.dispose();
  });

  it('never publishes a stale open and closes even resources acquired after cancellation', async () => {
    const identity = createSource<string | null>('alice');
    const opening = deferred<void>();
    const started = deferred<void>();
    const events: string[] = [];
    const ready: string[] = [];
    let aliceScope: Scope | undefined;
    const host = createSessionHost({
      identity: identity.source,
      scope: createScope(),
      open: async (account, scope) => {
        events.push(`open:${account}`);
        if (account === 'alice') {
          aliceScope = scope;
          started.resolve();
          await opening.promise;
        }
        scope.defer(() => { events.push(`close:${account}`); });
        return account;
      },
    });
    host.state.subscribe((state) => {
      if (state.phase === 'ready') ready.push(state.value);
    });
    await started.promise;
    identity.set('bob');
    identity.set('carol');
    expect(aliceScope?.signal.aborted).toBe(true);
    opening.resolve();
    await host.whenSettled();
    expect(events).toEqual(['open:alice', 'close:alice', 'open:carol']);
    expect(ready).toEqual(['carol']);
    await host.dispose();
  });

  it('cleans partial acquisitions after open errors and retries on the same identity notification', async () => {
    const identity = createSource<string | null>('alice', () => false);
    const events: string[] = [];
    const failure = new Error('opening failed');
    let attempts = 0;
    const host = createSessionHost({
      identity: identity.source,
      scope: createScope(),
      open: (account, scope) => {
        attempts += 1;
        scope.defer(() => { events.push(`closed:${attempts}`); });
        if (attempts === 1) throw failure;
        return account;
      },
    });
    await host.whenSettled();
    expect(host.state.read()).toEqual({ phase: 'error', identity: 'alice', value: null, error: failure });
    expect(events).toEqual(['closed:1']);
    identity.set('alice');
    await host.whenSettled();
    expect(host.state.read().value).toBe('alice');
    expect(attempts).toBe(2);
    await host.dispose();
  });

  it('uses semantic identity equality so irrelevant updates preserve the session', async () => {
    const identity = createSource<{ account: string; token: string } | null>({ account: 'alice', token: 'one' });
    let opens = 0;
    const host = createSessionHost({
      identity: identity.source,
      scope: createScope(),
      equals: (left, right) => left.account === right.account,
      open: (account) => { opens += 1; return account.account; },
    });
    await host.whenSettled();
    identity.set({ account: 'alice', token: 'two' });
    await host.whenSettled();
    expect(opens).toBe(1);
    await host.dispose();
  });

  it('owner disposal aborts opening immediately and awaits its resource cleanup', async () => {
    const owner = createScope();
    const identity = createSource<string | null>('alice');
    const opening = deferred<void>();
    const started = deferred<void>();
    const closed: string[] = [];
    let signal: AbortSignal | undefined;
    const host = createSessionHost({
      identity: identity.source,
      scope: owner,
      open: async (account, scope) => {
        signal = scope.signal;
        scope.defer(() => { closed.push(account); });
        started.resolve();
        await opening.promise;
        return account;
      },
    });
    await started.promise;
    let finished = false;
    const disposal = owner.dispose().then(() => { finished = true; });
    expect(signal?.aborted).toBe(true);
    expect(host.state.read().phase).toBe('idle');
    identity.set('bob');
    await Promise.resolve();
    expect(finished).toBe(false);
    opening.resolve();
    await disposal;
    expect(closed).toEqual(['alice']);
    expect(host.state.read().phase).toBe('idle');
    await host.dispose();
  });

  it('fails closed after a teardown failure instead of overlapping resource ownership', async () => {
    const identity = createSource<string | null>('alice');
    const owner = createScope();
    const failure = new Error('closing failed');
    const opened: string[] = [];
    const host = createSessionHost({
      identity: identity.source,
      scope: owner,
      open: (account, scope) => {
        opened.push(account);
        if (account === 'alice') scope.defer(() => { throw failure; });
        return account;
      },
    });
    await host.whenSettled();
    identity.set('bob');
    await host.whenSettled();
    expect(host.state.read().phase).toBe('error');
    identity.set('carol');
    await host.whenSettled();
    expect(host.state.read().phase).toBe('error');
    expect(opened).toEqual(['alice']);
    await expect(owner.dispose()).rejects.toBeInstanceOf(AggregateError);
  });

  it('cancels on parent abort but waits for later parent-owned resources before teardown', async () => {
    const owner = createScope();
    const releaseDependent = deferred<void>();
    const dependentStarted = deferred<void>();
    const events: string[] = [];
    let signal: AbortSignal | undefined;
    const host = createSessionHost({
      identity: createSource<string | null>('alice').source,
      scope: owner,
      open: (account, scope) => {
        signal = scope.signal;
        scope.defer(() => { events.push('session'); });
        return account;
      },
    });
    await host.whenSettled();
    owner.defer(async () => {
      events.push('dependent');
      dependentStarted.resolve();
      await releaseDependent.promise;
    });
    const disposal = owner.dispose();
    expect(signal?.aborted).toBe(true);
    expect(host.state.read().phase).toBe('idle');
    await dependentStarted.promise;
    expect(events).toEqual(['dependent']);
    releaseDependent.resolve();
    await disposal;
    expect(events).toEqual(['dependent', 'session']);
  });

  it('handles disposal reentered by a cancellation listener', async () => {
    let reentered: Promise<void> | undefined;
    let closed = 0;
    const host: ReturnType<typeof createSessionHost<string, string>> = createSessionHost({
      identity: createSource<string | null>('alice').source,
      scope: createScope(),
      open: (account, scope) => {
        scope.signal.addEventListener('abort', () => { reentered = host.dispose(); });
        scope.defer(() => { closed += 1; });
        return account;
      },
    });
    await host.whenSettled();
    const disposal = host.dispose();
    expect(reentered).toBe(disposal);
    await disposal;
    expect(closed).toBe(1);
  });

  it('keeps observer failures outside acquisition and still releases every session', async () => {
    const identity = createSource<string | null>('alice');
    const closed: string[] = [];
    const host = createSessionHost({
      identity: identity.source,
      scope: createScope(),
      open: (account, scope) => {
        scope.defer(() => { closed.push(account); });
        return account;
      },
    });
    const unsubscribe = host.state.subscribe(() => { throw new Error('observer failed'); });
    await host.whenSettled();
    expect(host.state.read().phase).toBe('ready');
    identity.set('bob');
    await host.whenSettled();
    expect(host.state.read().value).toBe('bob');
    unsubscribe();
    await expect(host.dispose()).rejects.toBeInstanceOf(AggregateError);
    expect(closed).toEqual(['alice', 'bob']);
  });

  it('returns one disposal promise and propagates resource cleanup failures to its owner', async () => {
    const owner = createScope();
    const host = createSessionHost({
      identity: createSource<string | null>('alice').source,
      scope: owner,
      open: (account, scope) => {
        scope.defer(() => { throw new Error('cleanup failed'); });
        return account;
      },
    });
    await host.whenSettled();
    const disposal = owner.dispose();
    expect(host.dispose()).toBe(host.dispose());
    await expect(disposal).rejects.toBeInstanceOf(AggregateError);
    await expect(host.dispose()).rejects.toBeInstanceOf(AggregateError);
  });
});
