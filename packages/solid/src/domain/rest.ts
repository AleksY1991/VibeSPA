import type {
  AdapterBatch, AdapterContext, DomainAdapter, DomainRow, IncomingAdmission,
  IncomingChange, RemoteRow, SaveReceipt,
} from './types.js';

export interface RestRequest {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: unknown;
}

export interface RestResponse {
  readonly status: number;
  readonly body: unknown;
}

/** Inject fetch, authentication and endpoint policy in composition. Tests can
 * supply this exact transport without a browser, server or account. */
export type RestTransport = (request: RestRequest, signal: AbortSignal) => Promise<RestResponse>;

export interface RestDomainAdapterOptions<Row> {
  readonly endpoint: string;
  readonly transport: RestTransport;
  /** Optional push/SSE source. It only gets the restricted admission port. */
  readonly subscribe?: (context: AdapterContext<Row>) => () => void;
  readonly onRefused?: (change: IncomingChange<Row>, admission: IncomingAdmission) => void;
}

/** Thin JSON REST connector. GET returns RemoteRow[]; POST /commands returns a
 * SaveReceipt. The server implements version CAS and per-row idempotency from
 * AdapterBatch.identity. This connector owns no entity cache or retry engine. */
export function createRestDomainAdapter<Row extends DomainRow>(
  options: RestDomainAdapterOptions<Row>,
): DomainAdapter<Row> {
  const endpoint = options.endpoint.replace(/\/$/, '');
  if (!endpoint) throw new Error('A REST adapter requires an endpoint.');
  return {
    async open(context) {
      context.signal.throwIfAborted();
      let closed = false;
      let stop: (() => void) | undefined;
      const assertOpen = (): void => {
        context.signal.throwIfAborted();
        if (closed) throw new Error('This REST adapter session is closed.');
      };
      const close = (): void => {
        if (closed) return;
        closed = true;
        context.signal.removeEventListener('abort', close);
        stop?.();
      };
      const request = async (input: RestRequest): Promise<unknown> => {
        assertOpen();
        const response = await options.transport(input, context.signal);
        assertOpen();
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`REST ${input.method} ${input.path} failed (${response.status}).`);
        }
        return response.body;
      };
      try {
        stop = options.subscribe?.({
          generation: context.generation,
          signal: context.signal,
          receive(change) {
            if (closed || context.signal.aborted) return { accepted: [], refused: change.rows.map(row => row.id) };
            const admission = context.receive(change);
            if (admission.refused.length) options.onRefused?.(change, admission);
            return admission;
          },
        });
        context.signal.addEventListener('abort', close, { once: true });
        assertOpen();
      } catch (error) {
        close();
        throw error;
      }
      return {
        load: async () => await request({ method: 'GET', path: endpoint }) as readonly RemoteRow<Row>[],
        save: async (batch: AdapterBatch<Row>) => await request({
          method: 'POST', path: `${endpoint}/commands`, body: batch,
        }) as SaveReceipt<Row>,
        close,
      };
    },
  };
}
