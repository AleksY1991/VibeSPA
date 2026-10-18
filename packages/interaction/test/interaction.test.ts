import { describe, expect, it, vi } from 'vitest';
import { createScope } from '@vibespa/core/scope';
import { constantReadable, createSource } from '@vibespa/core/readable';
import { createInteraction, normalizeKey } from '../src/index.js';

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

describe('key combinations', () => {
  it.each([
    ['Control+Shift+K', 'ctrl+shift+k'], ['Command+Enter', 'meta+enter'],
    ['Escape', 'escape'], ['ArrowLeft', 'left'], [' ', 'space'], ['+', 'plus'],
  ])('normalizes %s', (input, expected) => expect(normalizeKey(input)).toBe(expected));
  it.each(['', 'ctrl', 'ctrl+k+x', 'ctrl+'])('rejects %s', input => expect(() => normalizeKey(input)).toThrow('Invalid key'));
});
