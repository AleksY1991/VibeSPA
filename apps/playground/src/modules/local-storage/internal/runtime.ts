import { createRxDbDomainAdapter } from '@vibespa/local-first/solid-adapter';
import type { Intention } from '../../../contracts/focus';
import type { LocalStorage, LocalStorageInputs } from '../contract';

export function createLocalStorage(inputs: LocalStorageInputs): LocalStorage {
  return {
    adapter: createRxDbDomainAdapter<Intention>({
      name: inputs.name,
      schema: {
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
    }),
  };
}
