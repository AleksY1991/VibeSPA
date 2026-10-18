import type { Equality, Readable, Unsubscribe } from '@vibespa/contracts';

/** Keep this owner private; expose source and named domain commands. */
export interface Source<T> {
  readonly source: Readable<T>;
  set(value: T): void;
  update(fn: (previous: T) => T): void;
}

interface Subscription<T> {
  readonly listener: (value: T) => void;
  active: boolean;
}

interface Change<T> {
  readonly value: T;
  readonly subscriptions: readonly Subscription<T>[];
}

/**
 * Memory-only state with an immutable read facade. Nested writes notify in write
 * order. Listener failures are collected after all queued changes are delivered.
 */
export function createSource<T>(
  initial: T,
  equals: Equality<T> = Object.is,
): Source<T> {
  let current = initial;
  let notifying = false;
  const subscriptions = new Set<Subscription<T>>();
  const pending: Change<T>[] = [];

  const source: Readable<T> = Object.freeze({
    read: () => current,
    subscribe(listener: (value: T) => void): Unsubscribe {
      const subscription: Subscription<T> = { listener, active: true };
      subscriptions.add(subscription);
      return () => {
        subscription.active = false;
        subscriptions.delete(subscription);
      };
    },
  });

  const set = (value: T): void => {
    if (equals(current, value)) return;
    current = value;
    pending.push({ value, subscriptions: [...subscriptions] });
    if (notifying) return;

    notifying = true;
    const errors: unknown[] = [];
    try {
      // The queue may grow while a listener invokes a command.
      for (let index = 0; index < pending.length; index += 1) {
        const change = pending[index]!;
        for (const subscription of change.subscriptions) {
          if (!subscription.active) continue;
          try {
            subscription.listener(change.value);
          } catch (error) {
            errors.push(error);
          }
        }
      }
    } finally {
      pending.length = 0;
      notifying = false;
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, 'Source subscribers failed.');
    }
  };

  return {
    source,
    set,
    update: (fn) => set(fn(current)),
  };
}

export function constantReadable<T>(value: T): Readable<T> {
  return Object.freeze({
    read: () => value,
    subscribe: () => () => {},
  });
}

/** Derive a narrow value; unchanged projections never notify consumers. */
export function mapReadable<T, U>(
  source: Readable<T>,
  project: (value: T) => U,
  equals: Equality<U> = Object.is,
): Readable<U> {
  return Object.freeze({
    read: () => project(source.read()),
    subscribe(listener: (value: U) => void): Unsubscribe {
      let previous = project(source.read());
      return source.subscribe((value) => {
        const next = project(value);
        if (equals(previous, next)) return;
        previous = next;
        listener(next);
      });
    },
  });
}
