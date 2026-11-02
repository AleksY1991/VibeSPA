import { FeatureType } from '@vibespa/contracts';
import { dataPort, defineFeatureModule } from '@vibespa/core';
import { intentionsCapabilities, intentionsData } from '../intentions-data/contract';
import type { Focus, FocusInputs } from './contract';

export const focusModule = defineFeatureModule<FeatureType.Feature, FocusInputs, Focus>({
  id: 'focus',
  kind: FeatureType.Feature,
  title: 'Focus',
  description: 'Owns intention commands and exposes narrow read capabilities.',
  contract: {
    inputs: {
      data: 'Live intentions and local-application commands from the Data module.',
      titles: 'Validate titles through the title policy contract.',
      createId: 'Create identities for intentions and gestures.',
    },
    exports: {
      pending: 'Observe pending intentions.',
      completed: 'Observe completed intentions.',
      history: 'Observe undo and redo availability.',
      delivery: 'Observe background loading, saving and failures independently of local commands.',
      commands: 'Edit locally, undo, redo, retry delivery or explicitly keep local rows over remote conflicts.',
    },
  },
  data: { requires: { data: dataPort(intentionsData, intentionsCapabilities) } },
  load: () => import('./internal/runtime').then((module) => module.createFocus),
});
