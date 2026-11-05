import type { Readable } from '@vibespa/contracts';
import { defineContributionContract } from './contributions.js';
import type { ContributionRegistry } from './contributions.js';
import type { ModuleContext } from './module.js';
import { createSource } from './readable.js';

/** Public tool metadata can be passed to an AI adapter without exposing commands. */
export interface AiToolSummary {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Readonly<object>;
}

/** The unknown boundary is validated by the tool before entering feature code. */
export interface AiContribution extends AiToolSummary {
  invoke(input: unknown, signal: AbortSignal): Promise<unknown>;
}

export interface AiToolDefinition<Input, Output> extends AiToolSummary {
  parseInput(value: unknown): Input;
  parseOutput(value: unknown): Output;
  execute(input: Input, signal: AbortSignal): Promise<Output>;
}

export interface AiTool<Input, Output> extends AiContribution {
  run(input: Input, signal: AbortSignal): Promise<Output>;
}

export const aiContributionContract = defineContributionContract<AiContribution>({
  id: 'vibespa.ai', version: 1,
  validate(value) {
    if (!value || typeof value !== 'object') return false;
    const tool = value as Partial<AiContribution>;
    return typeof tool.id === 'string' && !!tool.id.trim()
      && typeof tool.title === 'string' && !!tool.title.trim()
      && typeof tool.description === 'string' && !!tool.description.trim()
      && !!tool.inputSchema && typeof tool.inputSchema === 'object' && !Array.isArray(tool.inputSchema)
      && typeof tool.invoke === 'function';
  },
});

/** Declare an inert tool with both a typed local call and a validated AI boundary.
 * Parsers should reject invalid input/output by throwing. The framework makes no
 * network request and chooses no model, credentials, or authorization policy.
 */
export function defineAiTool<Input, Output>(definition: AiToolDefinition<Input, Output>): AiTool<Input, Output> {
  const { id, title, description, parseInput, parseOutput, execute } = definition;
  if (!id.trim() || !title.trim() || !description.trim()) throw new Error('AI tools need an id, title and description.');
  if (definition.inputSchema === null || typeof definition.inputSchema !== 'object' || Array.isArray(definition.inputSchema)) {
    throw new Error(`AI tool ${id} needs an input schema object.`);
  }
  const inputSchema = freezeSchema(structuredClone(definition.inputSchema));
  const invoke = async (input: unknown, signal: AbortSignal): Promise<Output> => {
    signal.throwIfAborted();
    const parsed = parseInput(input);
    signal.throwIfAborted();
    const result = await execute(parsed, signal);
    signal.throwIfAborted();
    return parseOutput(result);
  };
  return Object.freeze({ id, title, description, inputSchema, invoke, run: invoke });
}

function freezeSchema<Value>(value: Value, ancestors = new WeakSet<object>()): Value {
  if (value && typeof value === 'object') {
    if (ancestors.has(value)) throw new Error('AI input schemas must be acyclic JSON data.');
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) {
      throw new Error('AI input schemas must contain only JSON data.');
    }
    ancestors.add(value);
    for (const child of Object.values(value)) freezeSchema(child, ancestors);
    ancestors.delete(value);
    Object.freeze(value);
  } else if (value !== null && typeof value !== 'string' && typeof value !== 'boolean'
    && !(typeof value === 'number' && Number.isFinite(value))) {
    throw new Error('AI input schemas must contain only JSON data.');
  }
  return value;
}

export interface AiConsumer {
  readonly tools: Readable<readonly AiToolSummary[]>;
  readonly error: Readable<Error | undefined>;
  invoke(toolId: string, input: unknown): Promise<unknown>;
}

/** Catalog and invoke the currently ready tools; removed providers cannot be called. */
export function createAiConsumer(scope: ModuleContext, registry: ContributionRegistry<AiContribution>): AiConsumer {
  if (scope.signal.aborted) throw new Error('Cannot create an AI consumer in an ended scope.');
  if (registry.contract !== aiContributionContract) throw new Error('Use the canonical AI contribution registry.');
  const tools = createSource<readonly AiToolSummary[]>(Object.freeze([]));
  const error = createSource<Error | undefined>(undefined);
  let active = new Map<string, AiContribution>();
  let stopped = false;
  let revision = 0;
  const publish = (next: readonly AiToolSummary[], failure?: Error, expected = revision): void => {
    if (revision !== expected) return;
    try { error.set(failure); } catch { /* A reader cannot prevent other publication. */ }
    if (revision !== expected) return;
    try { tools.set(next); } catch { /* Sources update before notifying observers. */ }
  };
  const refresh = (): void => {
    if (stopped) return;
    const expected = ++revision;
    const next = new Map<string, AiContribution>();
    let summaries: readonly AiToolSummary[];
    try {
      for (const { id, value: tool } of registry.items.read()) {
        if (!aiContributionContract.validate?.(tool)) throw new Error(`Invalid AI contribution: ${id}`);
        if (!tool.id.trim()) throw new Error('AI tools need a nonempty id.');
        if (next.has(tool.id)) throw new Error(`Duplicate AI tool: ${tool.id}`);
        next.set(tool.id, tool);
      }
      summaries = Object.freeze([...next.values()].map(tool => Object.freeze({
        id: tool.id, title: tool.title, description: tool.description, inputSchema: tool.inputSchema,
      })));
    } catch (failure) {
      if (revision !== expected) return;
      active = new Map();
      publish(Object.freeze([]), failure instanceof Error ? failure : new Error(String(failure)), expected);
      return;
    }
    if (revision !== expected) return;
    active = next;
    publish(summaries, undefined, expected);
  };
  refresh();
  const release = registry.items.subscribe(refresh);
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    revision++;
    active.clear();
    try { release(); } finally { publish(Object.freeze([])); }
  };
  scope.signal.addEventListener('abort', stop, { once: true });
  scope.defer(() => {
    scope.signal.removeEventListener('abort', stop);
    stop();
  });
  const commands = scope.commands({
    async invoke(toolId: string, input: unknown): Promise<unknown> {
      if (scope.signal.aborted) throw new Error('The AI consumer belongs to an ended scope.');
      const failure = error.source.read();
      if (failure) throw failure;
      const tool = active.get(toolId);
      if (!tool) throw new Error(`AI tool is unavailable: ${toolId}`);
      return tool.invoke(input, scope.signal);
    },
  });
  return Object.freeze({ tools: tools.source, error: error.source, ...commands });
}
