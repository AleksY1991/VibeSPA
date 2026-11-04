/** @jsxImportSource @solidjs/web */
import { FeatureType } from '@vibespa/contracts';
import type { ModuleSnapshot, Readable, SystemEvent, SystemSnapshot } from '@vibespa/contracts';
import type { InteractionSnapshot } from '@vibespa/interaction';
import { consumeReadable } from '@vibespa/solid';
import { Badge, BugIcon, Button, Card, Link, List, Select, TabPanel, Tabs, constructItem } from '@ui-kit/core';
import type { ButtonState, TabsState } from '@ui-kit/core';
import { createSignal, untrack } from 'solid-js';
import { DataGraph, FeatureRegistry, SurfacesGraph, registrations } from './InspectorGraphs';
import './inspector.css';

const presentations: Record<FeatureType, { readonly label: string; readonly responsibility: string; readonly boundary: string }> = {
  [FeatureType.Policy]: { label: 'Policy', responsibility: 'Rules & decisions', boundary: 'Evaluates a rule through its public contract.' },
  [FeatureType.Data]: { label: 'Data', responsibility: 'Data contracts & capabilities', boundary: 'Provides a validated part of the data graph through typed reads and writes.' },
  [FeatureType.Store]: { label: 'Store', responsibility: 'Durable data', boundary: 'Owns persistence behind explicit read and write ports.' },
  [FeatureType.Feature]: { label: 'Feature', responsibility: 'Reads & commands', boundary: 'Coordinates behavior through the capabilities it receives.' },
  [FeatureType.Service]: { label: 'Service', responsibility: 'External capability', boundary: 'Provides an adapter or shared application capability.' },
  [FeatureType.View]: { label: 'View', responsibility: 'Presentation', boundary: 'Presents semantic values and invokes named commands.' },
};

function readableState(state: string): string { return state.replaceAll('-', ' '); }

function eventDescription(event: SystemEvent): string {
  if (event.type === 'operation-started') return 'Operation started';
  if (event.type === 'operation-completed') return 'Operation completed';
  if (event.type === 'operation-failed') return 'Operation failed';
  const state = readableState(event.type);
  return state.charAt(0).toUpperCase() + state.slice(1);
}

function eventTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function ModuleCard(props: { readonly module: ModuleSnapshot }) {
  const presentation = () => presentations[props.module.kind];
  const model = constructItem('inspector.module', item => ({
    visible: item.constant('visible', true),
    state: item.observe('state', () => readableState(props.module.state)),
    inputs: item.observe('inputs', () => props.module.contract.inputs),
    exports: item.observe('exports', () => props.module.contract.exports),
    dependencies: item.observe('dependencies', () => props.module.dependencies),
  }));
  return <article class="inspector-module" data-kind={props.module.kind}>
    <Card.View observable={model.visible} surface={{ kind: 'inherit' }} hotkeys={[]} recipe="content">
      <header class="inspector-module-header">
        <div class="inspector-module-heading"><span class="inspector-detail-label">{presentation().label} / {presentation().responsibility}</span><h4>{props.module.title}</h4></div>
        <Badge.View observable={model.state} surface={{ kind: 'inherit' }} hotkeys={[]} tone="neutral" label="Module state" />
      </header>
      <p class="inspector-module-description">{props.module.description || presentation().boundary}</p>
      <dl class="inspector-identities"><div><dt>Instance</dt><dd><code>{props.module.id}</code></dd></div><div><dt>Definition</dt><dd><code>{props.module.definitionId}</code></dd></div></dl>
      <div class="inspector-contract">
        <section aria-label={`${props.module.title} inputs`}><h5>Receives <span>{String(props.module.contract.inputs.length)}</span></h5><ul>
          <List.View observable={model.inputs} surface={{ kind: 'inherit' }} hotkeys={[]} keyBy={port => port.name} fallback={<li class="inspector-empty-port">No inputs declared.</li>}>
            {port => <li><code>{port.read().name}</code><p>{port.read().description}</p></li>}
          </List.View>
        </ul></section>
        <section aria-label={`${props.module.title} exports`}><h5>Exposes <span>{String(props.module.contract.exports.length)}</span></h5><ul>
          <List.View observable={model.exports} surface={{ kind: 'inherit' }} hotkeys={[]} keyBy={port => port.name} fallback={<li class="inspector-empty-port">No exports declared.</li>}>
            {port => <li><code>{port.read().name}</code><p>{port.read().description}</p></li>}
          </List.View>
        </ul></section>
      </div>
      <div class="inspector-dependencies"><span class="inspector-detail-label">Depends on</span><ul>
        <List.View observable={model.dependencies} surface={{ kind: 'inherit' }} hotkeys={[]} keyBy={id => id} fallback={<li class="inspector-empty-port">No module dependencies</li>}>{dependency => <li><code>{dependency.read()}</code></li>}</List.View>
      </ul></div>
      {props.module.error ? <Card.View observable={model.visible} surface={{ kind: 'inherit' }} hotkeys={[]} recipe="notice" tone="error"><pre class="inspector-error">{props.module.error}</pre></Card.View> : null}
    </Card.View>
  </article>;
}

