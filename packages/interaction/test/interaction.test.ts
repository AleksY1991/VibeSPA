import { describe, expect, it, vi } from 'vitest';
import { createScope } from '@vibespa/core/scope';
import { constantReadable, createSource } from '@vibespa/core/readable';
import { createInteraction, normalizeKey } from '../src/index.js';
import type { InteractionSnapshot } from '../src/index.js';

const active = constantReadable(true);

describe('surface arbitration', () => {
  it('denies unknown actions and lets an opaque active upper surface stop fallthrough', async () => {
    const scope = createScope();
    const interaction = createInteraction(scope);
    const run = vi.fn();
    interaction.mount({ id: 'page', active, actions: [{ id: 'save', keys: ['Ctrl+s'], run }] });
    expect(await interaction.invoke('unknown')).toBe(false);
    expect(interaction.resolveKey('control+s')?.actionId).toBe('save');
    const release = interaction.mount({ id: 'dialog', active, actions: [] });
    expect(interaction.resolveKey('ctrl+s')).toBeNull();
    expect(await interaction.invoke('save')).toBe(false);
    expect(run).not.toHaveBeenCalled();
    release();
    expect(await interaction.invoke('save')).toBe(true);
    expect(run).toHaveBeenCalledExactlyOnceWith({ signal: scope.signal });
    await scope.dispose();
  });

  it('uses current shared liveness and permits fallthrough only through transparent surfaces', async () => {
    const scope = createScope();
    const interaction = createInteraction(scope);
    const dialog = createSource(false);
    interaction.mount({ id: 'page', active, actions: [{ id: 'save', keys: ['s'], run: () => {} }] });
    interaction.mount({ id: 'hint', active, transparent: true, actions: [] });
    interaction.mount({ id: 'dialog', active: dialog.source, actions: [] });
    expect(interaction.resolveKey('s')?.surfaceId).toBe('page');
    dialog.set(true);
    expect(interaction.resolveKey('s')).toBeNull();
    dialog.set(false);
    expect(interaction.resolveKey('s')?.surfaceId).toBe('page');
    await scope.dispose();
  });

  it('gives the newest surface priority for competing keys', async () => {
    const scope = createScope();
    const interaction = createInteraction(scope);
    interaction.mount({ id: 'page', active, actions: [{ id: 'page.close', keys: ['Escape'], run: () => {} }] });
    interaction.mount({ id: 'dialog', active, transparent: true,
      actions: [{ id: 'dialog.close', keys: ['esc'], run: () => {} }] });
    expect(interaction.resolveKey('escape')?.actionId).toBe('dialog.close');
    await scope.dispose();
  });

  it('checks enabled state and stack reachability again when invoking a prior resolution', async () => {
    const scope = createScope();
    const interaction = createInteraction(scope);
    const enabled = createSource(true);
    const run = vi.fn();
    interaction.mount({ id: 'page', active,
      actions: [{ id: 'save', keys: ['s'], enabled: enabled.source, run }] });
    const resolved = interaction.resolveKey('s')!;
    enabled.set(false);
    expect(await resolved.invoke()).toBe(false);
    enabled.set(true);
    const release = interaction.mount({ id: 'dialog', active, actions: [] });
    expect(await resolved.invoke()).toBe(false);
    release();
    expect(await resolved.invoke()).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    await scope.dispose();
  });

  it('does not resurrect a released surface after its IDs are reused', async () => {
    const scope = createScope();
    const interaction = createInteraction(scope);
    const previous = vi.fn();
    const replacement = vi.fn();
    const release = interaction.mount({ id: 'page', active,
      actions: [{ id: 'save', keys: ['s'], run: previous }] });
    const resolved = interaction.resolveAction('save')!;
    release();
    release();
    interaction.mount({ id: 'page', active, actions: [{ id: 'save', keys: ['s'], run: replacement }] });
    expect(await resolved.invoke()).toBe(false);
    expect(previous).not.toHaveBeenCalled();
    expect(replacement).not.toHaveBeenCalled();
    expect(await interaction.invoke('save')).toBe(true);
    await scope.dispose();
  });

  it('rechecks the resolved surface liveness before invoking its command', async () => {
    const scope = createScope();
    const interaction = createInteraction(scope);
    const visible = createSource(true);
    const run = vi.fn();
    interaction.mount({ id: 'dialog', active: visible.source,
      actions: [{ id: 'submit', keys: ['enter'], run }] });
    const resolved = interaction.resolveAction('submit')!;
    visible.set(false);
    expect(await resolved.invoke()).toBe(false);
    expect(run).not.toHaveBeenCalled();
    await scope.dispose();
  });

  it('preserves native editable keys unless an action explicitly overrides them', async () => {
    const scope = createScope();
    const interaction = createInteraction(scope);
    interaction.mount({ id: 'page', active, actions: [
      { id: 'delete', keys: ['Backspace'], run: () => {} },
      { id: 'submit', keys: ['Ctrl+Enter'], allowInEditable: true, run: () => {} },
    ] });
    expect(interaction.resolveKey('Backspace', { editable: true })).toBeNull();
    expect(interaction.resolveKey('ctrl+enter', { editable: true })?.actionId).toBe('submit');
    await scope.dispose();
  });

  it('cancels interaction before explicit teardown on parent cancellation', async () => {
    const parent = new AbortController();
    const scope = createScope(parent.signal);
    const interaction = createInteraction(scope);
    const run = vi.fn();
    interaction.mount({ id: 'page', active, actions: [{ id: 'save', run }] });
    const resolved = interaction.resolveAction('save')!;
    parent.abort();
    expect(await resolved.invoke()).toBe(false);
    expect(() => interaction.mount({ id: 'other', active, actions: [] })).toThrow('ended scope');
    expect(run).not.toHaveBeenCalled();
    await scope.dispose();
  });

  it('rejects ambiguous surface, action, and normalized key declarations', async () => {
    const scope = createScope();
    const interaction = createInteraction(scope);
    interaction.mount({ id: 'page', active, actions: [{ id: 'save', run: () => {} }] });
    expect(() => interaction.mount({ id: 'page', active, actions: [] })).toThrow('Duplicate surface');
    expect(() => interaction.mount({ id: 'other', active, actions: [{ id: 'save', run: () => {} }] })).toThrow('Duplicate action');
    expect(() => interaction.mount({ id: 'other', active, actions: [
      { id: 'one', keys: ['Esc'], run: () => {} }, { id: 'two', keys: ['Escape'], run: () => {} },
    ] })).toThrow('Duplicate key');
    await scope.dispose();
  });
});

