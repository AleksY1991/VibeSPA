import { createMemo } from 'solid-js';
import type { ModuleContext } from '@vibespa/core/module';
import type { DomainWrite } from '@vibespa/solid/domain';
import type { CommandResult, FocusCommands, Intention } from '../../../contracts/focus';
import type { Focus, FocusInputs } from '../contract';

const success: CommandResult = { ok: true };

export function createFocus(inputs: FocusInputs, scope: ModuleContext): Focus {
  const { data, titles, createId } = inputs;
  // Focus decides domain intent. The Data module owns the live records and
  // exposes the same typed capabilities for memory, IndexedDB and REST.
  const pending = createMemo(() => Object.freeze(data.view.rows.filter(item => !item.done)));
  const completed = createMemo(() => Object.freeze(data.view.rows.filter(item => item.done)));

  function find(id: string): Readonly<Intention> | undefined {
    return data.view.rows.find(item => item.id === id);
  }

  async function write(label: string, writes: readonly DomainWrite<Intention>[]): Promise<CommandResult> {
    // Registered Data commands enter their owner and apply synchronously before
    // returning their promise. Awaiting it does not wait for backend delivery.
    if (writes.length > 0) await data.commands.commit({ gestureId: createId(), label, writes });
    return success;
  }

  async function attempt(operation: () => Promise<unknown>): Promise<CommandResult> {
    try { await operation(); return success; }
    catch (error: unknown) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; }
  }

  // The async return value is the module command contract. Local application
  // happens synchronously, independently of disk or network acknowledgement.
  const commands: FocusCommands = {
    add: async value => {
      const result = titles.validate(value);
      if (!result.valid) return { ok: false, message: result.message };
      return write('Add intention', [{
        kind: 'put', document: { id: createId(), title: result.title, done: false },
      }]);
    },
    toggle: async id => {
      const item = find(id);
      if (!item) return success;
      return write(item.done ? 'Reopen intention' : 'Complete intention', [{
        kind: 'put', document: { ...item, done: !item.done },
      }]);
    },
    remove: async id => find(id) ? write('Remove intention', [{ kind: 'delete', id }]) : success,
    completePending: async () => write('Complete all intentions', data.view.rows.filter(item => !item.done).map(item => ({
      kind: 'put' as const, document: { ...item, done: true },
    }))),
    undo: async () => attempt(() => data.commands.undo()),
    redo: async () => attempt(() => data.commands.redo()),
    retry: async () => attempt(() => data.commands.retry()),
    keepLocal: async () => attempt(() => data.commands.keepLocal()),
  };

  return {
    pending,
    completed,
    history: data.view.history,
    delivery: data.view.delivery,
    commands: scope.commands(commands),
  };
}
