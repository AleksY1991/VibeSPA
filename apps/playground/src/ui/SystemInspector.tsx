/** @jsxImportSource @solidjs/web */
import { FeatureType } from '@vibespa/contracts';
import type { ModuleSnapshot, Readable, SystemEvent, SystemSnapshot } from '@vibespa/contracts';
import { consumeReadable } from '@vibespa/solid';
import { For, createSignal, untrack } from 'solid-js';
import './inspector.css';

const presentations: Record<FeatureType, {
  readonly label: string;
  readonly mark: string;
  readonly responsibility: string;
  readonly boundary: string;
}> = {
  [FeatureType.Policy]: {
    label: 'Policy', mark: '◇', responsibility: 'Rules & decisions',
    boundary: 'Evaluates a rule through its public contract.',
  },
  [FeatureType.Store]: {
    label: 'Store', mark: '▤', responsibility: 'Durable data',
    boundary: 'Owns persistence behind explicit read and write ports.',
  },
  [FeatureType.Feature]: {
    label: 'Feature', mark: '↗', responsibility: 'Reads & commands',
    boundary: 'Coordinates behavior through the capabilities it receives.',
  },
  [FeatureType.Service]: {
    label: 'Service', mark: '⇄', responsibility: 'External capability',
    boundary: 'Provides an adapter or shared application capability.',
  },
  [FeatureType.View]: {
    label: 'View', mark: '▧', responsibility: 'Presentation',
    boundary: 'Presents semantic values and invokes named commands.',
  },
};

function readableState(state: string): string {
  return state.replaceAll('-', ' ');
}

function eventDescription(event: SystemEvent): string {
  if (event.type === 'operation-started') return 'Operation started';
  if (event.type === 'operation-completed') return 'Operation completed';
  if (event.type === 'operation-failed') return 'Operation failed';
  const state = readableState(event.type);
  return state.charAt(0).toUpperCase() + state.slice(1);
}

function eventTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function ModuleCard(props: { readonly module: ModuleSnapshot }) {
  const presentation = () => presentations[props.module.kind];
  return <article class="inspector-module" data-kind={props.module.kind}>
    <header class="inspector-module-header">
      <span class="inspector-kind-mark" aria-hidden="true">{presentation().mark}</span>
      <div class="inspector-module-heading">
        <span class="inspector-kind-label">{presentation().label} / {presentation().responsibility}</span>
        <h4>{props.module.title}</h4>
      </div>
      <span class="inspector-status" data-state={props.module.state}>{readableState(props.module.state)}</span>
    </header>
    <p class="inspector-module-description">{props.module.description || presentation().boundary}</p>
    <dl class="inspector-identities">
      <div><dt>Instance</dt><dd><code>{props.module.id}</code></dd></div>
      <div><dt>Definition</dt><dd><code>{props.module.definitionId}</code></dd></div>
    </dl>
    <div class="inspector-contract">
      <section aria-label={`${props.module.title} inputs`}>
        <h5><span aria-hidden="true">→</span> Receives <span>{props.module.contract.inputs.length}</span></h5>
        <ul>
          <For each={props.module.contract.inputs} keyed={port => port.name} fallback={<li class="inspector-empty-port">No inputs declared.</li>}>
            {port => <li><code>{port().name}</code><p>{port().description}</p></li>}
          </For>
        </ul>
      </section>
      <section aria-label={`${props.module.title} exports`}>
        <h5><span aria-hidden="true">↗</span> Exposes <span>{props.module.contract.exports.length}</span></h5>
        <ul>
          <For each={props.module.contract.exports} keyed={port => port.name} fallback={<li class="inspector-empty-port">No exports declared.</li>}>
            {port => <li><code>{port().name}</code><p>{port().description}</p></li>}
          </For>
        </ul>
      </section>
    </div>
    <div class="inspector-dependencies">
      <span class="inspector-detail-label">Depends on</span>
      <ul>
        <For each={props.module.dependencies} keyed={id => id} fallback={<li class="inspector-no-dependency">No module dependencies</li>}>
          {dependency => <li><span aria-hidden="true">↳</span><code>{dependency()}</code></li>}
        </For>
      </ul>
    </div>
    {props.module.error ? <pre class="inspector-error">{props.module.error}</pre> : null}
  </article>;
}

