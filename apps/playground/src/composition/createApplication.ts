import type { System } from '@vibespa/core';
import type { FocusCommands } from '../contracts/focus';
import { focusModule } from '../modules/focus/definition';
import { localStorageModule } from '../modules/local-storage/definition';
import { titlePolicyModule } from '../modules/title-policy/definition';

const maximumTitleLength = 140;

export async function createApplication(system: System) {
  try {
    const storage = await system.start(localStorageModule, {
      name: 'vibespa-focus',
      maximumTitleLength,
    });
    const titles = await system.start(titlePolicyModule, { maximumLength: maximumTitleLength });
    const focus = await system.start(focusModule, {
      titles: titles.exports,
      createId: () => `${Date.now()}-${crypto.randomUUID()}`,
      repository: storage.exports.repository,
    }, { dependencies: [storage, titles] });

    // Trace only named public operations. Arguments, returned values and private
    // state never enter the inspector. Domain code does not know about tooling.
    const commands: FocusCommands = {
      add: (title) => system.trace(focus, 'add', () => focus.exports.commands.add(title)),
      toggle: (id) => system.trace(focus, 'toggle', () => focus.exports.commands.toggle(id)),
      remove: (id) => system.trace(focus, 'remove', () => focus.exports.commands.remove(id)),
      completePending: () => system.trace(focus, 'completePending', () => focus.exports.commands.completePending()),
      undo: () => system.trace(focus, 'undo', () => focus.exports.commands.undo()),
      redo: () => system.trace(focus, 'redo', () => focus.exports.commands.redo()),
    };

    return { focus: { ...focus.exports, commands }, dispose: () => system.dispose() };
  } catch (error) {
    try { await system.dispose(); }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Application startup and cleanup failed.', { cause: cleanupError });
    }
    throw error;
  }
}
