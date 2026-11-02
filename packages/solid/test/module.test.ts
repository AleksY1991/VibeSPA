import { createEffect, createRoot, createSignal, flush, getOwner, isDisposed, onCleanup } from 'solid-js';
import type { Owner } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import { defineFeatureModule, FeatureType, from } from '@vibespa/core';
import type { ModuleContext } from '@vibespa/core/module';
import { createSource, createSystem } from '@vibespa/core';
import type { Readable } from '@vibespa/contracts';
import { createModuleEffect, createSolidSystem, moduleAccessor, onModuleCleanup } from '../src/module.js';

interface TestExports { read(): number }
function feature(id: string, create: (scope: ModuleContext) => TestExports | Promise<TestExports>) {
  return defineFeatureModule<FeatureType.Service, Record<string, never>, TestExports>({
    id, kind: FeatureType.Service, title: id, description: `Owns ${id}.`,
    contract: { inputs: {}, exports: { read: 'Read the test value.' } },
    load: async () => (_inputs, scope) => create(scope),
  });
}

/** A dependent whose only input is the provider's exports, bound with from(). */
function dependent(create: (scope: ModuleContext) => TestExports | Promise<TestExports>) {
  return defineFeatureModule<FeatureType.Service, { readonly provider: TestExports }, TestExports>({
    id: 'dependent', kind: FeatureType.Service, title: 'dependent', description: 'Borrows the provider.',
    contract: { inputs: { provider: 'The provider exports.' }, exports: { read: 'Read the test value.' } },
    load: async () => (_inputs, scope) => create(scope),
  });
}

