import { describe, expect, it, vi } from 'vitest';
import { createSource } from '@vibespa/core';
import type { AccountIdentity } from '../contracts/account';
import { startAccountGenerations } from './startAccountGenerations';
import { startApplication } from './startApplication';
import { startApplicationGeneration, type ApplicationGeneration } from './startApplicationGeneration';

const alice: AccountIdentity = { userId: 'alice', email: 'alice@example.com' };
const bob: AccountIdentity = { userId: 'bob', email: 'bob@example.com' };

function fakes() {
  const order: string[] = [];
  const start = vi.fn((identity: AccountIdentity | null, previous: ApplicationGeneration | undefined): ApplicationGeneration => {
    const name = identity?.userId ?? 'signed-out';
    order.push(`start ${name}`);
    let disposal: Promise<void> | undefined;
    return {
      ready: Promise.resolve(),
      dispose() {
        disposal ??= (async () => { await previous?.dispose(); order.push(`dispose ${name}`); })();
        return disposal;
      },
    };
  });
  return { order, start };
}

describe('account generations', () => {
  it('waits for the stored session, then opens one generation per account', async () => {
    const identity = createSource<AccountIdentity | null | undefined>(undefined);
    const { order, start } = fakes();
    const generations = startAccountGenerations({ identity: identity.source, start });
    expect(start).not.toHaveBeenCalled();
    identity.set(null);
    await generations.ready;
    identity.set(alice);
    // A token refresh or email change keeps the same account generation.
    identity.set({ ...alice, email: 'alice@new.example.com' });
    identity.set(bob);
    expect(order).toEqual(['start signed-out', 'start alice', 'start bob']);
    expect(start.mock.calls.map(call => call[1])).toEqual([undefined, start.mock.results[0]!.value, start.mock.results[1]!.value]);
    await generations.dispose();
    identity.set(alice);
    expect(order).toEqual(['start signed-out', 'start alice', 'start bob', 'dispose signed-out', 'dispose alice', 'dispose bob']);
  });

  it('releases its predecessor and settles readiness when disposed before the session is known', async () => {
    const identity = createSource<AccountIdentity | null | undefined>(undefined);
    const previous = { ready: Promise.resolve(), dispose: vi.fn(async () => undefined) };
    const { start } = fakes();
    const generations = startAccountGenerations({ identity: identity.source, previous, start });
    await generations.dispose();
    await generations.ready;
    expect(previous.dispose).toHaveBeenCalledOnce();
    identity.set(alice);
    expect(start).not.toHaveBeenCalled();
  });

  it('closes the previous account before opening the next and keeps diagnostics when that close fails', async () => {
    const identity = createSource<AccountIdentity | null | undefined>(alice);
    const events: string[] = [];
    let failClose = false;
    const generations = startAccountGenerations({
      identity: identity.source,
      start: (account, previous) => startApplicationGeneration({
        previous,
        mountInspector: () => { events.push(`inspector ${account?.userId}`); return () => { events.push(`unmount inspector ${account?.userId}`); }; },
        startApplication: () => startApplication(
          async () => { events.push(`open ${account?.userId}`); return { dispose: async () => {
            events.push(`close ${account?.userId}`);
            if (failClose) throw new Error('undelivered gesture');
          } }; },
          () => () => undefined,
        ),
        disposeSystem: async () => {},
        showStartupError: () => () => undefined,
      }),
    });
    await generations.ready;
    identity.set(bob);
    await generations.current()!.ready;
    expect(events).toEqual(['inspector alice', 'open alice', 'close alice', 'unmount inspector alice', 'inspector bob', 'open bob']);
    failClose = true;
    identity.set(null);
    await expect(generations.current()!.ready).rejects.toThrow('undelivered gesture');
    expect(events.slice(6)).toEqual(['close bob']);
    expect(events).not.toContain('unmount inspector bob');
    await expect(generations.dispose()).rejects.toThrow('undelivered gesture');
  });
});
