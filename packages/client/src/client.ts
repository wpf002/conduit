import {
  CoverageError,
  isConduitError,
  type AssetClass,
  type HealthSnapshot,
  type ProviderAdapter,
  type ProviderId,
  type QuoteTick,
  type Schema,
  type SnapshotRequest,
} from '@conduit/core';
import { assertCoverage, coveringProviders, providerIds } from './coverage.js';
import { resolveConfig, type ConduitClientConfig, type ResolvedConfig } from './config.js';
import { ManagedSubscription, type SubscribeRequest, type Subscription } from './subscription.js';

/**
 * The consumer-facing client. Holds the user's own adapters, picks which of them can serve a
 * request, and moves a subscription between them on failure.
 *
 * Market data flows provider -> this process. Nothing here forwards ticks anywhere else.
 */
export class ConduitClient {
  #config: ResolvedConfig;
  #subscriptions = new Set<ManagedSubscription>();
  #closed = false;

  constructor(config: ConduitClientConfig) {
    this.#config = resolveConfig(config);
  }

  get providers(): readonly ProviderId[] {
    return providerIds(this.#config.providers);
  }

  /** Which of the configured keys can serve this request at all, in the order they'd be tried. */
  coverage(schema: Schema, assetClass: AssetClass = 'equity', symbols: readonly string[] = []) {
    return providerIds(coveringProviders(this.#config, { schema, assetClass, symbols }));
  }

  health(): Record<string, HealthSnapshot> {
    const out: Record<string, HealthSnapshot> = {};
    for (const adapter of this.#config.providers) out[adapter.id] = adapter.health();
    return out;
  }

  async subscribe(request: SubscribeRequest): Promise<Subscription> {
    if (this.#closed) throw new CoverageError('ConduitClient is closed');
    const assetClass = request.assetClass ?? 'equity';
    const query = { schema: request.schema, assetClass, symbols: request.symbols };

    let candidates = coveringProviders(this.#config, query);
    assertCoverage(this.#config, query, candidates);

    if (this.#config.failover.strategy === 'lowest-latency') {
      candidates = await this.#rankByLatency(candidates, request.symbols, assetClass);
    }
    if (this.#config.failover.strategy === 'manual') {
      // Manual means one provider and no automatic movement; switchTo still works.
      const preferred = candidates.find((a) => a.id === this.#config.preferredProvider);
      if (!preferred) {
        throw new CoverageError(
          `preferred provider ${this.#config.preferredProvider} does not cover ${request.schema}`,
          { schema: request.schema, assetClass },
        );
      }
      candidates = [preferred, ...candidates.filter((a) => a !== preferred)];
    }

    const subscription = new ManagedSubscription(this.#config, request, candidates);
    this.#subscriptions.add(subscription);
    subscription.start();
    return subscription;
  }

  /**
   * First covering provider that answers. A snapshot is a single request, so trying the next
   * provider on failure costs one extra request rather than a duplicate subscription.
   */
  async snapshot(request: SnapshotRequest & { readonly schema?: Schema }): Promise<QuoteTick[]> {
    if (this.#closed) throw new CoverageError('ConduitClient is closed');
    const assetClass = request.assetClass ?? 'equity';
    const query = {
      schema: request.schema ?? ('quote_l1' as Schema),
      assetClass,
      symbols: request.symbols,
    };
    const candidates = coveringProviders(this.#config, query);
    assertCoverage(this.#config, query, candidates);

    const failures: string[] = [];
    for (const adapter of candidates) {
      try {
        return await adapter.snapshot({
          symbols: request.symbols,
          ...(request.assetClass ? { assetClass: request.assetClass } : {}),
        });
      } catch (error) {
        failures.push(`${adapter.id}: ${error instanceof Error ? error.message : String(error)}`);
        if (isConduitError(error) && error.code === 'coverage') continue;
      }
    }
    throw new CoverageError(`every covering provider failed the snapshot. ${failures.join('; ')}`, {
      schema: query.schema,
      assetClass,
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#subscriptions].map((s) => s.close()));
    this.#subscriptions.clear();
    await Promise.all(this.#config.providers.map((a) => a.close()));
  }

  /**
   * Ranks by a measured snapshot round-trip. This costs one request per provider per subscribe
   * call, which is why it is opt-in rather than the default. Providers that cannot answer a
   * snapshot keep their configured position rather than being dropped.
   */
  async #rankByLatency(
    candidates: readonly ProviderAdapter[],
    symbols: readonly string[],
    assetClass: AssetClass,
  ): Promise<readonly ProviderAdapter[]> {
    const probeSymbols = symbols.slice(0, 1);
    const measured = await Promise.all(
      candidates.map(async (adapter, index) => {
        const startedAt = Date.now();
        try {
          await adapter.snapshot({ symbols: probeSymbols, assetClass });
          return { adapter, index, latencyMs: Date.now() - startedAt, ok: true };
        } catch {
          return { adapter, index, latencyMs: Number.POSITIVE_INFINITY, ok: false };
        }
      }),
    );

    return measured
      .sort((a, b) => {
        if (a.ok !== b.ok) return a.ok ? -1 : 1;
        if (a.latencyMs !== b.latencyMs) return a.latencyMs - b.latencyMs;
        return a.index - b.index;
      })
      .map((m) => m.adapter);
  }
}

export function createClient(config: ConduitClientConfig): ConduitClient {
  return new ConduitClient(config);
}
