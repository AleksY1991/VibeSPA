import { createRestDomainAdapter } from '@vibespa/solid/domain-rest';
import type { RestRequest, RestTransport } from '@vibespa/solid/domain-rest';
import type { AdapterBatch, RemoteRow, RowReceipt, SaveReceipt } from '@vibespa/solid/domain';
import type { Intention } from '../contracts/focus';

/** A controlled in-process SERVER fixture for the runnable REST example.
 * Its records represent the remote endpoint, not a second client domain store.
 * The REST connector itself has no domain cache. Reloading creates a fresh
 * server fixture; the IndexedDB mode is the persistent example. */
export function createDemoRestBackend(options: {
  readonly latencyMs?: number;
  readonly initial?: readonly Intention[];
} = {}) {
  const records: RemoteRow<Intention>[] = (options.initial ?? []).map(document => ({
    id: document.id, version: 1, document: structuredClone(document),
  }));
  const receipts: { key: string; receipt: RowReceipt<Intention> }[] = [];
  const requests: RestRequest[] = [];
  let offline = false;
  const transport: RestTransport = async (request, signal) => {
    const input = structuredClone(request);
    requests.push(input);
    if (options.latencyMs) await new Promise(resolve => { setTimeout(resolve, options.latencyMs); });
    signal.throwIfAborted();
    if (offline) throw new Error('The controlled REST server is offline.');
    if (input.method === 'GET' && input.path === '/demo/intentions') {
      return { status: 200, body: structuredClone(records) };
    }
    if (input.method !== 'POST' || input.path !== '/demo/intentions/commands') return { status: 404, body: null };
    const batch = input.body as AdapterBatch<Intention>;
    const result: SaveReceipt<Intention> = {
      identity: batch.identity,
      rows: batch.writes.map(write => {
        const key = JSON.stringify([batch.identity.generation, batch.identity.sequence, write.id]);
        const replay = receipts.find(receipt => receipt.key === key);
        if (replay) return replay.receipt;
        const index = records.findIndex(row => row.id === write.id);
        const previous = records[index];
        if ((previous?.version ?? 0) !== write.expectedVersion) {
          return { id: write.id, ok: false, error: 'The remote row changed. Resolve the version conflict explicitly.' };
        }
        const accepted: RowReceipt<Intention> = {
          id: write.id, ok: true, version: write.expectedVersion + 1, document: write.document,
        };
        const remote: RemoteRow<Intention> = { id: write.id, version: accepted.version, document: write.document };
        if (index < 0) records.push(remote);
        else records[index] = remote;
        receipts.push({ key, receipt: accepted });
        // Bounded demo server receipt retention. Production servers must define
        // their own idempotency retention and account/session policy.
        if (receipts.length > 1000) receipts.shift();
        return accepted;
      }),
    };
    return { status: 200, body: structuredClone(result) };
  };
  return {
    adapter: createRestDomainAdapter<Intention>({ endpoint: '/demo/intentions', transport }),
    requests: requests as readonly RestRequest[],
    setOffline(value: boolean) { offline = value; },
    read: (): readonly RemoteRow<Intention>[] => structuredClone(records),
  };
}
