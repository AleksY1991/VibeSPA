/** @jsxImportSource @solidjs/web */
import type { DataNodeSnapshot, DataPortSnapshot, ModuleRegistrationSnapshot, ModuleSnapshot, SystemSnapshot } from '@vibespa/contracts';
import type { InteractionSnapshot, SurfaceActionSnapshot, SurfaceSnapshot } from '@vibespa/interaction';
import { ArrowIcon, Badge, Button, Card, ChevronDownIcon, ChevronRightIcon, Link, List, constructItem } from '@ui-kit/core';
import type { ButtonState, LinkState, Observable } from '@ui-kit/core';
import { createSignal } from 'solid-js';
import type { Accessor } from 'solid-js';

/** Older diagnostic producers can still describe their admitted definitions. */
export function registrations(snapshot: SystemSnapshot): readonly ModuleRegistrationSnapshot[] {
  if (snapshot.registrations) return snapshot.registrations;
  return [...new Map(snapshot.modules.map(module => [module.definitionId, {
    id: module.definitionId, kind: module.kind, title: module.title,
    description: module.description, contract: module.contract, selected: false,
    instanceIds: snapshot.modules.filter(instance => instance.definitionId === module.definitionId).map(instance => instance.id),
  }])).values()];
}

function RuntimeInstance(props: { readonly instance: Observable<ModuleSnapshot> }) {
  const state = constructItem('inspector.registration.instance', item =>
    item.observe('state', () => props.instance.read().state.replaceAll('-', ' ')));
  return <li><code>{props.instance.read().id}</code><Badge.View observable={state} surface={{ kind: 'inherit' }} hotkeys={[]} tone="neutral" />
    {props.instance.read().error ? <pre class="inspector-error">{props.instance.read().error}</pre> : null}
  </li>;
}

function RegistrationRow(props: {
  readonly entry: Observable<ModuleRegistrationSnapshot>;
  readonly snapshot: SystemSnapshot;
  readonly inspect: (definitionId: string) => void;
}) {
  const [expanded, setExpanded] = createSignal(false);
  const model = constructItem('inspector.registration', item => ({
    disclosure: item.observe<ButtonState>('disclosure', () => ({ expanded: expanded() })),
    inspect: item.constant<ButtonState>('inspect', {}),
    status: item.observe('status', () => {
      const count = props.entry.read().instanceIds.length;
      return count === 0 ? 'Not started' : `${count} instance${count === 1 ? '' : 's'}`;
    }),
    inputs: item.observe('inputs', () => props.entry.read().contract.inputs),
    exports: item.observe('exports', () => props.entry.read().contract.exports),
    instances: item.observe('instances', () => props.snapshot.modules.filter(module => module.definitionId === props.entry.read().id)),
  }));
  const detailId = () => `inspector-registration-${encodeURIComponent(props.entry.read().id)}`;
  return <article class="inspector-registration" data-kind={props.entry.read().kind}>
    <div class="inspector-registration-heading">
      <Button.View observable={model.disclosure} surface={{ kind: 'inherit' }} hotkeys={[]}
        recipe="property-row" aria-controls={detailId()} onActivate={() => setExpanded(value => !value)}
        start={expanded() ? <ChevronDownIcon /> : <ChevronRightIcon />}>
        <span class="inspector-registration-name"><strong>{props.entry.read().title}</strong><code>{props.entry.read().id}</code></span>
      </Button.View>
      <span class="inspector-registration-kind">{props.entry.read().kind}</span>
      <Badge.View observable={model.status} surface={{ kind: 'inherit' }} hotkeys={[]} tone="neutral" />
    </div>
    {expanded() ? <div class="inspector-registration-detail" id={detailId()}>
      <p>{props.entry.read().description || 'No description supplied.'}</p>
      <p class="inspector-graph-caption">{props.entry.read().selected ? 'Selected at system creation' : 'Registered during startup'}</p>
      {props.entry.read().hasConflictingDefinitions ? <p class="inspector-error" role="status">Multiple definitions share this ID. Inspect runtime instances for their actual contracts.</p> : null}
      <div class="inspector-registration-ports">
        <section><h4>Inputs</h4><ul><List.View observable={model.inputs} surface={{ kind: 'inherit' }} hotkeys={[]} keyBy={port => port.name} fallback={<li>No inputs declared.</li>}>
          {port => <li><code>{port.read().name}</code> — {port.read().description}</li>}
        </List.View></ul></section>
        <section><h4>Exports</h4><ul><List.View observable={model.exports} surface={{ kind: 'inherit' }} hotkeys={[]} keyBy={port => port.name} fallback={<li>No exports declared.</li>}>
          {port => <li><code>{port.read().name}</code> — {port.read().description}</li>}
        </List.View></ul></section>
      </div>
      <ul class="inspector-instance-list"><List.View observable={model.instances} surface={{ kind: 'inherit' }} hotkeys={[]} keyBy={module => module.id}
        fallback={<li>No runtime instances. Registration does not load or start this module.</li>}>
        {instance => <RuntimeInstance instance={instance} />}
      </List.View></ul>
      {props.entry.read().instanceIds.length > 0 ? <Button.View observable={model.inspect} surface={{ kind: 'inherit' }} hotkeys={[]}
        variant="ghost" onActivate={() => props.inspect(props.entry.read().id)}>Inspect runtime instances</Button.View> : null}
    </div> : null}
  </article>;
}

