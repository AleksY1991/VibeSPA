import type { Readable } from '@vibespa/contracts';
import type { AccountIdentity } from '../contracts/account';
import type { ApplicationGeneration } from './startApplicationGeneration';

export interface AccountGenerations extends ApplicationGeneration {
  /** The generation for the current account, once the identity is known. */
  current(): ApplicationGeneration | undefined;
}

/** Open one application generation per account. Each identity change chains a
 * new generation after the previous one: it closes before the next opens, and
 * a failed close blocks replacement while keeping the old inspector visible.
 * Token refreshes and email changes keep the same account and generation. */
export function startAccountGenerations(options: {
  readonly identity: Readable<AccountIdentity | null | undefined>;
  readonly previous?: ApplicationGeneration;
  start(identity: AccountIdentity | null, previous: ApplicationGeneration | undefined): ApplicationGeneration;
}): AccountGenerations {
  let current: ApplicationGeneration | undefined;
  let account: string | null | undefined;
  let stopped = false;
  let disposal: Promise<void> | undefined;
  let resolveReady!: (value: void | PromiseLike<void>) => void;
  const ready = new Promise<void>(resolve => { resolveReady = resolve; });

  const open = (identity: AccountIdentity | null | undefined): void => {
    if (stopped || identity === undefined) return;
    const next = identity?.userId ?? null;
    if (current && next === account) return;
    account = next;
    const first = !current;
    current = options.start(identity, current ?? options.previous);
    if (first) resolveReady(current.ready);
  };
  const unsubscribe = options.identity.subscribe(open);
  open(options.identity.read());

  return {
    ready,
    current: () => current,
    dispose() {
      stopped = true;
      // Disposed before the stored session was read: nothing started here.
      if (!current) resolveReady();
      disposal ??= (async () => {
        unsubscribe();
        // Without any generation, still release the predecessor this one replaced.
        await (current ?? options.previous)?.dispose();
      })();
      return disposal;
    },
  };
}
