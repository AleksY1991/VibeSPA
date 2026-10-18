import { createRoot } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import type { Readable } from '@vibespa/contracts';
import { createScope, createSource } from '@vibespa/core';
import { consumeReadable, ownScope } from '../src/index.js';

describe('Solid read capability adapter', () => {
  it('reads stored values and releases its only subscription with the view', async () => {
    const owner = createSource('first');
    const unsubscribe = vi.fn();
    const subscribe = vi.fn((listener: (value: string) => void) => {
      const stop = owner.source.subscribe(listener);
      return () => { unsubscribe(); stop(); };
    });
    const source = { read: owner.source.read, subscribe };
    const mounted = createRoot(dispose => ({ read: consumeReadable(source), dispose }));
    expect(mounted.read()).toBe('first');
    owner.set('second');
    await Promise.resolve();
    expect(mounted.read()).toBe('second');
    expect(subscribe).toHaveBeenCalledTimes(1);
    mounted.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    owner.set('departed');
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('resamples after subscription acquisition so a racing update is retained', async () => {
    let current = 1;
    const source: Readable<number> = {
      read: () => current,
      subscribe: () => { current = 2; return () => {}; },
    };
    const mounted = createRoot(dispose => ({ read: consumeReadable(source), dispose }));
    await Promise.resolve();
    expect(mounted.read()).toBe(2);
    mounted.dispose();
  });

  it('requires an owner instead of leaking a detached subscription', () => {
    const source = createSource(0);
    expect(() => consumeReadable(source.source)).toThrow('requires a Solid owner');
  });

  it('forwards asynchronous scope cleanup failures to the rendering host', async () => {
    const scope = createScope();
    scope.defer(() => { throw new Error('cleanup failed'); });
    const onError = vi.fn();
    const dispose = createRoot(dispose => { ownScope(scope, onError); return dispose; });
    dispose();
    await scope.dispose().catch(() => {});
    expect(scope.signal.aborted).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
