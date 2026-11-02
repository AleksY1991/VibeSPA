import { FeatureType } from '@vibespa/contracts';
import { defineFeatureModule } from '@vibespa/core';
import type { LocalStorage, LocalStorageInputs } from './contract';

export const localStorageModule = defineFeatureModule<FeatureType.Store, LocalStorageInputs, LocalStorage>({
  id: 'local-storage',
  kind: FeatureType.Store,
  title: 'Local storage',
  description: 'Supplies IndexedDB persistence policy; Focus owns the live Solid records.',
  contract: {
    inputs: {
      name: 'The database identity owned by this application.',
      maximumTitleLength: 'The intention schema title length limit.',
    },
    exports: { adapter: 'Optional persistence adapter with restricted incoming admission.' },
  },
  load: () => import('./internal/runtime').then((module) => module.createLocalStorage),
});
