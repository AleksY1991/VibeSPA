/** @jsxImportSource @solidjs/web */
import { createSignal, onCleanup } from 'solid-js';
import { Button, Card, Form, Link, TextField, constructItem } from '@ui-kit/core';
import type { ButtonState, FormState, LinkState } from '@ui-kit/core';
import type { InputFocusHandle } from '@ui-kit/core/contracts/controls';
import { SendIcon } from '@ui-kit/core/icons';
import type { AccountView } from '../contracts/account';
import './theme.css';

/** Supabase backend, signed out: request an email sign-in link. */
export function SignIn(props: { readonly account: AccountView }) {
  const [email, setEmail] = createSignal(() => '');
  const [busy, setBusy] = createSignal(() => false);
  const link = () => props.account.link();
  let field: InputFocusHandle | undefined;
  let active = true;
  onCleanup(() => { active = false; });
  const controls = constructItem('signin.controls', item => ({
    email: item.observe('email', email),
    form: item.observe<FormState>('form', () => ({ disabled: busy() })),
    send: item.observe<ButtonState>('send', () => ({ disabled: busy() })),
    panel: item.constant('panel', true),
    home: item.constant<LinkState>('home', { href: '/' }),
    memory: item.constant<LinkState>('memory', { href: '?backend=memory' }),
    indexedDb: item.constant<LinkState>('indexedDb', { href: '?backend=rxdb' }),
  }));
  const error = () => { const state = link(); return state.phase === 'failed' ? state.message : ''; };
  const status = () => {
    const state = link();
    if (state.phase === 'sending') return 'Sending your sign-in link…';
    if (state.phase === 'sent') return `Check ${state.email} for a sign-in link, then open it in this browser.`;
    return '';
  };

  async function send() {
    if (busy()) return;
    setBusy(true);
    try {
      const result = await props.account.commands.requestLink(email());
      if (active && !result.ok) field?.focus();
    } finally {
      if (active) setBusy(false);
    }
  }

  return (
    <div class="app-shell">
      <header class="site-header">
        <Link.View observable={controls.home} surface={{ kind: 'inherit' }} hotkeys={[]} aria-label="VibeSPA home">VibeSPA</Link.View>
        <span class="brand-promise">Good vibes. Clear boundaries.</span>
      </header>
      <main id="focus" class="sign-in">
        <div class="intro">
          <h1>Sign in to sync</h1>
          <p>Your intentions stay on this device and sync with your Supabase account.</p>
        </div>
        <Card.View observable={controls.panel} surface={{ kind: 'inherit' }} hotkeys={[]} recipe="content">
          <Form.View observable={controls.form} surface={{ kind: 'inherit' }} hotkeys={[]} class="add-form" onSubmit={intent => { intent.preventDefault(); void send(); }}>
            <div class="input-row">
              <div class="intention-field"><TextField.View
                observable={controls.email} surface={{ kind: 'inherit' }} hotkeys={[]}
                onHandle={handle => { field = handle; }}
                id="sign-in-email"
                label="Email address"
                labelVisible
                recipe="form"
                size="large"
                name="email"
                type="email"
                autocomplete="email"
                placeholder="you@example.com"
                disabled={busy()}
                aria-invalid={error() ? 'true' : undefined}
                aria-describedby={error() ? 'sign-in-error' : undefined}
                onValueChange={value => { setEmail(value); }}
              /></div>
              <Button.View observable={controls.send} surface={{ kind: 'inherit' }} hotkeys={[]} type="submit" variant="default" size="large" start={<SendIcon />}>Send sign-in link</Button.View>
            </div>
            <p id="sign-in-error" class="field-error" role="alert">{error()}</p>
          </Form.View>
          <p class="live-message" role="status" aria-live="polite">{status()}</p>
        </Card.View>
        <div class="backend-links"><span>Or try it without an account:</span><Link.View observable={controls.memory} surface={{ kind: 'inherit' }} hotkeys={[]}>Memory</Link.View><Link.View observable={controls.indexedDb} surface={{ kind: 'inherit' }} hotkeys={[]}>IndexedDB</Link.View></div>
      </main>
    </div>
  );
}