/** A neutral read contract keeps diagnostics outside private module runtimes. */
export function SystemInspector(props: {
  readonly snapshot: Readable<SystemSnapshot>;
  readonly clearEvents: () => void;
}) {
  const snapshot = consumeReadable(untrack(() => props.snapshot));
  const [filter, setFilter] = createSignal(() => 'all');
  const modules = () => snapshot().modules.filter(module => filter() === 'all' || module.id === filter());
  const events = () => snapshot().events.filter(event => filter() === 'all' || event.moduleId === filter()).reverse();
  const readyCount = () => snapshot().modules.filter(module => module.state === 'ready').length;
  const failureCount = () => snapshot().modules.filter(module => module.state === 'failed' || module.error).length;

  return <>
    <a class="inspector-launcher" href="#system-inspector" aria-label={`Open system inspector: ${snapshot().state}, ${snapshot().modules.length} modules, ${failureCount()} with errors`}>
      <span class="inspector-launcher-dot" data-state={failureCount() > 0 ? 'failed' : snapshot().state} aria-hidden="true" />
      <span>System inspector</span>
      <span class="inspector-launcher-state">{readableState(snapshot().state)} · {snapshot().modules.length}</span>
      {failureCount() > 0 ? <span class="inspector-summary-error">{failureCount()} with errors</span> : null}
      <span aria-hidden="true">↗</span>
    </a>
    <aside id="system-inspector" class="system-inspector" aria-labelledby="system-inspector-title" tabindex={-1}>
    <header class="inspector-header">
      <div>
        <div class="inspector-eyebrow"><span class="inspector-live-dot" aria-hidden="true" /> Live system inspector</div>
        <h2 id="system-inspector-title">Every piece. In plain sight.</h2>
        <p>Declared contracts, owned lifetimes, and the activity connecting them.</p>
      </div>
      <div class="inspector-system-state">
        <code>{snapshot().id}</code>
        <span class="inspector-status" data-state={snapshot().state}>{readableState(snapshot().state)}</span>
      </div>
    </header>

    <div class="inspector-toolbar">
      <div class="inspector-summary" aria-label="System summary">
        <span><strong>{snapshot().modules.length}</strong> modules</span>
        <span><strong>{readyCount()}</strong> ready</span>
        <span class={failureCount() > 0 ? 'inspector-summary-error' : ''}><strong>{failureCount()}</strong> with errors</span>
      </div>
      <label class="inspector-filter">Inspect
        <select value={filter()} onChange={event => setFilter(event.currentTarget.value)}>
          <option value="all">All modules</option>
          <For each={snapshot().modules} keyed={module => module.id}>
            {module => <option value={module().id}>{module().title} ({module().id})</option>}
          </For>
        </select>
      </label>
    </div>

    <div class="inspector-layout">
      <section class="inspector-modules" aria-labelledby="inspector-modules-title">
        <div class="inspector-section-heading"><h3 id="inspector-modules-title">Module boundaries</h3><span>{modules().length} visible</span></div>
        <div class="inspector-module-grid" data-single={modules().length === 1 ? '' : undefined}>
          <For each={modules()} keyed={module => module.id} fallback={<p class="inspector-empty">Modules appear here as construction begins.</p>}>
            {module => <ModuleCard module={module()} />}
          </For>
        </div>
        <p class="inspector-boundary-note">Dependency edges are declared by composition. The inspector observes public contracts and recorded operations; it does not inspect private state.</p>
      </section>

      <section class="inspector-activity" aria-labelledby="inspector-activity-title">
        <div class="inspector-section-heading">
          <h3 id="inspector-activity-title">Activity <span class="inspector-event-count">{events().length}</span></h3>
          <button class="inspector-clear" type="button" disabled={snapshot().events.length === 0} onClick={() => props.clearEvents()}>Clear activity</button>
        </div>
        <p class="inspector-activity-caption">Latest first · bounded session history</p>
        <ol class="inspector-timeline" aria-label="Recorded system activity" tabindex={0}>
          <For each={events()} keyed={event => event.sequence} fallback={<li class="inspector-empty">No activity in this view yet.</li>}>
            {event => <li class="inspector-event" data-state={event().type}>
              <div class="inspector-event-topline">
                <span class="inspector-event-dot" aria-hidden="true" />
                <strong>{eventDescription(event())}</strong>
                <time datetime={new Date(event().timestamp).toISOString()}>{eventTime(event().timestamp)}</time>
              </div>
              <div class="inspector-event-context"><code>{event().moduleId ?? snapshot().id}</code><span>#{event().sequence}</span></div>
              {event().operation ? <code class="inspector-operation">{event().operation}</code> : null}
              {event().error ? <pre class="inspector-error">{event().error}</pre> : null}
            </li>}
          </For>
        </ol>
        <p class="inspector-retention">{snapshot().droppedEvents > 0 ? `${snapshot().droppedEvents} older events released from history.` : 'History stays in this session.'}</p>
      </section>
    </div>
    </aside>
  </>;
}
