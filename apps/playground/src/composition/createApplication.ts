import { external, from, type System } from '@vibespa/core';
import type { DomainAdapter } from '@vibespa/solid/domain';
import type { Intention } from '../contracts/focus';
import { focusModule } from '../modules/focus/definition';
import { intentionsDataModule } from '../modules/intentions-data/definition';
import { localStorageModule } from '../modules/local-storage/definition';
import { titlePolicyModule } from '../modules/title-policy/definition';

const maximumTitleLength = 140;

/** Inert definitions used to validate the complete Data graph before startup. */
export const applicationModules = [localStorageModule, titlePolicyModule, intentionsDataModule, focusModule] as const;

export interface ApplicationOptions {
  /** Omit for IndexedDB; null selects memory only. REST uses the same port. */
  readonly adapter?: DomainAdapter<Intention> | null;
  readonly storageName?: string;
}

export async function createApplication(system: System, options: ApplicationOptions = {}) {
  try {
    const storage = options.adapter === undefined ? await system.start(localStorageModule, {
      name: external(options.storageName ?? 'vibespa-focus-solid'),
      maximumTitleLength: external(maximumTitleLength),
    }) : undefined;
    const titles = await system.start(titlePolicyModule, { maximumLength: external(maximumTitleLength) });
    const data = await system.start(intentionsDataModule, {
      adapter: storage ? from(storage, 'adapter') : external(options.adapter ?? undefined),
      generation: external(crypto.randomUUID()),
      titles: from(titles),
    });
    const focus = await system.start(focusModule, {
      data: from(data, 'data'),
      titles: from(titles),
      createId: external(() => `${Date.now()}-${crypto.randomUUID()}`),
    });

    // Focus registers its commands with scope.commands: the system traces each
    // call by name without recording values, so no composition wrapper is needed.
    return { focus: focus.exports, dispose: () => system.dispose() };
  } catch (error) {
    try { await system.dispose(); }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Application startup and cleanup failed.', { cause: cleanupError });
    }
    throw error;
  }
}
