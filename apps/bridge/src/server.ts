import {
  isConduitError,
  type AssetClass,
  type Schema,
} from '@conduit/core';
import type { ConduitClient, Subscription } from '@conduit/client';
import { LineReader, encodeBigints, parseRequest, type Request, type Response } from './protocol.js';

export interface BridgeOptions {
  readonly client: ConduitClient;
  /** Writes one response. Returns false when the consumer's pipe is full. */
  readonly write: (line: string) => boolean;
  readonly onShutdown?: () => void;
}

/**
 * Serves the bridge protocol against a ConduitClient. Transport-agnostic on purpose: the process
 * wires it to stdin and stdout, the tests wire it to arrays.
 */
export class BridgeServer {
  #client: ConduitClient;
  #write: (line: string) => boolean;
  #onShutdown: (() => void) | undefined;
  #reader = new LineReader();
  #subscriptions = new Map<number, Subscription>();
  #closed = false;

  constructor(options: BridgeOptions) {
    this.#client = options.client;
    this.#write = options.write;
    this.#onShutdown = options.onShutdown;
  }

  get openSubscriptions(): number {
    return this.#subscriptions.size;
  }

  ready(): void {
    const coverage: Record<string, readonly string[]> = {};
    for (const schema of ['quote_l1', 'trades', 'bars_1m', 'bars_1d', 'depth_10'] as const) {
      coverage[schema] = this.#client.coverage(schema);
    }
    // `synthetic` is on the ready frame so a consumer that opted in with CONDUIT_ALLOW_SYNTHETIC can
    // still tell, and can label or refuse the data itself.
    this.#send({
      type: 'ready',
      providers: this.#client.providers,
      coverage,
      synthetic: this.#client.synthetic,
    });
  }

  /** Feeds raw bytes in. Complete lines are handled; a partial line waits for its newline. */
  feed(chunk: string): void {
    for (const line of this.#reader.push(chunk)) {
      if (line.trim().length === 0) continue;
      const request = parseRequest(line);
      if ('error' in request) {
        // No id to echo, so report against 0 rather than dropping it silently.
        this.#send({ type: 'error', id: 0, code: 'bad_request', message: request.error });
        continue;
      }
      void this.#handle(request);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.all([...this.#subscriptions.values()].map((s) => s.close()));
    this.#subscriptions.clear();
    await this.#client.close();
  }

  #send(response: Response): void {
    this.#write(`${JSON.stringify(encodeBigints(response))}\n`);
  }

  #fail(id: number, error: unknown): void {
    this.#send({
      type: 'error',
      id,
      code: isConduitError(error) ? error.code : 'unknown',
      message: error instanceof Error ? error.message : String(error),
    });
  }

  async #handle(request: Request): Promise<void> {
    if (this.#closed) return;
    try {
      switch (request.op) {
        case 'summary': {
          const data = await this.#client.summary({
            symbols: request.symbols ?? [],
            ...(request.assetClass ? { assetClass: request.assetClass as AssetClass } : {}),
          });
          this.#send({ type: 'result', id: request.id, data });
          return;
        }
        case 'snapshot': {
          const data = await this.#client.snapshot({
            symbols: request.symbols ?? [],
            ...(request.assetClass ? { assetClass: request.assetClass as AssetClass } : {}),
          });
          this.#send({ type: 'result', id: request.id, data });
          return;
        }
        case 'health': {
          this.#send({ type: 'result', id: request.id, data: this.#client.health() });
          return;
        }
        case 'subscribe': {
          await this.#subscribe(request);
          return;
        }
        case 'unsubscribe': {
          const subscription = this.#subscriptions.get(request.id);
          if (!subscription) {
            this.#fail(request.id, new Error(`no subscription with id ${request.id}`));
            return;
          }
          this.#subscriptions.delete(request.id);
          await subscription.close();
          this.#send({ type: 'end', id: request.id });
          return;
        }
        case 'shutdown': {
          this.#send({ type: 'result', id: request.id, data: { closing: true } });
          await this.close();
          this.#onShutdown?.();
          return;
        }
      }
    } catch (error) {
      this.#fail(request.id, error);
    }
  }

  async #subscribe(request: Request): Promise<void> {
    if (this.#subscriptions.has(request.id)) {
      this.#fail(request.id, new Error(`id ${request.id} is already subscribed`));
      return;
    }

    const subscription = await this.#client.subscribe({
      symbols: request.symbols ?? [],
      schema: (request.schema ?? 'quote_l1') as Schema,
      ...(request.assetClass ? { assetClass: request.assetClass as AssetClass } : {}),
      ...(request.start ? { start: BigInt(request.start) } : {}),
      ...(request.end ? { end: BigInt(request.end) } : {}),
    });
    this.#subscriptions.set(request.id, subscription);
    // Acknowledge before any data, so the consumer knows the handle is live.
    this.#send({ type: 'result', id: request.id, data: { subscribed: true } });

    void (async () => {
      try {
        for await (const message of subscription) {
          if (this.#closed || !this.#subscriptions.has(request.id)) break;
          this.#send({ type: 'message', id: request.id, data: message });
        }
        if (this.#subscriptions.delete(request.id)) this.#send({ type: 'end', id: request.id });
      } catch (error) {
        this.#subscriptions.delete(request.id);
        this.#fail(request.id, error);
      }
    })();
  }
}
