import { describe, expect, it, vi } from 'vitest';
import { defineModule, startModule } from '../src/module.js';
import { createScope } from '../src/scope.js';

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

  it('retains both startup and rollback errors', async () => {
    const owner = createScope();
    const definition = defineModule({ id: 'broken', load: async () => (_: undefined, scope: ReturnType<typeof createScope>) => {
      scope.defer(() => { throw new Error('cleanup failed'); });
      throw new Error('startup failed');
    } });
    await expect(startModule(definition, undefined, owner)).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: 'startup failed' }), expect.any(AggregateError)],
    });
    await owner.dispose();
  });
});
