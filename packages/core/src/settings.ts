import type { Readable } from '@vibespa/contracts';
import { defineContributionContract } from './contributions.js';
import type { ContributionRegistry } from './contributions.js';
import type { ModuleContext } from './module.js';
import { createSource } from './readable.js';

export interface SettingsOption {
  readonly value: string;
  readonly label: string;
}

interface SettingsEntryBase {
  readonly id: string;
  readonly label: Readable<string>;
  readonly description?: Readable<string>;
  readonly disabled?: Readable<boolean>;
}

export interface SettingsActionEntry extends SettingsEntryBase {
  readonly kind: 'action';
  readonly tone?: 'default' | 'danger';
  run(): Promise<void>;
}

export interface SettingsSelectEntry extends SettingsEntryBase {
  readonly kind: 'select';
  readonly value: Readable<string>;
  readonly options: Readable<readonly SettingsOption[]>;
  set(value: string): Promise<void>;
}

export interface SettingsValueEntry extends SettingsEntryBase {
  readonly kind: 'value';
  readonly value: Readable<string>;
}

export type SettingsEntry = SettingsActionEntry | SettingsSelectEntry | SettingsValueEntry;

/** A feature contributes semantic settings, independent of a rendering library. */
export interface SettingsSection {
  readonly id: string;
  readonly title: Readable<string>;
  readonly description?: Readable<string>;
  readonly order?: number;
  readonly entries: readonly SettingsEntry[];
}

/** Reuse this canonical reference in every Settings provider and consumer. */
export const settingsContributionContract = defineContributionContract<SettingsSection>({
  id: 'vibespa.settings', version: 1, validate: isSettingsSection,
});

function readable(value: unknown): value is Readable<unknown> {
  return !!value && typeof value === 'object' && 'read' in value && typeof value.read === 'function'
    && 'subscribe' in value && typeof value.subscribe === 'function';
}

function isSettingsSection(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const section = value as Partial<SettingsSection>;
  if (typeof section.id !== 'string' || !section.id.trim() || !readable(section.title)
    || (section.description !== undefined && !readable(section.description))
    || !Number.isFinite(section.order ?? 0) || !Array.isArray(section.entries)) return false;
  const ids = new Set<string>();
  return section.entries.every((entry: SettingsEntry) => {
    if (!entry || typeof entry.id !== 'string' || !entry.id.trim() || ids.has(entry.id)
      || !readable(entry.label) || (entry.description !== undefined && !readable(entry.description))
      || (entry.disabled !== undefined && !readable(entry.disabled))) return false;
    ids.add(entry.id);
    switch (entry.kind) {
      case 'action': return typeof entry.run === 'function'
        && (entry.tone === undefined || entry.tone === 'default' || entry.tone === 'danger');
      case 'select': return readable(entry.value) && readable(entry.options) && typeof entry.set === 'function';
      case 'value': return readable(entry.value);
      default: return false;
    }
  });
}

export interface SettingsConsumer {
  readonly sections: Readable<readonly SettingsSection[]>;
  /** Malformed or duplicate dynamic contributions are unavailable until corrected. */
  readonly error: Readable<Error | undefined>;
  activate(sectionId: string, entryId: string): Promise<void>;
  select(sectionId: string, entryId: string, value: string): Promise<void>;
}

function sectionsFrom(registry: ContributionRegistry<SettingsSection>): readonly SettingsSection[] {
  const identities = new Set<string>();
  const sections = registry.items.read().map(({ id, value: section }) => {
    if (!settingsContributionContract.validate?.(section)) throw new Error(`Invalid Settings contribution: ${id}`);
    if (!section.id.trim()) throw new Error('Settings sections need a nonempty id.');
    if (identities.has(section.id)) throw new Error(`Duplicate Settings section: ${section.id}`);
    identities.add(section.id);
    if (!Number.isFinite(section.order ?? 0)) throw new Error(`Invalid Settings section order: ${section.id}`);
    const entries = new Set<string>();
    for (const entry of section.entries) {
      if (!entry.id.trim()) throw new Error(`Settings section ${section.id} contains an empty entry id.`);
      if (entries.has(entry.id)) throw new Error(`Duplicate Settings entry: ${section.id}.${entry.id}`);
      entries.add(entry.id);
      if (!['action', 'select', 'value'].includes(entry.kind)) {
        throw new Error(`Unknown Settings entry kind in ${section.id}.${entry.id}`);
      }
    }
    return Object.freeze({ ...section, entries: Object.freeze([...section.entries]) });
  });
  return Object.freeze(sections.sort((left, right) =>
    (left.order ?? 0) - (right.order ?? 0) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)));
}

