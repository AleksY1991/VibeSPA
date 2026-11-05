import type { System } from '@vibespa/core';
import { createSolidSystem } from '@vibespa/solid/module';
import { createSupabaseApplication, supabaseApplicationModules, type SupabaseApplication } from './createSupabaseApplication';
import { startAccountGenerations } from './startAccountGenerations';
import { startApplication, type RunningApplication } from './startApplication';
import type { ApplicationGeneration } from './startApplicationGeneration';
import type { SupabaseConfig } from './supabaseConfig';
import { createSupabaseSession, type SupabaseSession } from './supabaseSession';

/** The Supabase backend: one page-lifetime auth client, one system per account. */
export function startSupabasePlayground(options: {
  readonly config: SupabaseConfig;
  readonly redirectTo: string;
  readonly previous?: ApplicationGeneration;
  /** Owns one system's inspector and lifetime, as for the other backends. */
  startGeneration(system: System, previous: ApplicationGeneration | undefined, start: () => RunningApplication): ApplicationGeneration;
  mount(application: SupabaseApplication): () => void;
  /** Tests supply a controlled session. */
  readonly session?: SupabaseSession;
}): ApplicationGeneration {
  const session = options.session ?? createSupabaseSession(options.config, { redirectTo: options.redirectTo });
  const generations = startAccountGenerations({
    identity: session.identity,
    previous: options.previous,
    start(identity, previous) {
      const system = createSolidSystem({ id: 'playground', modules: supabaseApplicationModules });
      return options.startGeneration(system, previous, () => startApplication(
        () => createSupabaseApplication(system, { client: session.client, auth: session.auth, identity }),
        options.mount,
      ));
    },
  });
  let disposal: Promise<void> | undefined;
  return {
    ready: generations.ready,
    dispose() {
      disposal ??= (async () => {
        await generations.dispose();
        await session.dispose();
      })();
      return disposal;
    },
  };
}
