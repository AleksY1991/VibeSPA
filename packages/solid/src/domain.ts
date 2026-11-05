import { createSignal, createStore, flush, latest, reconcile, runWithOwner, snapshot } from 'solid-js';
import type { ModuleContext } from '@vibespa/core/module';
import { copyJson, freezePayload, readonlyView } from './domain/readonly.js';
import type {
  AdapterBatch, AdapterWrite, CommandIdentity, DeliveryState, DomainAdapter, DomainAdapterSession,
  DomainHistory, DomainOwner, DomainRow, DomainWrite, IncomingAdmission, IncomingChange,
  LocalReceipt, RowReceipt,
} from './domain/types.js';

export type * from './domain/types.js';

interface Change<Row> { readonly id: string; readonly before: Row | null; readonly after: Row | null }
interface Journal<Row> {
  readonly gestureId: string;
  readonly label: string;
  readonly changes: readonly Change<Row>[];
  readonly beforeTokens: readonly number[];
  readonly afterToken: number;
}
interface Pending<Row> { readonly identity: CommandIdentity; readonly label: string; writes: AdapterWrite<Row>[] }

/** One module-private Solid store owns all domain records. This is an explicit
 * local-first policy: synchronous local application, FIFO delivery, failed head
 * blocks delivery, explicit retry, whole-row CAS conflicts keep local intent.
 * Keep this owner private and export only view + scope.commands(...).
 */
