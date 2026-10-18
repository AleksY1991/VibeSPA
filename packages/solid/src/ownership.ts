import { getOwner, onCleanup } from 'solid-js';
import type { Scope } from '@vibespa/contracts';

/** Tie an explicitly created module scope to its rendering owner. Callers own
 * error presentation; asynchronous teardown failures are never silently lost.
 */
export function ownScope(scope: Scope, onError: (error: unknown) => void): Scope {
  if (!getOwner()) throw new Error('ownScope requires a Solid owner.');
  onCleanup(() => { void scope.dispose().catch(onError); });
  return scope;
}
