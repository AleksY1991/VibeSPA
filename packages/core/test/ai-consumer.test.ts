import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiContributionContract, createAiConsumer, defineAiTool } from '../src/ai.js';
import type { AiConsumer, AiContribution } from '../src/ai.js';
import { contributionPort } from '../src/contributions.js';
import type { ContributionEntry, ContributionRegistry } from '../src/contributions.js';
import { defineFeatureModule, defineModule, FeatureType, startModule } from '../src/module.js';
import { constantReadable, createSource } from '../src/readable.js';
import { createScope } from '../src/scope.js';
import { createSystem } from '../src/system.js';

const scopes: ReturnType<typeof createScope>[] = [];
afterEach(async () => { await Promise.all(scopes.splice(0).map(scope => scope.dispose())); });

const parseNumber = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Expected a finite number.');
  return value;
};
const double = () => defineAiTool({
  id: 'double', title: 'Double', description: 'Double a finite number.', inputSchema: { type: 'number' },
  parseInput: parseNumber, parseOutput: parseNumber,
  execute: async (value: number) => value * 2,
});
const contribution = (value: AiContribution): ContributionEntry<AiContribution> => ({
  id: `${value.id}.tool`, definitionId: value.id, instanceId: value.id, export: 'tool', order: 0, value,
});

async function setup(initial: readonly AiContribution[]) {
  const scope = createScope();
  scopes.push(scope);
  const items = createSource<readonly ContributionEntry<AiContribution>[]>(initial.map(contribution));
  const registry: ContributionRegistry<AiContribution> = {
    contract: aiContributionContract, definitions: constantReadable([]), items: items.source,
  };
  const consumer = await startModule(defineModule<never, AiConsumer>({
    id: 'ai-consumer', load: async () => (_input, context) => createAiConsumer(context, registry),
  }), undefined as never, scope);
  return { consumer, scope, replace: (tools: readonly AiContribution[]) => items.set(tools.map(contribution)) };
}

