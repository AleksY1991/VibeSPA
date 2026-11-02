import { createRxDatabase } from 'rxdb';
import type { RxCollection, RxJsonSchema, RxStorage } from 'rxdb';
import { getRxStorageDexie } from 'rxdb/plugins/storage-dexie';
import { wrappedValidateAjvStorage } from 'rxdb/plugins/validate-ajv';
import type {
  AdapterBatch, AdapterWrite, CommandIdentity, DomainAdapter, DomainRow,
  IncomingAdmission, IncomingChange, RemoteRow, RowReceipt,
} from '@vibespa/solid/domain';

interface Envelope<Row> {
  id: string;
  version: number;
  document: Row | null;
  command: CommandIdentity;
}

export interface RxDbDomainAdapterOptions<Row> {
  readonly name: string;
  readonly schema: RxJsonSchema<Row>;
  readonly storage?: RxStorage<unknown, unknown>;
  readonly multiInstance?: boolean;
  /** An observer only. A refusal never grants the adapter mutation authority. */
  readonly onRefused?: (change: IncomingChange<Row>, admission: IncomingAdmission) => void;
}

const sameCommand = (left: CommandIdentity, right: CommandIdentity): boolean =>
  left.generation === right.generation && left.sequence === right.sequence
  && left.gestureId === right.gestureId && left.origin === right.origin;

function remote<Row>(row: { readonly id: string; readonly version: number; readonly document: unknown }): RemoteRow<Row> {
  // RxDB exposes deeply readonly JSON. The transport copy is admitted by the
  // domain owner, never passed through as a writable document reference.
  return { id: row.id, version: row.version, document: structuredClone(row.document) as Row | null };
}

class AlreadyAccepted<Row> extends Error {
  constructor(readonly row: Envelope<Row>) { super('This row already accepted this command.'); }
}

function envelopeSchema<Row>(schema: RxJsonSchema<Row>): RxJsonSchema<Envelope<Row>> {
  return {
    version: 0,
    primaryKey: 'id',
    type: 'object',
    properties: {
      id: { type: 'string', maxLength: 100 },
      version: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER, multipleOf: 1 },
      document: { anyOf: [{ type: 'null' }, {
        type: 'object', properties: schema.properties, required: schema.required,
        additionalProperties: schema.additionalProperties ?? false,
      }] },
      command: {
        type: 'object',
        properties: {
          generation: { type: 'string' }, sequence: { type: 'integer', minimum: 1 },
          gestureId: { type: 'string' }, origin: { type: 'string', enum: ['user', 'undo', 'redo', 'rebase'] },
        },
        required: ['generation', 'sequence', 'gestureId', 'origin'],
        additionalProperties: false,
      },
    },
    required: ['id', 'version', 'document', 'command'],
    additionalProperties: false,
  };
}

/** Thin persistence connector for a Solid-owned provider. RxDB owns only its
 * persistent envelope, version and last-command receipt. No RxDocument, query,
 * collection or database escapes. This is not a replication implementation.
 *
 * A row keeps its last accepted command as a bounded idempotency receipt. The
 * owner's ordered queue retries its head before advancing. Replay of arbitrarily
 * old commands after a later command is outside this adapter's contract. */
export function createRxDbDomainAdapter<Row extends DomainRow>(
  options: RxDbDomainAdapterOptions<Row>,
): DomainAdapter<Row> {
  return {
    async open(context) {
      context.signal.throwIfAborted();
      const database = await createRxDatabase<{ rows: RxCollection<Envelope<Row>> }>({
        name: options.name,
        storage: wrappedValidateAjvStorage({ storage: options.storage ?? getRxStorageDexie() }),
        multiInstance: options.multiInstance ?? false,
      });
      try {
        context.signal.throwIfAborted();
        await database.addCollections({ rows: { schema: envelopeSchema(options.schema), autoMigrate: false } });
        context.signal.throwIfAborted();
      } catch (error) {
        await database.close();
        throw error;
      }

      const collection = database.rows;
      let closed = false;
      let closing: Promise<void> | undefined;
      let saveTail: Promise<unknown> = Promise.resolve();
      const operations = new Set<Promise<unknown>>();
      const assertOpen = (): void => {
        context.signal.throwIfAborted();
        if (closed) throw new Error('This RxDB adapter session is closed.');
      };
      const track = <Result>(operation: Promise<Result>): Promise<Result> => {
        operations.add(operation);
        return operation.finally(() => { operations.delete(operation); });
      };
      const subscription = collection.$.subscribe(event => {
        if (closed || context.signal.aborted) return;
        const row = event.documentData;
        const change: IncomingChange<Row> = {
          generation: context.generation,
          changeId: `${row.id}:${row.version}`,
          origin: 'adapter',
          rows: [remote<Row>(row)],
          command: row.command,
        };
        const admission = context.receive(change);
        if (admission.refused.length) options.onRefused?.(change, admission);
      });
      const stop = (): void => { subscription.unsubscribe(); };
      context.signal.addEventListener('abort', stop, { once: true });

      const saveRow = async (batch: AdapterBatch<Row>, write: AdapterWrite<Row>): Promise<RowReceipt<Row>> => {
        try {
          assertOpen();
          let existing = await collection.findOne(write.id).exec();
          assertOpen();
          if (!existing) {
            if (write.expectedVersion !== 0) throw new Error(`Version conflict for ${write.id}.`);
            existing = await collection.insertIfNotExists({
              id: write.id, version: 1, document: structuredClone(write.document), command: { ...batch.identity },
            });
          }
          const prior = existing.toJSON();
          if (sameCommand(prior.command, batch.identity)) return { ...remote<Row>(prior), ok: true };
          const saved = await existing.incrementalModify((current: Envelope<Row>) => {
            assertOpen();
            if (sameCommand(current.command, batch.identity)) throw new AlreadyAccepted(current);
            if (current.version !== write.expectedVersion) throw new Error(`Version conflict for ${write.id}.`);
            return {
              ...current, version: current.version + 1,
              document: structuredClone(write.document), command: { ...batch.identity },
            };
          });
          return { ...remote<Row>(saved.toJSON()), ok: true };
        } catch (error) {
          if (error instanceof AlreadyAccepted) return { ...remote<Row>(error.row as Envelope<Row>), ok: true };
          return { id: write.id, ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      };

      return {
        load() {
          return track((async () => {
            assertOpen();
            const rows = await collection.find().exec();
            assertOpen();
            return rows.map(row => remote<Row>(row.toJSON()));
          })());
        },
        save(batch) {
          const saved = saveTail.then(async () => {
            assertOpen();
            const rows: RowReceipt<Row>[] = [];
            // No transaction is claimed: every row has an explicit receipt.
            for (const write of batch.writes) rows.push(await saveRow(batch, write));
            return { identity: batch.identity, rows };
          });
          saveTail = saved.catch(() => undefined);
          return track(saved);
        },
        close() {
          if (closing) return closing;
          closed = true;
          context.signal.removeEventListener('abort', stop);
          stop();
          closing = (async () => {
            await Promise.allSettled([...operations]);
            await database.close();
          })();
          return closing;
        },
      };
    },
  };
}
