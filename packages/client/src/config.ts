import { z } from 'zod';
import { CoverageError, PROVIDER_IDS, SCHEMAS, type AssetClass, type ProviderAdapter, type ProviderId, type Schema } from '@conduit/core';

/**
 * Not a cost-optimizing router. 'ordered' uses the configured order, 'lowest-latency' ranks by a
 * measured probe at subscribe time, and 'manual' never switches without being told to.
 */
export type FailoverStrategy = 'ordered' | 'lowest-latency' | 'manual';

export interface FailoverConfig {
  readonly strategy: FailoverStrategy;
  /** How long a provider must look healthy before a fail-back is accepted. */
  readonly healthWindowMs: number;
  readonly maxConsecutiveFailures: number;
  readonly staleAfterMs: number;
  /** How often a degraded provider is re-checked, and how often health is polled. */
  readonly probeIntervalMs: number;
}

export const DEFAULT_FAILOVER: FailoverConfig = {
  strategy: 'ordered',
  healthWindowMs: 30_000,
  maxConsecutiveFailures: 3,
  staleAfterMs: 10_000,
  probeIntervalMs: 1_000,
};

const assetClassSchema = z.enum(['equity', 'etf', 'option', 'future', 'crypto', 'fx', 'index']);

const failoverSchema = z
  .object({
    strategy: z.enum(['ordered', 'lowest-latency', 'manual']).default(DEFAULT_FAILOVER.strategy),
    healthWindowMs: z.number().int().positive().default(DEFAULT_FAILOVER.healthWindowMs),
    maxConsecutiveFailures: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_FAILOVER.maxConsecutiveFailures),
    staleAfterMs: z.number().int().positive().default(DEFAULT_FAILOVER.staleAfterMs),
    probeIntervalMs: z.number().int().positive().default(DEFAULT_FAILOVER.probeIntervalMs),
  })
  .default(DEFAULT_FAILOVER);

/**
 * Symbol-level coverage the user declares, for cases capabilities cannot express. partialRecord
 * rather than record: a user configuring one provider must not have to name the other three.
 */
const coverageSchema = z.partialRecord(
  z.enum(PROVIDER_IDS as unknown as [ProviderId, ...ProviderId[]]),
  z.object({
    symbols: z.array(z.string()).optional(),
    assetClasses: z.array(assetClassSchema).optional(),
  }),
);

export interface CoverageOverride {
  readonly symbols?: readonly string[];
  readonly assetClasses?: readonly AssetClass[];
}

export interface ConduitClientConfig {
  readonly providers: readonly ProviderAdapter[];
  readonly failover?: Partial<FailoverConfig>;
  readonly coverage?: Readonly<Partial<Record<ProviderId, CoverageOverride>>>;
  /** Required by the 'manual' strategy, and used as the head of the order otherwise. */
  readonly preferredProvider?: ProviderId;
  /** Messages the router drops as out-of-order after a switch are counted, not logged, by default. */
  readonly onEvent?: (event: RouterEvent) => void;
}

export interface RouterEvent {
  readonly type: 'switch' | 'degraded' | 'recovered' | 'dropped' | 'probe';
  readonly provider: ProviderId;
  readonly previousProvider?: ProviderId;
  readonly schema?: Schema;
  readonly reason: string;
  readonly atMs: number;
}

export interface ResolvedConfig {
  readonly providers: readonly ProviderAdapter[];
  readonly failover: FailoverConfig;
  readonly coverage: Readonly<Partial<Record<ProviderId, CoverageOverride>>>;
  readonly preferredProvider: ProviderId | undefined;
  readonly onEvent: ((event: RouterEvent) => void) | undefined;
}

export function resolveConfig(config: ConduitClientConfig): ResolvedConfig {
  if (config.providers.length === 0) {
    throw new CoverageError('ConduitClient needs at least one provider adapter');
  }

  const seen = new Set<ProviderId>();
  for (const adapter of config.providers) {
    if (seen.has(adapter.id)) {
      throw new CoverageError(`provider ${adapter.id} is configured twice`);
    }
    seen.add(adapter.id);
  }

  const failover = failoverSchema.parse({ ...DEFAULT_FAILOVER, ...config.failover });
  const coverage = config.coverage ? coverageSchema.parse(config.coverage) : {};

  if (failover.strategy === 'manual' && config.preferredProvider === undefined) {
    throw new CoverageError("the 'manual' failover strategy requires preferredProvider");
  }
  if (config.preferredProvider !== undefined && !seen.has(config.preferredProvider)) {
    throw new CoverageError(
      `preferredProvider ${config.preferredProvider} is not among the configured providers`,
    );
  }

  return {
    providers: config.providers,
    failover,
    coverage: coverage as Readonly<Partial<Record<ProviderId, CoverageOverride>>>,
    preferredProvider: config.preferredProvider,
    onEvent: config.onEvent,
  };
}

export function isSchema(value: string): value is Schema {
  return (SCHEMAS as readonly string[]).includes(value);
}
