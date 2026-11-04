/** @jsxImportSource @solidjs/web */
import { Button, constructItem, type ButtonState } from '@ui-kit/core';
import type { Readable, SystemSnapshot } from '@vibespa/contracts';
import type { InteractionSnapshot } from '@vibespa/interaction';
import type { FocusView } from '../contracts/focus';
import { App } from './App';
import { SystemInspector } from './SystemInspector';
import { mountUiRoot } from './runtime';
import './theme.css';

export function mount(target: HTMLElement, focus: FocusView): () => void {
  return mountUiRoot(target, 'focus', () => <App focus={focus} />);
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
