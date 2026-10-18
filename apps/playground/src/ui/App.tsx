/** @jsxImportSource @solidjs/web */
import { consumeReadable } from '@vibespa/solid';
import { createSignal, onCleanup, untrack } from 'solid-js';
import type { CommandResult, FocusView } from '../contracts/focus';
import { Icon } from './Icons';
import { IntentionList } from './IntentionList';
import './theme.css';

export function App(props: { readonly focus: FocusView }) {
  const history = consumeReadable(untrack(() => props.focus.history));
  const pending = consumeReadable(untrack(() => props.focus.pending));
  const [draft, setDraft] = createSignal(() => '');
  const [busy, setBusy] = createSignal(() => false);
  const [formError, setFormError] = createSignal(() => '');
  const [notice, setNotice] = createSignal(() => '');
  let field: HTMLInputElement | undefined;
  let active = true;
  onCleanup(() => { active = false; });

  async function perform(operation: () => Promise<CommandResult>, message: string): Promise<CommandResult> {
    if (busy()) return { ok: true };
    setBusy(true);
    setNotice('');
    try {
      const result = await operation();
      if (active) setNotice(result.ok ? message : result.message);
      return result;
    } finally {
      if (active) setBusy(false);
    }
  }

  async function add(event: SubmitEvent) {
    event.preventDefault();
    if (busy()) return;
    setFormError('');
    const result = await perform(() => props.focus.commands.add(draft()), 'Intention added.');
    if (!active) return;
    if (result.ok) {
      setDraft('');
      field?.focus();
    } else {
      setFormError(result.message);
      field?.focus();
    }
  }

  return (
    <div class="app-shell">
      <a class="skip-link" href="#focus">Skip to intentions</a>
      <header class="site-header">
        <a class="wordmark" href="/" aria-label="VibeSPA home">
          <span class="brand-symbol" aria-hidden="true"><span /><span /><span /></span>
          Vibe<span class="wordmark-light">SPA</span>
        </a>
        <span class="brand-promise">Good vibes. Clear boundaries.</span>
      </header>

      <main id="focus" class="main-grid">
        <div class="focus-room">
          <div class="intro">
            <div class="eyebrow"><span class="tiny-line" /> A little room to focus</div>
            <h1>Less noise.<br /><span>More space.</span></h1>
            <p>Put your thoughts down. Take one small step.</p>
          </div>

          <section class="focus-panel" aria-label="Your intentions">
            <form class="add-form" onSubmit={(event) => { void add(event); }}>
              <label for="intention">What would you like to make space for?</label>
              <div class="input-row">
                <input
                  ref={(element) => { field = element; }}
                  id="intention"
                  name="intention"
                  type="text"
                  autocomplete="off"
                  placeholder="Take the next small step…"
                  value={draft()}
                  disabled={busy()}
                  aria-invalid={formError() ? 'true' : undefined}
                  aria-describedby={formError() ? 'intention-error' : undefined}
                  onInput={(event) => { setDraft(event.currentTarget.value); setFormError(''); }}
                />
                <button class="primary-button" type="submit" disabled={busy()}><Icon name="plus" /><span>Add intention</span></button>
              </div>
              <p id="intention-error" class="field-error" role="alert">{formError()}</p>
            </form>

            <div class="list-toolbar">
              <span class="section-caption">A small step is still a step.</span>
              <button
                class="text-button"
                type="button"
                disabled={busy() || pending().length === 0}
                onClick={() => { void perform(() => props.focus.commands.completePending(), 'All intentions completed.'); }}
              ><Icon name="check" />Complete all</button>
            </div>

            <IntentionList
              source={props.focus.pending}
              completed={false}
              busy={busy()}
              toggle={(id) => { void perform(() => props.focus.commands.toggle(id), 'Intention updated.'); }}
              remove={(id) => { void perform(() => props.focus.commands.remove(id), 'Intention removed. Undo to bring it back.'); }}
            />
            <IntentionList
              source={props.focus.completed}
              completed={true}
              busy={busy()}
              toggle={(id) => { void perform(() => props.focus.commands.toggle(id), 'Intention updated.'); }}
              remove={(id) => { void perform(() => props.focus.commands.remove(id), 'Intention removed. Undo to bring it back.'); }}
            />

            <footer class="panel-footer">
              <span class="save-note"><span class="saved-dot" aria-hidden="true" />Saved on this device</span>
              <div class="history-controls" aria-label="Change history">
                <button class="history-button" type="button" disabled={busy() || !history().canUndo} onClick={() => { void perform(() => props.focus.commands.undo(), 'Change undone.'); }}><Icon name="undo" />Undo</button>
                <button class="history-button" type="button" disabled={busy() || !history().canRedo} onClick={() => { void perform(() => props.focus.commands.redo(), 'Change redone.'); }}><Icon name="redo" />Redo</button>
              </div>
            </footer>
          </section>
          <p class="live-message" role="status" aria-live="polite">{notice()}</p>
        </div>

        <aside class="architecture-note" aria-label="About this starter">
          <div class="architecture-heading"><span class="tiny-line" /><span>Inside this starter</span></div>
          <h2>Small pieces.<br />A calm whole.</h2>
          <p>Each module does one thing.<br />Clear contracts bring them together.</p>
          <ol class="module-map">
            <li><span class="module-number">01</span><div><strong>Presentation</strong><span>Reads state. Calls commands.</span></div></li>
            <li><span class="module-number">02</span><div><strong>Title policy</strong><span>One small rule, on its own.</span></div></li>
            <li><span class="module-number">03</span><div><strong>Focus commands</strong><span>Intent becomes one gesture.</span></div></li>
            <li><span class="module-number">04</span><div><strong>Local storage</strong><span>Durable data. Reversible changes.</span></div></li>
          </ol>
          <div class="composition-note"><span class="composition-symbol" aria-hidden="true">↳</span><p>Composition connects the pieces.<br />Every lifetime has an owner.</p></div>
          <div class="framework-label"><span aria-hidden="true">✳</span> Built with VibeSPA</div>
        </aside>
      </main>
      <footer class="site-footer"><span>A little structure. A lot of possibility.</span><span>Local first · Micro modular · Yours to shape</span></footer>
    </div>
  );
}
