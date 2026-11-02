import { FeatureType } from '@vibespa/contracts';
import { dataPort, defineFeatureModule } from '@vibespa/core';
import { intentionsCapabilities, intentionsData } from './contract';
import type { IntentionsDataExports, IntentionsDataInputs } from './contract';

export const intentionsDataModule = defineFeatureModule<FeatureType.Data, IntentionsDataInputs, IntentionsDataExports>({
  id: 'intentions-data',
  kind: FeatureType.Data,
  title: 'Intentions data',
  description: 'Owns live Solid intention records and their optional backend delivery.',
  contract: {
    inputs: {
      adapter: 'Optional persistence or REST policy; the Data module retains mutation authority.',
      generation: 'Unique identity for this account or application lifetime.',
      titles: 'Validate admitted intention titles through the configured title policy.',
    },
    exports: { data: 'Reactive intention reads and commands that apply to local memory.' },
  },
  data: { provides: { data: dataPort(intentionsData, intentionsCapabilities) } },
  load: () => import('./internal/runtime').then(module => module.createIntentionsData),
});