/** Consume the live typed registry under a module-owned lifetime.
 * Providers keep their own commands; this consumer validates current intent and
 * joins each invocation before its own resources are released.
 */
export function createSettingsConsumer(
  scope: ModuleContext, registry: ContributionRegistry<SettingsSection>,
): SettingsConsumer {
  if (scope.signal.aborted) throw new Error('Cannot create a Settings consumer in an ended scope.');
  if (registry.contract !== settingsContributionContract) throw new Error('Use the canonical Settings contribution registry.');
  const sections = createSource<readonly SettingsSection[]>(Object.freeze([]));
  const error = createSource<Error | undefined>(undefined);
  let stopped = false;
  let revision = 0;
  const publish = (next: readonly SettingsSection[], failure?: Error, expected = revision): void => {
    if (revision !== expected) return;
    // A rendering observer cannot leave another source stale or fail cancellation.
    try { error.set(failure); } catch { /* createSource notified every observer. */ }
    if (revision !== expected) return;
    try { sections.set(next); } catch { /* Sources update before notifying observers. */ }
  };
  const refresh = (): void => {
    if (stopped) return;
    const expected = ++revision;
    let next: readonly SettingsSection[];
    try { next = sectionsFrom(registry); }
    catch (failure) {
      publish(Object.freeze([]), failure instanceof Error ? failure : new Error(String(failure)), expected);
      return;
    }
    publish(next, undefined, expected);
  };
  refresh();
  const release = registry.items.subscribe(refresh);
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    revision++;
    try { release(); } finally { publish(Object.freeze([])); }
  };
  scope.signal.addEventListener('abort', stop, { once: true });
  scope.defer(() => {
    scope.signal.removeEventListener('abort', stop);
    stop();
  });

  const current = (sectionId: string, entryId: string): SettingsEntry => {
    if (scope.signal.aborted) throw new Error('The Settings consumer belongs to an ended scope.');
    const failure = error.source.read();
    if (failure) throw failure;
    const entry = sections.source.read().find(section => section.id === sectionId)
      ?.entries.find(candidate => candidate.id === entryId);
    if (!entry) throw new Error(`Settings entry is unavailable: ${sectionId}.${entryId}`);
    return entry;
  };
  const recheck = (sectionId: string, entryId: string, expected: SettingsEntry): void => {
    if (current(sectionId, entryId) !== expected) {
      throw new Error(`Settings entry changed before invocation: ${sectionId}.${entryId}`);
    }
  };
  const find = (sectionId: string, entryId: string): SettingsEntry => {
    const entry = current(sectionId, entryId);
    const disabled = entry.disabled?.read();
    // Reads are user-supplied callbacks and may cancel or replace a provider.
    recheck(sectionId, entryId, entry);
    if (disabled) throw new Error(`Settings entry is disabled: ${sectionId}.${entryId}`);
    return entry;
  };
  const commands = scope.commands({
    async activate(sectionId: string, entryId: string): Promise<void> {
      const entry = find(sectionId, entryId);
      if (entry.kind !== 'action') throw new Error(`Settings entry is not an action: ${sectionId}.${entryId}`);
      recheck(sectionId, entryId, entry);
      await entry.run();
    },
    async select(sectionId: string, entryId: string, value: string): Promise<void> {
      const entry = find(sectionId, entryId);
      if (entry.kind !== 'select') throw new Error(`Settings entry is not a selection: ${sectionId}.${entryId}`);
      const allowed = entry.options.read().some(option => option.value === value);
      recheck(sectionId, entryId, entry);
      if (!allowed) {
        throw new Error(`Invalid Settings choice for ${sectionId}.${entryId}: ${value}`);
      }
      await entry.set(value);
    },
  });
  return Object.freeze({ sections: sections.source, error: error.source, ...commands });
}