export function FeatureRegistry(props: {
  readonly snapshot: SystemSnapshot;
  readonly inspect: (definitionId: string) => void;
}) {
  const entries = constructItem('inspector.registrations', item => item.observe('entries', () => registrations(props.snapshot)));
  return <section aria-labelledby="inspector-registry-title">
    <div class="inspector-section-heading"><h3 id="inspector-registry-title">Registered modules</h3><span>{String(registrations(props.snapshot).length)} definitions</span></div>
    <p class="inspector-graph-caption">Selected definitions are visible before startup. Expand a definition to inspect its public contract and instances.</p>
    <div class="inspector-registry"><List.View observable={entries} surface={{ kind: 'inherit' }} hotkeys={[]} keyBy={entry => entry.id}
      fallback={<p class="inspector-empty">No definitions registered. Select modules when creating the system, or start a module.</p>}>
      {entry => <RegistrationRow entry={entry} snapshot={props.snapshot} inspect={props.inspect} />}
    </List.View></div>
  </section>;
}

function Capabilities(props: { readonly values: readonly string[] }) {
  const values = constructItem('inspector.capabilities', item => item.observe('values', () => props.values));
  return <ul class="inspector-capabilities" aria-label="Capabilities"><List.View observable={values} surface={{ kind: 'inherit' }} hotkeys={[]} keyBy={value => value}
    fallback={<li>No additional capabilities</li>}>
    {value => <li><Badge.View observable={value} surface={{ kind: 'inherit' }} hotkeys={[]} tone="neutral" /></li>}
  </List.View></ul>;
}

const contractAnchor = (id: string) => `inspector-data-${encodeURIComponent(id)}`;

function RelatedContract(props: { readonly id: Observable<string> }) {
  const destination = constructItem('inspector.relation', item => item.observe<LinkState>('destination', () => ({ href: `#${contractAnchor(props.id.read())}` })));
  return <Link.View observable={destination} surface={{ kind: 'inherit' }} hotkeys={[]}>{props.id.read()}</Link.View>;
}

function ConsumerNode(props: { readonly consumer: Observable<DataPortSnapshot> }) {
  const visible = constructItem('inspector.consumer', item => item.constant('visible', true));
  return <li class="inspector-graph-node"><Card.View observable={visible} surface={{ kind: 'inherit' }} hotkeys={[]} recipe="content">
    <div class="inspector-node-content"><span class="inspector-detail-label">Consumer</span><code>{props.consumer.read().definitionId}</code>
      <span class="inspector-port-name">Input: {props.consumer.read().port}</span><Capabilities values={props.consumer.read().capabilities} /></div>
  </Card.View></li>;
}

function DataFlow(props: { readonly node: Observable<DataNodeSnapshot> }) {
  const model = constructItem('inspector.data-flow', item => ({
    visible: item.constant('visible', true),
    consumers: item.observe('consumers', () => props.node.read().consumers),
    relations: item.observe('relations', () => props.node.read().relations),
  }));
  return <article class="inspector-data-flow" id={contractAnchor(props.node.read().id)} aria-label={`${props.node.read().id} data flow`}>
    <div class="inspector-graph-node inspector-provider"><Card.View observable={model.visible} surface={{ kind: 'inherit' }} hotkeys={[]} recipe="content">
      <div class="inspector-node-content"><span class="inspector-detail-label">Provider</span><code>{props.node.read().provider.definitionId}</code>
        <span class="inspector-port-name">Export: {props.node.read().provider.port}</span><Capabilities values={props.node.read().provider.capabilities} /></div>
    </Card.View></div>
    <span class="inspector-graph-arrow" aria-hidden="true"><ArrowIcon /></span>
    <div class="inspector-graph-node inspector-data-contract"><Card.View observable={model.visible} surface={{ kind: 'inherit' }} hotkeys={[]} recipe="content">
      <div class="inspector-node-content"><span class="inspector-detail-label">Data contract</span><h4>{props.node.read().id}</h4><span class="inspector-port-name">Version {String(props.node.read().version)}</span>
        {props.node.read().relations.length > 0 ? <div class="inspector-relations"><span>Relates to</span><List.View observable={model.relations} surface={{ kind: 'inherit' }} hotkeys={[]} keyBy={id => id}>
          {id => <RelatedContract id={id} />}
        </List.View></div> : null}
      </div>
    </Card.View></div>
    <span class="inspector-graph-arrow" aria-hidden="true"><ArrowIcon /></span>
    <ul class="inspector-consumer-nodes" aria-label={`${props.node.read().id} consumers`}><List.View observable={model.consumers} surface={{ kind: 'inherit' }} hotkeys={[]}
      keyBy={consumer => JSON.stringify([consumer.definitionId, consumer.port])} fallback={<li class="inspector-unconsumed">No consumers declared</li>}>
      {consumer => <ConsumerNode consumer={consumer} />}
    </List.View></ul>
  </article>;
}