describe('interaction diagnostics', () => {
  it('describes the complete stack and recomputes live reachability and action availability', async () => {
    const scope = createScope();
    const interaction = createInteraction(scope);
    const dialog = createSource(false);
    const enabled = createSource(true);
    const run = vi.fn();
    interaction.mount({ id: 'page', active, actions: [{ id: 'save', keys: ['Control+S'], enabled: enabled.source, run }] });
    interaction.mount({ id: 'hint', active, transparent: true, actions: [] });
    const releaseDialog = interaction.mount({ id: 'dialog', active: dialog.source, actions: [] });
    const read = () => interaction.snapshot.read();
    expect(read()).toEqual({ state: 'active', surfaces: [
      { id: 'dialog', active: false, transparent: false, reachable: false, actions: [] },
      { id: 'hint', active: true, transparent: true, reachable: true, actions: [] },
      { id: 'page', active: true, transparent: false, reachable: true, actions: [
        { id: 'save', keys: ['ctrl+s'], enabled: true, allowInEditable: false },
      ] },
    ] });
    const first = read();
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.surfaces)).toBe(true);
    expect(Object.isFrozen(first.surfaces[2])).toBe(true);
    expect(Object.isFrozen(first.surfaces[2]!.actions[0])).toBe(true);
    expect(Object.isFrozen(first.surfaces[2]!.actions[0]!.keys)).toBe(true);
    expect(read()).toBe(first);
    const changed = vi.fn();
    interaction.snapshot.subscribe(changed);
    dialog.set(true);
    expect(read().surfaces.map(surface => [surface.id, surface.reachable, surface.blockedBy])).toEqual([
      ['dialog', true, undefined], ['hint', false, 'dialog'], ['page', false, 'dialog'],
    ]);
    enabled.set(false);
    expect(read().surfaces[2]!.actions[0]!.enabled).toBe(false);
    expect(first.surfaces[2]!.actions[0]!.enabled).toBe(true);
    releaseDialog();
    expect(read().surfaces[0]!.id).toBe('hint');
    expect(read().surfaces.every(surface => surface.reachable)).toBe(true);
    const count = changed.mock.calls.length;
    releaseDialog();
    expect(changed).toHaveBeenCalledTimes(count);
    expect(run).not.toHaveBeenCalled();
    await scope.dispose();
  });

  it('isolates inspector failures and delivers reentrant changes in order', async () => {
    const scope = createScope();
    const interaction = createInteraction(scope);
    interaction.snapshot.subscribe(() => { throw new Error('broken inspector'); });
    const changes: string[][] = [];
    interaction.snapshot.subscribe(snapshot => {
      if (snapshot.surfaces.length === 1) interaction.mount({ id: 'overlay', active, transparent: true, actions: [] });
    });
    const unsubscribe = interaction.snapshot.subscribe(snapshot => changes.push(snapshot.surfaces.map(surface => surface.id)));
    expect(() => interaction.mount({ id: 'page', active, actions: [] })).not.toThrow();
    expect(changes).toEqual([['page'], ['overlay', 'page']]);
    unsubscribe();
    unsubscribe();
    expect(() => interaction.dispose()).not.toThrow();
    expect(changes).toHaveLength(2);
    expect(interaction.snapshot.read()).toEqual({ state: 'disposed', surfaces: [] });
    await scope.dispose();
  });

  it('reports cancellation before teardown and releases all observed sources', async () => {
    const parent = new AbortController();
    const scope = createScope(parent.signal);
    const interaction = createInteraction(scope);
    const source = createSource(true);
    const unsubscribed = vi.fn();
    const watched = {
      read: source.source.read,
      subscribe(listener: (value: boolean) => void) {
        const release = source.source.subscribe(listener);
        return () => { unsubscribed(); release(); };
      },
    };
    const changes: InteractionSnapshot[] = [];
    interaction.snapshot.subscribe(snapshot => changes.push(snapshot));
    interaction.mount({ id: 'page', active: watched, actions: [{ id: 'save', enabled: watched, run: () => {} }] });
    parent.abort();
    expect(interaction.snapshot.read().state).toBe('cancelled');
    expect(interaction.snapshot.read().surfaces[0]!.reachable).toBe(false);
    expect(unsubscribed).toHaveBeenCalledTimes(1);
    const count = changes.length;
    source.set(false);
    expect(changes).toHaveLength(count);
    await scope.dispose();
    expect(interaction.snapshot.read()).toEqual({ state: 'disposed', surfaces: [] });
    expect(unsubscribed).toHaveBeenCalledTimes(1);
  });

  it('stops observing released mounts and keeps duplicate IDs from affecting diagnostics', async () => {
    const scope = createScope();
    const interaction = createInteraction(scope);
    const visible = createSource(true);
    const enabled = createSource(true);
    const release = interaction.mount({ id: 'page', active: visible.source,
      actions: [{ id: 'save', enabled: enabled.source, run: () => {} }] });
    const current = interaction.snapshot.read();
    expect(() => interaction.mount({ id: 'page', active, actions: [] })).toThrow('Duplicate surface');
    expect(interaction.snapshot.read()).toBe(current);
    release();
    const empty = interaction.snapshot.read();
    visible.set(false);
    enabled.set(false);
    expect(interaction.snapshot.read()).toBe(empty);
    await scope.dispose();
  });
});

describe('key combinations', () => {
  it.each([
    ['Control+Shift+K', 'ctrl+shift+k'], ['Command+Enter', 'meta+enter'],
    ['Escape', 'escape'], ['ArrowLeft', 'left'], [' ', 'space'], ['+', 'plus'],
  ])('normalizes %s', (input, expected) => expect(normalizeKey(input)).toBe(expected));
  it.each(['', 'ctrl', 'ctrl+k+x', 'ctrl+'])('rejects %s', input => expect(() => normalizeKey(input)).toThrow('Invalid key'));
});
