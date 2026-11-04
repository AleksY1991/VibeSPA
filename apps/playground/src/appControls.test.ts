import { createComponent } from 'solid-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSolidSystem } from '@vibespa/solid/module';
import { applicationModules, createApplication } from './composition/createApplication';
import { App } from './ui/App';
import { mountUiRoot } from './ui/runtime';
import { settleUi } from './uiTestHost.test-helper';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  document.body.replaceChildren();
});

function button(root: ParentNode, label: string): HTMLButtonElement {
  const element = [...root.querySelectorAll<HTMLButtonElement>('button')]
    .find(control => control.textContent?.trim() === label || control.getAttribute('aria-label') === label);
  expect(element, `Missing ${label} command`).toBeDefined();
  return element!;
}

describe('Focus design-system controls', () => {
  it('keeps editing, completion and history commands connected through the real prepared controls', async () => {
    // The memory backend contains ordinary Solid records; no database is opened.
    const system = createSolidSystem({ id: 'app-controls', modules: applicationModules });
    cleanups.push(() => system.dispose());
    const app = await createApplication(system, { adapter: null });
    const target = document.createElement('div');
    document.body.append(target);
    cleanups.push(mountUiRoot(target, 'test-focus', () => createComponent(App, { focus: app.focus })));
    await settleUi(target);
    expect(button(target, 'Complete all').disabled).toBe(true);
    expect(button(target, 'Undo').disabled).toBe(true);

    const field = target.querySelector<HTMLElement & { value: string }>('wa-input')!;
    expect(field).not.toBeNull();
    const input = field.shadowRoot!.querySelector<HTMLInputElement>('input')!;
    input.value = 'A small step';
    input.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: 'A small step' }));
    await settleUi(target);
    const submitted = vi.fn();
    target.querySelector('form')!.addEventListener('submit', submitted);
    button(target, 'Add intention').click();
    await settleUi(target);
    expect(submitted).toHaveBeenCalledOnce();
    expect(target.querySelector('#intention-error')?.textContent).toBe('');
    expect(app.focus.pending().map(row => row.title)).toEqual(['A small step']);
    expect(field.value).toBe('');
    expect(button(target, 'Complete all').disabled).toBe(false);
    expect(button(target, 'Undo').disabled).toBe(false);

    const checkbox = target.querySelector<HTMLElement & { checked: boolean }>('wa-checkbox')!;
    expect(checkbox).not.toBeNull();
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    await settleUi(target);
    expect(app.focus.pending()).toHaveLength(0);
    expect(app.focus.completed().map(row => row.title)).toEqual(['A small step']);
    button(target, 'Undo').click();
    await settleUi(target);
    expect(app.focus.pending().map(row => row.title)).toEqual(['A small step']);
    expect(app.focus.completed()).toHaveLength(0);
    expect(button(target, 'Redo').disabled).toBe(false);
  });
});
