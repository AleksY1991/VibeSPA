/** @jsxImportSource @solidjs/web */
import { render } from '@solidjs/web';
import type { Readable, SystemSnapshot } from '@vibespa/contracts';
import type { FocusView } from '../contracts/focus';
import { App } from './App';
import { SystemInspector } from './SystemInspector';
import './theme.css';

export function mount(target: HTMLElement, focus: FocusView): () => void {
  return render(() => <App focus={focus} />, target);
}

export function mountInspector(target: HTMLElement, snapshot: Readable<SystemSnapshot>, clearEvents: () => void): () => void {
  return render(() => <SystemInspector snapshot={snapshot} clearEvents={clearEvents} />, target);
}

export function showStartupError(target: HTMLElement): () => void {
  return render(() => <main class="startup-error">
    <span class="eyebrow">VibeSPA</span>
    <h1>A moment to reset.</h1>
    <p>Unable to open your intentions. Reload the page to try again.</p>
    <button class="primary-button" type="button" onClick={() => location.reload()}>Reload page</button>
  </main>, target);
}
