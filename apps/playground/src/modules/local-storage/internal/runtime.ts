import type { Scope } from '@vibespa/contracts';
import { createLocalStore } from '@vibespa/local-first';
import type { Intention } from '../../../contracts/focus';
import type { LocalStorage, LocalStorageInputs } from '../contract';

export async function createLocalStorage(inputs: LocalStorageInputs, scope: Scope): Promise<LocalStorage> {
  const store = await createLocalStore<{ intentions: Intention }>({
    name: inputs.name,
    scope,
    schemas: {
      intentions: {
        title: 'An intention',
        version: 0,
        primaryKey: 'id',
        type: 'object',
        properties: {
          id: { type: 'string', maxLength: 100 },
          title: { type: 'string', maxLength: inputs.maximumTitleLength },
          done: { type: 'boolean' },
        },
        required: ['id', 'title', 'done'],
      },
    },
  });
  const pending = await store.query('intentions', { selector: { done: false }, sort: [{ id: 'asc' }] });
  const completed = await store.query('intentions', { selector: { done: true }, sort: [{ id: 'asc' }] });

  return {
    repository: {
      pending,
      completed,
      history: store.history.state,
      write: async (gesture) => {
        await store.batch({
          ...gesture,
          writes: gesture.writes.map((write) => ({ ...write, collection: 'intentions' as const })),
        });
      },
      undo: async () => { await store.history.undo(); },
      redo: async () => { await store.history.redo(); },
    },
  };
}