describe('AI contribution consumer', () => {
  it('collects canonical module contributions through the system with real provider dependencies', async () => {
    const provider = defineFeatureModule<FeatureType.Feature, Record<string, never>, { tool: AiContribution }>({
      id: 'double-provider', kind: FeatureType.Feature, title: 'Double provider', description: 'Provides an AI tool.',
      contract: { inputs: {}, exports: { tool: 'Validated double tool.' } },
      contributions: { provides: { tool: contributionPort(aiContributionContract) } },
      load: async () => () => ({ tool: double() }),
    });
    const definition = defineFeatureModule<FeatureType.Service, { registry: ContributionRegistry<AiContribution> }, AiConsumer>({
      id: 'tool-consumer', kind: FeatureType.Service, title: 'AI consumer', description: 'Consumes contributed AI tools.',
      contract: { inputs: { registry: 'Canonical ready AI tool registry.' }, exports: {
        tools: 'Public tool metadata.', error: 'Catalog validation failure.', invoke: 'Invoke a currently available tool.',
      } },
      contributions: { requires: { registry: contributionPort(aiContributionContract) } },
      load: async () => (inputs, scope) => createAiConsumer(scope, inputs.registry),
    });
    const system = createSystem({ id: 'typed-ai', modules: [provider, definition] });
    try {
      const registry = system.contributions(aiContributionContract);
      expect(registry.definitions.read()).toHaveLength(1);
      expect(registry.items.read()).toEqual([]);
      await system.start(provider, {});
      const consumer = await system.start(definition, { registry: system.collect(aiContributionContract) });
      await expect(consumer.exports.invoke('double', 6)).resolves.toBe(12);
      expect(system.snapshot.read().modules.find(module => module.id === 'tool-consumer')?.dependencies)
        .toEqual(['double-provider']);
    } finally { await system.dispose(); }
  });

  it('exposes only tool metadata and validates external inputs before executing', async () => {
    const tool = double();
    const { consumer } = await setup([tool]);
    expect(consumer.tools.read()).toEqual([{
      id: 'double', title: 'Double', description: 'Double a finite number.', inputSchema: { type: 'number' },
    }]);
    expect('invoke' in consumer.tools.read()[0]!).toBe(false);
    await expect(consumer.invoke('double', 4)).resolves.toBe(8);
    await expect(consumer.invoke('double', '4')).rejects.toThrow('finite number');
    await expect(tool.run(5, new AbortController().signal)).resolves.toBe(10);
  });

  it('validates outputs and snapshots definitions without running them', async () => {
    const execute = vi.fn(async (_value: number): Promise<number> => Number.NaN);
    const schema = { type: 'object', properties: { count: { type: 'number' } } };
    const tool = defineAiTool({
      id: 'bad-output', title: 'Output validation', description: 'Reject invalid provider outputs.', inputSchema: schema,
      parseInput: parseNumber, parseOutput: parseNumber, execute,
    });
    schema.properties.count.type = 'string';
    expect(execute).not.toHaveBeenCalled();
    expect(tool.inputSchema).toEqual({ type: 'object', properties: { count: { type: 'number' } } });
    expect(Object.isFrozen((tool.inputSchema as typeof schema).properties.count)).toBe(true);
    await expect(tool.invoke(3, new AbortController().signal)).rejects.toThrow('finite number');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('refuses duplicates and removed tools and recovers when contributions become valid', async () => {
    const tool = double();
    const { consumer, replace } = await setup([tool]);
    replace([tool, tool]);
    expect(consumer.tools.read()).toEqual([]);
    expect(consumer.error.read()?.message).toContain('Duplicate AI tool');
    await expect(consumer.invoke('double', 3)).rejects.toThrow('Duplicate');
    replace([tool]);
    expect(consumer.error.read()).toBeUndefined();
    await expect(consumer.invoke('double', 3)).resolves.toBe(6);
    replace([]);
    await expect(consumer.invoke('double', 3)).rejects.toThrow('unavailable');
  });

  it('removes malformed tools and clears canceled catalogs despite failing observers', async () => {
    const tool = double();
    const { consumer, scope, replace } = await setup([tool]);
    consumer.error.subscribe(() => { throw new Error('Broken error observer.'); });
    consumer.tools.subscribe(() => { throw new Error('Broken tool observer.'); });
    const malformed = { ...tool, invoke: undefined } as unknown as AiContribution;
    expect(() => replace([malformed])).not.toThrow();
    expect(consumer.tools.read()).toEqual([]);
    expect(consumer.error.read()?.message).toContain('Invalid AI contribution');
    await expect(consumer.invoke('double', 3)).rejects.toThrow('Invalid AI contribution');
    expect(() => replace([tool])).not.toThrow();
    expect(consumer.error.read()).toBeUndefined();
    await expect(consumer.invoke('double', 3)).resolves.toBe(6);
    await expect(scope.dispose()).resolves.toBeUndefined();
    expect(consumer.tools.read()).toEqual([]);
    expect(() => replace([tool])).not.toThrow();
    expect(consumer.tools.read()).toEqual([]);
  });

  it('passes cancellation to tools and joins accepted invocations during shutdown', async () => {
    let finish!: () => void;
    let received!: AbortSignal;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const tool = defineAiTool({
      id: 'slow', title: 'Slow', description: 'Exercise owned invocation lifetime.', inputSchema: { type: 'number' },
      parseInput: parseNumber, parseOutput: parseNumber,
      execute: async (input, signal) => { received = signal; await pending; return input; },
    });
    const { consumer, scope, replace } = await setup([tool]);
    const invocation = consumer.invoke('slow', 3);
    const rejected = expect(invocation).rejects.toThrow();
    let disposed = false;
    const closing = scope.dispose().then(() => { disposed = true; });
    await Promise.resolve();
    expect(received.aborted).toBe(true);
    expect(disposed).toBe(false);
    expect(consumer.tools.read()).toEqual([]);
    replace([tool]);
    expect(consumer.tools.read()).toEqual([]);
    await expect(consumer.invoke('slow', 3)).rejects.toThrow();
    finish();
    await rejected;
    await closing;
    expect(disposed).toBe(true);
  });

  it('rejects canceled calls before feature execution and malformed contribution payloads', async () => {
    const execute = vi.fn(async (value: number) => value);
    const tool = defineAiTool({
      id: 'idle', title: 'Idle', description: 'Must not run after cancellation.', inputSchema: { type: 'number' },
      parseInput: parseNumber, parseOutput: parseNumber, execute,
    });
    const cancellation = new AbortController();
    cancellation.abort(new Error('Stopped.'));
    await expect(tool.run(1, cancellation.signal)).rejects.toThrow('Stopped.');
    expect(execute).not.toHaveBeenCalled();
    expect(aiContributionContract.validate?.({ id: 'invalid', invoke() {} })).toBe(false);
  });
});
