import { createRxDatabase } from 'rxdb';
import type { RxCollection, RxJsonSchema } from 'rxdb';
import { getRxStorageDexie } from 'rxdb/plugins/storage-dexie';
import { wrappedValidateAjvStorage } from 'rxdb/plugins/validate-ajv';
import { createSource, mapReadable } from '@vibespa/core/readable';
import type { ModuleContext } from '@vibespa/core/module';
import { createRxCollectionDomainAdapter } from '@vibespa/local-first/collection-adapter';
import { moduleAccessor } from '@vibespa/solid/module';
import { syncSupabaseCollections } from '@vibespa/supabase/collections';
import type { ReplacementNotice, SyncStatus } from '../../../contracts/account';
import type { Intention } from '../../../contracts/focus';
import type { SupabaseStorage, SupabaseStorageInputs } from '../contract';

type Collections = { intentions: RxCollection<Intention> };

function intentionSchema(maximumTitleLength: number): RxJsonSchema<Intention> {
  // Exactly the domain fields. Server-only columns (owner_id, _modified) are
  // stripped by replication and never reach RxDB or the Solid owner.
  return {
    title: 'An intention',
    version: 0,
    primaryKey: 'id',
    type: 'object',
    properties: {
      id: { type: 'string', maxLength: 100 },
      title: { type: 'string', maxLength: maximumTitleLength },
      done: { type: 'boolean' },
    },
    required: ['id', 'title', 'done'],
    additionalProperties: false,
  };
}

const sameStatus = (left: SyncStatus, right: SyncStatus): boolean => left.phase === right.phase
  && left.active === right.active && left.initialSyncComplete === right.initialSyncComplete && left.error === right.error;
const describe = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return 'Supabase replication failed.';
};

export async function createSupabaseStorage(inputs: SupabaseStorageInputs, scope: ModuleContext): Promise<SupabaseStorage> {
  // The database cleanup is registered first, so replication (registered next
  // in this scope) cancels before the database closes.
  const database = await scope.acquire(
    () => createRxDatabase<Collections>({
      name: inputs.databaseName,
      storage: wrappedValidateAjvStorage({ storage: inputs.storage ?? getRxStorageDexie() }),
      multiInstance: inputs.multiInstance,
    }),
    async opened => { await opened.close(); },
  );
  await database.addCollections({ intentions: { schema: intentionSchema(inputs.maximumTitleLength) } });
  scope.signal.throwIfAborted();

  const replaced = createSource<ReplacementNotice | null>(null);
  const noteReplacement = (): void => { replaced.update(notice => ({ count: (notice?.count ?? 0) + 1 })); };
  const sync = await syncSupabaseCollections<{ intentions: Intention }>({
    collections: { intentions: database.intentions },
    scope,
    accountId: inputs.accountId,
    client: inputs.client,
    namespace: 'vibespa-playground',
    tables: [{ collection: 'intentions', tableName: 'intentions', serverColumns: ['owner_id'] }],
    // A push the server refused: the stock handler keeps the server row.
    onConflict: noteReplacement,
  });
  scope.signal.throwIfAborted();

  const adapter = createRxCollectionDomainAdapter<Intention>({
    collection: database.intentions,
    // A proposal refused locally because a newer durable row arrived first.
    onAdopted: noteReplacement,
    onIncomingError: error => { console.error('Unable to admit a synchronized intention.', error); },
  });
  const status = mapReadable(sync.status, (value): SyncStatus => ({
    phase: value.phase,
    active: value.active,
    initialSyncComplete: value.initialSyncComplete,
    error: value.errors[0] ? describe(value.errors[0].error) : null,
  }), sameStatus);
  const commands = scope.commands({
    async dismiss() {
      replaced.set(null);
      return { ok: true as const };
    },
  });
  return {
    adapter,
    sync: {
      status: moduleAccessor(scope, status, { name: 'supabase.status', equals: sameStatus }),
      replaced: moduleAccessor(scope, replaced.source, { name: 'supabase.replaced' }),
      commands,
    },
  };
}
