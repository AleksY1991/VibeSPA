// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { createScope } from '@vibespa/core/scope';
import { constantReadable } from '@vibespa/core/readable';
import { attachKeyboard } from '../src/browser.js';
import { createInteraction } from '../src/index.js';

describe('browser keyboard ownership', () => {
  it('attaches one dispatcher, prevents resolved keys, and detaches with its scope', async () => {
    const scope = createScope();
    const interaction = createInteraction(scope);
    const target = document.createElement('div');
    const run = vi.fn();
    interaction.mount({ id: 'page', active: constantReadable(true),
      actions: [{ id: 'save', keys: ['ctrl+s'], run }] });
    attachKeyboard({ scope, interaction, target });
    expect(() => attachKeyboard({ scope, interaction, target })).toThrow('already has');
    const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true });
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    await scope.dispose();
    const after = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true });
    target.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('skips composition, already handled events, and editable targets without an override', async () => {
    const scope = createScope();
    const interaction = createInteraction(scope);
    const target = document.createElement('div');
    const ordinary = vi.fn();
    const overridden = vi.fn();
    interaction.mount({ id: 'page', active: constantReadable(true), actions: [
      { id: 'ordinary', keys: ['backspace'], run: ordinary },
      { id: 'overridden', keys: ['ctrl+enter'], allowInEditable: true, run: overridden },
    ] });
    attachKeyboard({ scope, interaction, target });
    const input = document.createElement('textarea');
    target.append(input);
    const composing = new KeyboardEvent('keydown', { key: 'Backspace', isComposing: true, cancelable: true });
    target.dispatchEvent(composing);
    expect(composing.defaultPrevented).toBe(false);
    const editing = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true });
    input.dispatchEvent(editing);
    expect(editing.defaultPrevented).toBe(false);
    const handled = new KeyboardEvent('keydown', { key: 'Backspace', cancelable: true });
    handled.preventDefault();
    target.dispatchEvent(handled);
    expect(ordinary).not.toHaveBeenCalled();
    const submit = new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(submit);
    expect(submit.defaultPrevented).toBe(true);
    expect(overridden).toHaveBeenCalledTimes(1);
    await scope.dispose();
  });

  it('preserves contenteditable keys, including descendants of the editing host', async () => {
    const scope = createScope();
    const interaction = createInteraction(scope);
    const target = document.createElement('div');
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    const child = document.createElement('span');
    editor.append(child);
    target.append(editor);
    const run = vi.fn();
    interaction.mount({ id: 'page', active: constantReadable(true),
      actions: [{ id: 'delete', keys: ['backspace'], run }] });
    attachKeyboard({ scope, interaction, target });
    const event = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true });
    child.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(run).not.toHaveBeenCalled();
    await scope.dispose();
  });

  it('releases immediately on cancellation and permits a new owner for the target', async () => {
    const parent = new AbortController();
    const scope = createScope(parent.signal);
    const target = document.createElement('div');
    const release = attachKeyboard({ scope, target, interaction: createInteraction(scope) });
    parent.abort();
    release();
    const next = createScope();
    const nextRelease = attachKeyboard({ scope: next, target, interaction: createInteraction(next) });
    nextRelease();
    nextRelease();
    await scope.dispose();
    await next.dispose();
  });

  it('delivers command failures to the supplied reporter', async () => {
    const scope = createScope();
    const interaction = createInteraction(scope);
    const target = document.createElement('div');
    const error = new Error('failed command');
    const onError = vi.fn();
    interaction.mount({ id: 'page', active: constantReadable(true),
      actions: [{ id: 'fail', keys: ['f'], run: async () => { throw error; } }] });
    attachKeyboard({ scope, interaction, target, onError });
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    await scope.dispose();
  });
});
