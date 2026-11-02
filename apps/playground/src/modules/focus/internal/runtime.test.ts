import { external, from } from '@vibespa/core';
import { flush } from 'solid-js';
import { createSolidSystem } from '@vibespa/solid/module';
import type { AdapterBatch, DomainAdapter, SaveReceipt } from '@vibespa/solid/domain';
import { describe, expect, it } from 'vitest';
import type { Intention } from '../../../contracts/focus';
import { focusModule } from '../definition';
import { intentionsDataModule } from '../../intentions-data/definition';
import { titlePolicyModule } from '../../title-policy/definition';

async function until(predicate: () => boolean) {
  for (let count = 0; count < 100 && !predicate(); count++) await new Promise(resolve => setTimeout(resolve, 0));
  expect(predicate()).toBe(true);
}

async function harness(initial: readonly Intention[] = [], options: { memory?: boolean; fail?: boolean; delay?: Promise<void> } = {}) {
  const system = createSolidSystem({
    id: `focus-test-${crypto.randomUUID()}`,
    modules: [titlePolicyModule, intentionsDataModule, focusModule],
  });
  let nextId = 0;
  let fail = options.fail ?? false;
  const batches: AdapterBatch<Intention>[] = [];
  const adapter: DomainAdapter<Intention> = {
    async open() {
      return {
        load: async () => initial.map(document => ({ id: document.id, document, version: 1 })),
        async save(batch): Promise<SaveReceipt<Intention>> {
          batches.push(batch);
          if (options.delay) await options.delay;
          if (fail) throw new Error('Offline fixture');
          return { identity: batch.identity, rows: batch.writes.map(write => ({
            id: write.id, ok: true, version: write.expectedVersion + 1, document: write.document,
          })) };
        },
        close() {},
      };
    },
  };
  const titles = await system.start(titlePolicyModule, { maximumLength: external(140) });
  const data = await system.start(intentionsDataModule, {
    adapter: external(options.memory ? undefined : adapter),
    generation: external('test-generation'),
    titles: from(titles),
  });
  const focus = await system.start(focusModule, {
    data: from(data, 'data'),
    titles: from(titles),
    createId: external(() => `id-${++nextId}`),
  });
  return { focus: focus.exports, system, batches, recover() { fail = false; } };
}

