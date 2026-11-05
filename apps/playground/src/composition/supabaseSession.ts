import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createSource, type Readable } from '@vibespa/core';
import type { AccountIdentity } from '../contracts/account';
import type { AccountAuth } from '../modules/account/contract';
import type { SupabaseConfig } from './supabaseConfig';

export interface SupabaseSession {
  readonly client: SupabaseClient;
  /** Undefined until the stored session has been read; null when signed out. */
  readonly identity: Readable<AccountIdentity | null | undefined>;
  readonly auth: AccountAuth;
  dispose(): Promise<void>;
}

const sameIdentity = (left: AccountIdentity | null | undefined, right: AccountIdentity | null | undefined): boolean =>
  left === right || (!!left && !!right && left.userId === right.userId && left.email === right.email);

/** One page-lifetime auth client. Account generations come and go under it. */
export function createSupabaseSession(config: SupabaseConfig, options: {
  /** Where the magic link returns, for example this page with ?backend=supabase. */
  readonly redirectTo: string;
  /** Tests supply a controlled client. */
  readonly client?: SupabaseClient;
}): SupabaseSession {
  const client = options.client ?? createClient(config.url, config.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      // The link must be opened in the browser that requested it.
      flowType: 'pkce',
      storageKey: 'vibespa-playground-auth',
    },
  });
  const identity = createSource<AccountIdentity | null | undefined>(undefined, sameIdentity);
  // Keep this callback synchronous: awaiting Supabase calls inside it can
  // deadlock the client's auth lock.
  const { data } = client.auth.onAuthStateChange((_event, session) => {
    identity.set(session ? { userId: session.user.id, email: session.user.email ?? null } : null);
  });
  let disposal: Promise<void> | undefined;
  return {
    client,
    identity: identity.source,
    auth: {
      async requestLink(email) {
        const { error } = await client.auth.signInWithOtp({ email, options: { emailRedirectTo: options.redirectTo } });
        if (error) throw error;
      },
      async signOut() {
        const { error } = await client.auth.signOut();
        if (error) throw error;
      },
    },
    dispose() {
      disposal ??= (async () => {
        data.subscription.unsubscribe();
        await client.auth.stopAutoRefresh();
        await client.removeAllChannels();
      })();
      return disposal;
    },
  };
}
