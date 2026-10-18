import type { Scope } from '@vibespa/contracts';
import type { CommandResult, Intention } from '../../../contracts/focus';
import type { Focus, FocusInputs, IntentionWrite } from '../contract';

const success: CommandResult = { ok: true };

export function createFocus(inputs: FocusInputs, scope: Scope): Focus {
  const { repository, titles, createId } = inputs;
  let settled: Promise<unknown> = Promise.resolve();
  scope.defer(async () => { await settled; });

  // Serial commands read the latest query result after the preceding gesture.
  // Persistence still receives one explicit batch for every compound action.
  function run(operation: () => Promise<CommandResult>): Promise<CommandResult> {
    const command = settled.then(async (): Promise<CommandResult> => {
      if (scope.signal.aborted) {
        return { ok: false, message: 'This session has ended. Reload to continue.' };
      }
      try {
        return await operation();
      } catch {
        return { ok: false, message: 'Unable to save this change. Try again.' };
      }
    });
    settled = command;
    return command;
  }

  function find(id: string): Readonly<Intention> | undefined {
    return repository.pending.read().find((item) => item.id === id)
      ?? repository.completed.read().find((item) => item.id === id);
  }

  async function write(label: string, writes: readonly IntentionWrite[]): Promise<CommandResult> {
    if (writes.length > 0) {
      await repository.write({ gestureId: createId(), label, writes });
    }
    return success;
  }

  return {
    pending: repository.pending,
    completed: repository.completed,
    history: repository.history,
    commands: {
      add: (value) => run(async () => {
        const result = titles.validate(value);
        if (!result.valid) return { ok: false, message: result.message };
        return write('Add intention', [{
          kind: 'put',
          document: { id: createId(), title: result.title, done: false },
        }]);
      }),
      toggle: (id) => run(async () => {
        const item = find(id);
        if (!item) return success;
        return write(item.done ? 'Reopen intention' : 'Complete intention', [{
          kind: 'put', document: { ...item, done: !item.done },
        }]);
      }),
      remove: (id) => run(async () => {
        if (!find(id)) return success;
        return write('Remove intention', [{ kind: 'delete', id }]);
      }),
      completePending: () => run(async () => write(
        'Complete all intentions',
        repository.pending.read().map((item) => ({
          kind: 'put' as const,
          document: { ...item, done: true },
        })),
      )),
      undo: () => run(async () => { await repository.undo(); return success; }),
      redo: () => run(async () => { await repository.redo(); return success; }),
    },
  };
}
