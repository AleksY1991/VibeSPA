import type { Accessor } from 'solid-js';

/** Domain rows are plain JSON records. The owner copies admitted payloads, never
 * the exposed collection. No functions, class instances or writable references. */
export interface DomainRow { readonly id: string }
export type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> } : T;

export type DomainWrite<Row> =
  | { readonly kind: 'put'; readonly document: Row }
  | { readonly kind: 'delete'; readonly id: string };

export interface CommandIdentity {
  readonly generation: string;
  readonly sequence: number;
  readonly gestureId: string;
  readonly origin: 'user' | 'undo' | 'redo' | 'rebase';
}

export interface RemoteRow<Row> {
  readonly id: string;
  /** Monotonic per row, including tombstones; supplied by the adapter. */
  readonly version: number;
  readonly document: Row | null;
}

export interface AdapterWrite<Row> {
  readonly id: string;
  readonly document: Row | null;
  readonly expectedVersion: number;
  readonly localRevision: number;
}

export interface AdapterBatch<Row> {
  readonly identity: CommandIdentity;
  readonly label: string;
  readonly writes: readonly AdapterWrite<Row>[];
}

export type RowReceipt<Row> =
  | { readonly id: string; readonly ok: true; readonly version: number; readonly document: Row | null }
  | { readonly id: string; readonly ok: false; readonly error: string };

export interface SaveReceipt<Row> {
  readonly identity: CommandIdentity;
  /** Exactly one receipt per submitted row. Partial acceptance is explicit. */
  readonly rows: readonly RowReceipt<Row>[];
}

export interface IncomingChange<Row> {
  readonly generation: string;
  readonly changeId: string;
  readonly origin: 'adapter' | 'hydration';
  readonly rows: readonly RemoteRow<Row>[];
  /** Echoes of this owner's commands are ignored; save receipts admit them. */
  readonly command?: CommandIdentity;
}

export interface IncomingAdmission {
  readonly accepted: readonly string[];
  readonly refused: readonly string[];
}

/** An adapter receives only this restricted admission port, never a setter or
 * writable domain collection. The owner validates and applies every payload. */
export interface AdapterContext<Row> {
  readonly generation: string;
  readonly signal: AbortSignal;
  receive(change: IncomingChange<Row>): IncomingAdmission;
}

export interface DomainAdapterSession<Row> {
  /** Bounded startup payload, including versioned tombstones. */
  load(): Promise<readonly RemoteRow<Row>[]>;
  /** Ordered, idempotent per (identity, row id). No whole-batch atomicity assumed.
   * Retry preserves identity; accepted rows must return their original receipt.
   * Conflicts reject explicitly. The owner never silently discards local edits. */
  save(batch: AdapterBatch<Row>): Promise<SaveReceipt<Row>>;
  close(): void | Promise<void>;
}

export interface DomainAdapter<Row> {
  open(context: AdapterContext<Row>): Promise<DomainAdapterSession<Row>>;
}

export interface DeliveryState {
  readonly phase: 'memory' | 'loading' | 'saving' | 'idle' | 'failed' | 'closed';
  readonly pending: number;
  readonly error: string | null;
}

export interface DomainHistory {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

/** Borrow these reads. Keep DomainOwner and its mutation methods private. */
export interface DomainView<Row> {
  readonly rows: readonly DeepReadonly<Row>[];
  readonly delivery: Accessor<DeliveryState>;
  readonly history: Accessor<DomainHistory>;
}

export interface LocalReceipt {
  readonly identity: CommandIdentity;
  readonly revision: number;
  /** Local admission/application only. Consult delivery for backend status. */
  readonly applied: readonly string[];
}

export interface DomainOwner<Row> {
  readonly view: DomainView<Row>;
  commit(gesture: { readonly gestureId: string; readonly label: string; readonly writes: readonly DomainWrite<Row>[] }): LocalReceipt;
  undo(): LocalReceipt | undefined;
  redo(): LocalReceipt | undefined;
  retry(): void;
  /** Explicit whole-row local-wins resolution: reload remote versions, preserve
   * local rows, and resubmit pending intent with new command identities. This
   * can overwrite concurrent remote fields. Ordinary retry never rebases. */
  keepLocal(): void;
  /** Current delivery attempt; failures are represented in delivery, not thrown.
   * Does not wait indefinitely for retry, or imply remote durability. */
  settled(): Promise<void>;
}
