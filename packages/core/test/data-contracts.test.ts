import { describe, expect, it } from 'vitest';
import { dataPort, defineDataContract, snapshotDataDeclarations, validateDataGraph } from '../src/data.js';
import type { DataContract, DataContractReference } from '../src/data.js';

interface Tasks { read(): readonly string[]; write(title: string): Promise<void> }
const tasks = () => defineDataContract<Tasks>({ id: 'tasks', version: 0 });

describe('canonical data declarations', () => {
  it('copies and freezes schema and capabilities without opening a provider', () => {
    const schema = { properties: { title: { type: 'string' } } };
    const contract = defineDataContract<Tasks>({ id: 'tasks', version: 0, schema });
    const capabilities = ['read', 'write', 'read'];
    const port = dataPort(contract, capabilities);
    const declaration = { provides: { tasks: port } };
    const snapshot = snapshotDataDeclarations(declaration);
    schema.properties.title.type = 'number';
    capabilities.push('admin');
    declaration.provides.tasks = dataPort(contract, ['write']);
    expect(contract.schema).toEqual({ properties: { title: { type: 'string' } } });
    expect(Object.isFrozen(Reflect.get(contract.schema!, 'properties').title)).toBe(true);
    expect(snapshot.provides?.tasks).toBe(port);
    expect(port.capabilities).toEqual(['read', 'write']);
    expect(Object.isFrozen(snapshot.provides)).toBe(true);
  });

  it('rejects invalid identity, versions, forged contracts and forged ports', () => {
    expect(() => defineDataContract({ id: ' ', version: 0 })).toThrow('id');
    for (const version of [-1, 0.5, NaN]) expect(() => defineDataContract({ id: 'tasks', version })).toThrow('version');
    expect(() => dataPort({ id: 'tasks', version: 0 } as DataContract<Tasks>, ['read'])).toThrow('canonical');
    expect(() => dataPort(tasks(), [''])).toThrow('capabilities');
    expect(() => snapshotDataDeclarations({ provides: { tasks: { contract: tasks(), capabilities: ['read'] } } })).toThrow('dataPort');
    expect(() => snapshotDataDeclarations({ provides: Object.create({ tasks: dataPort(tasks(), ['read']) }) })).toThrow('plain object');
  });

  it('rejects unknown declarations and symbol names rather than silently dropping them', () => {
    expect(() => snapshotDataDeclarations({ suggests: {} })).toThrow('Unknown data declaration');
    expect(() => snapshotDataDeclarations({ requires: { [Symbol('tasks')]: dataPort(tasks(), ['read']) } })).toThrow('strings');
  });

  it('refuses cyclic schemas and mutable non-JSON objects before a provider can open', () => {
    const cyclic: { self?: object } = {};
    cyclic.self = cyclic;
    expect(() => defineDataContract({ id: 'cyclic', version: 0, schema: cyclic })).toThrow('acyclic JSON');
    expect(() => defineDataContract({ id: 'date', version: 0, schema: { default: new Date() } })).toThrow('only JSON');
    expect(() => defineDataContract({ id: 'map', version: 0, schema: { fields: new Map() } })).toThrow('only JSON');
    const shared = { type: 'string' };
    expect(() => defineDataContract({ id: 'shared', version: 0, schema: { properties: { left: shared, right: shared } } })).not.toThrow();
  });
});

describe('data graph validation', () => {
  it('resolves shared canonical references and narrow requirements into immutable metadata', () => {
    const contract = tasks();
    const graph = validateDataGraph([
      { id: 'data', data: { provides: { tasks: dataPort(contract, ['read', 'write', 'live']) } } },
      { id: 'board', data: { requires: { cards: dataPort(contract, ['read', 'live']) } } },
      { id: 'editor', data: { requires: { tasks: dataPort(contract, ['write']) } } },
    ]);
    expect(graph).toEqual([{ id: 'tasks', version: 0,
      provider: { definitionId: 'data', port: 'tasks', capabilities: ['read', 'write', 'live'] },
      consumers: [
        { definitionId: 'board', port: 'cards', capabilities: ['read', 'live'] },
        { definitionId: 'editor', port: 'tasks', capabilities: ['write'] },
      ], relations: [],
    }]);
    expect(Object.isFrozen(graph)).toBe(true);
    expect(Object.isFrozen(graph[0]?.consumers)).toBe(true);
    expect(JSON.stringify(graph)).not.toContain('schema');
  });

  it('rejects missing, ambiguous or insufficient providers', () => {
    const contract = tasks();
    const read = dataPort(contract, ['read']);
    expect(() => validateDataGraph([{ id: 'board', data: { requires: { tasks: read } } }])).toThrow('Missing provider');
    expect(() => validateDataGraph([
      { id: 'rxdb', data: { provides: { tasks: read } } },
      { id: 'rest', data: { provides: { tasks: read } } },
    ])).toThrow('Multiple providers');
    expect(() => validateDataGraph([
      { id: 'rest', data: { provides: { tasks: read } } },
      { id: 'board', data: { requires: { tasks: dataPort(contract, ['live']) } } },
    ])).toThrow('lacks live');
  });

  it('rejects competing definitions even when they use the same structural types', () => {
    const original = tasks();
    for (const version of [0, 1]) {
      const other = defineDataContract<Tasks>({ id: 'tasks', version, schema: { type: 'object' } });
      expect(() => validateDataGraph([
        { id: 'data', data: { provides: { tasks: dataPort(original, ['read']) } } },
        { id: 'board', data: { requires: { tasks: dataPort(other, ['read']) } } },
      ])).toThrow('Conflicting data contract tasks');
    }
  });

  it('resolves relations through the same canonical definitions and requires their providers', () => {
    const projects = defineDataContract<readonly string[]>({ id: 'projects', version: 1 });
    const task = defineDataContract<Tasks>({ id: 'tasks', version: 0, relations: [projects] });
    const declarations = [{ id: 'task-data', data: { provides: { tasks: dataPort(task, ['read']) } } }];
    expect(() => validateDataGraph(declarations)).toThrow('Missing provider for data projects');
    const graph = validateDataGraph([...declarations, { id: 'project-data', data: { provides: { projects: dataPort(projects, ['read']) } } }]);
    expect(graph.map(node => [node.id, node.relations])).toEqual([['projects', []], ['tasks', ['projects']]]);
    expect(() => defineDataContract({ id: 'forged', version: 0, relations: [{ id: 'projects', version: 1 } as DataContractReference] })).toThrow('canonical');
  });
});
