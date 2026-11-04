import { createComponent } from 'solid-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScope, createSource, createSystem, dataPort, defineDataContract, defineFeatureModule, FeatureType } from '@vibespa/core';
import type { System } from '@vibespa/core';
import { createInteraction } from '@vibespa/interaction';
import type { Interaction } from '@vibespa/interaction';
import { SystemInspector } from './ui/SystemInspector';
import { mountUiRoot } from './ui/runtime';
import { activateTab, settleUi } from './uiTestHost.test-helper';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  document.body.replaceChildren();
});

function feature(id: string) {
  const load = vi.fn(async () => () => ({ read: () => 'private value' }));
  return { load, definition: defineFeatureModule<FeatureType.Feature, Record<string, never>, { read(): string }>({
    id, kind: FeatureType.Feature, title: `${id} feature`, description: `Public ${id} contract.`,
    contract: { inputs: {}, exports: { read: 'Read a value.' } }, load,
  }) };
}

async function mountInspector(system: System, interaction?: Interaction) {
  const target = document.createElement('div');
  document.body.append(target);
  cleanups.push(mountUiRoot(target, 'test-inspector', () => createComponent(SystemInspector, {
    snapshot: system.snapshot,
    clearEvents: () => system.clearEvents(),
    interaction: interaction?.snapshot,
  })));
  await settleUi(target);
  return target;
}

async function clickView(target: HTMLElement, name: string) {
  const button = [...target.querySelectorAll<HTMLElement>('wa-tab')]
    .find(item => item.textContent?.startsWith(name));
  expect(button, `Missing ${name} view button`).toBeDefined();
  activateTab(button!);
  await settleUi(target);
  expect(button!.getAttribute('aria-selected')).toBe('true');
}

async function settle() {
  await settleUi();
}

describe('system inspector diagnostics', () => {
  it('shows selected definitions before loading and tracks instance startup without exposing values', async () => {
    const selected = feature('selected');
    const system = createSystem({ id: 'test', modules: [selected.definition] });
    cleanups.push(() => system.dispose());
    const target = await mountInspector(system);
    expect(target.querySelector('.inspector-registration')?.textContent).toContain('selected feature');
    expect(target.querySelector('.inspector-registration')?.textContent).toContain('Not started');
    expect(selected.load).not.toHaveBeenCalled();

    await system.start(selected.definition, {}, { id: 'selected-instance' });
    await settle();
    expect(target.querySelector('.inspector-registration')?.textContent).toContain('1 instance');
    target.querySelector<HTMLButtonElement>('.inspector-registration button[aria-expanded]')!.click();
    await settleUi(target);
    expect(target.querySelector('.inspector-instance-list')?.textContent).toContain('selected-instance');
    expect(target.querySelector('.inspector-instance-list')?.textContent).toContain('ready');
    expect(target.textContent).not.toContain('private value');
  });

  it('renders provider, contract and consumer ports from the selected data plan without starting modules', async () => {
    const contract = defineDataContract<{ read(): string }>({ id: 'notes', version: 2 });
    const system = createSystem({ id: 'data-test', modules: [
      { id: 'notes-data', kind: FeatureType.Data, data: { provides: { notes: dataPort(contract, ['read', 'live']) } } },
      { id: 'notes-board', kind: FeatureType.View, data: { requires: { cards: dataPort(contract, ['read']) } } },
    ] });
    cleanups.push(() => system.dispose());
    const target = await mountInspector(system);
    await clickView(target, 'Data graph');
    expect(target.querySelector('.inspector-provider')?.textContent).toContain('notes-data');
    expect(target.querySelector('.inspector-provider')?.textContent).toContain('Export: notes');
    expect(target.querySelector('.inspector-data-contract')?.textContent).toContain('Version 2');
    expect(target.querySelector('.inspector-consumer-nodes')?.textContent).toContain('notes-board');
    expect(target.querySelector('.inspector-consumer-nodes')?.textContent).toContain('Input: cards');
    expect(system.snapshot.read().modules).toEqual([]);
  });

  it('updates the surface stack when an opaque layer deactivates and when action availability changes', async () => {
    const scope = createScope();
    cleanups.push(() => scope.dispose());
    const interaction = createInteraction(scope);
    const lowerActive = createSource(true);
    const overlayActive = createSource(true);
    const enabled = createSource(true);
    interaction.mount({ id: 'page', active: lowerActive.source, transparent: true, actions: [{ id: 'save', keys: ['Ctrl+s'], enabled: enabled.source, run() {} }] });
    interaction.mount({ id: 'dialog', active: overlayActive.source, actions: [] });
    const system = createSystem({ id: 'surface-test' });
    cleanups.push(() => system.dispose());
    const target = await mountInspector(system, interaction);
    await clickView(target, 'Surfaces');
    const surfaces = () => [...target.querySelectorAll<HTMLElement>('.inspector-surface')];
    expect(surfaces()[0]?.textContent).toContain('dialog');
    expect(surfaces()[0]?.textContent).toContain('Transparent: no · opaque');
    expect(surfaces()[1]?.textContent).toContain('Transparent: yes');
    expect(surfaces()[1]?.textContent).toContain('Blocked by dialog');
    expect(surfaces()[1]?.dataset.reachable).toBe('false');

    overlayActive.set(false);
    enabled.set(false);
    await settle();
    expect(surfaces()[0]?.textContent).toContain('Inactive · skipped');
    expect(surfaces()[1]?.dataset.reachable).toBe('true');
    expect(surfaces()[1]?.textContent).toContain('unmatched actions continue below');
    expect(surfaces()[1]?.querySelector('.inspector-surface-actions')?.textContent).toContain('Disabled');
    expect(surfaces()[1]?.querySelector('kbd')?.textContent).toBe('ctrl+s');
  });

  it('filters every instance of a definition and carries that filter into activity', async () => {
    const first = feature('first');
    const other = feature('other');
    const system = createSystem({ id: 'filter-test', modules: [first.definition, other.definition] });
    cleanups.push(() => system.dispose());
    await system.start(first.definition, {}, { id: 'first-a' });
    await system.start(first.definition, {}, { id: 'first-b' });
    await system.start(other.definition, {});
    const target = await mountInspector(system);
    const filter = target.querySelector<HTMLElement & { value: string }>('wa-select')!;
    filter.value = 'first';
    filter.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    await settleUi(target);
    expect(target.querySelectorAll('.inspector-module')).toHaveLength(2);
    expect(target.querySelector('.inspector-module-grid')?.textContent).toContain('first-a');
    expect(target.querySelector('.inspector-module-grid')?.textContent).toContain('first-b');
    expect(target.querySelector('.inspector-module-grid')?.textContent).not.toContain('other');

    await clickView(target, 'Activity');
    expect(target.querySelector<HTMLElement & { value: string }>('wa-select')?.value).toBe('first');
    const activity = target.querySelector('.inspector-timeline')!;
    expect(activity.textContent).toContain('first-a');
    expect(activity.textContent).toContain('first-b');
    expect(activity.textContent).not.toContain('other');
    [...target.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Clear activity')!.click();
    await settle();
    expect(activity.textContent).toContain('No activity in this view yet.');
  });
});
