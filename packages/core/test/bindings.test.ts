import { describe, expect, it, vi } from 'vitest';
import { defineFeatureModule, FeatureType } from '../src/module.js';
import type { ModuleContext } from '../src/module.js';
import { createSystem, external, from } from '../src/system.js';
import type { InputBindings, SystemStartOptions } from '../src/system.js';

interface Resource { readonly name: string }
interface ResourceInputs { readonly resource: Resource }

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}

function resourceProvider(resource: Resource, capture?: (scope: ModuleContext) => void) {
  return defineFeatureModule({
    id: 'provider', kind: FeatureType.Store, title: 'Provider', description: 'Owns the resource.',
    contract: { inputs: {}, exports: { resource: 'Borrowed resource.' } },
    load: async () => (_inputs: object, scope: ModuleContext) => {
      capture?.(scope);
      return { resource };
    },
  });
}

function resourceConsumer(gate?: Promise<void>) {
  const create = vi.fn((inputs: ResourceInputs) => inputs);
  const load = vi.fn(async () => { await gate; return create; });
  const definition = defineFeatureModule({
    id: 'consumer', kind: FeatureType.Feature, title: 'Consumer', description: 'Borrows one resource.',
    contract: { inputs: { resource: 'Borrowed resource.' }, exports: { resource: 'Received resource.' } },
    load,
  });
  return { definition, create, load };
}

