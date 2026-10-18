import { FeatureType } from '@vibespa/contracts';
import { defineFeatureModule } from '@vibespa/core';
import type { TitlePolicy, TitlePolicyInputs } from './contract';

export const titlePolicyModule = defineFeatureModule<FeatureType.Policy, TitlePolicyInputs, TitlePolicy>({
  id: 'title-policy',
  kind: FeatureType.Policy,
  title: 'Title policy',
  description: 'Normalizes intention titles and enforces their length.',
  contract: {
    inputs: { maximumLength: 'The maximum number of characters in a normalized title.' },
    exports: { validate: 'Validate a proposed title without reading or changing storage.' },
  },
  load: () => import('./internal/runtime').then((module) => module.createTitlePolicy),
});