describe('Solid-owned focus commands', () => {
  it.each([
    { name: 'undeclared fields', row: { id: 'extra', title: 'An intention', done: false, extra: 'Refuse this field' } },
    { name: 'invalid titles', row: { id: 'invalid', title: 'x'.repeat(141), done: false } },
  ])('rejects incoming rows with $name before they reach the feature', async ({ row }) => {
    const test = await harness([row]);
    try {
      expect(test.focus.pending()).toHaveLength(0);
      expect(test.focus.completed()).toHaveLength(0);
      expect(test.focus.delivery()).toMatchObject({ phase: 'failed', pending: 0 });
      expect(test.focus.delivery().error).toContain('Invalid domain row');
    } finally { await test.system.dispose(); }
  });

  it('validates and normalizes before local admission, including without persistence', async () => {
    const test = await harness([], { memory: true });
    try {
      expect(await test.focus.commands.add('   ')).toEqual({ ok: false, message: 'Write one thing you want to focus on.' });
      expect(await test.focus.commands.add('x'.repeat(141))).toEqual({ ok: false, message: 'Keep your intention within 140 characters.' });
      expect(test.focus.pending()).toHaveLength(0);
      const admitted = test.focus.commands.add('  Make\n a little   room  ');
      // Flush Solid's scheduled read publication, without awaiting delivery.
      flush();
      expect(test.focus.pending()).toEqual([{ id: 'id-1', title: 'Make a little room', done: false }]);
      expect(await admitted).toEqual({ ok: true });
      expect(test.focus.delivery().phase).toBe('memory');
      expect(test.batches).toHaveLength(0);
    } finally { await test.system.dispose(); }
  });

  it('completes pending intentions in one semantic adapter batch', async () => {
    const test = await harness([
      { id: 'one', title: 'One', done: false },
      { id: 'two', title: 'Two', done: false },
      { id: 'three', title: 'Three', done: true },
    ]);
    try {
      expect(await test.focus.commands.completePending()).toEqual({ ok: true });
      expect(test.focus.pending()).toHaveLength(0);
      expect(test.focus.completed()).toHaveLength(3);
      await until(() => test.focus.delivery().phase === 'idle');
      expect(test.batches).toHaveLength(1);
      expect(test.batches[0]?.identity.gestureId).toBe('id-1');
      expect(test.batches[0]?.label).toBe('Complete all intentions');
      expect(test.batches[0]?.writes.map(write => write.document)).toEqual([
        { id: 'one', title: 'One', done: true }, { id: 'two', title: 'Two', done: true },
      ]);
      await test.focus.commands.completePending();
      expect(test.batches).toHaveLength(1);
    } finally { await test.system.dispose(); }
  });

  it('admits rapid actions against the latest Solid row while saves are delayed', async () => {
    let release!: () => void;
    const delay = new Promise<void>(resolve => { release = resolve; });
    const test = await harness([{ id: 'one', title: 'One', done: false }], { delay });
    try {
      const first = test.focus.commands.toggle('one');
      flush();
      expect(test.focus.completed()[0]?.id).toBe('one');
      const second = test.focus.commands.toggle('one');
      flush();
      expect(test.focus.pending()[0]?.id).toBe('one');
      expect(await Promise.all([first, second])).toEqual([{ ok: true }, { ok: true }]);
      expect(test.focus.delivery().pending).toBeGreaterThan(0);
      release();
      await until(() => test.focus.delivery().phase === 'idle');
      expect(test.batches.map(batch => batch.label)).toEqual(['Complete intention', 'Reopen intention']);
    } finally { release(); await test.system.dispose(); }
  });

  it('preserves accepted edits on save failure and retries through the named API', async () => {
    const test = await harness([], { fail: true });
    try {
      expect(await test.focus.commands.add('Keep my edit')).toEqual({ ok: true });
      await until(() => test.focus.delivery().phase === 'failed');
      expect(test.focus.pending()[0]?.title).toBe('Keep my edit');
      expect(test.focus.delivery().error).toContain('Offline fixture');
      test.recover();
      await test.focus.commands.retry();
      await until(() => test.focus.delivery().phase === 'idle');
      expect(test.batches).toHaveLength(2);
      expect(test.batches[1]?.identity).toEqual(test.batches[0]?.identity);
      expect(test.focus.pending()[0]?.title).toBe('Keep my edit');
    } finally { await test.system.dispose(); }
  });

  it('uses the same owner for history and refuses stale public commands', async () => {
    const test = await harness([], { memory: true });
    await test.focus.commands.add('One');
    expect(test.focus.history().canUndo).toBe(true);
    await test.focus.commands.undo();
    expect(test.focus.pending()).toHaveLength(0);
    expect(test.focus.history().canRedo).toBe(true);
    await test.focus.commands.redo();
    expect(test.focus.pending()[0]?.title).toBe('One');
    await test.system.dispose();
    await expect(test.focus.commands.add('After shutdown')).rejects.toThrow('disposed');
    expect(test.focus.pending()).toHaveLength(1);
  });

  it('reports disposal with undelivered accepted edits as a failure', async () => {
    const test = await harness([], { fail: true });
    await test.focus.commands.add('An accepted, unsaved edit');
    await until(() => test.focus.delivery().phase === 'failed');
    await expect(test.system.dispose()).rejects.toBeInstanceOf(AggregateError);
    expect(test.system.snapshot.read().state).toBe('failed');
    expect(test.focus.pending()[0]?.title).toBe('An accepted, unsaved edit');
    await expect(test.focus.commands.add('After cancellation')).rejects.toThrow();
  });
});