type InspectorView = 'features' | 'data' | 'surfaces' | 'activity';

function DefinitionFilter(props: { readonly snapshot: SystemSnapshot; readonly value: string; readonly onChange: (value: string) => void }) {
  const value = constructItem('inspector.definition-filter', item => item.observe('value', () => props.value));
  return <div class="inspector-runtime-filter"><Select.View observable={value} surface={{ kind: 'inherit' }} hotkeys={[]} label="Definition" recipe="form" size="compact"
    options={[{ value: 'all', label: 'All definitions' }, ...registrations(props.snapshot).map(entry => ({ value: entry.id, label: `${entry.title} (${entry.id})` }))]}
    onValueChange={props.onChange} /></div>;
}

/** Public diagnostics are rendered exclusively with the shared Haku controls. */
export function SystemInspector(props: { readonly snapshot: Readable<SystemSnapshot>; readonly clearEvents: () => void; readonly interaction?: Readable<InteractionSnapshot> }) {
  const snapshot = consumeReadable(untrack(() => props.snapshot));
  const interactionSource = untrack(() => props.interaction);
  const interaction = interactionSource ? consumeReadable(interactionSource) : () => undefined;
  const [view, setView] = createSignal<InspectorView>(() => 'features' as const);
  const [filter, setFilter] = createSignal(() => 'all');
  const modules = () => snapshot().modules.filter(module => filter() === 'all' || module.definitionId === filter());
  const events = () => snapshot().events.filter(event => filter() === 'all' || snapshot().modules.some(module => module.id === event.moduleId && module.definitionId === filter())).reverse();
  const readyCount = () => snapshot().modules.filter(module => module.state === 'ready').length;
  const failureCount = () => snapshot().modules.filter(module => module.state === 'failed' || module.error).length;
  const model = constructItem('inspector', item => ({
    launcher: item.constant('launcher', { href: '#system-inspector' }),
    visible: item.constant('visible', true),
    state: item.observe('state', () => readableState(snapshot().state)),
    modules: item.observe('modules', modules),
    events: item.observe('events', events),
    clear: item.observe<ButtonState>('clear', () => ({ disabled: snapshot().events.length === 0 })),
    tabs: item.observe<TabsState<InspectorView>>('tabs', () => ({ value: view(), tabs: [
      { value: 'features', label: `Features ${registrations(snapshot()).length}`, id: 'inspector-tab-features', panelId: 'inspector-panel-features' },
      { value: 'data', label: `Data graph ${snapshot().data?.length ?? 0}`, id: 'inspector-tab-data', panelId: 'inspector-panel-data' },
      { value: 'surfaces', label: `Surfaces ${interaction()?.surfaces.length ?? 0}`, id: 'inspector-tab-surfaces', panelId: 'inspector-panel-surfaces' },
      { value: 'activity', label: `Activity ${snapshot().events.length}`, id: 'inspector-tab-activity', panelId: 'inspector-panel-activity' },
    ] })),
    features: item.observe('features', () => view() === 'features'),
    data: item.observe('data', () => view() === 'data'),
    surfaces: item.observe('surfaces', () => view() === 'surfaces'),
    activity: item.observe('activity', () => view() === 'activity'),
  }));

  return <>
    <div class="inspector-launcher"><Card.View observable={model.visible} surface={{ kind: 'inherit' }} hotkeys={[]} recipe="panel"><Link.View observable={model.launcher} surface={{ kind: 'inherit' }} hotkeys={[]} appearance="action" size="target" controlSize="large"
      aria-label={`Open system inspector: ${snapshot().state}, ${snapshot().modules.length} modules, ${failureCount()} with errors`}><BugIcon />System inspector</Link.View></Card.View></div>
    <aside id="system-inspector" class="system-inspector" aria-labelledby="system-inspector-title" tabindex={-1}>
      <header class="inspector-header"><h2 id="system-inspector-title">System inspector</h2><div class="inspector-system-state"><code>{snapshot().id}</code><Badge.View observable={model.state} surface={{ kind: 'inherit' }} hotkeys={[]} tone="neutral" label="System state" /></div></header>
      <div class="inspector-summary" aria-label="System summary"><span><strong>{String(registrations(snapshot()).length)}</strong> registered</span><span><strong>{String(snapshot().modules.length)}</strong> instances</span><span><strong>{String(readyCount())}</strong> ready</span><span><strong>{String(failureCount())}</strong> with errors</span></div>
      <div class="inspector-views"><Tabs.View observable={model.tabs} surface={{ kind: 'inherit' }} hotkeys={[]} label="Inspector views" size="large" wrap onValueChange={setView} /></div>

      <TabPanel.View observable={model.features} surface={{ kind: 'inherit' }} hotkeys={[]} id="inspector-panel-features" tabId="inspector-tab-features" value="features">
        {view() === 'features' ? <>
          <FeatureRegistry snapshot={snapshot()} inspect={id => { setFilter(id); document.getElementById('inspector-modules-title')?.scrollIntoView({ block: 'start' }); }} />
          <DefinitionFilter snapshot={snapshot()} value={filter()} onChange={setFilter} />
          <section class="inspector-modules" aria-labelledby="inspector-modules-title">
            <div class="inspector-section-heading"><h3 id="inspector-modules-title">Module boundaries</h3><span>{String(modules().length)} visible</span></div>
            <div class="inspector-module-grid" data-single={modules().length === 1 ? '' : undefined}>
              <List.View observable={model.modules} surface={{ kind: 'inherit' }} hotkeys={[]} keyBy={module => module.id} fallback={<p class="inspector-empty">No runtime instances in this view.</p>}>{module => <ModuleCard module={module.read()} />}</List.View>
            </div>
          </section>
        </> : null}
      </TabPanel.View>
      <TabPanel.View observable={model.data} surface={{ kind: 'inherit' }} hotkeys={[]} id="inspector-panel-data" tabId="inspector-tab-data" value="data">{view() === 'data' ? <DataGraph nodes={snapshot().data ?? []} /> : null}</TabPanel.View>
      <TabPanel.View observable={model.surfaces} surface={{ kind: 'inherit' }} hotkeys={[]} id="inspector-panel-surfaces" tabId="inspector-tab-surfaces" value="surfaces">{view() === 'surfaces' ? <SurfacesGraph snapshot={interaction()} /> : null}</TabPanel.View>
      <TabPanel.View observable={model.activity} surface={{ kind: 'inherit' }} hotkeys={[]} id="inspector-panel-activity" tabId="inspector-tab-activity" value="activity">
        {view() === 'activity' ? <>
          <DefinitionFilter snapshot={snapshot()} value={filter()} onChange={setFilter} />
          <section class="inspector-activity" aria-labelledby="inspector-activity-title">
            <div class="inspector-section-heading"><h3 id="inspector-activity-title">Activity <span>{String(events().length)}</span></h3><Button.View observable={model.clear} surface={{ kind: 'inherit' }} hotkeys={[]} variant="ghost" size="compact" onActivate={props.clearEvents}>Clear activity</Button.View></div>
            <p class="inspector-graph-caption">Latest first · bounded session history</p>
            <ol class="inspector-timeline" aria-label="Recorded system activity">
              <List.View observable={model.events} surface={{ kind: 'inherit' }} hotkeys={[]} keyBy={event => event.sequence} fallback={<li class="inspector-empty">No activity in this view yet.</li>}>
                {event => <li class="inspector-event" data-state={event.read().type}><div class="inspector-event-topline"><strong>{eventDescription(event.read())}</strong><time datetime={new Date(event.read().timestamp).toISOString()}>{eventTime(event.read().timestamp)}</time></div><div class="inspector-event-context"><code>{event.read().moduleId ?? snapshot().id}</code><span>#{String(event.read().sequence)}</span></div>{event.read().operation ? <code class="inspector-operation">{event.read().operation}</code> : null}{event.read().error ? <Card.View observable={model.visible} surface={{ kind: 'inherit' }} hotkeys={[]} recipe="notice" tone="error"><pre class="inspector-error">{event.read().error}</pre></Card.View> : null}</li>}
              </List.View>
            </ol>
            <p class="inspector-graph-caption">{snapshot().droppedEvents > 0 ? `${snapshot().droppedEvents} older events released from history.` : 'History stays in this session.'}</p>
          </section>
        </> : null}
      </TabPanel.View>
    </aside>
  </>;
}