describe('owned module lifetimes', () => {
  it('gives instances distinct owners that outlive an incidental rendering owner', async () => {
    const rendering = createRoot(dispose => ({ dispose, system: createSolidSystem({ id: 'owned' }) }));
    const captured: Owner[] = [];
    const create = () => { captured.push(getOwner()!); return { read: () => 1 }; };
    await rendering.system.start(feature('first', create), {});
    await rendering.system.start(feature('second', create), {});
    expect(captured[0]).not.toBe(captured[1]);
    rendering.dispose();
    expect(captured.every(owner => !isDisposed(owner))).toBe(true);
    await rendering.system.dispose();
    expect(captured.every(owner => isDisposed(owner))).toBe(true);
  });

  it('reenters the module for commands and explicit continuations after await', async () => {
    const system = createSolidSystem({ id: 'continuations' });
    let context!: ModuleContext;
    let owner!: Owner;
    const handle = await system.start(feature('one', async scope => {
      context = scope;
      owner = getOwner()!;
      await Promise.resolve();
      expect(getOwner()).toBeNull();
      expect(scope.run(() => getOwner())).toBe(owner);
      return { read: () => getOwner() === owner ? 1 : 0 };
    }), {});
    expect(await system.trace(handle, 'read', handle.exports.read)).toBe(1);
    await system.dispose();
    expect(() => context.run(() => 1)).toThrow();
    await expect(context.task(() => 1)).rejects.toThrow();
  });

  it('stops queued effects and releases their subscriptions before resources close', async () => {
    const system = createSolidSystem({ id: 'effects' });
    const events: string[] = [];
    let update!: (value: number) => void;
    await system.start(feature('one', scope => {
      let open = true;
      scope.defer(() => { events.push('close'); open = false; });
      const [value, setValue] = createSignal(() => 1);
      update = setValue;
      createModuleEffect(scope, value, current => {
        events.push(`effect:${current}`);
        return () => { expect(open).toBe(true); events.push('unsubscribe'); };
      });
      return { read: value };
    }), {});
    flush();
    expect(events).toEqual(['effect:1']);
    update(2);
    const closing = system.dispose();
    flush();
    await closing;
    expect(events).toEqual(['effect:1', 'unsubscribe', 'close']);
  });

  it('attempts every managed reactive and asynchronous resource cleanup after a failure', async () => {
    const system = createSolidSystem({ id: 'cleanup' });
    const events: string[] = [];
    await system.start(feature('one', scope => {
      onModuleCleanup(scope, () => { events.push('first'); });
      onModuleCleanup(scope, () => { events.push('broken'); throw new Error('reactive cleanup failed'); });
      scope.defer(async () => { await Promise.resolve(); events.push('resource'); });
      return { read: () => 1 };
    }), {});
    await expect(system.dispose()).rejects.toBeInstanceOf(AggregateError);
    expect(events).toEqual(['broken', 'first', 'resource']);
    expect(system.snapshot.read().modules[0]?.error).toContain('reactive cleanup failed');
  });

  it('joins accidental async reactive cleanup and reports the contract violation', async () => {
    const system = createSolidSystem({ id: 'async-cleanup' });
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const resource = vi.fn();
    await system.start(feature('one', scope => {
      onModuleCleanup(scope, () => done);
      scope.defer(resource);
      return { read: () => 1 };
    }), {});
    const closing = system.dispose();
    const rejected = expect(closing).rejects.toBeInstanceOf(AggregateError);
    await Promise.resolve();
    expect(resource).not.toHaveBeenCalled();
    finish();
    await rejected;
    expect(resource).toHaveBeenCalledOnce();
    expect(system.snapshot.read().modules[0]?.error).toContain('must be synchronous');
  });

  it('accounts for a resource arriving after canceled startup without publishing it', async () => {
    const system = createSolidSystem({ id: 'late-acquisition' });
    let arrive!: (value: { close(): void }) => void;
    let began!: () => void;
    const opening = new Promise<void>(resolve => { began = resolve; });
    const acquired = new Promise<{ close(): void }>(resolve => { arrive = resolve; });
    const close = vi.fn();
    const started = system.start(feature('one', async scope => {
      await scope.acquire(() => { began(); return acquired; }, resource => { resource.close(); });
      return { read: () => 1 };
    }), {});
    const rejected = expect(started).rejects.toMatchObject({ name: 'AbortError' });
    await opening;
    const closing = system.dispose();
    arrive({ close });
    await rejected;
    await closing;
    expect(close).toHaveBeenCalledOnce();
    expect(system.snapshot.read().modules[0]?.state).toBe('cancelled');
  });

  it('retains remaining resources after an unsupported cleanup interrupts Solid traversal', async () => {
    const system = createSolidSystem({ id: 'incomplete' });
    const providerClose = vi.fn();
    const dependentClose = vi.fn();
    const provider = await system.start(feature('provider', scope => {
      scope.defer(providerClose);
      return { read: () => 1 };
    }), {});
    await system.start(dependent(scope => {
      // Deliberately bypass the managed cleanup API to exercise the fatal barrier.
      onCleanup(() => { throw new Error('unprotected cleanup'); });
      scope.defer(dependentClose);
      return { read: () => 1 };
    }), { provider: from(provider) });
    await expect(system.dispose()).rejects.toBeInstanceOf(AggregateError);
    expect(providerClose).not.toHaveBeenCalled();
    expect(dependentClose).not.toHaveBeenCalled();
    expect(system.snapshot.read().state).toBe('failed');
    expect(system.snapshot.read().modules.every(module => module.state === 'failed')).toBe(true);
  });

  it('retains provider resources when a failing dependent cleanup reenters provider disposal', async () => {
    const system = createSolidSystem({ id: 'reentrant-incomplete' });
    const providerClose = vi.fn();
    let providerScope!: ModuleContext;
    const provider = await system.start(feature('provider', scope => {
      providerScope = scope;
      scope.defer(providerClose);
      return { read: () => 1 };
    }), {});
    await system.start(dependent(scope => {
      onCleanup(() => {
        // The provider begins disposal before this traversal reports its failure.
        void providerScope.dispose().catch(() => {});
        throw new Error('dependent traversal interrupted');
      });
      scope.defer(() => {});
      return { read: () => 1 };
    }), { provider: from(provider) });
    await expect(system.dispose()).rejects.toBeInstanceOf(AggregateError);
    expect(providerClose).not.toHaveBeenCalled();
    expect(system.snapshot.read().modules.every(module => module.state === 'failed')).toBe(true);
  });

  it('rechecks teardown safety after joining an in-flight provider operation', async () => {
    const system = createSolidSystem({ id: 'joining-incomplete' });
    let providerScope!: ModuleContext;
    let dependentScope!: ModuleContext;
    let providerOwner!: Owner;
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const providerClose = vi.fn();
    const provider = await system.start(feature('provider', scope => {
      providerScope = scope;
      providerOwner = getOwner()!;
      scope.defer(providerClose);
      return { read: () => 1 };
    }), {});
    await system.start(dependent(scope => {
      dependentScope = scope;
      onCleanup(() => { throw new Error('dependent traversal interrupted'); });
      return { read: () => 1 };
    }), { provider: from(provider) });
    const operation = system.trace(provider, 'pending', () => done);
    const providerDisposal = providerScope.dispose();
    const providerFailed = expect(providerDisposal).rejects.toBeInstanceOf(AggregateError);
    // Drain microtasks so the provider has released its root and is joining work.
    await new Promise<void>(resolve => { setTimeout(resolve, 0); });
    expect(isDisposed(providerOwner)).toBe(true);
    expect(providerClose).not.toHaveBeenCalled();
    await expect(dependentScope.dispose()).rejects.toBeInstanceOf(AggregateError);
    finish();
    await operation;
    await providerFailed;
    expect(providerClose).not.toHaveBeenCalled();
    await expect(system.dispose()).rejects.toBeInstanceOf(AggregateError);
  });

  it('retains remaining acquired resources when a different unwind fails during awaited cleanup', async () => {
    const system = createSolidSystem({ id: 'resource-drain-incomplete' });
    let providerScope!: ModuleContext;
    let dependentScope!: ModuleContext;
    let began!: () => void;
    let finish!: () => void;
    const beginning = new Promise<void>(resolve => { began = resolve; });
    const done = new Promise<void>(resolve => { finish = resolve; });
    const providerClose = vi.fn();
    const provider = await system.start(feature('provider', async scope => {
      providerScope = scope;
      await scope.acquire(() => ({}), providerClose);
      scope.defer(async () => { began(); await done; });
      return { read: () => 1 };
    }), {});
    await system.start(dependent(scope => {
      dependentScope = scope;
      onCleanup(() => { throw new Error('dependent traversal interrupted'); });
      return { read: () => 1 };
    }), { provider: from(provider) });
    const providerDisposal = providerScope.dispose();
    const providerFailed = expect(providerDisposal).rejects.toBeInstanceOf(AggregateError);
    await beginning;
    await expect(dependentScope.dispose()).rejects.toBeInstanceOf(AggregateError);
    finish();
    await providerFailed;
    expect(providerClose).not.toHaveBeenCalled();
    await expect(system.dispose()).rejects.toBeInstanceOf(AggregateError);
  });

  describe('moduleAccessor', () => {
    function counted<T>(source: Readable<T>) {
      let active = 0;
      return {
        get active() { return active; },
        readable: {
          read: source.read,
          subscribe(listener: (value: T) => void) {
            active++;
            const release = source.subscribe(listener);
            return () => { active--; release(); };
          },
        } satisfies Readable<T>,
      };
    }

    it('creates an owned, tracked accessor after an await and releases it with the module', async () => {
      const owner = createSource(1);
      const source = counted(owner.source);
      const system = createSolidSystem({ id: 'accessor' });
      let value!: () => number;
      await system.start(feature('reader', async scope => {
        await Promise.resolve();
        // No ambient owner here: moduleAccessor enters the module owner itself.
        expect(getOwner()).toBeNull();
        value = moduleAccessor(scope, source.readable);
        return { read: value };
      }), {});
      expect(source.active).toBe(1);
      const seen: number[] = [];
      const stop = createRoot(dispose => {
        createEffect(() => value(), next => { seen.push(next); });
        return dispose;
      });
      flush();
      owner.set(2);
      flush();
      expect(seen).toEqual([1, 2]);
      stop();
      await system.dispose();
      expect(source.active).toBe(0);
    });

    it('refuses scopes without a Solid module runtime and after cancellation', async () => {
      const plain = createSystem({ id: 'plain' });
      const source = createSource(0);
      await expect(plain.start(feature('plain', scope => ({ read: moduleAccessor(scope, source.source) })), {}))
        .rejects.toThrow('not started by a Solid module runtime');
      await plain.dispose();
      const system = createSolidSystem({ id: 'cancelled' });
      let captured!: ModuleContext;
      await system.start(feature('late', scope => { captured = scope; return { read: () => 0 }; }), {});
      const disposal = system.dispose();
      expect(() => moduleAccessor(captured, source.source)).toThrow();
      await disposal;
    });
  });
});
