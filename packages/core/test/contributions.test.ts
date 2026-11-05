import { describe, expect, it, vi } from 'vitest';
import { contributionPort, defineContributionContract } from '../src/contributions.js';
import type { ContributionRegistry } from '../src/contributions.js';
import { defineFeatureModule, FeatureType } from '../src/module.js';
import type { ModuleContext } from '../src/module.js';
import { createSystem, external } from '../src/system.js';

type Value = { readonly label: string };
const labels = defineContributionContract<Value>({
  id: 'test.labels', version: 1,
  validate: value => !!value && typeof value === 'object' && typeof (value as Value).label === 'string',
});

function provider(id: string, order = 0, events: string[] = []) {
  const load = vi.fn(async () => (_inputs: Record<string, never>, scope: ModuleContext) => {
    scope.defer(() => { events.push(`close:${id}`); });
    return { label: Object.freeze({ label: id }) };
  });
  const module = defineFeatureModule({
    id, kind: FeatureType.Feature, title: id, description: 'A label provider.',
    contract: { inputs: {}, exports: { label: 'The contributed label.' } },
    contributions: { provides: { label: contributionPort(labels, { order }) } },
    load,
  });
  return { module, load };
}

function consumer(events: string[] = []) {
  return defineFeatureModule({
    id: 'consumer', kind: FeatureType.Service, title: 'Consumer', description: 'Collects typed labels.',
    contract: { inputs: { registry: 'Typed labels.' }, exports: { list: 'Read labels.' } },
    contributions: { requires: { registry: contributionPort(labels) } },
    load: async () => (inputs: { readonly registry: ContributionRegistry<Value> }, scope: ModuleContext) => {
      scope.defer(() => { events.push('close:consumer'); });
      return scope.commands({ list: async () => inputs.registry.items.read().map(entry => entry.value.label) });
    },
  });
}

