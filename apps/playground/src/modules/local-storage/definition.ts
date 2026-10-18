import { FeatureType } from '@vibespa/contracts';
import { defineFeatureModule } from '@vibespa/core';
import type { LocalStorage, LocalStorageInputs } from './contract';

export const localStorageModule = defineFeatureModule<FeatureType.Store, LocalStorageInputs, LocalStorage>({
  id: 'local-storage',
  kind: FeatureType.Store,
  title: 'Local storage',
  description: 'Owns IndexedDB persistence, native queries and gesture history.',
  contract: {
    inputs: {
      name: 'The database identity owned by this application.',
      maximumTitleLength: 'The intention schema title length limit.',
    },
    exports: { repository: 'Intention reads, batch writes and undo/redo capabilities.' },
  },
  load: () => import('./internal/runtime').then((module) => module.createLocalStorage),
});
