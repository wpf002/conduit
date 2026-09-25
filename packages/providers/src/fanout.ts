import { nowNs, type CdmMessage, type ControlMessage, type MarketMessage, type ProviderId, type Schema } from '@conduit/core';
import { AsyncQueue } from './queue.js';

export function schemaOf(message: MarketMessage): Schema {
  switch (message.kind) {
    case 'quote':
      return 'quote_l1';
    case 'trade':
      return 'trades';
    case 'bar':
      return message.interval === '1m' ? 'bars_1m' : 'bars_1d';
    case 'depth':
      return 'depth_10';
  }
}

interface Consumer {
  readonly schema: Schema;
  readonly symbols: ReadonlySet<string>;
  readonly queue: AsyncQueue<CdmMessage>;
}

/**
 * Tracks who is listening to what, routes each normalized message to the consumers that asked for
 * it, and works out which symbols nobody wants any more so the adapter can unsubscribe. Shared by
 * every websocket adapter; the wire protocol is all that differs between them.
 */
export class ConsumerSet {
  #consumers = new Set<Consumer>();

  get size(): number {
    return this.#consumers.size;
  }

  add(
    schema: Schema,
    symbols: readonly string[],
    highWaterMark: number,
    provider: ProviderId,
  ): Consumer {
    const symbolSet = new Set(symbols);
    // The queue tells the consumer when it is losing data. Announced on the consumer's own stream,
    // urgently, so the message about dropping is not itself dropped.
    const queue = new AsyncQueue<CdmMessage>({
      highWaterMark,
      onOverflow: (info) =>
        queue.pushUrgent({
          kind: 'control',
          control: 'backpressure',
          provider,
          reason: `consumer is behind; dropping the oldest of ${info.highWaterMark} buffered messages`,
          symbols: [...symbolSet],
          tsConduitRecv: nowNs(),
          backpressure: info,
        }),
      onRecover: (info) =>
        queue.pushUrgent({
          kind: 'control',
          control: 'backpressure_recovered',
          provider,
          reason: `consumer caught up after dropping ${info.droppedThisEpisode} message(s)`,
          symbols: [...symbolSet],
          tsConduitRecv: nowNs(),
          backpressure: info,
        }),
    });
    const consumer: Consumer = { schema, symbols: symbolSet, queue };
    this.#consumers.add(consumer);
    return consumer;
  }

  /** Removes a consumer and returns the symbols no remaining consumer of that schema wants. */
  remove(consumer: Consumer): string[] {
    this.#consumers.delete(consumer);
    const stillWanted = new Set<string>();
    for (const other of this.#consumers) {
      if (other.schema === consumer.schema) for (const s of other.symbols) stillWanted.add(s);
    }
    return [...consumer.symbols].filter((s) => !stillWanted.has(s));
  }

  /** Delivers a control message to the consumers watching that symbol, on the same stream. */
  dispatchControl(message: ControlMessage, symbol: string): void {
    for (const consumer of this.#consumers) {
      if (consumer.symbols.has(symbol)) consumer.queue.push(message);
    }
  }

  dispatch(messages: readonly MarketMessage[]): void {
    for (const message of messages) {
      const schema = schemaOf(message);
      for (const consumer of this.#consumers) {
        if (consumer.schema === schema && consumer.symbols.has(message.symbol)) {
          consumer.queue.push(message);
        }
      }
    }
  }

  /** Terminates every consumer's iterator with an error. For failures retrying cannot fix. */
  failAll(error: unknown): void {
    for (const consumer of this.#consumers) consumer.queue.fail(error);
  }

  endAll(): void {
    for (const consumer of this.#consumers) consumer.queue.end();
    this.#consumers.clear();
  }
}

export type { Consumer };
