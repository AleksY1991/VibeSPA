import type { Readable, Scope } from '@vibespa/contracts';
import { createSource } from '@vibespa/core/readable';

/** Saving is allowed to finish after cancellation so teardown can flush edits. */
export interface SettingsStorage<T> {
  load(key: string, signal: AbortSignal): unknown | Promise<unknown>;
  save(key: string, value: T): void | Promise<void>;
}

export interface SettingsOptions<T> {
  readonly scope: Scope;
  readonly key: string;
  readonly defaults: T;
  readonly storage: SettingsStorage<T>;
  /** Return undefined, or throw, to reject persisted data. */
  readonly parse: (saved: unknown) => T | undefined;
}

/** Keep this owner private to its module; expose only values to consumers. */
export interface SettingsOwner<T> {
  readonly values: Readable<T>;
  readonly ready: Promise<void>;
  set(value: T): void;
  update(change: (previous: T) => T): void;
  /** Wait for queued saves and report storage failures. */
  flush(): Promise<void>;
  /** Stop publication and wait for edits already queued for persistence. */
  dispose(): Promise<void>;
}

export function createSettings<T>(options: SettingsOptions<T>): SettingsOwner<T> {
  const { scope, storage, key } = options;
  if (scope.signal.aborted) throw new Error('Cannot create settings in an ended scope.');
  if (!key.trim()) throw new Error('Settings need a nonempty storage key.');

  const values = createSource(options.defaults);
  const loading = new AbortController();
  const abortLoading = () => loading.abort(scope.signal.reason);
  let closed = false;
  let revision = 0;
  let saves: Promise<void> = Promise.resolve();
  const failures: unknown[] = [];
  let disposal: Promise<void> | undefined;
  const current = () => !closed && !scope.signal.aborted;

  const flush = async (): Promise<void> => {
    // A save may enqueue another save through an adapter's synchronous callback.
    let observed: Promise<void>;
    do { observed = saves; await observed; } while (observed !== saves);
    if (failures.length) throw new AggregateError(failures.splice(0), `Saving settings "${key}" failed.`);
  };

  const set = (value: T): void => {
    if (!current()) throw new Error(`Settings "${key}" belong to an ended scope.`);
    if (Object.is(value, values.source.read())) return;
    revision++;
    // Every accepted edit is ordered behind the previous save, including after
    // a failed save. The public flush/dispose promise owns error reporting.
    saves = saves.then(async () => {
      try { await storage.save(key, value); }
      catch (error) { failures.push(error); }
    });
    // Queue persistence before publishing: a subscriber may dispose the owner.
    values.set(value);
  };

  const dispose = (): Promise<void> => {
    if (!disposal) {
      closed = true;
      loading.abort();
      scope.signal.removeEventListener('abort', abortLoading);
      unregister();
      disposal = flush();
    }
    return disposal;
  };
  const unregister = scope.defer(dispose);
  scope.signal.addEventListener('abort', abortLoading, { once: true });

  const ready = new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      loading.signal.removeEventListener('abort', aborted);
      if (error !== undefined) reject(error);
      else resolve();
    };
    const aborted = () => finish();
    loading.signal.addEventListener('abort', aborted, { once: true });
    void Promise.resolve().then(() => {
      if (!current()) return undefined;
      return storage.load(key, loading.signal);
    }).then(saved => {
      try {
        if (current() && revision === 0) {
          let parsed: T | undefined;
          try { parsed = options.parse(saved); }
          catch { parsed = undefined; }
          if (parsed !== undefined && current() && revision === 0) values.set(parsed);
        }
        finish();
      } catch (error) { finish(error); }
    }, error => finish(current() ? error : undefined));
  });
  // Loading can fail before a consumer chooses to await ready. The same promise
  // remains rejected for that consumer without causing an unhandled rejection.
  void ready.catch(() => {});

  return Object.freeze({
    values: values.source,
    ready,
    set,
    update: (change: (previous: T) => T) => set(change(values.source.read())),
    flush,
    dispose,
  });
}
