import type { ModuleContext } from '@vibespa/core/module';
import { createSolidDomain } from '@vibespa/solid/domain';
import type { Intention } from '../../../contracts/focus';
import type { IntentionsDataCommands, IntentionsDataExports, IntentionsDataInputs } from '../contract';

export async function createIntentionsData(inputs: IntentionsDataInputs, scope: ModuleContext): Promise<IntentionsDataExports> {
  // The mutable owner stays private. Consumers receive a read view and named
  // commands; the adapter receives only the owner's incoming-admission port.
  const owner = createSolidDomain<Intention>(scope, {
    generation: inputs.generation,
    adapter: inputs.adapter,
    validate: (row: unknown): row is Intention => {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) return false;
      const value = row as Record<string, unknown>;
      return Object.keys(value).every(key => key === 'id' || key === 'title' || key === 'done')
        && typeof value.id === 'string' && typeof value.title === 'string'
        && typeof value.done === 'boolean' && inputs.titles.validate(value.title).valid;
    },
  });
  const commands: IntentionsDataCommands = {
    commit: async gesture => owner.commit(gesture),
    undo: async () => owner.undo(),
    redo: async () => owner.redo(),
    retry: async () => { owner.retry(); },
    keepLocal: async () => { owner.keepLocal(); },
  };

  // Preserve current hydration behavior: backend failures stay in delivery and
  // local commands can still operate. Completion does not promise durability.
  await owner.settled();
  scope.signal.throwIfAborted();
  return { data: { view: owner.view, commands: scope.commands(commands) } };
}
