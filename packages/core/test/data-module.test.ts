import { describe, expect, it, vi } from 'vitest';
import { dataPort, defineDataContract } from '../src/data.js';
import type { DataContract } from '../src/data.js';
import { defineFeatureModule, FeatureType } from '../src/module.js';
import { createSystem, external, from } from '../src/system.js';

type Empty = Record<string, never>;
interface Notes {
  read(): string;
  save(value: string): Promise<void>;
}
const notesContract = defineDataContract<Notes>({
  id: 'notes', version: 1, schema: { type: 'object', properties: { title: { type: 'string' } } },
});

function provider(id: string, options: {
  contract?: DataContract<Notes>;
  capabilities?: readonly string[];
  persist?: (value: string) => Promise<void>;
} = {}) {
  const loaded = vi.fn();
  const closed = vi.fn();
  const definition = defineFeatureModule<FeatureType.Data, Empty, { notes: Notes }>({
    id, kind: FeatureType.Data, title: id, description: 'Provides the selected notes implementation.',
    contract: { inputs: {}, exports: { notes: 'Named notes reads and writes.' } },
    data: { provides: { notes: dataPort(options.contract ?? notesContract, options.capabilities ?? ['read', 'write', 'live']) } },
    load: async () => {
      loaded();
      return (_inputs, scope) => {
        let current = 'initial';
        scope.defer(closed);
        const commands = scope.commands({ async save(value: string) {
          await options.persist?.(value);
          current = value;
        } });
        return { notes: { read: () => current, save: commands.save } };
      };
    },
  });
  return { definition, loaded, closed };
}

function consumer(required = ['read', 'write']) {
  return defineFeatureModule<FeatureType.Feature, { notes: Notes }, { read(): string; rename(value: string): Promise<void> }>({
    id: 'consumer', kind: FeatureType.Feature, title: 'Consumer', description: 'Consumes declared notes capabilities.',
    contract: { inputs: { notes: 'Notes capability.' }, exports: { read: 'Read the current title.', rename: 'Save a title.' } },
    data: { requires: { notes: dataPort(notesContract, required) } },
    load: async () => (inputs, scope) => ({
      read: () => inputs.notes.read(),
      ...scope.commands({ rename: (value: string) => inputs.notes.save(value) }),
    }),
  });
}

