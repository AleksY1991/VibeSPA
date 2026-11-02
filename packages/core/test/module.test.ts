import { describe, expect, it, vi } from 'vitest';
import { defineModule, startModule } from '../src/module.js';
import type { ModuleContext, ModuleRuntimeFactory } from '../src/module.js';
import { createScope } from '../src/scope.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

describe('module composition', () => {
  it('leaves declarations inert and passes typed dependencies explicitly', async () => {
    const load = vi.fn(async () => (inputs: { prefix: string }) => ({ greet: (name: string) => `${inputs.prefix}, ${name}` }));
    const definition = defineModule({ id: 'greeting', load });
    expect(load).not.toHaveBeenCalled();
    const owner = createScope();
    const greeting = await startModule(definition, { prefix: 'Hello' }, owner);
    expect(greeting.greet('Ada')).toBe('Hello, Ada');
    expect(load).toHaveBeenCalledOnce();
    await owner.dispose();
  });

  it('rolls back partial startup without ending sibling modules', async () => {
    const owner = createScope();
    const events: string[] = [];
    const good = defineModule({ id: 'good', load: async () => (_: undefined, scope: ReturnType<typeof createScope>) => {
      scope.defer(() => { events.push('good disposed'); });
      return 1;
    } });
    const bad = defineModule({ id: 'bad', load: async () => (_: undefined, scope: ReturnType<typeof createScope>) => {
      scope.defer(() => { events.push('bad rolled back'); });
      throw new Error('startup failed');
    } });
    await startModule(good, undefined, owner);
    await expect(startModule(bad, undefined, owner)).rejects.toThrow('startup failed');
    expect(owner.signal.aborted).toBe(false);
    expect(events).toEqual(['bad rolled back']);
    await owner.dispose();
    expect(events).toEqual(['bad rolled back', 'good disposed']);
  });

  it('aborts every module before releasing dependents before dependencies', async () => {
    const owner = createScope();
    const events: string[] = [];
    const create = (id: string) => defineModule({ id, load: async () => (_: undefined, scope: ReturnType<typeof createScope>) => {
      scope.signal.addEventListener('abort', () => events.push(`${id}:abort`));
      scope.defer(async () => { events.push(`${id}:close`); await Promise.resolve(); });
      return id;
    } });
    await startModule(create('database'), undefined, owner);
    await startModule(create('views'), undefined, owner);
    await owner.dispose();
    expect(events).toEqual(['database:abort', 'views:abort', 'views:close', 'database:close']);
  });

  it('never invokes a lazy factory after cancellation during loading', async () => {
    const owner = createScope();
    let finish!: (factory: () => string) => void;
    const factory = vi.fn(() => 'stale');
    const definition = defineModule({ id: 'lazy', load: () => new Promise<() => string>(resolve => { finish = resolve; }) });
    const started = startModule(definition, undefined, owner);
    const rejected = expect(started).rejects.toMatchObject({ name: 'AbortError' });
    const disposal = owner.dispose();
    finish(factory);
    await disposal;
    await rejected;
    expect(factory).not.toHaveBeenCalled();
  });

  it('rolls back and rejects a completed factory from a canceled generation', async () => {
    const owner = createScope();
    let finish!: (value: string) => void;
    let began!: () => void;
    const beginning = new Promise<void>(resolve => { began = resolve; });
    const cleanup = vi.fn();
    const definition = defineModule({ id: 'async', load: async () => (_: undefined, scope: ReturnType<typeof createScope>) => {
      scope.defer(cleanup);
      began();
      return new Promise<string>(resolve => { finish = resolve; });
    } });
    const started = startModule(definition, undefined, owner);
    const rejected = expect(started).rejects.toMatchObject({ name: 'AbortError' });
    await beginning;
    const disposal = owner.dispose();
    finish('stale');
    await disposal;
    await rejected;
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('keeps ownership open for a resource arriving after cancellation', async () => {
    const owner = createScope();
    let arrive!: () => void;
    let began!: () => void;
    const beganOpening = new Promise<void>(resolve => { began = resolve; });
    const arrived = new Promise<void>(resolve => { arrive = resolve; });
    const cleanup = vi.fn();
    const definition = defineModule({ id: 'late-resource', load: async () => async (_: undefined, scope: ReturnType<typeof createScope>) => {
      began();
      await arrived;
      scope.defer(cleanup);
      return 'canceled export';
    } });
    const started = startModule(definition, undefined, owner);
    const rejected = expect(started).rejects.toMatchObject({ name: 'AbortError' });
    await beganOpening;
    const disposal = owner.dispose();
    arrive();
    await disposal;
    await rejected;
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('retains startup and rollback errors through parent disposal without retrying cleanup', async () => {
    const owner = createScope();
    const close = vi.fn(() => { throw new Error('cleanup failed'); });
    const definition = defineModule({ id: 'broken', load: async () => (_: undefined, scope: ReturnType<typeof createScope>) => {
      scope.defer(close);
      throw new Error('startup failed');
    } });
    await expect(startModule(definition, undefined, owner)).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: 'startup failed' }), expect.any(AggregateError)],
    });
    await expect(owner.dispose()).rejects.toMatchObject({
      errors: [expect.objectContaining({ errors: [expect.any(AggregateError)] })],
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it('enters the runtime during construction and explicit continuations, then closes it before resources', async () => {
    const owner = createScope();
    const events: string[] = [];
    let entered = false;
    const definition = defineModule({ id: 'owned', load: async () => async (_: undefined, scope: ModuleContext) => {
      expect(entered).toBe(true);
      scope.defer(() => { events.push('resource'); });
      await Promise.resolve();
      expect(entered).toBe(false);
      scope.run(() => { expect(entered).toBe(true); });
      return scope;
    } });
    const scope = await startModule(definition, undefined, owner, undefined, {
      createRuntime: () => ({
        run(operation) {
          const previous = entered;
          entered = true;
          try { return operation(); } finally { entered = previous; }
        },
        quiesce() { events.push('quiesce'); },
        dispose() { events.push('runtime'); return []; },
      }),
    });
    await scope.dispose();
    expect(events).toEqual(['quiesce', 'runtime', 'resource']);
    expect(() => scope.run(() => {})).toThrow();
    await owner.dispose();
    expect(events).toEqual(['quiesce', 'runtime', 'resource']);
  });

  it('joins tasks and registers a resource arriving after cancellation before disposing it', async () => {
    const owner = createScope();
    const arrival = deferred<{ id: string }>();
    const close = vi.fn();
    const definition = defineModule({ id: 'acquisition', load: async () => (_: undefined, scope: ModuleContext) => scope });
    const scope = await startModule(definition, undefined, owner);
    const acquisition = scope.acquire(() => arrival.promise, close);
    const cancelled = expect(acquisition).rejects.toMatchObject({ name: 'AbortError' });
    let disposed = false;
    const disposal = owner.dispose().then(() => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);
    const refused = vi.fn();
    await expect(scope.task(refused)).rejects.toMatchObject({ name: 'AbortError' });
    expect(refused).not.toHaveBeenCalled();
    arrival.resolve({ id: 'late' });
    await cancelled;
    await disposal;
    expect(close).toHaveBeenCalledExactlyOnceWith({ id: 'late' });
  });

  it('keeps cleanup registration open until a task requesting shutdown settles', async () => {
    const owner = createScope();
    const finish = deferred<void>();
    const close = vi.fn();
    const definition = defineModule({ id: 'tasks', load: async () => (_: undefined, scope: ModuleContext) => scope });
    const scope = await startModule(definition, undefined, owner);
    let disposal!: Promise<void>;
    const task = scope.task(async () => {
      disposal = owner.dispose();
      await finish.promise;
      scope.defer(close);
      return 'finished';
    });
    expect(scope.signal.aborted).toBe(true);
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
    finish.resolve();
    await expect(task).resolves.toBe('finished');
    await disposal;
    expect(close).toHaveBeenCalledOnce();
  });

  it('drains resources after managed runtime failures and retains every cleanup error', async () => {
    const owner = createScope();
    const close = vi.fn(() => { throw new Error('resource failed'); });
    const definition = defineModule({ id: 'managed-failure', load: async () => (_: undefined, scope: ModuleContext) => {
      scope.defer(close);
      return {};
    } });
    await startModule(definition, undefined, owner, undefined, {
      createRuntime: () => ({
        run: operation => operation(),
        quiesce() { throw new Error('quiesce failed'); },
        dispose: () => [new Error('reactive cleanup failed')],
      }),
    });
    await expect(owner.dispose()).rejects.toMatchObject({
      errors: [expect.objectContaining({ errors: [
        expect.objectContaining({ message: 'quiesce failed' }),
        expect.objectContaining({ message: 'reactive cleanup failed' }),
        expect.any(AggregateError),
      ] })],
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it('retains resources when runtime disposal throws before traversal completes', async () => {
    const owner = createScope();
    const close = vi.fn();
    const states: string[] = [];
    const definition = defineModule({ id: 'unsafe', load: async () => (_: undefined, scope: ModuleContext) => {
      scope.defer(close);
      return {};
    } });
    await startModule(definition, undefined, owner, state => { states.push(state); }, {
      createRuntime: () => ({
        run: operation => operation(),
        quiesce() {},
        dispose() { throw new Error('traversal interrupted'); },
      }),
    });
    await expect(owner.dispose()).rejects.toBeInstanceOf(AggregateError);
    expect(close).not.toHaveBeenCalled();
    expect(states.at(-1)).toBe('failed');
    expect(states).not.toContain('disposed');
  });

  it('keeps unsafe failed startup owned so parent disposal cannot claim successful release', async () => {
    const owner = createScope();
    const close = vi.fn();
    const definition = defineModule({ id: 'unsafe-startup', load: async () => (_: undefined, scope: ModuleContext) => {
      scope.defer(close);
      throw new Error('construction failed');
    } });
    await expect(startModule(definition, undefined, owner, undefined, {
      createRuntime: () => ({
        run: operation => operation(),
        quiesce() {},
        dispose() { throw new Error('traversal interrupted'); },
      }),
    })).rejects.toBeInstanceOf(AggregateError);
    await expect(owner.dispose()).rejects.toBeInstanceOf(AggregateError);
    expect(close).not.toHaveBeenCalled();
  });

  it('rolls back runtime factory acquisition and preserves entry and cleanup failures', async () => {
    const owner = createScope();
    const close = vi.fn();
    const definition = defineModule({ id: 'constructor', load: async () => () => ({}) });
    const createRuntime: ModuleRuntimeFactory = scope => {
      scope.defer(close);
      throw new Error('runtime factory failed');
    };
    await expect(startModule(definition, undefined, owner, undefined, { createRuntime }))
      .rejects.toThrow('runtime factory failed');
    expect(close).toHaveBeenCalledOnce();

    const enter = new Error('runtime entry failed');
    await expect(startModule(definition, undefined, owner, undefined, {
      createRuntime: () => ({
        run() { throw enter; },
        quiesce() {},
        dispose: () => [new Error('runtime cleanup failed')],
      }),
    })).rejects.toMatchObject({ errors: [enter, expect.any(AggregateError)] });
    await expect(owner.dispose()).rejects.toMatchObject({
      errors: [expect.objectContaining({ errors: [expect.objectContaining({ message: 'runtime cleanup failed' })] })],
    });
  });
});
