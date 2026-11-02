import { describe, expect, it, vi } from 'vitest';
import { createScope } from '../src/scope.js';
import { defineFeatureModule, FeatureType, startModule } from '../src/module.js';
import type { ModuleContext } from '../src/module.js';
import { createSystem } from '../src/system.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function commandModule<Exports extends object>(id: string, create: (scope: ModuleContext) => Exports) {
  return defineFeatureModule<FeatureType.Feature, Record<string, never>, Exports>({
    id, kind: FeatureType.Feature, title: id, description: `Owns ${id} commands.`,
    contract: { inputs: {}, exports: { commands: 'Registered commands.' } as never },
    load: async () => (_inputs, scope) => create(scope),
  });
}

describe('registered commands', () => {
  it('preserve arguments, results, rejections and receivers, and enter the module runtime', async () => {
    const entered: string[] = [];
    const scope = createScope();
    const failure = new Error('domain rejection');
    const commands = await startModule(commandModule('owner', context => context.commands({
      async echo(left: number, right: string) { return { left, right }; },
      async fail() { throw failure; },
      throwSynchronously(): Promise<never> { throw failure; },
      async receiver(this: unknown) { return this; },
    })), {}, scope, undefined, {
      createRuntime: () => ({
        run: operation => { entered.push('run'); return operation(); },
        quiesce() {}, dispose: () => [],
      }),
    });
    const value = { nested: true };
    const result = await commands.echo(1, 'two');
    expect(result).toEqual({ left: 1, right: 'two' });
    await expect(commands.fail()).rejects.toBe(failure);
    await expect(commands.throwSynchronously()).rejects.toBe(failure);
    expect(await commands.receiver()).toBe(commands);
    expect(await commands.receiver.call(value)).toBe(value);
    expect(entered.length).toBeGreaterThanOrEqual(4);
    expect(Object.isFrozen(commands)).toBe(true);
    await scope.dispose();
  });

  it('joins accepted and queued commands before releasing module resources', async () => {
    const order: string[] = [];
    const gate = deferred();
    const scope = createScope();
    const commands = await startModule(commandModule('queue', context => {
      context.defer(() => { order.push('resource closed'); });
      let tail: Promise<unknown> = Promise.resolve();
      const serial = (label: string) => {
        const next = tail.then(async () => { await gate.promise; order.push(label); return label; });
        tail = next;
        return next;
      };
      return context.commands({ first: () => serial('first'), second: () => serial('second') });
    }), {}, scope);
    const first = commands.first();
    const queued = commands.second();
    let disposed = false;
    const disposal = scope.dispose().then(() => { disposed = true; });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(disposed).toBe(false);
    gate.resolve();
    expect(await first).toBe('first');
    expect(await queued).toBe('second');
    await disposal;
    expect(order).toEqual(['first', 'second', 'resource closed']);
  });

  it('refuses new calls after cancellation and after disposal without invoking them', async () => {
    const parent = new AbortController();
    const scope = createScope(parent.signal);
    const implementation = vi.fn(async () => 'ran');
    const commands = await startModule(commandModule('closing', context => context.commands({ run: implementation })), {}, scope);
    parent.abort();
    await expect(commands.run()).rejects.toThrow('Module closing is cancelled');
    await scope.dispose();
    await expect(commands.run()).rejects.toThrow('Module closing is disposed');
    expect(implementation).not.toHaveBeenCalled();
  });

  it('accepts only explicit groups of named functions', async () => {
    const scope = createScope();
    const symbol = Symbol('command');
    await expect(startModule(commandModule('invalid', context => context.commands({ value: 1 } as never)), {}, scope))
      .rejects.toThrow('Command value must be a function');
    await expect(startModule(commandModule('symbol', context => context.commands({ [symbol]: async () => {} } as never)), {}, scope))
      .rejects.toThrow('Command names must be strings');
    await scope.dispose();
  });

  it('refuses class instances, whose inherited methods would not be registered', async () => {
    const scope = createScope();
    class Commands { async run() { return 1; } }
    await expect(startModule(commandModule('class', context => context.commands(new Commands())), {}, scope))
      .rejects.toThrow('Commands must be a plain object literal');
    const inherited = Object.create({ async run() { return 1; } }) as { run(): Promise<number> };
    await expect(startModule(commandModule('inherited', context => context.commands(inherited)), {}, scope))
      .rejects.toThrow('Commands must be a plain object literal');
    const prototypeless = Object.assign(Object.create(null) as object, { async run() { return 2; } }) as { run(): Promise<number> };
    const commands = await startModule(commandModule('null-prototype', context => context.commands(prototypeless)), {}, scope);
    expect(await commands.run()).toBe(2);
    await scope.dispose();
  });

  it('returns native promises for custom thenables', async () => {
    const scope = createScope();
    const cancellable = Object.assign(Promise.resolve(3), { cancel() {} });
    const commands = await startModule(commandModule('thenable', context => context.commands({ run: () => cancellable })), {}, scope);
    const result = commands.run();
    expect(result).toBeInstanceOf(Promise);
    expect('cancel' in result).toBe(false);
    expect(await result).toBe(3);
    await scope.dispose();
  });

  it('rechecks admission inside the runtime callback and leaves no task accounted after refusal', async () => {
    const order: string[] = [];
    let checks = 0;
    let refuseAt = 1;
    const observed: string[] = [];
    const implementation = vi.fn(async () => 'ran');
    const scope = createScope();
    const commands = await startModule(commandModule('admission', context => context.commands({ run: implementation })), {}, scope,
      undefined, {
        createRuntime: () => ({
          run: operation => { order.push('runtime entered'); return operation(); },
          quiesce() {}, dispose: () => [],
        }),
        admitCommand: () => {
          checks += 1;
          order.push(`admission ${checks}`);
          if (checks === refuseAt) throw new Error(`refused at check ${checks}`);
        },
        observeCommand: () => ({ completed: () => { observed.push('completed'); }, failed: () => { observed.push('failed'); } }),
      });
    order.length = 0;
    // First check refuses before the call is accounted or observed.
    await expect(commands.run()).rejects.toThrow('refused at check 1');
    expect(order).toEqual(['admission 1']);
    expect(observed).toEqual([]);
    // Second check runs inside the runtime callback; refusal there is a failed call.
    order.length = 0; checks = 0; refuseAt = 2;
    await expect(commands.run()).rejects.toThrow('refused at check 2');
    expect(order).toEqual(['admission 1', 'runtime entered', 'admission 2']);
    expect(observed).toEqual(['failed']);
    expect(implementation).not.toHaveBeenCalled();
    // Nothing remains accounted: disposal does not wait on either refused call.
    let disposed = false;
    const disposal = scope.dispose().then(() => { disposed = true; });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(disposed).toBe(true);
    await disposal;
  });

  it('isolates observers from command outcomes', async () => {
    const scope = createScope();
    const commands = await startModule(commandModule('observed', context => context.commands({ async ok() { return 1; } })), {}, scope,
      undefined, { observeCommand: () => { throw new Error('observer failed'); } });
    expect(await commands.ok()).toBe(1);
    await scope.dispose();
  });
});

