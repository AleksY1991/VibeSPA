interface Publications {
  depth: number;
  readonly pending: Map<object, () => void>;
  readonly settled: Promise<void>;
  readonly resolve: () => void;
}

const batches = new WeakMap<object, Publications>();

/** Whether local collection writes are withholding this database's publications. */
export function isRxBatchActive(database: object): boolean {
  return batches.has(database);
}

/** Hold the latest emission per binding until every nested local batch finishes. */
export function beginRxBatch(database: object): () => void {
  let batch = batches.get(database);
  if (!batch) {
    let resolve!: () => void;
    const settled = new Promise<void>(done => { resolve = done; });
    batch = { depth: 0, pending: new Map(), settled, resolve };
    batches.set(database, batch);
  }
  batch.depth++;
  const owner = batch;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--owner.depth > 0) return;
    batches.delete(database);
    const errors: unknown[] = [];
    try {
      for (const publish of owner.pending.values()) {
        try { publish(); } catch (error) { errors.push(error); }
      }
    } finally {
      owner.pending.clear();
      owner.resolve();
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'RxDB batch publications failed.');
  };
}

/** Publish immediately unless a local batch currently owns the database. */
export function publishRxValue(database: object, binding: object, publish: () => void): void {
  const batch = batches.get(database);
  if (batch) batch.pending.set(binding, publish);
  else publish();
}

/** Remove a disposed binding's queued publication. */
export function forgetRxPublication(database: object, binding: object): void {
  batches.get(database)?.pending.delete(binding);
}

/** Include another batch begun while an earlier batch was publishing. */
export async function waitForRxBatches(database: object): Promise<void> {
  while (batches.has(database)) await batches.get(database)!.settled;
}
