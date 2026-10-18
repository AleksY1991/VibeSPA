import type { Readable, Scope } from '@vibespa/contracts';
import type { MangoQuery, RxJsonSchema, RxStorage } from 'rxdb';

export type CollectionName<Rows> = Extract<keyof Rows, string>;
export type RowMap<Rows> = { [Name in keyof Rows]: object };
export type StoreWrite<Rows extends RowMap<Rows>> = {
  [Name in CollectionName<Rows>]:
    | { readonly collection: Name; readonly kind: 'put'; readonly document: Rows[Name] }
    | { readonly collection: Name; readonly kind: 'delete'; readonly id: string }
}[CollectionName<Rows>];

export interface StoreOptions<Rows extends RowMap<Rows>> {
  /** Include the account identity in the name to keep replicas isolated. */
  readonly name: string;
  readonly schemas: { readonly [Name in keyof Rows]: RxJsonSchema<Rows[Name]> };
  readonly scope: Scope;
  /** Defaults to durable IndexedDB via Dexie. Storage engines stay in adapters. */
  readonly storage?: RxStorage<unknown, unknown>;
  readonly multiInstance?: boolean;
  /** Session history retains at most this many semantic gestures; defaults to 100. */
  readonly historyLimit?: number;
}

export interface BatchCommand<Rows extends RowMap<Rows>> {
  readonly gestureId: string;
  readonly label?: string;
  readonly writes: readonly StoreWrite<Rows>[];
  /** Machine maintenance can share the write gate without entering undo history. */
  readonly history?: 'include' | 'exclude';
}

export interface JournalChange {
  readonly collection: string;
  readonly id: string;
  readonly before: Readonly<object> | null;
  readonly after: Readonly<object> | null;
}

export interface JournalEntry {
  readonly gestureId: string;
  readonly label: string;
  readonly origin: 'command' | 'undo' | 'redo';
  readonly changes: readonly JournalChange[];
}

export interface HistoryState {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoLabel: string | null;
  readonly redoLabel: string | null;
}

export interface LocalStore<Rows extends RowMap<Rows>> {
  /** One native RxDB query, owned and released by this store's scope. */
  query<Name extends CollectionName<Rows>>(
    collection: Name, query?: MangoQuery<Rows[Name]>, scope?: Scope,
  ): Promise<Readable<readonly Readonly<Rows[Name]>[]>>;
  document<Name extends CollectionName<Rows>>(
    collection: Name, id: string, scope?: Scope,
  ): Promise<Readable<Readonly<Rows[Name]> | null>>;
  /** One explicit bulk write per collection. Collections are not one atomic transaction. */
  batch(command: BatchCommand<Rows>): Promise<JournalEntry>;
  readonly journal: { subscribe(listener: (entry: JournalEntry) => void): () => void };
  /** Bounded session history; reopening storage starts a new undo session. */
  readonly history: {
    readonly state: Readable<HistoryState>;
    undo(): Promise<JournalEntry | null>;
    redo(): Promise<JournalEntry | null>;
  };
  close(): Promise<void>;
}

/** A storage failure can follow successful writes in the same explicit batch. */
export class BatchWriteError extends AggregateError {
  constructor(readonly applied: JournalEntry, errors: readonly unknown[]) {
    super(errors, `Batch ${applied.gestureId} failed after ${applied.changes.length} successful row writes.`);
    this.name = 'BatchWriteError';
  }
}

/** Replay stops rather than overwriting a newer local or replicated value. */
export class HistoryConflictError extends Error {
  constructor(readonly collection: string, readonly id: string) {
    super(`Cannot replay history: ${collection}/${id} changed since that gesture.`);
    this.name = 'HistoryConflictError';
  }
}
