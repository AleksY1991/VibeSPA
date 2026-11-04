import { describe, expect, it, vi } from 'vitest';
import { defineFeatureModule, FeatureType } from '../src/module.js';
import { createSystem } from '../src/system.js';

function service(id: string, load = vi.fn(async () => () => ({ value: 'private-runtime-value' }))) {
  return defineFeatureModule<FeatureType.Service, Record<string, never>, { readonly value: string }>({
    id,
    kind: FeatureType.Service,
    title: `${id} service`,
    description: `Owns ${id}.`,
    contract: { inputs: {}, exports: { value: 'A public value.' } },
    load,
  });
}

describe('module registration diagnostics', () => {
  it('shows selected definitions before startup without loading or recording private values', async () => {
    const load = vi.fn(async () => () => ({ value: 'private-runtime-value' }));
    const selected = service('selected', load);
    const system = createSystem({ id: 'app', modules: [selected] });
    const initial = system.snapshot.read();
    expect(initial.modules).toEqual([]);
    expect(initial.registrations).toEqual([{
      id: 'selected', kind: FeatureType.Service, title: 'selected service',
      description: 'Owns selected.', contract: {
        inputs: [], exports: [{ name: 'value', description: 'A public value.' }],
      }, selected: true, instanceIds: [],
    }]);
    expect(load).not.toHaveBeenCalled();

    await system.start(selected, {}, { id: 'first' });
    await system.start(selected, {}, { id: 'second' });
    expect(system.snapshot.read().registrations?.[0]?.instanceIds).toEqual(['first', 'second']);
    expect(initial.registrations?.[0]?.instanceIds).toEqual([]);
    expect(JSON.stringify(system.snapshot.read())).not.toContain('private-runtime-value');
    await system.dispose();
    expect(system.snapshot.read().registrations?.[0]?.instanceIds).toEqual(['first', 'second']);
  });

  it('registers ad hoc starts only after admission and retains failed instances', async () => {
    const system = createSystem({ id: 'app' });
    const definition = service('dynamic');
    await expect(system.start(definition, {}, { id: ' ' })).rejects.toThrow('instance id');
    expect(system.snapshot.read().registrations).toEqual([]);
    await system.start(definition, {});
    const failing = service('failing', vi.fn(async () => () => { throw new Error('startup failed'); }));
    await expect(system.start(failing, {})).rejects.toThrow('startup failed');
    expect(system.snapshot.read().registrations?.map(registration => ({
      id: registration.id, selected: registration.selected, instances: registration.instanceIds,
    }))).toEqual([
      { id: 'dynamic', selected: false, instances: ['dynamic'] },
      { id: 'failing', selected: false, instances: ['failing'] },
    ]);
    expect(system.snapshot.read().modules[1]?.state).toBe('failed');
    system.clearEvents();
    expect(system.snapshot.read().registrations).toHaveLength(2);
    await system.dispose();
  });

  it('copies and freezes selected metadata and keeps minimal validation declarations compatible', async () => {
    const supplied = {
      id: 'supplied', kind: FeatureType.Policy, title: 'Supplied policy', description: 'A policy.',
      contract: { inputs: { limit: 'A limit.' }, exports: { validate: 'Validation.' } },
    };
    const system = createSystem({
      id: 'app', modules: [supplied, { id: 'minimal', kind: FeatureType.View }],
    });
    supplied.title = 'changed';
    supplied.contract.inputs.limit = 'changed';
    const registrations = system.snapshot.read().registrations!;
    expect(registrations[0]?.title).toBe('Supplied policy');
    expect(registrations[0]?.contract.inputs[0]?.description).toBe('A limit.');
    expect(registrations[1]).toMatchObject({
      id: 'minimal', title: 'minimal', description: '', contract: { inputs: [], exports: [] },
    });
    expect(Object.isFrozen(registrations)).toBe(true);
    expect(Object.isFrozen(registrations[0])).toBe(true);
    expect(Object.isFrozen(registrations[0]?.instanceIds)).toBe(true);
    expect(Object.isFrozen(registrations[0]?.contract)).toBe(true);
    expect(Object.isFrozen(registrations[0]?.contract.inputs)).toBe(true);
    expect(Object.isFrozen(registrations[0]?.contract.inputs[0])).toBe(true);
    await system.dispose();
  });

  it('marks conflicting same-ID declarations while preserving each runtime boundary', async () => {
    const first = service('shared');
    const second = defineFeatureModule({
      ...service('shared'), title: 'Second service', description: 'A different boundary.',
      contract: { inputs: {}, exports: { value: 'Another public value.' } },
    });
    const system = createSystem({ id: 'app' });
    await system.start(first, {}, { id: 'one' });
    const beforeConflict = system.snapshot.read();
    await system.start(second, {}, { id: 'two' });
    expect(system.snapshot.read().registrations).toHaveLength(1);
    expect(system.snapshot.read().registrations?.[0]).toMatchObject({
      id: 'shared', title: 'shared service', hasConflictingDefinitions: true,
      selected: false, instanceIds: ['one', 'two'],
    });
    expect(beforeConflict.registrations?.[0]?.hasConflictingDefinitions).toBeUndefined();
    expect(system.snapshot.read().modules.map(module => ({
      id: module.id, title: module.title, port: module.contract.exports[0]?.description,
    }))).toEqual([
      { id: 'one', title: 'shared service', port: 'A public value.' },
      { id: 'two', title: 'Second service', port: 'Another public value.' },
    ]);
    system.clearEvents();
    expect(system.snapshot.read().registrations?.[0]?.hasConflictingDefinitions).toBe(true);
    await system.dispose();
  });

  it('enriches omitted selected metadata without reporting a conflict', async () => {
    const system = createSystem({ id: 'app', modules: [{ id: 'selected', kind: FeatureType.Service }] });
    const initial = system.snapshot.read();
    await system.start(service('selected'), {});
    expect(system.snapshot.read().registrations?.[0]).toEqual({
      id: 'selected', kind: FeatureType.Service, title: 'selected service', description: 'Owns selected.',
      contract: { inputs: [], exports: [{ name: 'value', description: 'A public value.' }] },
      selected: true, instanceIds: ['selected'],
    });
    expect(initial.registrations?.[0]?.title).toBe('selected');
    expect(initial.registrations?.[0]?.contract.exports).toEqual([]);
    await system.dispose();
  });

  it('preserves supplied selected metadata while enriching only missing fields', async () => {
    const selected = {
      id: 'selected', kind: FeatureType.Policy, title: 'Selected policy',
      contract: { inputs: {}, exports: { validate: 'The selected boundary.' } },
    };
    const system = createSystem({ id: 'app', modules: [selected] });
    await system.start(service('selected'), {});
    expect(system.snapshot.read().registrations?.[0]).toMatchObject({
      kind: FeatureType.Policy, title: 'Selected policy', description: 'Owns selected.',
      contract: { inputs: [], exports: [{ name: 'validate', description: 'The selected boundary.' }] },
      selected: true, hasConflictingDefinitions: true, instanceIds: ['selected'],
    });
    expect(system.snapshot.read().modules[0]).toMatchObject({
      kind: FeatureType.Service, title: 'selected service',
      contract: { exports: [{ name: 'value', description: 'A public value.' }] },
    });
    await system.dispose();
  });

  it('treats equal metadata as equivalent regardless of declaration or port order', async () => {
    const define = (reverse: boolean) => defineFeatureModule<
      FeatureType.Service, Record<string, never>, { readonly first: string; readonly second: string }
    >({
      id: 'shared', kind: FeatureType.Service, title: 'Shared', description: 'Shared service.',
      contract: { inputs: {}, exports: reverse
        ? { second: 'Second.', first: 'First.' }
        : { first: 'First.', second: 'Second.' } },
      load: async () => () => ({ first: 'one', second: 'two' }),
    });
    const first = define(false);
    const system = createSystem({ id: 'app', modules: [first] });
    await system.start(first, {}, { id: 'one' });
    await system.start(define(true), {}, { id: 'two' });
    expect(system.snapshot.read().registrations?.[0]?.hasConflictingDefinitions).toBeUndefined();
    expect(system.snapshot.read().registrations?.[0]?.instanceIds).toEqual(['one', 'two']);
    await system.dispose();
  });
});
