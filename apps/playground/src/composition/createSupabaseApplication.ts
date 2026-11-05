import type { SupabaseClient } from '@supabase/supabase-js';
import type { RxStorage } from 'rxdb';
import { external, from, type System } from '@vibespa/core';
import type { AccountIdentity, AccountView, SyncView } from '../contracts/account';
import type { FocusView } from '../contracts/focus';
import type { AccountAuth } from '../modules/account/contract';
import { accountModule } from '../modules/account/definition';
import { focusModule } from '../modules/focus/definition';
import { intentionsDataModule } from '../modules/intentions-data/definition';
import { supabaseStorageModule } from '../modules/supabase-storage/definition';
import { titlePolicyModule } from '../modules/title-policy/definition';
import { maximumTitleLength } from './createApplication';

/** The static Data plan for the Supabase backend. */
export const supabaseApplicationModules = [
  accountModule, supabaseStorageModule, titlePolicyModule, intentionsDataModule, focusModule,
] as const;

export interface SupabaseApplicationOptions {
  readonly client: SupabaseClient;
  readonly auth: AccountAuth;
  readonly identity: AccountIdentity | null;
  /** Tests inject memory storage; IndexedDB when omitted. */
  readonly storage?: RxStorage<unknown, unknown>;
  /** Defaults to true: tabs share one database and only the leader replicates. */
  readonly multiInstance?: boolean;
}

export interface SupabaseApplication {
  readonly account: AccountView;
  /** Present only while signed in. */
  readonly signedIn?: { readonly focus: FocusView; readonly sync: SyncView };
  dispose(): Promise<void>;
}

/** One account generation: sign-in only when signed out; otherwise the same
 * Focus composition persisted through a native RxDB collection that stock
 * replication keeps in sync with the account's Supabase rows. */
export async function createSupabaseApplication(system: System, options: SupabaseApplicationOptions): Promise<SupabaseApplication> {
  try {
    const account = await system.start(accountModule, {
      auth: external(options.auth),
      identity: external(options.identity),
    });
    const dispose = () => system.dispose();
    if (!options.identity) return { account: account.exports.account, dispose };
    const storage = await system.start(supabaseStorageModule, {
      client: external(options.client),
      accountId: external(options.identity.userId),
      databaseName: external(`vibespa-focus-supabase-${options.identity.userId}`),
      maximumTitleLength: external(maximumTitleLength),
      multiInstance: external(options.multiInstance ?? true),
      ...(options.storage ? { storage: external(options.storage) } : {}),
    });
    const titles = await system.start(titlePolicyModule, { maximumLength: external(maximumTitleLength) });
    const data = await system.start(intentionsDataModule, {
      adapter: from(storage, 'adapter'),
      generation: external(crypto.randomUUID()),
      titles: from(titles),
    });
    const focus = await system.start(focusModule, {
      data: from(data, 'data'),
      titles: from(titles),
      createId: external(() => `${Date.now()}-${crypto.randomUUID()}`),
    });
    return { account: account.exports.account, signedIn: { focus: focus.exports, sync: storage.exports.sync }, dispose };
  } catch (error) {
    try { await system.dispose(); }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Application startup and cleanup failed.', { cause: cleanupError });
    }
    throw error;
  }
}