describe('typed contributions', () => {
  it('discovers inert providers and collects ready values in deterministic order with dependency edges', async () => {
    const events: string[] = [];
    const a = provider('a', 20, events);
    const b = provider('b', 10, events);
    const reader = consumer(events);
    const system = createSystem({ id: 'app', modules: [a.module, b.module, reader] });
    const registry = system.contributions(labels);
    expect(registry.definitions.read().map(entry => entry.definitionId)).toEqual(['b', 'a']);
    expect(registry.items.read()).toEqual([]);
    expect(a.load).not.toHaveBeenCalled();
    await expect(system.start(reader, { registry: system.collect(labels) })).rejects.toThrow('Start contribution provider a');

    const alpha = await system.start(a.module, {});
    await system.start(b.module, {});
    const running = await system.start(reader, { registry: system.collect(labels) });
    expect(await running.exports.list()).toEqual(['b', 'a']);
    expect(registry.items.read()[1]?.value).toBe(alpha.exports.label);
    expect(system.snapshot.read().modules.find(module => module.id === 'consumer')?.dependencies).toEqual(['a', 'b']);
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.items.read())).toBe(true);
    expect(Object.isFrozen(registry.items.read()[0])).toBe(true);

    const late = provider('late');
    await expect(system.start(late.module, {})).rejects.toThrow(/before consumers/);
    expect(late.load).not.toHaveBeenCalled();
    const closing = system.dispose();
    expect(registry.items.read()).toEqual([]);
    await expect(running.exports.list()).rejects.toThrow(/disposing|cancelled|disposed/);
    await closing;
    expect(events).toEqual(['close:consumer', 'close:b', 'close:a']);
    expect(registry.definitions.read()).toHaveLength(2);
  });

  it('requires matching authenticated collection inputs and refuses foreign-system descriptors', async () => {
    const first = createSystem({ id: 'first' });
    const second = createSystem({ id: 'second' });
    const other = defineContributionContract<Value>({ id: 'other', version: 1 });
    await expect(first.start(consumer(), { registry: first.collect(other) })).rejects.toThrow('requires collect(test.labels)');
    await expect(first.start(consumer(), { registry: external(first.contributions(labels)) })).rejects.toThrow('requires collect(test.labels)');
    await expect(first.start(consumer(), { registry: second.collect(labels) })).rejects.toThrow('another system');
    await expect(first.start(consumer(), {} as never)).rejects.toThrow('Missing contribution input');
    await Promise.all([first.dispose(), second.dispose()]);
  });

  it('rejects conflicting canonical definitions before invoking loaders', async () => {
    const duplicate = defineContributionContract<Value>({ id: labels.id, version: 2 });
    const source = provider('source');
    const conflicting = defineFeatureModule({
      ...source.module, id: 'conflicting', contributions: { provides: { label: contributionPort(duplicate) } },
    });
    expect(() => createSystem({ id: 'bad', modules: [source.module, conflicting] })).toThrow('Conflicting contribution contract');
    expect(source.load).not.toHaveBeenCalled();
    const system = createSystem({ id: 'good', modules: [source.module] });
    expect(() => system.contributions(duplicate)).toThrow('Conflicting contribution contract');
    await system.dispose();
  });

  it('validates public export values before readiness and rolls back rejected providers', async () => {
    let released = false;
    const broken = defineFeatureModule<FeatureType.Feature, Record<string, never>, { label: Value }>({
      id: 'broken', kind: FeatureType.Feature, title: 'Broken', description: 'Returns malformed data.',
      contract: { inputs: {}, exports: { label: 'A label.' } },
      contributions: { provides: { label: contributionPort(labels) } },
      load: async () => (_inputs, scope) => {
        scope.defer(() => { released = true; });
        return { label: { label: 123 } as unknown as Value };
      },
    });
    const system = createSystem({ id: 'broken-app', modules: [broken] });
    const registry = system.contributions(labels);
    await expect(system.start(broken, {})).rejects.toThrow('Invalid contribution broken.label');
    expect(released).toBe(true);
    expect(registry.items.read()).toEqual([]);
    expect(system.snapshot.read().modules[0]?.state).toBe('failed');
    await system.dispose();
  });

  it('withdraws values and refuses escaped startup when a registry observer disposes the system', async () => {
    const source = provider('source');
    const system = createSystem({ id: 'reentrant', modules: [source.module] });
    const registry = system.contributions(labels);
    let closing: Promise<void> | undefined;
    registry.items.subscribe(items => {
      if (items.length) closing = system.dispose();
    });
    await expect(system.start(source.module, {})).rejects.toThrow(/disposing|abort/i);
    await closing;
    expect(registry.items.read()).toEqual([]);
  });

  it('keeps identifiers unique when module identities and export names contain separators', async () => {
    const define = (id: string, name: string) => defineFeatureModule({
      id, kind: FeatureType.Feature, title: id, description: 'Contributes through an arbitrary export name.',
      contract: { inputs: {}, exports: { [name]: 'A label.' } },
      contributions: { provides: { [name]: contributionPort(labels) } },
      load: async () => (_inputs: Record<string, never>) => ({ [name]: { label: id } }),
    });
    const a = define('a.b', 'c');
    const b = define('a', 'b.c');
    const system = createSystem({ id: 'ids', modules: [a, b] });
    const registry = system.contributions(labels);
    await system.start(a, {});
    await system.start(b, {});
    expect(new Set(registry.definitions.read().map(entry => entry.id)).size).toBe(2);
    expect(new Set(registry.items.read().map(entry => entry.id)).size).toBe(2);
    await system.dispose();
  });

  it('snapshots declaration metadata and rejects nonexistent named exports', () => {
    const source = provider('source');
    expect(() => defineFeatureModule({
      ...source.module, contributions: { provides: { missing: contributionPort(labels) } } as never,
    })).toThrow('Unknown contribution export');
    expect(() => contributionPort(labels, { order: Infinity })).toThrow('finite');
    expect(() => contributionPort({ id: 'fake', version: 1 } as never)).toThrow('canonical');
  });

  it('checks providers admitted by an instance-id getter before sealing a consumer plan', async () => {
    const source = provider('source');
    const late = provider('late');
    const system = createSystem({ id: 'options', modules: [source.module] });
    await system.start(source.module, {});
    let pending: Promise<unknown> | undefined;
    await expect(system.start(consumer(), { registry: system.collect(labels) }, {
      get id() {
        pending = system.start(late.module, {});
        return 'reader';
      },
    })).rejects.toThrow(/still starting|Start contribution provider late/);
    await pending;
    expect(system.snapshot.read().modules.some(module => module.id === 'reader')).toBe(false);
    await system.dispose();
  });
});
