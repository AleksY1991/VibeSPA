import { createComponent } from 'solid-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSolidSystem } from '@vibespa/solid/module';
import { createSupabaseApplication, supabaseApplicationModules } from './composition/createSupabaseApplication';
import { App } from './ui/App';
import { SignIn } from './ui/SignIn';
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
const client = { auth: {
  getSession: async () => ({ data: { session: null }, error: null }),
  onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
} } as unknown as SupabaseClient;

describe('Supabase sign-in design-system controls', () => {
  it('requests a magic link through the account command and reports where it was sent', async () => {
    const requestLink = vi.fn(async (_email: string) => undefined);
    const system = createSolidSystem({ id: 'sign-in-controls', modules: supabaseApplicationModules });
    cleanups.push(() => system.dispose());
    const application = await createSupabaseApplication(system, {
      client, auth: { requestLink, signOut: async () => undefined }, identity: null,
    });
    const target = document.createElement('div');
    document.body.append(target);
    cleanups.push(mountUiRoot(target, 'test-sign-in', () => createComponent(SignIn, { account: application.account })));
    await settleUi(target);

    const field = target.querySelector<HTMLElement & { value: string }>('wa-input')!;
    const input = field.shadowRoot!.querySelector<HTMLInputElement>('input')!;
    expect(input.type).toBe('email');
    input.value = 'Me@Example.com';
    input.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: 'Me@Example.com' }));
    await settleUi(target);
    button(target, 'Send sign-in link').click();
    await settleUi(target);
    expect(requestLink).toHaveBeenCalledWith('me@example.com');
    await vi.waitFor(() => {
      expect(target.querySelector('[role="status"]')?.textContent).toContain('Check me@example.com for a sign-in link');
    });
    expect(target.querySelector('#sign-in-error')?.textContent).toBe('');
  });

  it('shows the signed-in account and keeps sign-out available when nothing is pending', async () => {
    const signOut = vi.fn(async () => undefined);
    const system = createSolidSystem({ id: 'signed-in-controls', modules: supabaseApplicationModules });
    cleanups.push(() => system.dispose());
    const application = await createSupabaseApplication(system, {
      client, auth: { requestLink: async () => undefined, signOut }, identity: null,
    });
    // The Focus half is covered elsewhere; this checks the account bar wiring.
    const account = { ...application.account, identity: { userId: 'u', email: 'me@example.com' } };
    const focus = {
      pending: () => [], completed: () => [],
      history: () => ({ canUndo: false, canRedo: false }),
      delivery: () => ({ phase: 'idle' as const, pending: 0, error: null }),
      commands: {} as never,
    };
    const sync = {
      status: () => ({ phase: 'running' as const, active: false, initialSyncComplete: true, error: null }),
      replaced: () => ({ count: 2 }),
      commands: { dismiss: async () => ({ ok: true as const }) },
    };
    const target = document.createElement('div');
    document.body.append(target);
    cleanups.push(mountUiRoot(target, 'test-signed-in', () => createComponent(App, { focus, account, sync })));
    await settleUi(target);
    expect(target.querySelector('.account-email')?.textContent).toBe('me@example.com');
    expect(target.textContent).toContain('Synced with Supabase');
    expect(target.textContent).toContain('Newer saved versions replaced 2 of your changes.');
    expect(button(target, 'Sign out').disabled).toBe(false);
    button(target, 'Sign out').click();
    await settleUi(target);
    expect(signOut).toHaveBeenCalledOnce();
  });
});
