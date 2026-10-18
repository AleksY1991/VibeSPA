import type { Scope } from '@vibespa/contracts';
import { describe, expect, it, vi } from 'vitest';
import { defineFeatureModule, FeatureType } from '../src/module.js';
import type { ModuleFactory } from '../src/module.js';
import { createSystem } from '../src/system.js';

type Inputs = Record<string, never>;
interface Exports { readonly value: string }

function feature(id: string, factory: ModuleFactory<Inputs, Exports> = () => ({ value: id })) {
  return defineFeatureModule<FeatureType.Service, Inputs, Exports>({
    id,
    kind: FeatureType.Service,
    title: `${id} service`,
    description: `Owns ${id}.`,
    contract: { inputs: {}, exports: { value: 'The public value.' } },
    load: async () => factory,
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

describe('observable system ownership', () => {
  it('keeps declarations inert, rejects duplicate instances before loading, and isolates systems', async () => {
    const loaded = deferred<ModuleFactory<Inputs, Exports>>();
    const load = vi.fn(() => loaded.promise);
    const definition = defineFeatureModule({ ...feature('one'), load });
    const first = createSystem({ id: 'first' });
    const second = createSystem({ id: 'second' });
    expect(load).not.toHaveBeenCalled();
    const pending = first.start(definition, {});
    await expect(first.start(definition, {})).rejects.toThrow('Duplicate module instance: one');
    expect(load).toHaveBeenCalledOnce();
    loaded.resolve(() => ({ value: 'one' }));
    const a = await pending;
    const b = await second.start(definition, {});
    expect(a).not.toBe(b);
    expect(a.exports).toEqual({ value: 'one' });
    await first.dispose();
    expect(second.snapshot.read().modules[0]?.state).toBe('ready');
    await second.dispose();
  });

  it('reports loader and constructor readiness with deeply immutable contract metadata', async () => {
    const loaded = deferred<ModuleFactory<Inputs, Exports>>();
    const constructed = deferred<Exports>();
    const began = deferred<void>();
    const definition = defineFeatureModule({ ...feature('slow'), load: () => loaded.promise });
    const system = createSystem({ id: 'app' });
    const pending = system.start(definition, {});
    expect(system.snapshot.read().modules[0]?.state).toBe('loading');
    loaded.resolve(() => { began.resolve(); return constructed.promise; });
    await began.promise;
    expect(system.snapshot.read().modules[0]?.state).toBe('starting');
    constructed.resolve({ value: 'ready' });
    await pending;
    const snapshot = system.snapshot.read();
    expect(snapshot.modules[0]).toMatchObject({
      id: 'slow', definitionId: 'slow', kind: FeatureType.Service, state: 'ready',
      contract: { inputs: [], exports: [{ name: 'value', description: 'The public value.' }] },
    });
    expect(snapshot.events.map(event => event.type)).toEqual(['loading', 'starting', 'ready']);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.modules[0]?.contract.exports[0])).toBe(true);
    await system.dispose();
    expect(snapshot.modules[0]?.state).toBe('ready');
  });

  it('accepts only ready dependency handles created by the same system', async () => {
    const system = createSystem({ id: 'app' });
    const foreign = createSystem({ id: 'foreign' });
    const dependency = await system.start(feature('dependency'), {});
    const other = await foreign.start(feature('other'), {});
    const load = vi.fn(async () => () => ({ value: 'dependent' }));
    const dependent = defineFeatureModule({ ...feature('dependent'), load });
    await expect(system.start(dependent, {}, { dependencies: [other] })).rejects.toThrow('does not belong');
    await expect(system.start(dependent, {}, { dependencies: [{ ...dependency }] })).rejects.toThrow('does not belong');
    await expect(system.start(dependent, {}, { dependencies: [dependency, dependency] })).rejects.toThrow('Duplicate dependency');
    expect(load).not.toHaveBeenCalled();
    await system.start(dependent, {}, { id: 'custom', dependencies: [dependency] });
    expect(system.snapshot.read().modules[1]?.dependencies).toEqual(['dependency']);
    const disposal = system.dispose();
    await expect(system.start(dependent, {}, { id: 'stale', dependencies: [dependency] })).rejects.toThrow('disposing');
    await disposal;
    await foreign.dispose();
  });

  it('rolls back failed construction while preserving siblings and both failure messages', async () => {
    const system = createSystem({ id: 'app' });
    await system.start(feature('good'), {});
    const broken = feature('broken', (_inputs, scope) => {
      scope.defer(() => { throw new Error('release failed'); });
      throw new Error('construction failed');
    });
    await expect(system.start(broken, {})).rejects.toBeInstanceOf(AggregateError);
    expect(system.snapshot.read().state).toBe('running');
    expect(system.snapshot.read().modules[0]?.state).toBe('ready');
    expect(system.snapshot.read().modules[1]).toMatchObject({ state: 'failed' });
    expect(system.snapshot.read().modules[1]?.error).toContain('construction failed');
    expect(system.snapshot.read().modules[1]?.error).toContain('release failed');
    expect(system.snapshot.read().events.map(event => event.type)).toContain('rolling-back');
    await system.dispose();
  });

  it('cancels immediately, waits for startup, and releases resources arriving after cancellation', async () => {
    const system = createSystem({ id: 'app' });
    const arrived = deferred<void>();
    const began = deferred<void>();
    const cleanup = vi.fn();
    const definition = feature('late', async (_inputs, scope) => {
      began.resolve();
      await arrived.promise;
      scope.defer(cleanup);
      return { value: 'stale' };
    });
    const pending = system.start(definition, {});
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await began.promise;
    const disposal = system.dispose();
    expect(system.dispose()).toBe(disposal);
    expect(system.snapshot.read().state).toBe('disposing');
    expect(system.snapshot.read().modules[0]?.state).toBe('cancelling');
    arrived.resolve();
    await disposal;
    await rejected;
    expect(cleanup).toHaveBeenCalledOnce();
    expect(system.snapshot.read().modules[0]?.state).toBe('cancelled');
    expect(system.snapshot.read().state).toBe('disposed');
  });

  it('skips a loader factory after cancellation and records cancelled rollback', async () => {
    const system = createSystem({ id: 'app' });
    const loaded = deferred<ModuleFactory<Inputs, Exports>>();
    const factory = vi.fn(() => ({ value: 'stale' }));
    const definition = defineFeatureModule({ ...feature('lazy'), load: () => loaded.promise });
    const pending = system.start(definition, {});
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const disposal = system.dispose();
    loaded.resolve(factory);
    await disposal;
    await rejected;
    expect(factory).not.toHaveBeenCalled();
    expect(system.snapshot.read().events.filter(event => event.moduleId).map(event => event.type))
      .toEqual(['loading', 'cancelling', 'rolling-back', 'cancelled']);
  });

  it('contains observer failures during startup, tracing, and cleanup', async () => {
    const system = createSystem({ id: 'app' });
    const received: string[] = [];
    const stopBroken = system.snapshot.subscribe(() => { throw new Error('broken inspector'); });
    const stopHealthy = system.snapshot.subscribe(snapshot => { received.push(snapshot.state); });
    const cleanup = vi.fn();
    const handle = await system.start(feature('service', (_inputs, scope) => {
      scope.defer(cleanup);
      return { value: 'ok' };
    }), {});
    await expect(system.trace(handle, 'read', () => handle.exports.value)).resolves.toBe('ok');
    await system.dispose();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(received).toContain('disposed');
    stopBroken();
    stopHealthy();
  });

  it('refuses a handle when an observer schedules disposal at the ready boundary', async () => {
    const system = createSystem({ id: 'app' });
    const stop = system.snapshot.subscribe(snapshot => {
      if (snapshot.modules[0]?.state === 'ready' && snapshot.state === 'running') {
        queueMicrotask(() => { void system.dispose(); });
      }
    });
    await expect(system.start(feature('service'), {})).rejects.toMatchObject({ name: 'AbortError' });
    await system.dispose();
    expect(system.snapshot.read().modules[0]?.state).toBe('disposed');
    stop();
  });

  it('refuses to invoke an operation if an observer disposes during its start notification', async () => {
    const system = createSystem({ id: 'app' });
    const handle = await system.start(feature('service'), {});
    const run = vi.fn();
    const stop = system.snapshot.subscribe(snapshot => {
      if (snapshot.events.at(-1)?.type === 'operation-started') void system.dispose();
    });
    await expect(system.trace(handle, 'late', run)).rejects.toThrow('disposing');
    expect(run).not.toHaveBeenCalled();
    await system.dispose();
    expect(system.snapshot.read().events.some(event => event.type === 'operation-failed')).toBe(true);
    stop();
  });

  it('reports rollback cleanup failure even when startup was cancelled', async () => {
    const system = createSystem({ id: 'app' });
    const arrived = deferred<void>();
    const began = deferred<void>();
    const pending = system.start(feature('broken', async (_inputs, scope) => {
      began.resolve();
      await arrived.promise;
      scope.defer(() => { throw new Error('late close failed'); });
      return { value: 'stale' };
    }), {});
    const rejected = expect(pending).rejects.toBeInstanceOf(AggregateError);
    await began.promise;
    const disposal = system.dispose();
    const failedDisposal = expect(disposal).rejects.toBeInstanceOf(AggregateError);
    arrived.resolve();
    await rejected;
    await failedDisposal;
    expect(system.snapshot.read().state).toBe('failed');
    expect(system.snapshot.read().modules[0]?.state).toBe('failed');
    expect(system.snapshot.read().modules[0]?.error).toContain('late close failed');
  });

  it('bounds the journal, clears only history, and keeps sequence identities monotonic', async () => {
    const system = createSystem({ id: 'app', eventLimit: 2 });
    const handle = await system.start(feature('service'), {});
    const first = system.snapshot.read();
    expect(first.events).toHaveLength(2);
    expect(first.droppedEvents).toBe(1);
    const sequence = first.events.at(-1)!.sequence;
    system.clearEvents();
    expect(system.snapshot.read().events).toEqual([]);
    expect(system.snapshot.read().droppedEvents).toBe(0);
    expect(system.snapshot.read().modules[0]?.state).toBe('ready');
    await system.trace(handle, 'work', () => 42);
    expect(system.snapshot.read().events[0]?.sequence).toBeGreaterThan(sequence);
    expect(system.snapshot.read().events.map(event => event.operation)).toEqual(['work', 'work']);
    await system.dispose();
  });

  it('preserves operation results and errors without exposing payloads', async () => {
    const system = createSystem({ id: 'app' });
    const handle = await system.start(feature('service'), {});
    const value = { secret: 'private' };
    await expect(system.trace(handle, 'fetch', async () => value)).resolves.toBe(value);
    const failure = new Error('command failed');
    await expect(system.trace(handle, 'save', () => { throw failure; })).rejects.toBe(failure);
    expect(system.snapshot.read().events.at(-1)).toMatchObject({
      type: 'operation-failed', moduleId: 'service', operation: 'save', error: 'command failed',
    });
    expect(JSON.stringify(system.snapshot.read())).not.toContain('private');
    await system.dispose();
    const run = vi.fn();
    await expect(system.trace(handle, 'late', run)).rejects.toThrow('disposed');
    expect(run).not.toHaveBeenCalled();
  });

  it('aborts all modules before disposing dependents and preserves failed teardown', async () => {
    const events: string[] = [];
    const system = createSystem({ id: 'app' });
    const factory = (id: string, broken = false) => (_inputs: Inputs, scope: Scope) => {
      scope.signal.addEventListener('abort', () => { events.push(`${id}:abort`); });
      scope.defer(() => {
        events.push(`${id}:dispose`);
        if (broken) throw new Error(`${id} close failed`);
      });
      return { value: id };
    };
    const dependency = await system.start(feature('database', factory('database')), {});
    await system.start(feature('feature', factory('feature', true)), {}, { dependencies: [dependency] });
    await expect(system.dispose()).rejects.toBeInstanceOf(AggregateError);
    expect(events).toEqual(['database:abort', 'feature:abort', 'feature:dispose', 'database:dispose']);
    expect(system.snapshot.read().state).toBe('failed');
    expect(system.snapshot.read().modules.map(module => module.state)).toEqual(['disposed', 'failed']);
    expect(system.snapshot.read().modules[1]?.error).toContain('feature close failed');
    expect(system.snapshot.read().events.at(-1)?.error).toContain('feature close failed');
  });

  it('validates system identity and journal limits before construction', () => {
    expect(() => createSystem({ id: ' ' })).toThrow('System id');
    expect(() => createSystem({ id: 'app', eventLimit: -1 })).toThrow('event limit');
    expect(() => createSystem({ id: 'app', eventLimit: 1.5 })).toThrow('event limit');
  });

  it('retains the system identity captured at construction', async () => {
    const options = { id: 'original' };
    const system = createSystem(options);
    options.id = 'changed';
    await system.start(feature('service'), {});
    expect(system.snapshot.read().id).toBe('original');
    await system.dispose();
  });
});
