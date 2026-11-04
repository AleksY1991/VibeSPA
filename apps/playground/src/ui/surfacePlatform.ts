import { HOTKEY_DELEGATE, HOTKEY_PASS, nativeOwnsCombo, surfaceShadowHost } from '@ui-kit/core/contracts/platform';
import type { ElementSurfaceDefinition, ElementSurfaceLease, ElementSurfaceResolution, ElementSurfaceUpdate, NonvisualSurfaceDefinition, SurfaceHotkeyHandler, SurfaceLease, UiRendererDefinition, UiSurfacePlatform } from '@ui-kit/core/contracts/platform';

interface Mounted {
  readonly id: string;
  readonly order: number;
  readonly name: string;
  readonly parentId?: string | null;
  readonly element?: Element;
  readonly target?: EventTarget;
  readonly transparent: boolean;
  readonly keys: Readonly<Record<string, SurfaceHotkeyHandler>>;
  readonly delegate?: readonly string[] | 'all';
  readonly nativeOverrides?: readonly string[];
  readonly focusKeys?: Readonly<Record<string, SurfaceHotkeyHandler>>;
  layer: boolean;
  modal?: boolean;
  dismissable?: boolean;
  nativeOwners?: readonly Element[];
  activationRoots?: readonly Element[];
}

/** The host supplies surface authority; shared controls retain their native DOM
 * and keyboard behavior. This adapter dispatches only explicitly declared keys,
 * never another keyboard handler alongside a control's native owner. */
