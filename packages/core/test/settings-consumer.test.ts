import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContributionEntry, ContributionRegistry } from '../src/contributions.js';
import { defineContributionContract } from '../src/contributions.js';
import { defineModule, startModule } from '../src/module.js';
import { constantReadable, createSource } from '../src/readable.js';
import { createScope } from '../src/scope.js';
import { createSettingsConsumer, settingsContributionContract } from '../src/settings.js';
import type { SettingsConsumer, SettingsSection } from '../src/settings.js';

const scopes: ReturnType<typeof createScope>[] = [];
afterEach(async () => { await Promise.all(scopes.splice(0).map(scope => scope.dispose())); });

const contribution = (value: SettingsSection): ContributionEntry<SettingsSection> => ({
  id: `${value.id}.settings`, definitionId: value.id, instanceId: value.id, export: 'settings', order: 0, value,
});

async function setup(initial: readonly SettingsSection[]) {
  const scope = createScope();
  scopes.push(scope);
  const items = createSource<readonly ContributionEntry<SettingsSection>[]>(initial.map(contribution));
  const registry: ContributionRegistry<SettingsSection> = {
    contract: settingsContributionContract, definitions: constantReadable([]), items: items.source,
  };
  const consumer = await startModule(defineModule<never, SettingsConsumer>({
    id: 'settings-consumer', load: async () => (_input, context) => createSettingsConsumer(context, registry),
  }), undefined as never, scope);
  return { consumer, scope, replace: (sections: readonly SettingsSection[]) => items.set(sections.map(contribution)) };
}

