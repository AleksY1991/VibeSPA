import type { Readable, Unsubscribe } from '@vibespa/contracts';

export interface SurfaceActionSnapshot {
  readonly id: string;
  readonly keys: readonly string[];
  readonly enabled: boolean;
  readonly allowInEditable: boolean;
}

export interface SurfaceSnapshot {
  readonly id: string;
  readonly active: boolean;
  readonly transparent: boolean;
  /** An active surface is reachable until an active opaque surface above it. */
  readonly reachable: boolean;
  readonly blockedBy?: string;
  readonly actions: readonly SurfaceActionSnapshot[];
}

export interface InteractionSnapshot {
  readonly state: 'active' | 'cancelled' | 'disposed';
  /** Newest mount first, including inactive and blocked surfaces. */
  readonly surfaces: readonly SurfaceSnapshot[];
}

interface DiagnosticSurface {
  readonly id: string;
  readonly active: Readable<boolean>;
  readonly transparent: boolean;
  readonly actions: readonly {
    readonly id: string;
    readonly keys: readonly string[];
    readonly enabled?: Readable<boolean>;
    readonly allowInEditable?: boolean;
  }[];
}

interface Subscription {
  readonly listener: (snapshot: InteractionSnapshot) => void;
  active: boolean;
}

/** Private metadata observer; it never exposes or invokes action implementations. */
export function createInteractionDiagnostics(
  surfaces: () => readonly DiagnosticSurface[],
  state: () => InteractionSnapshot['state'],
) {
  let value: InteractionSnapshot = Object.freeze({ state: 'active', surfaces: Object.freeze([]) });
  const subscriptions = new Set<Subscription>();
  const watches = new Map<DiagnosticSurface, readonly Unsubscribe[]>();
  const pending: { value: InteractionSnapshot; listeners: readonly Subscription[] }[] = [];
  let notifying = false;

  const publish = () => {
    const status = state();
    let blockedBy: string | undefined;
    const nodes = [...surfaces()].reverse().map(surface => {
      const active = surface.active.read();
      const node: SurfaceSnapshot = Object.freeze({
        id: surface.id,
        active,
        transparent: surface.transparent,
        reachable: status === 'active' && active && blockedBy === undefined,
        ...(blockedBy === undefined ? {} : { blockedBy }),
        actions: Object.freeze(surface.actions.map(action => Object.freeze({
          id: action.id,
          keys: action.keys,
          enabled: action.enabled?.read() ?? true,
          allowInEditable: action.allowInEditable ?? false,
        }))),
      });
      if (active && !surface.transparent && blockedBy === undefined) blockedBy = surface.id;
      return node;
    });
    const next = Object.freeze({ state: status, surfaces: Object.freeze(nodes) });
    // Metadata is small and contains only these JSON-safe primitives. Shared
    // active/enabled sources can notify more than one mounted-surface watcher.
    if (JSON.stringify(next) === JSON.stringify(value)) return;
    value = next;
    pending.push({ value, listeners: [...subscriptions] });
    if (notifying) return;
    notifying = true;
    try {
      for (let index = 0; index < pending.length; index++) {
        const change = pending[index]!;
        for (const subscription of change.listeners) {
          if (!subscription.active) continue;
          // A debugging view cannot fail application commands or cleanup.
          try { subscription.listener(change.value); } catch { /* observational boundary */ }
        }
      }
    } finally {
      pending.length = 0;
      notifying = false;
    }
  };

  const unwatch = (surface: DiagnosticSurface) => {
    const releases = watches.get(surface);
    watches.delete(surface);
    for (const release of releases ?? []) release();
  };

  const snapshot: Readable<InteractionSnapshot> = Object.freeze({
    read: () => value,
    subscribe(listener: (snapshot: InteractionSnapshot) => void): Unsubscribe {
      const subscription = { listener, active: true };
      subscriptions.add(subscription);
      return () => {
        subscription.active = false;
        subscriptions.delete(subscription);
      };
    },
  });

  return {
    snapshot,
    publish,
    watch(surface: DiagnosticSurface) {
      const sources = new Set([surface.active, ...surface.actions.flatMap(action => action.enabled ? [action.enabled] : [])]);
      const releases: Unsubscribe[] = [];
      try {
        for (const source of sources) releases.push(source.subscribe(publish));
      } catch (error) {
        for (const release of releases) release();
        throw error;
      }
      watches.set(surface, releases);
    },
    unwatch,
    stopWatching() {
      for (const surface of [...watches.keys()]) unwatch(surface);
    },
  };
}
