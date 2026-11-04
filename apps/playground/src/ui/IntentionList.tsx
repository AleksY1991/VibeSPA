/** @jsxImportSource @solidjs/web */
import type { Accessor } from 'solid-js';
import { Button, Checkbox, LeafIcon, List, XIcon, constructItem } from '@ui-kit/core';
import type { ButtonState, Observable } from '@ui-kit/core';
import type { Intention } from '../contracts/focus';

function IntentionRow(props: {
  readonly record: Observable<Readonly<Intention>>;
  readonly busy: boolean;
  readonly toggle: (id: string) => void;
  readonly remove: (id: string) => void;
}) {
  const state = constructItem('focus.intention', item => ({
    checked: item.observe('checked', () => props.record.read().done),
    remove: item.observe<ButtonState>('remove', () => ({ disabled: props.busy })),
  }));

  return <li class="intention-row">
    <div class="intention-label">
      <Checkbox.View observable={state.checked} surface={{ kind: 'inherit' }} hotkeys={[]}
        label={props.record.read().title} disabled={props.busy}
        onCheckedChange={() => props.toggle(props.record.read().id)} />
    </div>
    <Button.View observable={state.remove} surface={{ kind: 'inherit' }} hotkeys={[]}
      recipe="button" variant="ghost" shape="icon"
      aria-label={`Remove ${props.record.read().title}`}
      onActivate={() => props.remove(props.record.read().id)}><XIcon /></Button.View>
  </li>;
}

export function IntentionList(props: {
  readonly source: Accessor<readonly Readonly<Intention>[]>;
  readonly completed: boolean;
  readonly busy: boolean;
  readonly toggle: (id: string) => void;
  readonly remove: (id: string) => void;
}) {
  const items = constructItem('focus.intentions', item => item.observe('records', () => props.source()));

  return (
    <section class="intention-section" aria-labelledby={props.completed ? 'completed-heading' : 'pending-heading'}>
      <div class="list-heading">
        <h2 id={props.completed ? 'completed-heading' : 'pending-heading'}>{props.completed ? 'Made space for' : 'On your mind'}</h2>
        <span class="item-count" aria-label={items.read().length === 1 ? '1 intention' : `${items.read().length} intentions`}>{String(items.read().length).padStart(2, '0')}</span>
      </div>
      <ul class="intention-list">
        <List.View observable={items} surface={{ kind: 'inherit' }} hotkeys={[]} keyBy={item => item.id} fallback={
          <li class={props.completed ? 'quiet-empty' : 'empty-list'}>
            {props.completed ? 'Finished intentions will settle here.' : <>
              <span class="empty-mark"><LeafIcon /></span>
              <h3>Start with one small thing.</h3>
              <p>There’s room for whatever matters to you.</p>
            </>}
          </li>
        }>
          {record => <IntentionRow record={record} busy={props.busy} toggle={props.toggle} remove={props.remove} />}
        </List.View>
      </ul>
    </section>
  );
}