export function DataGraph(props: { readonly nodes: readonly DataNodeSnapshot[] }) {
  const nodes = constructItem('inspector.data', item => item.observe('nodes', () => props.nodes));
  return <section aria-labelledby="inspector-data-title">
    <div class="inspector-section-heading"><h3 id="inspector-data-title">Data registry & consumers</h3><span>{String(props.nodes.length)} contracts</span></div>
    <p class="inspector-graph-caption">Provider → data contract → consumers. These edges describe selected definitions and declared capabilities.</p>
    <div class="inspector-data-graph" aria-label="Data provider to consumer graph"><List.View observable={nodes} surface={{ kind: 'inherit' }} hotkeys={[]} keyBy={node => node.id}
      fallback={<p class="inspector-empty">No data contracts selected. Declare data.provides and data.requires on your modules to see their wiring.</p>}>
      {node => <DataFlow node={node} />}
    </List.View></div>
  </section>;
}

function SurfaceAction(props: { readonly action: Observable<SurfaceActionSnapshot> }) {
  const model = constructItem('inspector.surface-action', item => ({
    state: item.observe('state', () => props.action.read().enabled ? 'Enabled' : 'Disabled'),
    keys: item.observe('keys', () => props.action.read().keys),
  }));
  return <li><code>{props.action.read().id}</code><Badge.View observable={model.state} surface={{ kind: 'inherit' }} hotkeys={[]} tone="neutral" />
    <List.View observable={model.keys} surface={{ kind: 'inherit' }} hotkeys={[]} keyBy={key => key}>{key => <kbd>{key.read()}</kbd>}</List.View>
    {props.action.read().allowInEditable ? <span>Allowed in editable controls</span> : null}
  </li>;
}

function SurfaceNode(props: { readonly surface: Observable<SurfaceSnapshot>; readonly index: Accessor<number> }) {
  const model = constructItem('inspector.surface', item => ({
    visible: item.constant('visible', true),
    state: item.observe('state', () => props.surface.read().active ? 'Active' : 'Inactive · skipped'),
    transparency: item.observe('transparency', () => props.surface.read().transparent ? 'Transparent: yes' : 'Transparent: no · opaque'),
    actions: item.observe('actions', () => props.surface.read().actions),
  }));
  return <li class="inspector-surface" data-reachable={props.surface.read().reachable ? 'true' : 'false'} data-active={props.surface.read().active ? 'true' : 'false'}>
    <div class="inspector-surface-order" aria-label={`Priority ${props.index() + 1}`}>{String(props.index() + 1)}</div>
    <div class="inspector-surface-body"><Card.View observable={model.visible} surface={{ kind: 'inherit' }} hotkeys={[]} recipe="content">
      <header><code>{props.surface.read().id}</code><Badge.View observable={model.state} surface={{ kind: 'inherit' }} hotkeys={[]} tone="neutral" />
        <Badge.View observable={model.transparency} surface={{ kind: 'inherit' }} hotkeys={[]} tone="neutral" /></header>
      <p class="inspector-graph-caption">{!props.surface.read().active ? 'Does not participate in action resolution.' : props.surface.read().blockedBy ? <>Blocked by <code>{props.surface.read().blockedBy}</code>.</> : props.surface.read().reachable ? props.surface.read().transparent ? 'Receives actions; unmatched actions continue below.' : 'Receives actions; unmatched actions stop here.' : 'Interaction scope has ended.'}</p>
      <ul class="inspector-surface-actions" aria-label={`${props.surface.read().id} actions`}><List.View observable={model.actions} surface={{ kind: 'inherit' }} hotkeys={[]} keyBy={action => action.id} fallback={<li>No actions registered</li>}>
        {action => <SurfaceAction action={action} />}
      </List.View></ul>
    </Card.View></div>
  </li>;
}

export function SurfacesGraph(props: { readonly snapshot?: InteractionSnapshot }) {
  const surfaces = constructItem('inspector.surfaces', item => item.observe('surfaces', () => props.snapshot?.surfaces ?? []));
  return <section aria-labelledby="inspector-surfaces-title">
    <div class="inspector-section-heading"><h3 id="inspector-surfaces-title">Surfaces graph</h3><span>{props.snapshot ? `${props.snapshot.surfaces.length} mounted · ${props.snapshot.state}` : 'Not connected'}</span></div>
    <p class="inspector-graph-caption">Topmost first. Unmatched actions pass through transparent surfaces; the first active opaque surface stops them. A matching disabled action also stops resolution.</p>
    <ol class="inspector-surface-stack" aria-label="Surface priority and transparency"><List.View observable={surfaces} surface={{ kind: 'inherit' }} hotkeys={[]} keyBy={surface => surface.id}
      fallback={<li class="inspector-empty">{props.snapshot ? 'No surfaces mounted in this interaction scope.' : 'No interaction diagnostics connected. Pass an interaction snapshot to the inspector.'}</li>}>
      {(surface, index) => <SurfaceNode surface={surface} index={index} />}
    </List.View></ol>
  </section>;
}