describe('bound system inputs', () => {
  it('aligns exact selected values and distinct instance edges while deduplicating repeated providers', async () => {
    const system = createSystem({ id: 'app' });
    const provider = defineFeatureModule({
      id: 'provider', kind: FeatureType.Store, title: 'Provider', description: 'Owns one resource per instance.',
      contract: { inputs: { resource: 'Instance resource.' }, exports: { resource: 'Borrowed resource.' } },
      load: async () => (inputs: ResourceInputs) => ({ resource: inputs.resource }),
    });
    const first = await system.start(provider, { resource: external({ name: 'first' }) }, { id: 'first' });
    const second = await system.start(provider, { resource: external({ name: 'second' }) }, { id: 'second' });
    const consumer = defineFeatureModule({
      id: 'pair', kind: FeatureType.Feature, title: 'Pair', description: 'Borrows two resources.',
      contract: { inputs: { left: 'First resource.', right: 'Second resource.' }, exports: { left: 'First.', right: 'Second.' } },
      load: async () => (inputs: { left: Resource; right: Resource }) => inputs,
    });
    const repeated = await system.start(consumer, {
      left: from(first, 'resource'), right: from(first, 'resource'),
    });
    const distinct = await system.start(consumer, {
      left: from(first, 'resource'), right: from(second, 'resource'),
    }, { id: 'distinct' });
    expect(repeated.exports.left).toBe(first.exports.resource);
    expect(repeated.exports.right).toBe(first.exports.resource);
    expect(first.exports.resource).not.toBe(second.exports.resource);
    expect(distinct.exports.left).toBe(first.exports.resource);
    expect(distinct.exports.right).toBe(second.exports.resource);
    const modules = system.snapshot.read().modules;
    expect(modules.find(module => module.id === repeated.id)?.dependencies).toEqual(['first']);
    expect(modules.find(module => module.id === distinct.id)?.dependencies).toEqual(['first', 'second']);
    expect(modules.filter(module => module.definitionId === provider.id).map(module => module.id)).toEqual(['first', 'second']);
    await system.dispose();
  });

  it('rejects foreign, copied, forged and stale provider handles before loading', async () => {
    const system = createSystem({ id: 'app' });
    const foreignSystem = createSystem({ id: 'foreign' });
    let providerScope!: ModuleContext;
    const provider = await system.start(resourceProvider({ name: 'local' }, scope => { providerScope = scope; }), {});
    const foreign = await foreignSystem.start(resourceProvider({ name: 'foreign' }), {});
    const consumer = resourceConsumer();
    const invalid: (typeof provider)[] = [foreign, { ...provider }, { id: provider.id, exports: provider.exports }, Object.create(provider)];
    for (const handle of invalid) {
      await expect(system.start(consumer.definition, { resource: from(handle, 'resource') }))
        .rejects.toThrow('does not belong to this system');
    }
    await providerScope.dispose();
    await expect(system.start(consumer.definition, { resource: from(provider, 'resource') }))
      .rejects.toThrow('is disposed');
    expect(consumer.load).not.toHaveBeenCalled();
    expect(consumer.create).not.toHaveBeenCalled();
    await system.dispose();
    await foreignSystem.dispose();
  });

  it('rejects forged descriptors, raw values, unknown ports and unknown export keys before loading', async () => {
    const system = createSystem({ id: 'app' });
    const provider = await system.start(resourceProvider({ name: 'native' }), {});
    const descriptor = from(provider, 'resource');
    const consumer = resourceConsumer();
    const invalid = [{}, { ...descriptor }, Object.create(descriptor), { kind: 'export', handle: provider, key: 'resource' },
      provider.exports.resource, undefined];
    for (const resource of invalid) {
      await expect(system.start(consumer.definition, { resource } as InputBindings<ResourceInputs>))
        .rejects.toThrow('must use from() or external()');
    }
    await expect(system.start(consumer.definition, {
      resource: from(provider, 'missing' as 'resource'),
    })).rejects.toThrow('unknown public export missing');
    await expect(system.start(consumer.definition, {
      resource: descriptor, invented: external(true),
    } as InputBindings<ResourceInputs>)).rejects.toThrow('Unknown bound input: invented');
    expect(consumer.load).not.toHaveBeenCalled();
    expect(consumer.create).not.toHaveBeenCalled();
    await system.dispose();
  });

  it('rejects independent dependency overrides including inherited and undefined runtime properties', async () => {
    const system = createSystem({ id: 'app' });
    const provider = await system.start(resourceProvider({ name: 'native' }), {});
    const consumer = resourceConsumer();
    const overrides = [{ dependencies: [provider] }, { dependencies: [] }, { dependencies: undefined },
      Object.create({ dependencies: [provider] }), Object.create({ dependencies: undefined })];
    for (const options of overrides) {
      await expect(system.start(consumer.definition, { resource: from(provider, 'resource') }, options as SystemStartOptions))
        .rejects.toThrow('does not accept a dependencies override');
    }
    expect(consumer.load).not.toHaveBeenCalled();
    expect(consumer.create).not.toHaveBeenCalled();
    await system.dispose();
  });

  it('snapshots the input map and authenticates immutable descriptor metadata before awaiting a loader', async () => {
    const system = createSystem({ id: 'app' });
    const first = await system.start(resourceProvider({ name: 'first' }), {}, { id: 'first' });
    const second = await system.start(resourceProvider({ name: 'second' }), {}, { id: 'second' });
    const gate = deferred();
    const consumer = resourceConsumer(gate.promise);
    const descriptor = from(first, 'resource');
    const map = { resource: descriptor };
    const pending = system.start(consumer.definition, map);
    expect(consumer.load).toHaveBeenCalledOnce();
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Reflect.set(descriptor, 'handle', second)).toBe(false);
    expect(Reflect.set(descriptor, 'key', 'replacement')).toBe(false);
    expect(Reflect.defineProperty(descriptor, 'value', { value: second.exports.resource })).toBe(false);
    map.resource = from(second, 'resource');
    Reflect.set(map, 'invented', external('late'));
    gate.resolve();
    const received = await pending;
    expect(received.exports.resource).toBe(first.exports.resource);
    expect(Object.keys(received.exports)).toEqual(['resource']);
    expect(system.snapshot.read().modules.find(module => module.id === received.id)?.dependencies).toEqual(['first']);
    await system.dispose();
  });

  it('selects a replaced export property at factory entry and invokes its getter exactly once', async () => {
    const system = createSystem({ id: 'app' });
    const before = vi.fn(() => ({ name: 'before' }));
    const replacement = { name: 'replacement' };
    const entry = vi.fn(() => replacement);
    const nativeExports = { get resource() { return before(); } };
    const provider = defineFeatureModule({
      ...resourceProvider({ name: 'unused' }), load: async () => (_inputs: object) => nativeExports,
    });
    const handle = await system.start(provider, {});
    const gate = deferred();
    const consumer = resourceConsumer(gate.promise);
    const pending = system.start(consumer.definition, { resource: from(handle, 'resource') });
    expect(before).not.toHaveBeenCalled();
    Object.defineProperty(nativeExports, 'resource', { configurable: true, enumerable: true, get: entry });
    gate.resolve();
    const received = await pending;
    expect(received.exports.resource).toBe(replacement);
    expect(before).not.toHaveBeenCalled();
    expect(entry).toHaveBeenCalledOnce();
    expect(consumer.create).toHaveBeenCalledOnce();
    await system.dispose();
  });

  it('preserves native objects, document-shaped values, accessors and functions without starting work', async () => {
    const system = createSystem({ id: 'app' });
    const subscribe = vi.fn();
    const accessor = vi.fn(() => 'value');
    const operation = vi.fn(async () => undefined);
    const resource = new Map([['row', 'value']]);
    class NativeDocument {
      readonly primary = 'row';
      readonly $ = { subscribe };
      readonly $$ = accessor;
      readonly incrementalPatch = operation;
    }
    const document = new NativeDocument();
    const nativeExports = { resource, document, accessor, operation };
    const provider = defineFeatureModule({
      id: 'native', kind: FeatureType.Store, title: 'Native', description: 'Owns native capabilities.',
      contract: { inputs: {}, exports: { resource: 'Native object.', document: 'Native document.', accessor: 'Accessor.', operation: 'Operation.' } },
      load: async () => (_inputs: object) => nativeExports,
    });
    type NativeInputs = typeof nativeExports & { whole: typeof nativeExports };
    const consumer = defineFeatureModule({
      id: 'native-consumer', kind: FeatureType.Feature, title: 'Consumer', description: 'Borrows native capabilities.',
      contract: {
        inputs: { resource: 'Object.', document: 'Document.', accessor: 'Accessor.', operation: 'Operation.', whole: 'Whole export.' },
        exports: { resource: 'Object.', document: 'Document.', accessor: 'Accessor.', operation: 'Operation.', whole: 'Whole export.' },
      },
      load: async () => (inputs: NativeInputs) => inputs,
    });
    const handle = await system.start(provider, {});
    const received = await system.start(consumer, {
      resource: from(handle, 'resource'), document: from(handle, 'document'), accessor: from(handle, 'accessor'),
      operation: from(handle, 'operation'), whole: from(handle),
    });
    expect(received.exports.resource).toBe(resource);
    expect(received.exports.document).toBe(document);
    expect(received.exports.document).toBeInstanceOf(NativeDocument);
    expect(received.exports.accessor).toBe(accessor);
    expect(received.exports.operation).toBe(operation);
    expect(received.exports.whole).toBe(nativeExports);
    expect(subscribe).not.toHaveBeenCalled();
    expect(accessor).not.toHaveBeenCalled();
    expect(operation).not.toHaveBeenCalled();
    await system.dispose();
    expect(subscribe).not.toHaveBeenCalled();
    expect(operation).not.toHaveBeenCalled();
  });

  it('retains whole-object method receivers and ordinary extraction semantics without auto-binding', async () => {
    const system = createSystem({ id: 'app' });
    const method = vi.fn(function (this: unknown) { return this; });
    const nativeExports = { method };
    const provider = defineFeatureModule({
      id: 'methods', kind: FeatureType.Service, title: 'Methods', description: 'Supplies a method.',
      contract: { inputs: {}, exports: { method: 'Return its receiver.' } },
      load: async () => (_inputs: object) => nativeExports,
    });
    const consumer = defineFeatureModule({
      id: 'method-consumer', kind: FeatureType.Feature, title: 'Consumer', description: 'Borrows methods.',
      contract: { inputs: { whole: 'Whole export.', extracted: 'Extracted method.' }, exports: { whole: 'Whole export.', extracted: 'Extracted method.' } },
      load: async () => (inputs: { whole: typeof nativeExports; extracted: typeof method }) => inputs,
    });
    const handle = await system.start(provider, {});
    const received = await system.start(consumer, { whole: from(handle), extracted: from(handle, 'method') });
    expect(method).not.toHaveBeenCalled();
    expect(received.exports.extracted).toBe(method);
    expect(received.exports.whole.method()).toBe(nativeExports);
    const extracted = received.exports.extracted;
    expect(extracted()).toBeUndefined();
    expect(received.exports.extracted()).toBe(received.exports);
    await system.dispose();
  });

  it('selects numeric public keys and accepts an absent optional export as undefined', async () => {
    const system = createSystem({ id: 'app' });
    interface Exports { 0: Resource; optional?: Resource }
    const nativeExports: Exports = { 0: { name: 'numeric' } };
    const provider = defineFeatureModule({
      id: 'numeric', kind: FeatureType.Store, title: 'Numeric', description: 'Supplies numeric and optional exports.',
      contract: { inputs: {}, exports: { 0: 'Numeric resource.', optional: 'Optional resource.' } },
      load: async () => (_inputs: object): Exports => nativeExports,
    });
    const consumer = defineFeatureModule({
      id: 'optional-consumer', kind: FeatureType.Feature, title: 'Consumer', description: 'Borrows optional data.',
      contract: { inputs: { resource: 'Numeric resource.', optional: 'Optional resource.' }, exports: { resource: 'Resource.', optional: 'Optional.' } },
      load: async () => (inputs: { resource: Resource; optional: Resource | undefined }) => inputs,
    });
    const handle = await system.start(provider, {});
    const received = await system.start(consumer, { resource: from(handle, 0), optional: from(handle, 'optional') });
    expect(received.exports.resource).toBe(nativeExports[0]);
    expect(received.exports.optional).toBeUndefined();
    expect(Object.hasOwn(received.exports, 'optional')).toBe(true);
    expect(system.snapshot.read().modules.find(module => module.id === received.id)?.dependencies).toEqual(['numeric']);
    await system.dispose();
  });

  it('deliberately accepts an external stale resource without claiming a provider edge', async () => {
    const system = createSystem({ id: 'app' });
    let providerScope!: ModuleContext;
    const old = await system.start(resourceProvider({ name: 'old' }, scope => { providerScope = scope; }), {});
    await providerScope.dispose();
    const consumer = resourceConsumer();
    const received = await system.start(consumer.definition, { resource: external(old.exports.resource) });
    expect(received.exports.resource).toBe(old.exports.resource);
    expect(consumer.create).toHaveBeenCalledOnce();
    expect(system.snapshot.read().modules.find(module => module.id === received.id)?.dependencies).toEqual([]);
    await system.dispose();
  });
});
