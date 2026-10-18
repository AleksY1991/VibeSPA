import type { Readable } from '@vibespa/contracts';
import { createScope, startModule } from '@vibespa/core';
import { describe, expect, it } from 'vitest';
import type { HistoryState, Intention } from '../../../contracts/focus';
import type { FocusInputs, IntentionRepository, IntentionWrite } from '../contract';
import { titlePolicyModule } from '../../title-policy/definition';
import { createFocus } from './runtime';

async function harness(initial: readonly Intention[] = []) {
  const scope = createScope();
  let rows = [...initial];
  let nextId = 0;
  const gestures: { gestureId: string; label: string; writes: readonly IntentionWrite[] }[] = [];
  const historyCalls: string[] = [];
  const read = <T>(reader: () => T): Readable<T> => ({ read: reader, subscribe: () => () => {} });
  const repository: IntentionRepository = {
    pending: read(() => rows.filter((row) => !row.done)),
    completed: read(() => rows.filter((row) => row.done)),
    history: read<HistoryState>(() => ({ canUndo: true, canRedo: true })),
    write: async (gesture) => {
      gestures.push(gesture);
      for (const write of gesture.writes) {
        if (write.kind === 'delete') {
          rows = rows.filter((row) => row.id !== write.id);
        } else {
          rows = [...rows.filter((row) => row.id !== write.document.id), write.document];
        }
      }
    },
    undo: async () => { historyCalls.push('undo'); },
    redo: async () => { historyCalls.push('redo'); },
  };
  const inputs: FocusInputs = {
    repository,
    titles: await startModule(titlePolicyModule, { maximumLength: 140 }, scope),
    createId: () => `id-${++nextId}`,
  };
  return { focus: createFocus(inputs, scope), scope, gestures, historyCalls, rows: () => rows };
}

describe('focus commands', () => {
  it('validates and normalizes an intention before making any durable change', async () => {
    const test = await harness();
    expect(await test.focus.commands.add('   ')).toEqual({ ok: false, message: 'Write one thing you want to focus on.' });
    expect(await test.focus.commands.add('x'.repeat(141))).toEqual({ ok: false, message: 'Keep your intention within 140 characters.' });
    expect(test.gestures).toHaveLength(0);

    expect(await test.focus.commands.add('  Make\n a little   room  ')).toEqual({ ok: true });
    expect(test.rows()).toEqual([{ id: 'id-1', title: 'Make a little room', done: false }]);
    expect(test.gestures).toHaveLength(1);
    await test.scope.dispose();
  });

  it('completes all pending intentions in one semantic batch', async () => {
    const test = await harness([
      { id: 'one', title: 'One', done: false },
      { id: 'two', title: 'Two', done: false },
      { id: 'three', title: 'Three', done: true },
    ]);

    await test.focus.commands.completePending();

    expect(test.gestures).toEqual([{
      gestureId: 'id-1',
      label: 'Complete all intentions',
      writes: [
        { kind: 'put', document: { id: 'one', title: 'One', done: true } },
        { kind: 'put', document: { id: 'two', title: 'Two', done: true } },
      ],
    }]);
    await test.focus.commands.completePending();
    expect(test.gestures).toHaveLength(1);
    await test.scope.dispose();
  });

  it('serializes rapid actions against the latest persisted rows', async () => {
    const test = await harness([{ id: 'one', title: 'One', done: false }]);
    const first = test.focus.commands.toggle('one');
    const second = test.focus.commands.toggle('one');
    await Promise.all([first, second]);

    expect(test.rows()).toEqual([{ id: 'one', title: 'One', done: false }]);
    expect(test.gestures.map((gesture) => gesture.label)).toEqual(['Complete intention', 'Reopen intention']);
    await test.scope.dispose();
  });

  it('does not allow queued or future writes after its lifetime ends', async () => {
    const test = await harness();
    const queued = test.focus.commands.add('Too late');
    await test.scope.dispose();

    expect((await queued).ok).toBe(false);
    expect((await test.focus.commands.add('Still too late')).ok).toBe(false);
    expect(test.gestures).toHaveLength(0);
  });

  it('delegates undo and redo to the one history owner', async () => {
    const test = await harness();
    await test.focus.commands.undo();
    await test.focus.commands.redo();
    expect(test.historyCalls).toEqual(['undo', 'redo']);
    expect(test.gestures).toHaveLength(0);
    await test.scope.dispose();
  });
});
