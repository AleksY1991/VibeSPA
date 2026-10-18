import { describe, expect, it, vi } from 'vitest';
import { createScope } from '@vibespa/core/scope';
import { createSettings, type SettingsStorage } from '../src/index.js';

interface Preferences { readonly density: 'calm' | 'compact' }
const defaults: Preferences = { density: 'calm' };
const compact: Preferences = { density: 'compact' };
const parse = (value: unknown): Preferences | undefined => {
  if (value && typeof value === 'object' && 'density' in value
    && (value.density === 'calm' || value.density === 'compact')) return { density: value.density };
  return undefined;
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

describe('owned settings', () => {
  it('provides defaults synchronously and loads validated values without writing them back', async () => {
    const scope = createScope();
    const loaded = deferred<unknown>();
    const storage = { load: vi.fn(() => loaded.promise), save: vi.fn() };
    const settings = createSettings({ scope, key: 'preferences', defaults, storage, parse });
    const changes: Preferences[] = [];
    settings.values.subscribe(value => changes.push(value));
    expect(settings.values.read()).toBe(defaults);
    loaded.resolve(compact);
    await settings.ready;
    expect(settings.values.read()).toEqual(compact);
    expect(changes).toEqual([compact]);
    expect(storage.save).not.toHaveBeenCalled();
    await scope.dispose();
  });

  it.each([undefined, { density: 'unknown' }, 'broken'])('keeps defaults for invalid saved data: %s', async saved => {
    const scope = createScope();
    const storage = { load: () => saved, save: vi.fn() };
    const settings = createSettings({ scope, key: 'preferences', defaults, storage, parse });
    await settings.ready;
    expect(settings.values.read()).toBe(defaults);
    expect(storage.save).not.toHaveBeenCalled();
    await scope.dispose();
  });

  it('keeps defaults when the supplied parser rejects with an exception', async () => {
    const scope = createScope();
    const settings = createSettings({ scope, key: 'preferences', defaults,
      storage: { load: () => compact, save: () => {} }, parse: () => { throw new Error('invalid'); } });
    await settings.ready;
    expect(settings.values.read()).toBe(defaults);
    await scope.dispose();
  });

  it('preserves a local edit made while loading', async () => {
    const scope = createScope();
    const loaded = deferred<unknown>();
    const save = vi.fn();
    const settings = createSettings({ scope, key: 'preferences', defaults,
      storage: { load: () => loaded.promise, save }, parse });
    settings.set(compact);
    loaded.resolve(defaults);
    await settings.ready;
    await settings.flush();
    expect(settings.values.read()).toBe(compact);
    expect(save).toHaveBeenCalledExactlyOnceWith('preferences', compact);
    await scope.dispose();
  });

  it('serializes saves and makes scope teardown await the final edit', async () => {
    const scope = createScope();
    const first = deferred<void>();
    const writes: Preferences[] = [];
    const storage: SettingsStorage<Preferences> = {
      load: () => undefined,
      async save(_key, value) {
        writes.push(value);
        if (writes.length === 1) await first.promise;
      },
    };
    const settings = createSettings({ scope, key: 'preferences', defaults, storage, parse });
    await settings.ready;
    settings.set(compact);
    settings.update(() => defaults);
    await Promise.resolve();
    expect(writes).toEqual([compact]);
    let disposed = false;
    const disposal = scope.dispose().then(() => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);
    first.resolve();
    await disposal;
    expect(writes).toEqual([compact, defaults]);
    expect(() => settings.set(compact)).toThrow('ended scope');
  });

  it('does not publish a stale load and settles readiness when the owner ends', async () => {
    const scope = createScope();
    const loaded = deferred<unknown>();
    let loadSignal: AbortSignal | undefined;
    const settings = createSettings({ scope, key: 'preferences', defaults,
      storage: { load: (_key, signal) => { loadSignal = signal; return loaded.promise; }, save: () => {} }, parse });
    const changes = vi.fn();
    settings.values.subscribe(changes);
    await Promise.resolve();
    const disposal = settings.dispose();
    expect(settings.dispose()).toBe(disposal);
    await disposal;
    await settings.ready;
    expect(loadSignal?.aborted).toBe(true);
    loaded.resolve(compact);
    await Promise.resolve();
    await Promise.resolve();
    expect(settings.values.read()).toBe(defaults);
    expect(changes).not.toHaveBeenCalled();
    await scope.dispose();
  });

  it('blocks stale publication on parent cancellation before explicit teardown', async () => {
    const parent = new AbortController();
    const scope = createScope(parent.signal);
    const loaded = deferred<unknown>();
    const settings = createSettings({ scope, key: 'preferences', defaults,
      storage: { load: () => loaded.promise, save: () => {} }, parse });
    await Promise.resolve();
    parent.abort();
    await settings.ready;
    loaded.resolve(compact);
    await Promise.resolve();
    expect(settings.values.read()).toBe(defaults);
    expect(() => settings.set(compact)).toThrow('ended scope');
    await scope.dispose();
  });

  it('flushes an edit even when its subscriber immediately disposes the owner', async () => {
    const scope = createScope();
    const save = vi.fn();
    const settings = createSettings({ scope, key: 'preferences', defaults,
      storage: { load: () => undefined, save }, parse });
    await settings.ready;
    let disposal: Promise<void> | undefined;
    settings.values.subscribe(() => { disposal = settings.dispose(); });
    settings.set(compact);
    await disposal;
    expect(save).toHaveBeenCalledExactlyOnceWith('preferences', compact);
    await scope.dispose();
  });

  it('reports failed saves while allowing later saves to continue', async () => {
    const scope = createScope();
    const save = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined);
    const settings = createSettings({ scope, key: 'preferences', defaults,
      storage: { load: () => undefined, save }, parse });
    await settings.ready;
    settings.set(compact);
    settings.set(defaults);
    await expect(settings.flush()).rejects.toThrow('Saving settings');
    expect(save).toHaveBeenCalledTimes(2);
    await scope.dispose();
  });

  it('exposes load failures through readiness and retains defaults', async () => {
    const scope = createScope();
    const settings = createSettings({ scope, key: 'preferences', defaults,
      storage: { load: () => Promise.reject(new Error('unavailable')), save: () => {} }, parse });
    await expect(settings.ready).rejects.toThrow('unavailable');
    expect(settings.values.read()).toBe(defaults);
    await scope.dispose();
  });
});
