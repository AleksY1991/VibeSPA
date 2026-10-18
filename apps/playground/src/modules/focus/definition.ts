import { FeatureType } from '@vibespa/contracts';
import { defineFeatureModule } from '@vibespa/core';
import type { Focus, FocusInputs } from './contract';

export const focusModule = defineFeatureModule<FeatureType.Feature, FocusInputs, Focus>({
  id: 'focus',
  kind: FeatureType.Feature,
  title: 'Focus',
  description: 'Owns intention commands and exposes narrow read capabilities.',
  contract: {
    inputs: {
      repository: 'Read intentions and write one durable gesture at a time.',
      titles: 'Validate titles through the title policy contract.',
      createId: 'Create identities for intentions and gestures.',
    },
    exports: {
      pending: 'Observe pending intentions.',
      completed: 'Observe completed intentions.',
      history: 'Observe undo and redo availability.',
      commands: 'Add, toggle, remove, complete, undo and redo intentions.',
    },
  },
  load: () => import('./internal/runtime').then((module) => module.createFocus),
});
