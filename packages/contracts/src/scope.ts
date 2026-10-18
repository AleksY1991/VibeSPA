import type { Unsubscribe } from './readable.js';

export type Cleanup = () => void | Promise<void>;

/** A lifetime owner for cancellable work and resource cleanup.
 * Cancellation stops continuations; dispose explicitly awaits owned teardown.
 */
export interface Scope {
  readonly signal: AbortSignal;
  /** Register at acquisition, before awaiting. Returns an idempotent unregister.
   * Registration is allowed after cancellation, but not once disposal starts.
   */
  defer(cleanup: Cleanup): Unsubscribe;
  /** Abort first, then await all registered cleanup in reverse order. */
  dispose(): Promise<void>;
}
