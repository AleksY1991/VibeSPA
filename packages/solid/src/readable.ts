import { createSignal, getOwner, onCleanup, untrack, type Accessor } from 'solid-js';
import type { Equality, Readable } from '@vibespa/contracts';

/** Own one exact source subscription in the current Solid view. Select IDs or
 * scalars before this boundary instead of copying an entire domain collection.
 */
export function consumeReadable<T>(source: Readable<T>, options?: {
  readonly name?: string;
  readonly equals?: Equality<T>;
}): Accessor<T> {
  if (!getOwner()) throw new Error('consumeReadable requires a Solid owner. Construct it inside a view or createRoot.');
  const initial = source.read();
  const [value, setValue] = createSignal<T>(() => initial, {
    name: options?.name ?? 'vibespa.readable',
    equals: options?.equals ?? Object.is,
    ownedWrite: true,
  });
  let active = true;
  const unsubscribe = source.subscribe(next => {
    if (active) untrack(() => setValue(() => next));
  });
  onCleanup(() => {
    active = false;
    unsubscribe();
  });
  // Close a read/subscribe race for sources that change while attaching a lease.
  untrack(() => setValue(() => source.read()));
  return value;
}
