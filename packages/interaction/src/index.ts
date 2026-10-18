import type { Readable, Scope } from '@vibespa/contracts';
import { normalizeKey } from './key.js';

export { normalizeKey } from './key.js';

export interface ActionContext {
  readonly signal: AbortSignal;
}

export interface SurfaceAction {
  readonly id: string;
  readonly keys?: readonly string[];
  readonly enabled?: Readable<boolean>;
  readonly allowInEditable?: boolean;
  run(context: ActionContext): void | Promise<void>;
}

export interface InteractionSurface {
  readonly id: string;
  /** Use this same capability to decide whether to render the surface. */
  readonly active: Readable<boolean>;
  /** Only transparent surfaces permit unmatched actions to reach lower layers. */
  readonly transparent?: boolean;
  readonly actions: readonly SurfaceAction[];
}

export interface KeyContext {
  readonly editable?: boolean;
}

export interface ResolvedAction {
  readonly surfaceId: string;
  readonly actionId: string;
  /** Resolution is advisory; invocation checks the current stack again. */
  invoke(): Promise<boolean>;
}

export interface Interaction {
  /** Newest active mount has priority. The returned release is idempotent. */
  mount(surface: InteractionSurface): () => void;
  resolveKey(key: string, context?: KeyContext): ResolvedAction | null;
  resolveAction(actionId: string): ResolvedAction | null;
  invoke(actionId: string): Promise<boolean>;
  dispose(): void;
}

interface MountedAction extends SurfaceAction {
  readonly keys: readonly string[];
}

interface MountedSurface {
  readonly token: symbol;
  readonly id: string;
  readonly active: Readable<boolean>;
  readonly transparent: boolean;
  readonly actions: readonly MountedAction[];
}

interface Candidate {
  readonly surface: MountedSurface;
  readonly action: MountedAction;
}

export function createInteraction(scope: Scope): Interaction {
  if (scope.signal.aborted) throw new Error('Cannot create interaction in an ended scope.');
  const mounted: MountedSurface[] = [];
  let closed = false;
  const current = () => !closed && !scope.signal.aborted;

  const find = (matches: (action: MountedAction) => boolean, context: KeyContext = {}): Candidate | null => {
    if (!current()) return null;
    for (let index = mounted.length - 1; index >= 0; index--) {
      const surface = mounted[index]!;
      if (!surface.active.read()) continue;
      const action = surface.actions.find(matches);
      if (action) {
        if (action.enabled && !action.enabled.read()) return null;
        if (context.editable && !action.allowInEditable) return null;
        return { surface, action };
      }
      if (!surface.transparent) return null;
    }
    return null;
  };

  const resolve = (matches: (action: MountedAction) => boolean, context?: KeyContext): ResolvedAction | null => {
    const candidate = find(matches, context);
    if (!candidate) return null;
    return Object.freeze({
      surfaceId: candidate.surface.id,
      actionId: candidate.action.id,
      async invoke(): Promise<boolean> {
        const live = find(matches, context);
        // A released and remounted ID cannot resurrect an earlier resolution.
        if (!live || live.surface.token !== candidate.surface.token || live.action !== candidate.action) return false;
        await live.action.run({ signal: scope.signal });
        return true;
      },
    });
  };

  const dispose = () => {
    if (closed) return;
    closed = true;
    mounted.length = 0;
    unregister();
  };
  const unregister = scope.defer(dispose);

  const interaction: Interaction = {
    mount(surface) {
      if (!current()) throw new Error('Interaction belongs to an ended scope.');
      if (!surface.id.trim()) throw new Error('A surface needs a nonempty ID.');
      if (mounted.some(item => item.id === surface.id)) throw new Error(`Duplicate surface: ${surface.id}`);
      const ids = new Set(mounted.flatMap(item => item.actions.map(action => action.id)));
      const keys = new Set<string>();
      const actions = surface.actions.map(action => {
        if (!action.id.trim()) throw new Error('An action needs a nonempty ID.');
        if (ids.has(action.id)) throw new Error(`Duplicate action: ${action.id}`);
        ids.add(action.id);
        const normalized = (action.keys ?? []).map(normalizeKey);
        for (const key of normalized) {
          if (keys.has(key)) throw new Error(`Duplicate key ${key} on surface ${surface.id}.`);
          keys.add(key);
        }
        return Object.freeze({ ...action, keys: Object.freeze(normalized) });
      });
      const entry: MountedSurface = Object.freeze({
        token: Symbol(surface.id), id: surface.id, active: surface.active,
        transparent: surface.transparent ?? false, actions: Object.freeze(actions),
      });
      mounted.push(entry);
      return () => {
        const index = mounted.indexOf(entry);
        if (index >= 0) mounted.splice(index, 1);
      };
    },
    resolveKey(key, context = {}) {
      const normalized = normalizeKey(key);
      const snapshot = Object.freeze({ ...context });
      return resolve(action => action.keys.includes(normalized), snapshot);
    },
    resolveAction: actionId => resolve(action => action.id === actionId),
    async invoke(actionId) {
      return (await interaction.resolveAction(actionId)?.invoke()) ?? false;
    },
    dispose,
  };
  return Object.freeze(interaction);
}
