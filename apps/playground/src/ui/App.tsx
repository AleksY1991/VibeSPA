/** @jsxImportSource @solidjs/web */
import { createSignal, onCleanup } from 'solid-js';
import { Button, Card, Form, Link, TextField, constructItem } from '@ui-kit/core';
import type { ButtonState, FormState, LinkState } from '@ui-kit/core';
import type { InputFocusHandle } from '@ui-kit/core/contracts/controls';
import { CheckIcon, LogOutIcon, PlusIcon, RedoIcon, UndoIcon } from '@ui-kit/core/icons';
import type { AccountView, SyncView } from '../contracts/account';
import type { CommandResult, FocusView } from '../contracts/focus';
import { IntentionList } from './IntentionList';
import './theme.css';

export function App(props: {
  readonly focus: FocusView;
  /** Supabase backend only: the signed-in account and its replication status. */
  readonly account?: AccountView;
  readonly sync?: SyncView;
}) {
  const history = () => props.focus.history();
  const pending = () => props.focus.pending();
  const delivery = () => props.focus.delivery();
  const saveNote = () => {
    switch (delivery().phase) {
      case 'memory': return 'Kept in this session';
      case 'loading': return 'Loading saved intentions…';
      case 'saving': return 'Saving changes…';
      case 'idle': return 'Changes saved';
      case 'failed': return 'Changes kept here · save failed';
      case 'closed': return 'Session ended';
    }
  };
  const syncNote = () => {
    const status = props.sync?.status();
    if (!status) return '';
    if (status.error) return `Supabase sync failed: ${status.error}`;
    switch (status.phase) {
      case 'starting': return 'Connecting to Supabase…';
      case 'stopped': return 'Supabase sync stopped';
      case 'running': return status.active ? 'Syncing with Supabase…'
        : status.initialSyncComplete ? 'Synced with Supabase' : 'Waiting for Supabase…';
    }
  };
  const replacedNote = () => {
    const count = props.sync?.replaced()?.count ?? 0;
    return count === 1 ? 'A newer saved version replaced one of your changes.'
      : `Newer saved versions replaced ${count} of your changes.`;
  };
  const [draft, setDraft] = createSignal(() => '');
  const [busy, setBusy] = createSignal(() => false);
  const [formError, setFormError] = createSignal(() => '');
  const [notice, setNotice] = createSignal(() => '');
  let field: InputFocusHandle | undefined;
  let active = true;
  onCleanup(() => { active = false; });
  const controls = constructItem('focus.controls', item => ({
    draft: item.observe('draft', draft),
    form: item.observe<FormState>('form', () => ({ disabled: busy() })),
    add: item.observe<ButtonState>('add', () => ({ disabled: busy() })),
    complete: item.observe<ButtonState>('complete', () => ({ disabled: busy() || pending().length === 0 })),
    undo: item.observe<ButtonState>('undo', () => ({ disabled: busy() || !history().canUndo })),
    redo: item.observe<ButtonState>('redo', () => ({ disabled: busy() || !history().canRedo })),
    retry: item.observe<ButtonState>('retry', () => ({ disabled: busy() })),
    keepLocal: item.observe<ButtonState>('keepLocal', () => ({ disabled: busy() })),
    // Sign-out ends this account generation; wait until local changes are delivered.
    signOut: item.observe<ButtonState>('signOut', () => ({ disabled: busy() || delivery().pending > 0 })),
    dismiss: item.observe<ButtonState>('dismiss', () => ({ disabled: busy() })),
    replaced: item.observe('replaced', () => (props.sync?.replaced() ?? null) !== null),
    panel: item.constant('panel', true),
    failed: item.observe('failed', () => delivery().phase === 'failed'),
    home: item.constant<LinkState>('home', { href: '/' }),
    skip: item.constant<LinkState>('skip', { href: '#focus' }),
    memory: item.constant<LinkState>('memory', { href: '?backend=memory' }),
    rest: item.constant<LinkState>('rest', { href: '?backend=rest' }),
    indexedDb: item.constant<LinkState>('indexedDb', { href: '?backend=rxdb' }),
    supabase: item.constant<LinkState>('supabase', { href: '?backend=supabase' }),
  }));

  async function perform(operation: () => Promise<CommandResult>, message: string): Promise<CommandResult> {
    if (busy()) return { ok: true };
    setBusy(true);
    setNotice('');
    try {
      const result = await operation();
      if (active) setNotice(result.ok ? message : result.message);
      return result;
    } catch (error: unknown) {
      const result = { ok: false as const, message: error instanceof Error ? error.message : 'Unable to apply this change.' };
      if (active) setNotice(result.message);
      return result;
    } finally {
      if (active) setBusy(false);
    }
  }

  async function add() {
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
      <div class="skip-link"><Link.View observable={controls.skip} surface={{ kind: 'inherit' }} hotkeys={[]}>Skip to intentions</Link.View></div>
      <header class="site-header">
        <Link.View observable={controls.home} surface={{ kind: 'inherit' }} hotkeys={[]} aria-label="VibeSPA home">VibeSPA</Link.View>
        <span class="brand-promise">Good vibes. Clear boundaries.</span>
        {props.account?.identity ? <div class="account-bar">
          <span class="account-email">{props.account.identity.email ?? 'Signed in'}</span>
          <Button.View observable={controls.signOut} surface={{ kind: 'inherit' }} hotkeys={[]} variant="ghost" start={<LogOutIcon />}
            onActivate={() => { void perform(() => props.account!.commands.signOut(), 'Signing out.'); }}>Sign out</Button.View>
        </div> : null}
      </header>

      <main id="focus" class="main-grid">
        <div class="focus-room">
          <div class="intro">
            <h1>Less noise. More space.</h1>
            <p>Put your thoughts down. Take one small step.</p>
          </div>

          <section class="focus-panel" aria-label="Your intentions">
          <Card.View observable={controls.panel} surface={{ kind: 'inherit' }} hotkeys={[]} recipe="content">
            <Form.View observable={controls.form} surface={{ kind: 'inherit' }} hotkeys={[]} class="add-form" onSubmit={intent => { intent.preventDefault(); void add(); }}>
              <div class="input-row">
                <div class="intention-field"><TextField.View
                  observable={controls.draft} surface={{ kind: 'inherit' }} hotkeys={[]}
                  onHandle={handle => { field = handle; }}
                  id="intention"
                  label="What would you like to make space for?"
                  labelVisible
                  recipe="form"
                  size="large"
                  name="intention"
                  type="text"
                  autocomplete="off"
                  placeholder="Take the next small step…"
                  disabled={busy()}
                  aria-invalid={formError() ? 'true' : undefined}
                  aria-describedby={formError() ? 'intention-error' : undefined}
                  onValueChange={value => { setDraft(value); setFormError(''); }}
                /></div>
                <Button.View observable={controls.add} surface={{ kind: 'inherit' }} hotkeys={[]} type="submit" variant="default" size="large" start={<PlusIcon />}>Add intention</Button.View>
              </div>
              <p id="intention-error" class="field-error" role="alert">{formError()}</p>
            </Form.View>

            <div class="list-toolbar">
              <span class="section-caption">A small step is still a step.</span>
              <Button.View observable={controls.complete} surface={{ kind: 'inherit' }} hotkeys={[]} variant="ghost" start={<CheckIcon />}
                onActivate={() => { void perform(() => props.focus.commands.completePending(), 'All intentions completed.'); }}>Complete all</Button.View>
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
              <span class="save-note" role="status">{saveNote()}{props.sync ? ` · ${syncNote()}` : ''}</span>
              <div class="history-controls" aria-label="Change history">
                <Button.View observable={controls.undo} surface={{ kind: 'inherit' }} hotkeys={[]} variant="ghost" start={<UndoIcon />} onActivate={() => { void perform(() => props.focus.commands.undo(), 'Change undone.'); }}>Undo</Button.View>
                <Button.View observable={controls.redo} surface={{ kind: 'inherit' }} hotkeys={[]} variant="ghost" start={<RedoIcon />} onActivate={() => { void perform(() => props.focus.commands.redo(), 'Change redone.'); }}>Redo</Button.View>
              </div>
            </footer>
            <Card.View observable={controls.failed} surface={{ kind: 'inherit' }} hotkeys={[]} recipe="notice" tone="error" attributes={{ role: 'alert' }}>
              <div class="delivery-recovery">
              <p>{delivery().error}</p>
              <div><Button.View observable={controls.retry} surface={{ kind: 'inherit' }} hotkeys={[]} onActivate={() => { void perform(() => props.focus.commands.retry(), 'Retry started.'); }}>Retry save</Button.View></div>
              <p>If the saved rows changed elsewhere, keeping your version replaces those rows with your local changes.</p>
              <div><Button.View observable={controls.keepLocal} surface={{ kind: 'inherit' }} hotkeys={[]} onActivate={() => { void perform(() => props.focus.commands.keepLocal(), 'Saving your version.'); }}>Keep my version</Button.View></div>
              </div>
            </Card.View>
            <Card.View observable={controls.replaced} surface={{ kind: 'inherit' }} hotkeys={[]} recipe="notice" tone="warning" attributes={{ role: 'status' }}>
              <div class="delivery-recovery">
              <p>{replacedNote()}</p>
              <div><Button.View observable={controls.dismiss} surface={{ kind: 'inherit' }} hotkeys={[]} onActivate={() => { void perform(() => props.sync!.commands.dismiss(), ''); }}>Dismiss</Button.View></div>
              </div>
            </Card.View>
          </Card.View>
          </section>
          <p class="live-message" role="status" aria-live="polite">{notice()}</p>
        </div>

        <aside class="architecture-note" aria-label="About this starter">
          <h2>Inside this starter</h2>
          <p>Each module does one thing. Clear contracts bring them together.</p>
          <ol class="module-map">
            <li><strong>Presentation</strong><span>Reads state. Calls commands.</span></li>
            <li><strong>Title policy</strong><span>One small rule, on its own.</span></li>
            <li><strong>Focus</strong><span>Applies feature policy through the Data contract.</span></li>
            <li><strong>Intentions data</strong><span>Owns state, commands and history.</span></li>
            <li><strong>Optional saving</strong><span>Memory, REST, IndexedDB or Supabase.</span></li>
          </ol>
          <p>Composition connects the pieces. Every lifetime has an owner.</p>
          <div class="backend-links"><span>Try the same UI:</span><Link.View observable={controls.memory} surface={{ kind: 'inherit' }} hotkeys={[]}>Memory</Link.View><Link.View observable={controls.rest} surface={{ kind: 'inherit' }} hotkeys={[]}>Demo REST</Link.View><Link.View observable={controls.indexedDb} surface={{ kind: 'inherit' }} hotkeys={[]}>IndexedDB</Link.View><Link.View observable={controls.supabase} surface={{ kind: 'inherit' }} hotkeys={[]}>Supabase</Link.View></div>
        </aside>
      </main>
      <footer class="site-footer"><span>A little structure. A lot of possibility.</span><span>Local first · Micro modular · Yours to shape</span></footer>
    </div>
  );
}
