import { describe, expect, it, vi } from 'vitest';
import type { Scope } from '@vibespa/contracts';
import { defineFeatureModule, FeatureType } from '../src/module.js';
import type { ModuleContext, ModuleFactory } from '../src/module.js';
import { createSystem, external, from } from '../src/system.js';

type Empty = Record<string, never>;
interface Value { value: object }

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

function provider(factory: ModuleFactory<Empty, Value>) {
  return defineFeatureModule({
    id: 'provider', kind: FeatureType.Store, title: 'Provider', description: 'Owns a resource.',
    contract: { inputs: {}, exports: { value: 'Borrowed resource.' } },
    load: async () => factory,
  });
}

function consumer(load: () => Promise<ModuleFactory<Value, Value>>) {
  return defineFeatureModule({
    id: 'consumer', kind: FeatureType.Feature, title: 'Consumer', description: 'Borrows a resource.',
    contract: { inputs: { value: 'Borrowed resource.' }, exports: { value: 'Same resource.' } },
    load,
  });
}

describe('provider readiness at original factory entry', () => {
  it('rejects startup after disposal during loading and awaits rollback', async () => {
    const loaded = deferred<ModuleFactory<Value, Value>>();
    const cleanupBegan = deferred<void>();
    const cleanupGate = deferred<void>();
    let cleanupCompleted = false;
    const factory = vi.fn((inputs: Value) => inputs);
    const providerClose = vi.fn();
    const consumerClose = vi.fn(async () => {
      cleanupBegan.resolve();
      await cleanupGate.promise;
      cleanupCompleted = true;
    });
    const runtimeClose = vi.fn();
    let providerScope!: ModuleContext;
    let runtimes = 0;
    const system = createSystem({
      id: 'app',
      createRuntime(scope) {
        const isConsumer = ++runtimes === 2;
        if (isConsumer) scope.defer(consumerClose);
        return {
          run: operation => operation(), quiesce() {},
          dispose() { if (isConsumer) runtimeClose(); return []; },
        };
      },
    });
    const storage = await system.start(provider((_inputs, scope) => {
      providerScope = scope;
      scope.defer(providerClose);
      return { value: {} };
    }), {});
    const definition = consumer(() => loaded.promise);
    const pending = system.start(definition, { value: from(storage, 'value') });
    let startupSettled = false;
    void pending.then(() => { startupSettled = true; }, () => { startupSettled = true; });
    const rejected = expect(pending).rejects.toThrow('provider is disposed');
    await providerScope.dispose();
    loaded.resolve(factory);
    await cleanupBegan.promise;
    expect(startupSettled).toBe(false);
    expect(system.snapshot.read().modules.find(module => module.id === 'consumer')?.state).toBe('rolling-back');
    cleanupGate.resolve();
    await rejected;
    expect(cleanupCompleted).toBe(true);
    expect(factory).not.toHaveBeenCalled();
    expect(runtimeClose).toHaveBeenCalledOnce();
    expect(consumerClose).toHaveBeenCalledOnce();
    expect(providerClose).toHaveBeenCalledOnce();
    expect(system.snapshot.read().modules.find(module => module.id === 'consumer')?.state).toBe('failed');
    expect(system.snapshot.read().events.filter(event => event.moduleId === 'consumer').map(event => event.type))
      .toEqual(['loading', 'starting', 'rolling-back', 'failed']);
    await system.dispose();
    expect(providerClose).toHaveBeenCalledOnce();
    expect(consumerClose).toHaveBeenCalledOnce();
  });

  it.each(['runtime creation', 'runtime entry', 'starting observer'] as const)(
    'rechecks providers after %s', async stage => {
      let providerScope!: ModuleContext;
      let runtimes = 0;
      let invalidated = false;
      const rollback = vi.fn();
      const factory = vi.fn((inputs: Value) => inputs);
      const stopProvider = () => {
        if (!invalidated) { invalidated = true; void providerScope.dispose(); }
      };
      const system = createSystem({
        id: 'app',
        createRuntime(scope) {
          const isConsumer = ++runtimes === 2;
          if (isConsumer) {
            scope.defer(rollback);
            if (stage === 'runtime creation') stopProvider();
          }
          return {
            run(operation) {
              if (isConsumer && stage === 'runtime entry') stopProvider();
              return operation();
            },
            quiesce() {}, dispose: () => [],
          };
        },
      });
      const storage = await system.start(provider((_inputs, scope) => {
        providerScope = scope;
        return { value: {} };
      }), {});
      const unsubscribe = system.snapshot.subscribe(snapshot => {
        const event = snapshot.events.at(-1);
        if (stage === 'starting observer' && event?.moduleId === 'consumer' && event.type === 'starting') stopProvider();
      });
      const definition = consumer(async () => factory);
      const pending = system.start(definition, { value: from(storage, 'value') });
      await expect(pending).rejects.toThrow(/provider is (disposing|disposed)/);
      expect(invalidated).toBe(true);
      expect(factory).not.toHaveBeenCalled();
      expect(rollback).toHaveBeenCalledOnce();
      unsubscribe();
      await system.dispose();
    },
  );

  it.each(['system', 'consumer'] as const)('rechecks admission and cancellation after runtime entry: %s', async target => {
    const value = {};
    const rollback = vi.fn();
    const factory = vi.fn((inputs: Value) => inputs);
    const system = createSystem({
      id: 'app',
      createRuntime(scope) {
        scope.defer(rollback);
        return {
          run(operation) {
            if (target === 'system') void system.dispose();
            else void scope.dispose();
            return operation();
          },
          quiesce() {}, dispose: () => [],
        };
      },
    });
    const definition = consumer(async () => factory);
    const pending = system.start(definition, { value: external(value) });
    await expect(pending).rejects.toBeInstanceOf(Error);
    expect(factory).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledOnce();
    await system.dispose();
  });

  it.each(['earlier provider', 'system', 'consumer'] as const)('rechecks all admission after a later getter invalidates %s', async target => {
    let providerScope!: ModuleContext;
    let consumerScope!: Scope;
    let runtimes = 0;
    const getter = vi.fn(() => {
      if (target === 'earlier provider') void providerScope.dispose();
      else if (target === 'system') void system.dispose();
      else void consumerScope.dispose();
      return {};
    });
    const rollback = vi.fn();
    const factory = vi.fn((_inputs: { first: object; second: object }) => ({ value: {} }));
    const system = createSystem({
      id: 'app',
      createRuntime(scope) {
        if (++runtimes === 3) { consumerScope = scope; scope.defer(rollback); }
        return { run: operation => operation(), quiesce() {}, dispose: () => [] };
      },
    });
    const first = await system.start(provider((_inputs, scope) => {
      providerScope = scope;
      return { value: {} };
    }), {}, { id: 'first' });
    const second = await system.start(provider(() => ({ get value() { return getter(); } })), {}, { id: 'second' });
    const definition = defineFeatureModule({
      id: 'consumer', kind: FeatureType.Feature, title: 'Consumer', description: 'Borrows two resources.',
      contract: { inputs: { first: 'Earlier provider.', second: 'Later provider.' }, exports: { value: 'Result.' } },
      load: async () => factory,
    });
    const pending = system.start(definition, { first: from(first, 'value'), second: from(second, 'value') });
    await expect(pending).rejects.toBeInstanceOf(Error);
    expect(getter).toHaveBeenCalledOnce();
    expect(factory).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledOnce();
    await system.dispose();
  });

  it('releases only failed consumer acquisitions and joins bound tasks/traces before reverse resource cleanup', async () => {
    const events: string[] = [];
    const failedClose = vi.fn();
    const providerClose = vi.fn(() => { events.push('provider'); });
    const consumerClose = vi.fn(() => { events.push('consumer'); });
    const taskGate = deferred<void>();
    const traceGate = deferred<void>();
    let scope!: ModuleContext;
    let entered = false;
    const system = createSystem({
      id: 'app',
      createRuntime: () => ({
        run(operation) {
          entered = true;
          try { return operation(); } finally { entered = false; }
        },
        quiesce() {}, dispose: () => [],
      }),
    });
    const storage = await system.start(provider((_inputs, context) => {
      context.defer(providerClose);
      return { value: {} };
    }), {});
    await expect(system.start(consumer(async () => (_inputs, context) => {
      context.defer(failedClose);
      throw new Error('consumer failed');
    }), { value: from(storage, 'value') })).rejects.toThrow('consumer failed');
    expect(failedClose).toHaveBeenCalledOnce();
    expect(providerClose).not.toHaveBeenCalled();
    expect(system.snapshot.read().modules[0]?.state).toBe('ready');
    const handle = await system.start(consumer(async () => (inputs, context) => {
      expect(entered).toBe(true);
      scope = context;
      context.defer(consumerClose);
      return inputs;
    }), { value: from(storage, 'value') }, { id: 'successful-consumer' });
    const task = scope.task(async () => {
      expect(entered).toBe(true);
      await taskGate.promise;
      events.push('task');
    });
    const trace = system.trace(handle, 'borrow', async () => {
      expect(entered).toBe(true);
      await traceGate.promise;
      events.push('trace');
    });
    const disposal = system.dispose();
    await Promise.resolve();
    expect(consumerClose).not.toHaveBeenCalled();
    expect(providerClose).not.toHaveBeenCalled();
    traceGate.resolve();
    await trace;
    expect(consumerClose).not.toHaveBeenCalled();
    taskGate.resolve();
    await task;
    await disposal;
    expect(events).toEqual(['trace', 'task', 'consumer', 'provider']);
    expect(consumerClose).toHaveBeenCalledOnce();
    expect(providerClose).toHaveBeenCalledOnce();
    expect(failedClose).toHaveBeenCalledOnce();
  });
});
