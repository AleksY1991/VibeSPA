import { describe, expect, it, vi } from 'vitest';
import { createSystem, defineFeatureModule, FeatureType } from '@vibespa/core';
import { startApplication } from './startApplication';
import { startApplicationGeneration, type ApplicationGeneration } from './startApplicationGeneration';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function renderers() {
  const active = new Map<'application' | 'inspector' | 'error', string>();
  const order: string[] = [];
  return {
    active,
    order,
    mount(kind: 'application' | 'inspector' | 'error', id: string) {
      if (active.has(kind)) throw new Error(`Duplicate ${kind} renderer`);
      if (kind === 'application' && active.has('error')) throw new Error('Startup error is still mounted');
      if (kind === 'error' && active.has('application')) throw new Error('Application is still mounted');
      active.set(kind, id);
      order.push(`mount ${kind} ${id}`);
      return () => {
        expect(active.get(kind)).toBe(id);
        active.delete(kind);
        order.push(`unmount ${kind} ${id}`);
      };
    },
  };
}

describe('application generation handoff', () => {
  it('waits for shutdown and replaces diagnostic roots only after successful cleanup', async () => {
    const closing = deferred();
    const views = renderers();
    const openNext = vi.fn();
    const first = startApplicationGeneration({
      mountInspector: () => views.mount('inspector', 'first'),
      startApplication: () => startApplication(
        async () => ({ dispose: () => closing.promise }),
        () => views.mount('application', 'first'),
      ),
      disposeSystem: async () => { views.order.push('close first system'); },
      showStartupError: () => views.mount('error', 'first'),
    });
    await first.ready;
    const shutdown = first.dispose();
    expect(first.dispose()).toBe(shutdown);
    const second = startApplicationGeneration({
      previous: first,
      mountInspector: () => views.mount('inspector', 'second'),
      startApplication: () => {
        openNext();
        return startApplication(async () => ({ dispose: async () => {} }), () => views.mount('application', 'second'));
      },
      disposeSystem: async () => {},
      showStartupError: () => views.mount('error', 'second'),
    });
    await Promise.resolve();
    expect(openNext).not.toHaveBeenCalled();
    expect(views.active.get('inspector')).toBe('first');

    closing.resolve();
    await second.ready;
    expect(openNext).toHaveBeenCalledOnce();
    expect(views.active).toEqual(new Map([['inspector', 'second'], ['application', 'second']]));
    expect(views.order.indexOf('unmount application first')).toBeLessThan(views.order.indexOf('close first system'));
    expect(views.order.indexOf('unmount inspector first')).toBeLessThan(views.order.indexOf('mount inspector second'));
    await second.dispose();
    expect(views.active.size).toBe(0);
  });

  it.each(['application', 'system'] as const)('retains the failed snapshot after %s cleanup fails and blocks later opens', async (failure) => {
    const views = renderers();
    const cleanupError = new Error(`${failure} cleanup failed`);
    const closeSystem = vi.fn(async () => { if (failure === 'system') throw cleanupError; });
    const first = startApplicationGeneration({
      mountInspector: () => views.mount('inspector', 'failed snapshot'),
      startApplication: () => startApplication(
        async () => ({ dispose: async () => { if (failure === 'application') throw cleanupError; } }),
        () => views.mount('application', 'first'),
      ),
      disposeSystem: closeSystem,
      showStartupError: () => views.mount('error', 'first'),
    });
    await first.ready;
    await expect(first.dispose()).rejects.toBe(cleanupError);
    expect(closeSystem).toHaveBeenCalledOnce();
    expect(views.active).toEqual(new Map([['inspector', 'failed snapshot']]));

    const attempt = vi.fn();
    function next(previous: ApplicationGeneration) {
      return startApplicationGeneration({
        previous,
        mountInspector: () => { attempt(); return views.mount('inspector', 'replacement'); },
        startApplication: () => { attempt(); return { ready: Promise.resolve(), dispose: async () => {} }; },
        disposeSystem: async () => {},
        showStartupError: () => { attempt(); return views.mount('error', 'replacement'); },
      });
    }
    const second = next(first);
    await expect(second.ready).rejects.toBe(cleanupError);
    await expect(second.dispose()).rejects.toBe(cleanupError);
    const third = next(second);
    await expect(third.ready).rejects.toBe(cleanupError);
    expect(attempt).not.toHaveBeenCalled();
    expect(views.active.get('inspector')).toBe('failed snapshot');
  });

  it('keeps startup diagnostics through failed rollback without mounting another error root', async () => {
    const views = renderers();
    const startupError = new Error('Startup failed');
    const cleanupError = new Error('Rollback failed');
    const first = startApplicationGeneration({
      mountInspector: () => views.mount('inspector', 'first'),
      startApplication: () => startApplication(async () => { throw startupError; }, () => views.mount('application', 'first')),
      disposeSystem: async () => { throw cleanupError; },
      showStartupError: () => views.mount('error', 'first'),
    });
    await expect(first.ready).rejects.toBe(startupError);
    const second = startApplicationGeneration({
      previous: first,
      mountInspector: () => views.mount('inspector', 'second'),
      startApplication: () => { throw new Error('Must not reopen'); },
      disposeSystem: async () => {},
      showStartupError: () => views.mount('error', 'second'),
    });
    await expect(second.ready).rejects.toBe(cleanupError);
    expect(views.active).toEqual(new Map([['inspector', 'first'], ['error', 'first']]));
  });

  it('blocks replacement when a module resource close rejects during startup rollback', async () => {
    const views = renderers();
    const system = createSystem({ id: 'failed-rollback' });
    const close = vi.fn(() => { throw new Error('Database close failed'); });
    const module = defineFeatureModule<FeatureType.Store, Record<string, never>, Record<string, never>>({
      id: 'store', kind: FeatureType.Store, title: 'Store', description: 'Owns the startup resource.',
      contract: { inputs: {}, exports: {} },
      load: async () => (_inputs, scope) => {
        scope.defer(close);
        throw new Error('Store startup failed');
      },
    });
    const first = startApplicationGeneration({
      mountInspector: () => views.mount('inspector', 'failed store'),
      startApplication: () => startApplication(
        async () => { await system.start(module, {}); return { dispose: () => system.dispose() }; },
        () => views.mount('application', 'first'),
      ),
      disposeSystem: () => system.dispose(),
      showStartupError: () => views.mount('error', 'first'),
    });
    await expect(first.ready).rejects.toBeInstanceOf(AggregateError);
    const reopen = vi.fn();
    const second = startApplicationGeneration({
      previous: first,
      mountInspector: () => views.mount('inspector', 'second'),
      startApplication: () => { reopen(); return { ready: Promise.resolve(), dispose: async () => {} }; },
      disposeSystem: async () => {},
      showStartupError: () => views.mount('error', 'second'),
    });
    await expect(second.ready).rejects.toBeInstanceOf(AggregateError);
    expect(system.snapshot.read().state).toBe('failed');
    expect(close).toHaveBeenCalledOnce();
    expect(reopen).not.toHaveBeenCalled();
    expect(views.active).toEqual(new Map([['inspector', 'failed store'], ['error', 'first']]));
  });

  it('releases a startup error root before a successful replacement mounts', async () => {
    const views = renderers();
    const startupError = new Error('Startup failed');
    const first = startApplicationGeneration({
      mountInspector: () => views.mount('inspector', 'first'),
      startApplication: () => startApplication(async () => { throw startupError; }, () => views.mount('application', 'first')),
      disposeSystem: async () => {},
      showStartupError: () => views.mount('error', 'first'),
    });
    await expect(first.ready).rejects.toBe(startupError);
    const second = startApplicationGeneration({
      previous: first,
      mountInspector: () => views.mount('inspector', 'second'),
      startApplication: () => startApplication(async () => ({ dispose: async () => {} }), () => views.mount('application', 'second')),
      disposeSystem: async () => {},
      showStartupError: () => views.mount('error', 'second'),
    });
    await second.ready;
    expect(views.active).toEqual(new Map([['inspector', 'second'], ['application', 'second']]));
    await second.dispose();
  });

  it('cancels pending startup before waiting and closes late acquisition without mounting it', async () => {
    const views = renderers();
    const controller = new AbortController();
    const closing = deferred();
    const acquired = deferred();
    const closeLateResource = vi.fn(() => closing.promise);
    const first = startApplicationGeneration({
      mountInspector: () => views.mount('inspector', 'first'),
      startApplication: () => startApplication(
        () => new Promise<{ dispose(): Promise<void> }>((resolve) => {
          controller.signal.addEventListener('abort', () => {
            acquired.resolve();
            resolve({ dispose: closeLateResource });
          }, { once: true });
        }),
        () => views.mount('application', 'first'),
      ),
      disposeSystem: async () => { controller.abort(); },
      showStartupError: () => views.mount('error', 'first'),
    });
    // The inspector mounts before acquisition begins.
    await Promise.resolve();
    expect(views.active.get('inspector')).toBe('first');
    const shutdown = first.dispose();
    await acquired.promise;
    await first.ready;
    expect(controller.signal.aborted).toBe(true);
    expect(views.active.has('application')).toBe(false);
    const openNext = vi.fn();
    const second = startApplicationGeneration({
      previous: first,
      mountInspector: () => views.mount('inspector', 'second'),
      startApplication: () => { openNext(); return { ready: Promise.resolve(), dispose: async () => {} }; },
      disposeSystem: async () => {},
      showStartupError: () => views.mount('error', 'second'),
    });
    await Promise.resolve();
    expect(openNext).not.toHaveBeenCalled();
    expect(views.active.get('inspector')).toBe('first');
    closing.resolve();
    await shutdown;
    await second.ready;
    expect(closeLateResource).toHaveBeenCalledOnce();
    expect(openNext).toHaveBeenCalledOnce();
    expect(views.order).not.toContain('mount application first');
    expect(views.order).not.toContain('mount error first');
    await second.dispose();
  });

  it('skips a generation invalidated while its predecessor is closing', async () => {
    const closing = deferred();
    const open = vi.fn();
    const first = { ready: Promise.resolve(), dispose: () => closing.promise };
    const skipped = startApplicationGeneration({
      previous: first,
      mountInspector: () => { open(); return () => {}; },
      startApplication: () => { open(); return { ready: Promise.resolve(), dispose: async () => {} }; },
      disposeSystem: async () => {},
      showStartupError: () => () => {},
    });
    const shutdown = skipped.dispose();
    closing.resolve();
    await shutdown;
    await skipped.ready;
    expect(open).not.toHaveBeenCalled();
  });
});
