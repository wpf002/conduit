import type { ProviderId, Schema } from './ids.js';

/**
 * What a provider charges for, and what its limits are counted in. These three are the units every
 * vendor bills or throttles on, whatever they call them.
 */
export type UsageKind = 'rest' | 'ws_message' | 'ws_subscribe';

export interface UsageRecord {
  readonly provider: ProviderId;
  readonly kind: UsageKind;
  readonly schema?: Schema;
  readonly symbol?: string;
  readonly figi?: string;
  /** Number of billable units, not always 1: a batched REST call covers many symbols. */
  readonly count: number;
  readonly atNs: bigint;
}

/**
 * Adapters report usage through this. It is synchronous and must not throw — accounting never
 * interferes with the data path.
 */
export type UsageSink = (record: UsageRecord) => void;

/**
 * What an adapter needs from the ledger: somewhere to report what it did, and permission to do it.
 * Both optional, so an adapter works with no ledger configured at all.
 */
export interface UsageHooks {
  readonly sink?: UsageSink;
  /**
   * Called before a billable operation. May wait for room or throw RateLimitError, which is the
   * point: refusing locally costs one call, collecting a 429 mid-session costs a reconnect.
   */
  readonly acquire?: (kind: UsageKind, units: number) => Promise<void>;
}

export const NOOP_USAGE_SINK: UsageSink = () => {};

/** Wraps a sink so a broken ledger cannot take down a stream. */
export function safeSink(sink: UsageSink | undefined): UsageSink {
  if (!sink) return NOOP_USAGE_SINK;
  return (record) => {
    try {
      sink(record);
    } catch {
      /* accounting is never allowed to break the data path */
    }
  };
}