describe('system command diagnostics', () => {
  it('records one start and one outcome per call by declared key, without values', async () => {
    const system = createSystem({ id: 'commands' });
    const handle = await system.start(commandModule('focus', context => context.commands({
      async save(secret: string) { return { ok: false as const, message: `rejected ${secret}` }; },
      async explode(secret: string) { throw new Error(`failed for ${secret.length} chars`); },
    })), {});
    expect(await handle.exports.save('private-argument')).toEqual({ ok: false, message: 'rejected private-argument' });
    await expect(handle.exports.explode('private-argument')).rejects.toThrow('failed for 16 chars');
    const operations = system.snapshot.read().events
      .filter(event => event.type.startsWith('operation-'))
      .map(event => [event.type, event.moduleId, event.operation, event.error]);
    expect(operations).toEqual([
      ['operation-started', 'focus', 'save', undefined],
      // A resolved negative domain result is a completed invocation.
      ['operation-completed', 'focus', 'save', undefined],
      ['operation-started', 'focus', 'explode', undefined],
      ['operation-failed', 'focus', 'explode', 'failed for 16 chars'],
    ]);
    expect(JSON.stringify(system.snapshot.read())).not.toContain('private-argument');
    await system.dispose();
    await expect(handle.exports.save('late')).rejects.toThrow('disposed');
    expect(system.snapshot.read().events.filter(event => event.operation === 'save')).toHaveLength(2);
  });

  it('refuses a command started by a snapshot subscriber once shutdown begins', async () => {
    const system = createSystem({ id: 'shutdown-window' });
    const implementation = vi.fn(async () => 'ran');
    const handle = await system.start(commandModule('late', context => context.commands({ run: implementation })), {});
    let attempted: Promise<string> | undefined;
    const stop = system.snapshot.subscribe(snapshot => {
      const event = snapshot.events.at(-1);
      // The system publishes 'disposing' before it cancels module scopes.
      if (!attempted && event?.type === 'disposing' && event.moduleId === undefined) attempted = handle.exports.run();
    });
    const disposal = system.dispose();
    expect(attempted).toBeDefined();
    await expect(attempted).rejects.toThrow('System shutdown-window is disposing');
    await disposal;
    stop();
    expect(implementation).not.toHaveBeenCalled();
    expect(system.snapshot.read().events.some(event => event.operation === 'run')).toBe(false);
  });

  it('prevents domain execution when the start observer shuts the system down', async () => {
    const system = createSystem({ id: 'observer-shutdown' });
    const implementation = vi.fn(async () => 'ran');
    const handle = await system.start(commandModule('guarded', context => context.commands({ run: implementation })), {});
    let disposal: Promise<void> | undefined;
    const stop = system.snapshot.subscribe(snapshot => {
      if (!disposal && snapshot.events.at(-1)?.type === 'operation-started') disposal = system.dispose();
    });
    await expect(handle.exports.run()).rejects.toThrow(/disposing|cancelled|aborted/);
    expect(disposal).toBeDefined();
    await disposal;
    stop();
    expect(implementation).not.toHaveBeenCalled();
    const events = system.snapshot.read().events.filter(event => event.operation === 'run').map(event => event.type);
    expect(events).toEqual(['operation-started', 'operation-failed']);
    expect(system.snapshot.read().state).toBe('disposed');
  });

  it('accounts for queued calls during system shutdown and reports each once', async () => {
    const gate = deferred();
    const system = createSystem({ id: 'queued' });
    const handle = await system.start(commandModule('serial', context => {
      let tail: Promise<unknown> = Promise.resolve();
      return context.commands({
        step: (label: string) => { const next = tail.then(() => gate.promise).then(() => label); tail = next; return next; },
      });
    }), {});
    const calls = [handle.exports.step('a'), handle.exports.step('b')];
    const disposal = system.dispose();
    gate.resolve();
    expect(await Promise.all(calls)).toEqual(['a', 'b']);
    await disposal;
    const events = system.snapshot.read().events.filter(event => event.operation === 'step').map(event => event.type);
    expect(events.filter(type => type === 'operation-started')).toHaveLength(2);
    expect(events.filter(type => type === 'operation-completed')).toHaveLength(2);
    expect(system.snapshot.read().state).toBe('disposed');
  });
});
