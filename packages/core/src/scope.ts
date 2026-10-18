import type { Cleanup, Scope, Unsubscribe } from '@vibespa/contracts';

interface CleanupEntry {
  readonly run: Cleanup;
  registered: boolean;
}

/** Cancellation propagates immediately; the owner explicitly awaits disposal.
 * Forwarding a parent signal does not start teardown, so nested owners can
 * release dependents before dependencies instead of racing their cleanups.
 */
export function createScope(parentSignal?: AbortSignal): Scope {
  const controller = new AbortController();
  const cleanups: CleanupEntry[] = [];
  let disposal: Promise<void> | undefined;
  let disposing = false;

  const forwardAbort = (): void => { controller.abort(parentSignal?.reason); };
  if (parentSignal?.aborted) forwardAbort();
  else parentSignal?.addEventListener('abort', forwardAbort, { once: true });

  const scope: Scope = Object.freeze({
    signal: controller.signal,

    defer(cleanup: Cleanup): Unsubscribe {
      if (disposing) throw new Error('Cannot register cleanup on a disposing scope');
      const entry: CleanupEntry = { run: cleanup, registered: true };
      cleanups.push(entry);
      return () => {
        if (!entry.registered) return;
        entry.registered = false;
        const index = cleanups.indexOf(entry);
        if (index >= 0) cleanups.splice(index, 1);
      };
    },

    dispose(): Promise<void> {
      if (disposal) return disposal;
      disposing = true;
      let resolveDisposal!: () => void;
      let rejectDisposal!: (error: unknown) => void;
      // Assign before aborting: abort listeners may reenter dispose().
      disposal = new Promise<void>((resolve, reject) => {
        resolveDisposal = resolve;
        rejectDisposal = reject;
      });
      parentSignal?.removeEventListener('abort', forwardAbort);
      controller.abort();

      const drain = async (): Promise<void> => {
        const errors: unknown[] = [];
        while (cleanups.length > 0) {
          const entry = cleanups.pop();
          if (!entry?.registered) continue;
          entry.registered = false;
          try { await entry.run(); }
          catch (error: unknown) { errors.push(error); }
        }
        if (errors.length > 0) throw new AggregateError(errors, 'Scope cleanup failed');
      };
      void drain().then(resolveDisposal, rejectDisposal);
      return disposal;
    },
  });

  return scope;
}
