import { FeatureType } from '@vibespa/contracts';
import { defineFeatureModule } from '@vibespa/core';
import type { AccountExports, AccountInputs } from './contract';

export const accountModule = defineFeatureModule<FeatureType.Service, AccountInputs, AccountExports>({
  id: 'account',
  kind: FeatureType.Service,
  title: 'Account',
  description: 'Requests email sign-in links and signs out of the Supabase account.',
  contract: {
    inputs: {
      auth: 'Send a magic sign-in link or sign out; composition owns the auth client.',
      identity: 'The account this generation was opened for, or null when signed out.',
    },
    exports: { account: 'Observe sign-in link state and request a link or sign out.' },
  },
  load: () => import('./internal/runtime').then(module => module.createAccount),
});
