import type { AccountIdentity, AccountView } from '../../contracts/account';

/** The narrow sign-in capability composition builds from its auth client. */
export interface AccountAuth {
  requestLink(email: string): Promise<void>;
  signOut(): Promise<void>;
}

export interface AccountInputs {
  readonly auth: AccountAuth;
  readonly identity: AccountIdentity | null;
}

export interface AccountExports {
  readonly account: AccountView;
}