export function createUiSurfacePlatform(document: Document) {
  const definitions = new Map<string, UiRendererDefinition>();
  const mounted = new Map<string, Mounted>();
  const observers = new Set<() => void>();
  const actionObservers = new Map<string, Set<() => void>>();
  const claimed = new WeakSet<Event>();
  let sequence = 0;
  let attached = false;
  const notify = () => { for (const listener of [...observers]) listener(); };
  const ordered = () => [...mounted.values()].sort((a, b) => b.order - a.order);
  const owns = (entry: Mounted, owner: Mounted): boolean => {
    const visited = new Set<string>();
    for (let next: Mounted | undefined = entry; next && !visited.has(next.id); next = next.parentId ? mounted.get(next.parentId) : undefined) {
      if (next === owner) return true;
      visited.add(next.id);
    }
    return false;
  };
  const contains = (entry: Mounted, target?: EventTarget | null): boolean => {
    if (!target || !('nodeType' in target)) return false;
    const node = target as Node;
    if (entry.element === node || entry.element?.contains(node)) return true;
    return [...mounted.values()].some(child => child.element && (child.element === node || child.element.contains(node)) && owns(child, entry));
  };
  const live = (entry: Mounted): boolean => {
    if (!mounted.has(entry.id) || entry.parentId && !mounted.has(entry.parentId)) return false;
    for (let node: Element | null | undefined = entry.element; node; node = node.parentElement ?? surfaceShadowHost(node.getRootNode())) {
      if (!node.isConnected || node.hasAttribute('hidden') || node.hasAttribute('inert')) return false;
      const style = document.defaultView?.getComputedStyle(node);
      if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse') return false;
    }
    return true;
  };
  const activeLayer = () => ordered().find(entry => entry.layer && !entry.transparent && live(entry));
  const admitted = (entry: Mounted): boolean => {
    if (!live(entry)) return false;
    const layer = activeLayer();
    return !layer || owns(entry, layer) || !!entry.element && (layer.activationRoots?.some(root => root === entry.element || root.contains(entry.element!)) ?? false);
  };
  const forget = (entry: Mounted) => {
    const subtree = [...mounted.values()].filter(child => owns(child, entry));
    for (const child of subtree) mounted.delete(child.id);
    notify();
  };
  const children = (entry: Mounted) => ordered().filter(child => child !== entry && child.dismissable && owns(child, entry) && live(child));
  const canDismiss = (entry: Mounted, target?: EventTarget | null) => {
    if (!entry.dismissable || !live(entry)) return false;
    if (!entry.layer && target && !contains(entry, target)) return false;
    const latest = ordered().find(candidate => candidate.dismissable && live(candidate) && (candidate.layer || contains(candidate, target)));
    return !latest || latest === entry;
  };
  const invoke = (entry: Mounted, event: KeyboardEvent, combo: string, visited = new Set<string>()): ElementSurfaceResolution => {
    if (visited.has(entry.id) || !live(entry)) return { kind: 'unclaimed' };
    visited.add(entry.id);
    const handler = entry.keys[combo];
    if (handler && entry.element) {
      if (!admitted(entry)) return { kind: 'blocked', name: entry.name };
      const result = handler(event, entry.element);
      if (result !== HOTKEY_DELEGATE) return { kind: result === HOTKEY_PASS ? 'blocked' : 'handled', name: entry.name };
    } else if (!entry.transparent && entry.delegate !== 'all' && !entry.delegate?.includes(combo)) {
      return { kind: 'blocked', name: entry.name };
    }
    const parent = entry.parentId ? mounted.get(entry.parentId) : undefined;
    return parent ? invoke(parent, event, combo, visited) : { kind: 'unclaimed' };
  };
  const childEscape = (entry: Mounted, event: KeyboardEvent): ElementSurfaceResolution => {
    const child = children(entry).find(child => child.layer || contains(child, event.target));
    return child ? invoke(child, event, 'Escape', new Set([entry.id])) : { kind: 'unclaimed' };
  };
  function mount(definition: Omit<ElementSurfaceDefinition, 'element'> & { readonly element?: Element; readonly target?: EventTarget }): ElementSurfaceLease {
    const order = ++sequence;
    const entry: Mounted = { ...definition, id: `${definition.name}:${order}`, order };
    mounted.set(entry.id, entry);
    notify();
    let active = true;
    return {
      instanceId: entry.id,
      dispose() { if (active) { active = false; forget(entry); } },
      update(next: ElementSurfaceUpdate) { if (active && mounted.has(entry.id)) { Object.assign(entry, next); notify(); } },
      authority: {
        subscribe(listener) { observers.add(listener); return () => { observers.delete(listener); }; },
        canActivate: () => admitted(entry),
        canDismiss: target => canDismiss(entry, target),
        claimDismissal(event) {
          if (claimed.has(event) || !canDismiss(entry, event.target)) return false;
          claimed.add(event); return true;
        },
        canMoveFocus() {
          if (!live(entry)) return false;
          const modal = ordered().find(candidate => candidate.modal && live(candidate));
          return !modal || owns(entry, modal);
        },
        canRestoreFocus(target) {
          if (ordered().some(candidate => candidate.order > entry.order && candidate.dismissable && live(candidate) && (candidate.layer || owns(candidate, entry)))) return false;
          const modal = ordered().find(candidate => candidate.modal && live(candidate));
          return !modal || (target ? contains(modal, target) : owns(entry, modal));
        },
        hasDismissableChild: () => children(entry).length > 0,
        dispatchChildEscape: event => childEscape(entry, event),
      },
    };
  }
  const platform: UiSurfacePlatform = {
    registerRenderer(definition) { definitions.set(definition.id, definition); },
    mountRenderer(id): SurfaceLease {
      const definition = definitions.get(id);
      if (!definition) throw new Error(`Unknown UI renderer: ${id}`);
      return mount({ name: id, transparent: definition.transparent, layer: false, keys: {} });
    },
    mountElement: definition => mount(definition),
    mountNonvisual: (definition: NonvisualSurfaceDefinition) => mount({ ...definition, transparent: false, layer: false, keys: {}, delegate: 'all' }),
    onAction(id, listener, rendererInstanceId) {
      const key = `${rendererInstanceId ?? ''}/${id}`;
      const listeners = actionObservers.get(key) ?? new Set<() => void>();
      listeners.add(listener); actionObservers.set(key, listeners);
      return () => { listeners.delete(listener); if (!listeners.size) actionObservers.delete(key); };
    },
  };
  function keydown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.isComposing || event.key === 'Process' || event.keyCode === 229) return;
    const key = event.key === ' ' ? 'Space' : event.key;
    if (['Control', 'Alt', 'Meta', 'Shift'].includes(key)) return;
    const combo = [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.metaKey && 'Meta', event.shiftKey && 'Shift', key.length === 1 ? key.toUpperCase() : key].filter(Boolean).join('+');
    const path = event.composedPath();
    const entries = ordered();
    const finish = (result: ElementSurfaceResolution) => {
      if (result.kind === 'handled') { event.preventDefault(); event.stopPropagation(); }
      return result.kind !== 'unclaimed';
    };
    const focusOwner = entries.find(entry => entry.layer && live(entry) && entry.focusKeys?.[combo]);
    if (focusOwner?.element) {
      const result = focusOwner.focusKeys![combo]!(event, focusOwner.element);
      if (result !== HOTKEY_DELEGATE) { if (result !== HOTKEY_PASS) { event.preventDefault(); event.stopPropagation(); } return; }
    }
    // This marker is the explicit keyboard ownership seam supplied by shared
    // controls. Releasing a native key never delegates it to an app shortcut.
    const nativeOwner = path.find((target): target is Element => target instanceof Element && nativeOwnsCombo(combo, target.getAttribute('data-ui-keyboard-owner')?.split(/\s+/) ?? []));
    if (nativeOwner) {
      const nativeLayer = activeLayer();
      if (nativeLayer && !contains(nativeLayer, nativeOwner) && !nativeLayer.activationRoots?.some(root => root === nativeOwner || root.contains(nativeOwner))) {
        event.preventDefault(); event.stopPropagation(); return;
      }
      const override = entries.find(entry => live(entry) && entry.nativeOverrides?.includes(combo) && (entry.element && path.includes(entry.element) || entry.nativeOwners?.includes(nativeOwner)));
      if (override) finish(invoke(override, event, combo));
      return;
    }
    for (const entry of entries.filter(entry => entry.layer && live(entry))) if (finish(invoke(entry, event, combo))) return;
    for (const target of path) for (const entry of entries.filter(entry => entry.element === target && live(entry))) if (finish(invoke(entry, event, combo))) return;
  }
  return {
    platform,
    attach() {
      if (!attached) { document.addEventListener('keydown', keydown, true); attached = true; }
      return () => { if (attached) { document.removeEventListener('keydown', keydown, true); attached = false; } };
    },
  };
}
