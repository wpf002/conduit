import type { ProviderId } from '@conduit/core';

/**
 * Gap detection against a provider's own sequence numbers, and an honest account of when it works.
 *
 * **It usually does not.** Polygon's `q` and Databento's `sequence` are channel-wide counters: they
 * increment across every symbol and message type on the feed, not per instrument. Conduit subscribes
 * to a handful of symbols out of thousands, so consecutive messages for one symbol are numbered
 * hundreds apart, and every one of those is a "gap" that means nothing.
 *
 * Detection is only meaningful when the numbering matches what you actually receive:
 *
 * - `'symbol'` — the provider numbers per instrument. Then a jump is a genuinely dropped message.
 * - `'stream'` — the provider numbers per channel and you subscribe to the whole channel. Then a
 *   jump is also genuine.
 * - `'none'` — the default. Numbering exists but does not correspond to your subscription, so a gap
 *   cannot be distinguished from a message about a symbol you did not ask for.
 *
 * Turning this on without knowing which case you are in produces a control message per tick.
 */
export type SequenceScope = 'symbol' | 'stream' | 'none';

export interface SequenceGap {
  readonly symbol: string;
  readonly expectedSeq: bigint;
  readonly receivedSeq: bigint;
  readonly missing: bigint;
}

export interface SequenceTrackerOptions {
  readonly provider: ProviderId;
  readonly scope?: SequenceScope;
}

const STREAM_KEY = '\u0000stream';

export class SequenceTracker {
  readonly provider: ProviderId;
  readonly scope: SequenceScope;

  #last = new Map<string, bigint>();

  gaps = 0;
  missing = 0n;
  /** Messages whose sequence went backwards: a replay, or reordering in transit. */
  outOfOrder = 0;

  constructor(options: SequenceTrackerOptions) {
    this.provider = options.provider;
    this.scope = options.scope ?? 'none';
  }

  /**
   * Returns a gap when the sequence jumped forward, undefined otherwise. The first message for a key
   * establishes the baseline and never reports a gap.
   */
  check(symbol: string, seq: bigint | undefined): SequenceGap | undefined {
    if (this.scope === 'none' || seq === undefined) return undefined;
    const key = this.scope === 'stream' ? STREAM_KEY : symbol;

    const last = this.#last.get(key);
    this.#last.set(key, seq);
    if (last === undefined) return undefined;

    if (seq <= last) {
      // Equal or lower. Not a gap, and advancing the baseline backwards would invent one next time.
      this.#last.set(key, last);
      if (seq < last) this.outOfOrder += 1;
      return undefined;
    }

    const expected = last + 1n;
    if (seq === expected) return undefined;

    const missing = seq - expected;
    this.gaps += 1;
    this.missing += missing;
    return { symbol, expectedSeq: expected, receivedSeq: seq, missing };
  }

  /** After a reconnect the provider's numbering may restart, so the baseline is dropped. */
  reset(): void {
    this.#last.clear();
  }

  get tracked(): number {
    return this.#last.size;
  }
}