describe('Settings contribution consumer', () => {
  it('consumes ordered reactive sections and dispatches current validated choices', async () => {
    const language = createSource('en');
    const label = createSource('Language');
    const disabled = createSource(false);
    const run = vi.fn(async () => {});
    const set = vi.fn(async (value: string) => { language.set(value); });
    const { consumer } = await setup([
      { id: 'localization', title: constantReadable('Localization'), order: 20, entries: [{
        id: 'language', kind: 'select', label: label.source, value: language.source,
        options: constantReadable([{ value: 'en', label: 'English' }, { value: 'de', label: 'Deutsch' }]), set,
      }] },
      { id: 'account', title: constantReadable('Account'), order: 10, entries: [{
        id: 'logout', kind: 'action', label: constantReadable('Sign out'), disabled: disabled.source, run,
      }] },
    ]);

    expect(consumer.sections.read().map(section => section.id)).toEqual(['account', 'localization']);
    await consumer.select('localization', 'language', 'de');
    expect(language.source.read()).toBe('de');
    label.set('Sprache');
    expect(consumer.sections.read()[1]?.entries[0]?.label.read()).toBe('Sprache');
    await expect(consumer.select('localization', 'language', 'missing')).rejects.toThrow('Invalid Settings choice');
    expect(set).toHaveBeenCalledTimes(1);
    await expect(consumer.activate('localization', 'language')).rejects.toThrow('not an action');
    await consumer.activate('account', 'logout');
    disabled.set(true);
    await expect(consumer.activate('account', 'logout')).rejects.toThrow('disabled');
    expect(run).toHaveBeenCalledOnce();
  });

  it('refuses ambiguous sections, recovers when corrected and refuses removed entries', async () => {
    const run = vi.fn(async () => {});
    const account: SettingsSection = { id: 'account', title: constantReadable('Account'), entries: [
      { id: 'logout', kind: 'action', label: constantReadable('Sign out'), run },
    ] };
    const { consumer, replace } = await setup([account]);
    replace([account, account]);
    expect(consumer.sections.read()).toEqual([]);
    expect(consumer.error.read()?.message).toContain('Duplicate Settings section');
    await expect(consumer.activate('account', 'logout')).rejects.toThrow('Duplicate');
    replace([account]);
    expect(consumer.error.read()).toBeUndefined();
    await consumer.activate('account', 'logout');
    replace([]);
    await expect(consumer.activate('account', 'logout')).rejects.toThrow('unavailable');
    expect(run).toHaveBeenCalledOnce();
  });

  it('clears malformed dynamic sections even when catalog observers throw', async () => {
    const run = vi.fn(async () => {});
    const account: SettingsSection = { id: 'account', title: constantReadable('Account'), entries: [
      { id: 'logout', kind: 'action', label: constantReadable('Sign out'), run },
    ] };
    const { consumer, scope, replace } = await setup([account]);
    consumer.error.subscribe(() => { throw new Error('Broken error observer.'); });
    consumer.sections.subscribe(() => { throw new Error('Broken section observer.'); });
    const malformed = { ...account, title: 'Wrong shape' } as unknown as SettingsSection;
    expect(() => replace([malformed])).not.toThrow();
    expect(consumer.error.read()?.message).toContain('Invalid Settings contribution');
    expect(consumer.sections.read()).toEqual([]);
    await expect(consumer.activate('account', 'logout')).rejects.toThrow('Invalid Settings contribution');
    expect(run).not.toHaveBeenCalled();
    expect(() => replace([account])).not.toThrow();
    expect(consumer.error.read()).toBeUndefined();
    await consumer.activate('account', 'logout');
    await expect(scope.dispose()).resolves.toBeUndefined();
    expect(consumer.sections.read()).toEqual([]);
    expect(() => replace([account])).not.toThrow();
    expect(consumer.sections.read()).toEqual([]);
  });

  it('joins accepted actions at shutdown, clears discovery and stops registry observation', async () => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const section: SettingsSection = { id: 'account', title: constantReadable('Account'), entries: [
      { id: 'logout', kind: 'action', label: constantReadable('Sign out'), run: () => pending },
    ] };
    const { consumer, scope, replace } = await setup([section]);
    const invocation = consumer.activate('account', 'logout');
    let disposed = false;
    const closing = scope.dispose().then(() => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);
    expect(consumer.sections.read()).toEqual([]);
    replace([section]);
    expect(consumer.sections.read()).toEqual([]);
    await expect(consumer.activate('account', 'logout')).rejects.toThrow();
    finish();
    await invocation;
    await closing;
    expect(disposed).toBe(true);
  });

  it('rechecks cancellation and provider identity after custom disabled and option reads', async () => {
    const run = vi.fn(async () => {});
    const account: SettingsSection = { id: 'account', title: constantReadable('Account'), entries: [
      { id: 'logout', kind: 'action', label: constantReadable('Sign out'), run, disabled: {
        read: () => { actions.replace([]); return false; }, subscribe: () => () => {},
      } },
    ] };
    const actions = await setup([account]);
    await expect(actions.consumer.activate('account', 'logout')).rejects.toThrow('unavailable');
    expect(run).not.toHaveBeenCalled();

    const set = vi.fn(async (_value: string) => {});
    let closing: Promise<void> | undefined;
    const localization: SettingsSection = { id: 'localization', title: constantReadable('Localization'), entries: [
      { id: 'language', kind: 'select', label: constantReadable('Language'), value: constantReadable('en'), set,
        options: { read: () => { closing = selections.scope.dispose(); return [{ value: 'de', label: 'Deutsch' }]; }, subscribe: () => () => {} },
      },
    ] };
    const selections = await setup([localization]);
    await expect(selections.consumer.select('localization', 'language', 'de')).rejects.toThrow(/ended|unavailable/);
    expect(set).not.toHaveBeenCalled();
    await closing;
  });

  it('requires the canonical typed registry and rejects malformed provider payloads', async () => {
    const duplicate = defineContributionContract<SettingsSection>({ id: 'vibespa.settings', version: 1 });
    const registry: ContributionRegistry<SettingsSection> = {
      contract: duplicate, definitions: constantReadable([]), items: constantReadable([]),
    };
    const scope = createScope();
    scopes.push(scope);
    await expect(startModule(defineModule<never, SettingsConsumer>({
      id: 'wrong-registry', load: async () => (_input, context) => createSettingsConsumer(context, registry),
    }), undefined as never, scope)).rejects.toThrow('canonical Settings');
    expect(settingsContributionContract.validate?.({ id: 'broken', entries: [] })).toBe(false);
    expect(settingsContributionContract.validate?.({
      id: 'duplicate', title: constantReadable('Invalid'), entries: [
        { id: 'same', kind: 'value', label: constantReadable('One'), value: constantReadable('a') },
        { id: 'same', kind: 'value', label: constantReadable('Two'), value: constantReadable('b') },
      ],
    })).toBe(false);
  });
});
