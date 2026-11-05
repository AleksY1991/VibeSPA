/** @jsxImportSource @solidjs/web */
import { Button, Link, constructItem, type ButtonState, type LinkState } from '@ui-kit/core';
import type { Readable, SystemSnapshot } from '@vibespa/contracts';
import type { InteractionSnapshot } from '@vibespa/interaction';
import type { AccountView, SyncView } from '../contracts/account';
import type { FocusView } from '../contracts/focus';
import { App } from './App';
import { SignIn } from './SignIn';
import { SystemInspector } from './SystemInspector';
import { mountUiRoot } from './runtime';
import './theme.css';

export function mount(target: HTMLElement, focus: FocusView): () => void {
  return mountUiRoot(target, 'focus', () => <App focus={focus} />);
}

/** Supabase backend: sign-in while signed out, otherwise the same Focus UI. */
export function mountSupabase(target: HTMLElement, application: {
  readonly account: AccountView;
  readonly signedIn?: { readonly focus: FocusView; readonly sync: SyncView };
}): () => void {
  const signedIn = application.signedIn;
  return mountUiRoot(target, 'focus', () => signedIn
    ? <App focus={signedIn.focus} account={application.account} sync={signedIn.sync} />
    : <SignIn account={application.account} />);
}

/** Supabase backend without project settings: explain the setup. */
export function showSupabaseSetup(target: HTMLElement): () => void {
  return mountUiRoot(target, 'focus', () => {
    const links = constructItem('supabase.setup', item => ({
      memory: item.constant<LinkState>('memory', { href: '?backend=memory' }),
      indexedDb: item.constant<LinkState>('indexedDb', { href: '?backend=rxdb' }),
    }));
    return <main class="startup-error">
      <h1 class="text-title">Connect a Supabase project</h1>
      <p class="text-body">Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in apps/playground/.env.local, then restart the dev server.</p>
      <p class="text-body">The table, row-level security and sign-in settings are in apps/playground/src/modules/supabase-storage/SUPABASE_SETUP.md.</p>
      <div class="backend-links"><span>Meanwhile, try:</span><Link.View observable={links.memory} surface={{ kind: 'inherit' }} hotkeys={[]}>Memory</Link.View><Link.View observable={links.indexedDb} surface={{ kind: 'inherit' }} hotkeys={[]}>IndexedDB</Link.View></div>
    </main>;
  });
}

export function mountInspector(target: HTMLElement, snapshot: Readable<SystemSnapshot>, clearEvents: () => void, interaction?: Readable<InteractionSnapshot>): () => void {
  return mountUiRoot(target, 'system-inspector', () => <SystemInspector snapshot={snapshot} clearEvents={clearEvents} interaction={interaction} />);
}

export function showStartupError(target: HTMLElement): () => void {
  return mountUiRoot(target, 'startup-error', () => {
    const reload = constructItem('startup.reload', item => item.constant<ButtonState>('state', {}));
    return <main class="startup-error">
      <h1 class="text-title">Unable to open intentions</h1>
      <p class="text-body">Reload the page to try again.</p>
      <Button.View observable={reload} surface={{ kind: 'inherit' }} hotkeys={[]} variant="default" onActivate={() => location.reload()}>Reload page</Button.View>
    </main>;
  });
}