export function createSolidDomain<Row extends DomainRow>(scope: ModuleContext, options: {
  readonly generation: string;
  readonly adapter?: DomainAdapter<Row>;
  readonly validate?: (value: unknown) => value is Row;
  readonly historyLimit?: number;
}): DomainOwner<Row> {
  if (!options.generation.trim()) throw new Error('A unique session generation is required.');
  const limit = options.historyLimit ?? 100;
  if (!Number.isInteger(limit) || limit < 0) throw new Error('historyLimit must be a nonnegative integer.');
  const adapter = options.adapter;
  const [state, setState] = scope.run(() => createStore({ rows: [] as Row[] }));
  const [delivery, setDelivery] = scope.run(() => createSignal<DeliveryState>(() => Object.freeze({
    phase: adapter ? 'loading' : 'memory', pending: 0, error: null,
  }), { ownedWrite: true }));
  const [history, setHistory] = scope.run(() => createSignal<DomainHistory>(() => Object.freeze({ canUndo: false, canRedo: false }), { ownedWrite: true }));
  // Synchronization metadata only; these maps contain no domain records.
  const localRevisions = new Map<string, number>();
  const remoteVersions = new Map<string, number>();
  // A refused push is a reason to refetch, not a retained second domain record.
  const dirtyVersions = new Map<string, number>();
  // Logical history positions differ from monotonic delivery revisions: undo
  // restores a prior history position, while receipts still guard latest edits.
  const historyTokens = new Map<string, number>();
  const pending: Pending<Row>[] = [];
  const past: Journal<Row>[] = [];
  const future: Journal<Row>[] = [];
  const seen = new Set<string>();
  // Command identities are metadata, retained for this session's echo checks.
  const identities = new Map<number, CommandIdentity>();
  let revision = 0;
  let sequence = 0;
  let loadAttempt = 0;
  let refreshAttempt = 0;
  let session: DomainAdapterSession<Row> | undefined;
  let loaded = !adapter;
  let running = false;
  let failed = false;
  let rebase = false;
  let work = Promise.resolve();

  const assertActive = (): void => { scope.signal.throwIfAborted(); };
  // This is the imperative command/admission seam. Publish one complete local
  // gesture synchronously so the next command reads Solid's committed state,
  // rather than introducing a second domain memory store for queued edits.
  const publishLocal = (): void => { runWithOwner(null, () => { flush(); }); };
  const publish = (phase: DeliveryState['phase'], error: string | null = null): void => {
    if (!scope.signal.aborted) setDelivery(Object.freeze({ phase, pending: pending.length, error }));
  };
  const publishHistory = (): void => { setHistory(Object.freeze({ canUndo: past.length > 0, canRedo: future.length > 0 })); };
  const rowAt = (id: string): Row | null => latest(() => {
    const row = state.rows.find(value => value.id === id);
    return row ? copyJson(snapshot(row)) : null;
  });
  const validate = (value: Row, id: string): Row => {
    const row = copyJson(value);
    if (row === null || typeof row !== 'object' || typeof row.id !== 'string' || !row.id || row.id !== id
      || (options.validate && !options.validate(row))) throw new TypeError(`Invalid domain row: ${id}`);
    return row;
  };
  const validVersion = (value: number): boolean => Number.isSafeInteger(value) && value > 0;
  const apply = (changes: readonly { readonly id: string; readonly after: Row | null }[]): void => {
    // A command has a module owner for resource creation, but Solid 2 forbids
    // store setters during owned computation. This synchronous write creates no
    // reactive children; admission stays with the private owner above it.
    runWithOwner(null, () => setState(draft => {
      for (const change of changes) {
        const index = draft.rows.findIndex(row => row.id === change.id);
        if (change.after === null) { if (index >= 0) draft.rows.splice(index, 1); }
        else if (index < 0) draft.rows.push(copyJson(change.after));
        else reconcile(copyJson(change.after))(draft.rows[index]!);
      }
    }));
  };
  const ownsPending = (id: string): boolean => pending.some(batch => batch.writes.some(write => write.id === id));
  const sameIdentity = (left: CommandIdentity, right: CommandIdentity): boolean =>
    left.generation === right.generation && left.sequence === right.sequence
      && left.gestureId === right.gestureId && left.origin === right.origin;

  // This closure is the adapter's only mutation capability. Validate complete
  // payloads before application, filter echoes/stale versions, and refuse rows
  // with local pending intent. Refusals are explicit and never become commands.
  const receive = (change: IncomingChange<Row>): IncomingAdmission => {
    const ids = change.rows.map(row => row.id);
    if (scope.signal.aborted || change.generation !== options.generation) return { accepted: [], refused: ids };
    if (!change.changeId || !['adapter', 'hydration'].includes(change.origin)) throw new TypeError('Invalid incoming identity.');
    if (change.command?.generation === options.generation) {
      const known = identities.get(change.command.sequence);
      if (known && sameIdentity(known, change.command)) return { accepted: [], refused: [] };
      throw new Error('Unknown own-command echo.');
    }
    if (seen.has(change.changeId)) return { accepted: [], refused: [] };
    if (new Set(ids).size !== ids.length) throw new Error('Incoming batch contains duplicate row ids.');
    const rows = change.rows.map(row => {
      if (!row.id || !validVersion(row.version)) throw new TypeError('Invalid incoming revision.');
      return { ...row, document: row.document === null ? null : validate(row.document, row.id) };
    });
    const accepted = rows.filter(row => row.version > (remoteVersions.get(row.id) ?? 0) && !ownsPending(row.id));
    const conflicting = rows.filter(row => row.version > (remoteVersions.get(row.id) ?? 0) && ownsPending(row.id));
    const refused = conflicting.map(row => row.id);
    for (const row of conflicting) dirtyVersions.set(row.id, Math.max(dirtyVersions.get(row.id) ?? 0, row.version));
    scope.run(() => {
      if (accepted.length) {
        apply(accepted.map(row => ({ id: row.id, after: row.document })));
        revision++;
        for (const row of accepted) {
          remoteVersions.set(row.id, row.version);
          localRevisions.set(row.id, revision);
          historyTokens.set(row.id, revision);
        }
      }
      for (const row of rows) {
        if ((remoteVersions.get(row.id) ?? 0) >= (dirtyVersions.get(row.id) ?? Infinity)) dirtyVersions.delete(row.id);
      }
      if (refused.length) publish('failed', `Incoming changes conflict with pending local edits: ${refused.join(', ')}`);
    });
    // Refused payloads can be retried; only remember fully handled changes.
    if (!refused.length) {
      seen.add(change.changeId);
      if (seen.size > 256) seen.delete(seen.values().next().value!);
    }
    publishLocal();
    return { accepted: accepted.map(row => row.id), refused };
  };

  function admitReceipt(batch: AdapterBatch<Row>, receipts: readonly RowReceipt<Row>[]): void {
    if (receipts.length !== batch.writes.length || new Set(receipts.map(row => row.id)).size !== receipts.length
      || receipts.some(row => !batch.writes.some(write => write.id === row.id))) throw new Error('Invalid adapter receipt row set.');
    const checked = receipts.map(receipt => {
      if (!receipt.ok) return receipt;
      const sent = batch.writes.find(row => row.id === receipt.id)!;
      if (!validVersion(receipt.version) || receipt.version <= sent.expectedVersion) throw new Error('Invalid adapter receipt version.');
      return { ...receipt, document: receipt.document === null ? null : validate(receipt.document, receipt.id) };
    });
    const head = pending[0]!;
    const accepted = checked.filter(row => row.ok);
    const normalized: { id: string; after: Row | null }[] = [];
    const adopted: string[] = [];
    for (const row of accepted) {
      remoteVersions.set(row.id, row.version);
      const sent = batch.writes.find(write => write.id === row.id)!;
      // Acknowledging an older edit must not overwrite a newer local edit.
      if (!scope.signal.aborted && localRevisions.get(row.id) === sent.localRevision
        && (dirtyVersions.get(row.id) ?? 0) <= row.version) {
        normalized.push({ id: row.id, after: row.document });
        if (row.adopted) adopted.push(row.id);
      }
      if ((dirtyVersions.get(row.id) ?? Infinity) <= row.version) dirtyVersions.delete(row.id);
    }
    if (normalized.length && !scope.signal.aborted) {
      scope.run(() => { apply(normalized); });
      if (adopted.length) {
        // An adopted durable row replaced the proposal. Treat it like an
        // external revision so undo/redo cannot write the refused value back.
        revision++;
        for (const id of adopted) { localRevisions.set(id, revision); historyTokens.set(id, revision); }
      }
    }
    head.writes = head.writes.filter(write => !accepted.some(row => row.id === write.id));
    if (!head.writes.length) pending.shift();
    if (!scope.signal.aborted) publishLocal();
    const rejected = checked.filter(row => !row.ok);
    if (rejected.length) throw new Error(rejected.map(row => `${row.id}: ${row.error}`).join('; '));
  }

  async function pump(): Promise<void> {
    try {
      if (!session) session = await scope.acquire(() => adapter!.open({ generation: options.generation, signal: scope.signal, receive }), resource => resource.close());
      if (rebase) {
        // This path requires a separate, intentional keepLocal call. A normal
        // retry preserves the original CAS baseline and idempotency identity.
        const rows = await session.load();
        assertActive();
        const versions = new Map<string, number>();
        for (const row of rows) {
          if (!validVersion(row.version) || !row.id || versions.has(row.id)) throw new Error('Invalid rebase version payload.');
          if (row.document !== null) validate(row.document, row.id);
          versions.set(row.id, row.version);
        }
        for (let index = 0; index < pending.length; index++) {
          const batch = pending[index]!;
          for (const write of batch.writes) remoteVersions.set(write.id, versions.get(write.id) ?? 0);
          const identity: CommandIdentity = Object.freeze({ ...batch.identity, sequence: ++sequence, origin: 'rebase' });
          identities.set(identity.sequence, identity);
          pending[index] = { ...batch, identity };
        }
        rebase = false;
      }
      if (!loaded) {
        const rows = await session.load();
        assertActive();
        receive({ generation: options.generation, origin: 'hydration', changeId: `hydrate:${++loadAttempt}`, rows });
        loaded = true;
      }
      while (pending.length || dirtyVersions.size) {
        assertActive();
        if (!pending.length) {
          // A foreign writer can change a row after our save accepted but
          // before its receipt arrived. Refused pushes must not disappear when
          // that receipt clears the queue. Reload through the same owner port.
          const rows = await session.load();
          assertActive();
          receive({ generation: options.generation, origin: 'adapter', changeId: `refresh:${++refreshAttempt}`, rows });
          if ([...dirtyVersions.keys()].some(id => !ownsPending(id))) {
            throw new Error('The adapter has not supplied the latest refused incoming revisions. Retry to refresh.');
          }
          continue;
        }
        const head = pending[0]!;
        // Refresh CAS baselines after preceding receipts, never infer commands
        // from a reactive effect. The payload is a bounded immutable handoff.
        const batch: AdapterBatch<Row> = freezePayload(copyJson({ identity: head.identity, label: head.label,
          writes: head.writes.map(write => ({ ...write, expectedVersion: remoteVersions.get(write.id) ?? 0 })) }));
        publish('saving');
        const receipt = await session.save(batch);
        if (!sameIdentity(batch.identity, receipt.identity)) throw new Error('Adapter receipt identity does not match the submitted command.');
        admitReceipt(batch, receipt.rows);
      }
      failed = false;
      publish('idle');
    } catch (error: unknown) {
      failed = true;
      publish('failed', error instanceof Error ? error.message : String(error));
    }
  }

  function launch(): void {
    if (!adapter || running || failed || scope.signal.aborted) return;
    running = true;
    work = scope.task(pump).finally(() => {
      running = false;
      if (pending.length && !failed && !scope.signal.aborted) launch();
    });
    // pump contains adapter failures. Cancellation before task entry is also a
    // status outcome; no detached rejection may escape the module lifetime.
    work = work.catch((error: unknown) => { failed = true; publish('failed', String(error)); });
  }

  function applyLocal(gestureId: string, label: string, changes: readonly Change<Row>[], origin: CommandIdentity['origin']): LocalReceipt {
    assertActive();
    const identity: CommandIdentity = Object.freeze({ generation: options.generation, sequence: ++sequence, gestureId, origin });
    identities.set(identity.sequence, identity);
    revision++;
    scope.run(() => { apply(changes); });
    for (const change of changes) { localRevisions.set(change.id, revision); historyTokens.set(change.id, revision); }
    if (adapter && changes.length) {
      pending.push({ identity, label, writes: changes.map(change => ({ id: change.id, document: copyJson(change.after),
        localRevision: revision, expectedVersion: remoteVersions.get(change.id) ?? 0 })) });
      publish(failed ? 'failed' : loaded ? 'saving' : 'loading', failed ? delivery().error : null);
    }
    return Object.freeze({ identity, revision, applied: Object.freeze(changes.map(change => change.id)) });
  }

  const owner: DomainOwner<Row> = {
    view: Object.freeze({ rows: readonlyView(state.rows), delivery: () => latest(delivery), history: () => latest(history) }),
    commit(gesture) {
      assertActive();
      if (!gesture.gestureId.trim() || !gesture.label.trim()) throw new Error('A gesture identity and label are required.');
      // Validate/coalesce the entire gesture before touching state. Last write
      // to a row wins within a batch; failure rejects the whole local gesture.
      const writes: DomainWrite<Row>[] = [];
      for (const write of gesture.writes) {
        const id = write.kind === 'put' ? write.document.id : write.id;
        if (typeof id !== 'string' || !id) throw new TypeError('A row id is required.');
        const admitted: DomainWrite<Row> = write.kind === 'put' ? { kind: 'put', document: validate(write.document, id) } : { kind: 'delete', id };
        const index = writes.findIndex(item => (item.kind === 'put' ? item.document.id : item.id) === id);
        if (index < 0) writes.push(admitted); else writes[index] = admitted;
      }
      const changes = writes.map(write => {
        const id = write.kind === 'put' ? write.document.id : write.id;
        return { id, before: rowAt(id), after: write.kind === 'put' ? write.document : null };
      }).filter(change => JSON.stringify(change.before) !== JSON.stringify(change.after));
      const beforeTokens = changes.map(change => historyTokens.get(change.id) ?? 0);
      const receipt = applyLocal(gesture.gestureId, gesture.label, changes, 'user');
      if (changes.length) {
        future.length = 0;
        past.push({ gestureId: gesture.gestureId, label: gesture.label, changes, beforeTokens, afterToken: receipt.revision });
        if (past.length > limit) past.shift();
        publishHistory();
      }
      try { publishLocal(); } finally { launch(); }
      return receipt;
    },
    undo: () => replay(past, future, 'undo'),
    redo: () => replay(future, past, 'redo'),
    retry() { assertActive(); failed = false; launch(); },
    keepLocal() {
      assertActive();
      if (running) throw new Error('Wait for the current delivery attempt before resolving conflicts.');
      rebase = true;
      failed = false;
      launch();
    },
    async settled() {
      // Joining a running attempt also includes gestures appended while saving.
      let attempt: Promise<void>;
      do { attempt = work; await attempt; } while (attempt !== work);
    },
  };

  function replay(from: Journal<Row>[], to: Journal<Row>[], origin: 'undo' | 'redo'): LocalReceipt | undefined {
    assertActive();
    const entry = from.at(-1);
    if (!entry) return undefined;
    if (entry.changes.some((change, index) => (historyTokens.get(change.id) ?? 0) !== (origin === 'undo' ? entry.afterToken : entry.beforeTokens[index]))) {
      throw new Error('History conflict: a row changed after this gesture.');
    }
    const changes = entry.changes.map(change => ({ id: change.id, before: rowAt(change.id), after: origin === 'undo' ? change.before : change.after }));
    const receipt = applyLocal(entry.gestureId, entry.label, changes, origin);
    from.pop();
    to.push(entry);
    entry.changes.forEach((change, index) => { historyTokens.set(change.id, origin === 'undo' ? entry.beforeTokens[index]! : entry.afterToken); });
    publishHistory();
    try { publishLocal(); } finally { launch(); }
    return receipt;
  }

  const closed = (): void => { setDelivery(Object.freeze({ phase: 'closed', pending: pending.length, error: delivery().error })); };
  scope.signal.addEventListener('abort', closed, { once: true });
  scope.defer(() => {
    scope.signal.removeEventListener('abort', closed);
    if (pending.length) throw new Error(`Session ended with ${pending.length} undelivered accepted gesture(s).`);
  });
  if (adapter) launch();
  return Object.freeze(owner);
}
