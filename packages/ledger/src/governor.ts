import { RateLimitError, type ProviderId, type UsageKind } from '@conduit/core';

export interface QuotaSpec {
  readonly windowSec: number;
  readonly maxRequests?: number;
  readonly maxMessages?: number;
}

/**
 * Free-tier limits, deliberately the most conservative plan. The governor refuses locally rather
 * than collecting a 429, so being conservative costs a little throughput while being wrong costs a
 * session. Override per provider for a paid tier.
 *
 * Provenance matters here, because a wrong ceiling is invisible until it bites:
 *
 * | Provider  | Limit      | Source                                              |
 * |-----------|------------|-----------------------------------------------------|
 * | polygon   | 5/min      | Massive pricing page, Stocks Basic. Verified 2026-09-25. Paid tiers are unlimited. |
 * | alpaca    | 200/min    | Alpaca market data plans, Basic. Verified 2026-09-25. Algo Trader Plus is 10,000/min. |
 * | databento | 100/sec    | **Unverified estimate.** Not published; confirm against a live 429 or their support. |
 *
 * Alpaca's Basic plan also caps websocket subscriptions at 30 symbols, which is a cap rather than a
 * rate and so is not modelled here — it surfaces as error 405 from the adapter.
 *
 * Tiingo has no entry because it has no adapter yet; an unused ceiling is just another unverified
 * number to trip over later.
 */
export const DEFAULT_QUOTAS: Readonly<Partial<Record<ProviderId, QuotaSpec>>> = {
  polygon: { windowSec: 60, maxRequests: 5 },
  alpaca: { windowSec: 60, maxRequests: 200 },
  databento: { windowSec: 1, maxRequests: 100 },
};

export type GovernorMode = 'queue' | 'refuse';

export interface GovernorOptions {
  readonly quotas?: Readonly<Partial<Record<ProviderId, QuotaSpec>>>;
  /** 'queue' waits for room; 'refuse' throws RateLimitError immediately. */
  readonly mode?: GovernorMode;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Fraction of the limit at which headroom is reported as low. */
  readonly warnAt?: number;
}

export interface Headroom {
  readonly provider: ProviderId;
  readonly kind: UsageKind;
  readonly used: number;
  readonly limit: number | undefined;
  /** Fraction of the limit consumed in the current window, or undefined when there is no limit. */
  readonly utilization: number | undefined;
  readonly nearCeiling: boolean;
}

interface Bucket {
  readonly windowSec: number;
  readonly limit: number;
  timestamps: number[];
}

/**
 * Counts what has been spent against each provider's window and refuses before the provider does.
 * A 429 mid-session costs a reconnect and a gap; a local refusal costs one call.
 */
export class RateLimitGovernor {
  #quotas: Readonly<Partial<Record<ProviderId, QuotaSpec>>>;
  #mode: GovernorMode;
  #now: () => number;
  #sleep: (ms: number) => Promise<void>;
  #warnAt: number;
  #buckets = new Map<string, Bucket>();

  refusals = 0;
  waits = 0;

  constructor(options: GovernorOptions = {}) {
    this.#quotas = options.quotas ?? DEFAULT_QUOTAS;
    this.#mode = options.mode ?? 'queue';
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#warnAt = options.warnAt ?? 0.8;
  }

  /** Overrides a provider's limits, for a paid tier or an observed correction. */
  setQuota(provider: ProviderId, spec: QuotaSpec): void {
    this.#quotas = { ...this.#quotas, [provider]: spec };
    this.#buckets.delete(this.#key(provider, 'rest'));
    this.#buckets.delete(this.#key(provider, 'ws_message'));
    this.#buckets.delete(this.#key(provider, 'ws_subscribe'));
  }

  /**
   * Reserves one unit. Waits for room in 'queue' mode, throws RateLimitError in 'refuse' mode, and
   * returns immediately when the provider has no counted limit for this kind.
   */
  async acquire(provider: ProviderId, kind: UsageKind, units = 1): Promise<void> {
    const bucket = this.#bucketFor(provider, kind);
    if (!bucket) return;

    for (;;) {
      this.#prune(bucket);
      if (bucket.timestamps.length + units <= bucket.limit) {
        for (let i = 0; i < units; i += 1) bucket.timestamps.push(this.#now());
        return;
      }

      const oldest = bucket.timestamps[0]!;
      const retryAfterMs = oldest + bucket.windowSec * 1000 - this.#now();
      if (this.#mode === 'refuse') {
        this.refusals += 1;
        throw new RateLimitError(
          `${provider} would exceed its local ${kind} budget of ${bucket.limit} per ${bucket.windowSec}s`,
          { provider, retryAfterMs: Math.max(0, retryAfterMs) },
        );
      }
      this.waits += 1;
      await this.#sleep(Math.max(1, retryAfterMs));
    }
  }

  /** Records usage that happened without going through acquire, so counts stay honest. */
  record(provider: ProviderId, kind: UsageKind, units = 1): void {
    const bucket = this.#bucketFor(provider, kind);
    if (!bucket) return;
    this.#prune(bucket);
    for (let i = 0; i < units; i += 1) bucket.timestamps.push(this.#now());
  }

  headroom(provider: ProviderId, kind: UsageKind): Headroom {
    const bucket = this.#bucketFor(provider, kind);
    if (!bucket) {
      return {
        provider,
        kind,
        used: 0,
        limit: undefined,
        utilization: undefined,
        nearCeiling: false,
      };
    }
    this.#prune(bucket);
    const used = bucket.timestamps.length;
    const utilization = used / bucket.limit;
    return {
      provider,
      kind,
      used,
      limit: bucket.limit,
      utilization,
      nearCeiling: utilization >= this.#warnAt,
    };
  }

  #key(provider: ProviderId, kind: UsageKind): string {
    return `${provider}|${kind}`;
  }

  #bucketFor(provider: ProviderId, kind: UsageKind): Bucket | undefined {
    const key = this.#key(provider, kind);
    const existing = this.#buckets.get(key);
    if (existing) return existing;

    const spec = this.#quotas[provider];
    if (!spec) return undefined;
    const limit =
      kind === 'rest'
        ? spec.maxRequests
        : kind === 'ws_message'
          ? spec.maxMessages
          : spec.maxRequests;
    if (limit === undefined) return undefined;

    const bucket: Bucket = { windowSec: spec.windowSec, limit, timestamps: [] };
    this.#buckets.set(key, bucket);
    return bucket;
  }

  #prune(bucket: Bucket): void {
    const cutoff = this.#now() - bucket.windowSec * 1000;
    if (bucket.timestamps.length > 0 && bucket.timestamps[0]! <= cutoff) {
      bucket.timestamps = bucket.timestamps.filter((t) => t > cutoff);
    }
  }
}
