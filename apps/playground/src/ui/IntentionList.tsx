/** @jsxImportSource @solidjs/web */
import type { Readable } from '@vibespa/contracts';
import { consumeReadable } from '@vibespa/solid';
import { For, untrack } from 'solid-js';
import type { Intention } from '../contracts/focus';
import { Icon } from './Icons';

export function IntentionList(props: {
  readonly source: Readable<readonly Readonly<Intention>[]>;
  readonly completed: boolean;
  readonly busy: boolean;
  readonly toggle: (id: string) => void;
  readonly remove: (id: string) => void;
}) {
  const items = consumeReadable(untrack(() => props.source));

  return (
    <section class="intention-section" aria-labelledby={props.completed ? 'completed-heading' : 'pending-heading'}>
      <div class="list-heading">
        <h2 id={props.completed ? 'completed-heading' : 'pending-heading'}>{props.completed ? 'Made space for' : 'On your mind'}</h2>
        <span class="item-count" aria-label={items().length === 1 ? '1 intention' : `${items().length} intentions`}>{String(items().length).padStart(2, '0')}</span>
      </div>
      <ul class="intention-list">
        <For each={items()} keyed={(item) => item.id} fallback={
          <li class={props.completed ? 'quiet-empty' : 'empty-list'}>
            {props.completed ? 'Finished intentions will settle here.' : <>
              <span class="empty-mark"><Icon name="leaf" /></span>
              <h3>Start with one small thing.</h3>
              <p>There’s room for whatever matters to you.</p>
            </>}
          </li>
        }>
          {(item) => <li class="intention-row" data-completed={props.completed || undefined}>
            <label class="intention-label">
              <input
                type="checkbox"
                checked={item().done}
                disabled={props.busy}
                onChange={() => props.toggle(item().id)}
              />
              <span class="check-visual" aria-hidden="true"><Icon name="check" /></span>
              <span class="intention-title">{item().title}</span>
            </label>
            <button
              class="icon-button remove-button"
              type="button"
              aria-label={`Remove ${item().title}`}
              disabled={props.busy}
              onClick={() => props.remove(item().id)}
            ><Icon name="close" /></button>
          </li>}
        </For>
      </ul>
    </section>
  );
}