describe('Data modules in the existing system', () => {
  it.each(['memory', 'REST mock'])('binds and traces %s through the same public contract', async kind => {
    // The REST implementation is a local transport stub; this test performs no I/O.
    const transport = vi.fn(async (_value: string) => {});
    const source = provider(kind, { persist: kind === 'REST mock' ? transport : undefined });
    const feature = consumer();
    const system = createSystem({ id: kind, modules: [source.definition, feature] });
    try {
      expect(source.loaded).not.toHaveBeenCalled();
      const data = await system.start(source.definition, {});
      const bound = await system.start(feature, { notes: from(data, 'notes') });
      await bound.exports.rename('private title');
      expect(bound.exports.read()).toBe('private title');
      if (kind === 'REST mock') expect(transport).toHaveBeenCalledWith('private title');
      const snapshot = system.snapshot.read();
      expect(snapshot.data).toEqual([{
        id: 'notes', version: 1,
        provider: { definitionId: kind, port: 'notes', capabilities: ['read', 'write', 'live'] },
        consumers: [{ definitionId: 'consumer', port: 'notes', capabilities: ['read', 'write'] }], relations: [],
      }]);
      expect(snapshot.modules.find(module => module.id === 'consumer')?.dependencies).toEqual([kind]);
      expect(snapshot.events.filter(event => event.moduleId === kind && event.operation === 'save').map(event => event.type))
        .toEqual(['operation-started', 'operation-completed']);
      expect(JSON.stringify(snapshot)).not.toContain('private title');
      await system.dispose();
      expect(source.closed).toHaveBeenCalledOnce();
      await expect(data.exports.notes.save('late')).rejects.toThrow(/disposed|cancelled/);
    } finally { await system.dispose(); }
  });

  it('refuses ambiguous, missing and weaker providers before any loader runs', () => {
    const first = provider('first');
    const second = provider('second');
    const feature = consumer();
    expect(() => createSystem({ id: 'ambiguous', modules: [first.definition, second.definition, feature] }))
      .toThrow(/Multiple providers.*notes/);
    expect(() => createSystem({ id: 'missing', modules: [feature] })).toThrow(/Missing provider.*notes/);
    const readOnly = provider('read-only', { capabilities: ['read'] });
    expect(() => createSystem({ id: 'weak', modules: [readOnly.definition, feature] })).toThrow(/lacks write/);
    expect(first.loaded).not.toHaveBeenCalled();
    expect(second.loaded).not.toHaveBeenCalled();
    expect(readOnly.loaded).not.toHaveBeenCalled();
  });

  it('rejects conflicting definitions for the same logical data identity', () => {
    const first = provider('first');
    const incompatible = provider('incompatible', { contract: defineDataContract<Notes>({ id: 'notes', version: 2 }) });
    expect(() => createSystem({ id: 'versions', modules: [first.definition, incompatible.definition] }))
      .toThrow(/Conflicting data contract notes/);
    expect(first.loaded).not.toHaveBeenCalled();
    expect(incompatible.loaded).not.toHaveBeenCalled();
  });

  it('checks the actual binding even when another provider has the same TypeScript shape', async () => {
    const expected = provider('expected');
    const other = provider('other', { contract: defineDataContract<Notes>({ id: 'other-notes', version: 1 }) });
    const feature = consumer();
    const system = createSystem({ id: 'actual-binding', modules: [expected.definition, other.definition, feature] });
    try {
      const correct = await system.start(expected.definition, {});
      const wrong = await system.start(other.definition, {});
      await expect(system.start(feature, { notes: from(wrong, 'notes') })).rejects.toThrow(/requires contract notes/);
      const accepted = await system.start(feature, { notes: from(correct, 'notes') });
      expect(accepted.exports.read()).toBe('initial');
    } finally { await system.dispose(); }
  });

  it('refuses external, whole-export and absent inputs for declared data requirements', async () => {
    const source = provider('source');
    const feature = consumer();
    const system = createSystem({ id: 'explicit-data-binding', modules: [source.definition, feature] });
    try {
      const data = await system.start(source.definition, {});
      await expect(system.start(feature, { notes: external(data.exports.notes) })).rejects.toThrow(/must use from/);
      await expect(system.start(feature, { notes: from(data) } as never)).rejects.toThrow(/must use from/);
      await expect(system.start(feature, {} as never)).rejects.toThrow(/Missing data input/);
    } finally { await system.dispose(); }
  });

  it('requires planned Data modules and refuses a second instance of the same provider', async () => {
    const source = provider('source');
    const unplanned = createSystem({ id: 'unplanned' });
    await expect(unplanned.start(source.definition, {})).rejects.toThrow(/createSystem\(\{ modules \}\)/);
    expect(source.loaded).not.toHaveBeenCalled();
    await unplanned.dispose();
    const planned = createSystem({ id: 'planned', modules: [source.definition] });
    try {
      await planned.start(source.definition, {}, { id: 'first' });
      await expect(planned.start(source.definition, {}, { id: 'second' })).rejects.toThrow(/already has an instance/);
      expect(source.loaded).toHaveBeenCalledOnce();
    } finally { await planned.dispose(); }
  });

  it('treats a declared ordinary toString input as its own binding, not a data requirement', async () => {
    const source = provider('source');
    const feature = defineFeatureModule<FeatureType.Feature, { notes: Notes; toString(): string }, { read(): string }>({
      id: 'own-property-consumer', kind: FeatureType.Feature, title: 'Own inputs', description: 'Uses a data port and an ordinary own input.',
      contract: { inputs: { notes: 'Notes capability.', toString: 'An ordinary formatter.' }, exports: { read: 'Format a title.' } },
      // TypeScript otherwise treats the inherited Object.prototype.toString as
      // this optional mapped port. Undefined is omitted by the runtime snapshot.
      data: { requires: { notes: dataPort(notesContract, ['read']), toString: undefined } },
      load: async () => inputs => ({ read: () => `${inputs.notes.read()}:${inputs.toString()}` }),
    });
    const system = createSystem({ id: 'own-property-input', modules: [source.definition, feature] });
    try {
      const data = await system.start(source.definition, {});
      const bound = await system.start(feature, { notes: from(data, 'notes'), toString: external(() => 'ordinary') });
      expect(bound.exports.read()).toBe('initial:ordinary');
    } finally { await system.dispose(); }
  });

  it('validates Data declaration ports and the Data specialization at definition time', () => {
    const base = {
      id: 'invalid', title: 'Invalid', description: 'Invalid declaration.',
      contract: { inputs: {}, exports: { notes: 'Notes.' } },
      load: async () => (_inputs: Empty) => ({ notes: { read: () => '', save: async (_value: string) => {} } }),
    };
    expect(() => defineFeatureModule<FeatureType.Data, Empty, { notes: Notes }>({
      ...base, kind: FeatureType.Data, data: { provides: {} },
    })).toThrow(/must provide/);
    expect(() => defineFeatureModule<FeatureType.Data, Empty, { notes: Notes }>({
      ...base, kind: FeatureType.Data, data: { provides: { absent: dataPort(notesContract, ['read']) } } as never,
    })).toThrow(/Unknown data export/);
    expect(() => defineFeatureModule<FeatureType.Feature, Empty, { notes: Notes }>({
      ...base, kind: FeatureType.Feature, data: { provides: { notes: dataPort(notesContract, ['read']) } } as never,
    })).toThrow(/Only Data modules/);
  });
});
