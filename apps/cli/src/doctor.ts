import {
  SCHEMAS,
  ageMs,
  isConduitError,
  type AssetClass,
  type ProviderAdapter,
  type ProviderId,
  type Schema,
} from '@conduit/core';
import type { Headroom, UsageLedger } from '@conduit/ledger';

export type DoctorStatus =
  | 'ok'
  | 'auth_failed'
  | 'no_entitlement'
  | 'rate_limited'
  | 'near_ceiling'
  | 'unreachable'
  | 'not_supported'
  /** Connected and authenticated, and no data arrived while the REST snapshot was current. */
  | 'silent';

export interface DoctorCheck {
  readonly provider: ProviderId;
  readonly status: DoctorStatus;
  readonly detail: string;
  readonly latencyMs: number | undefined;
  readonly capabilities: readonly Schema[];
  readonly headroom: Headroom | undefined;
  /** Messages received during the stream probe, or undefined if it was not run. */
  readonly streamed: number | undefined;
  /** How old the REST snapshot's data was, which says whether silence was expected. */
  readonly snapshotAgeMs: number | undefined;
}

export interface ReferenceLoad {
  readonly provider: ProviderId;
  readonly venues: number;
  readonly conditions: number;
  readonly conditionsFlagged: number;
  readonly error: string | undefined;
}

export interface DoctorReport {
  readonly checks: readonly DoctorCheck[];
  /** Venue and condition tables pulled from each vendor's reference endpoint. */
  readonly reference: readonly ReferenceLoad[];
  /** Which providers can serve each schema for equities, after the live probe. */
  readonly coverage: Readonly<Record<string, readonly ProviderId[]>>;
  readonly missing: readonly ProviderId[];
  readonly ok: boolean;
}

export interface DoctorOptions {
  readonly adapters: readonly ProviderAdapter[];
  readonly ledger?: UsageLedger;
  readonly missing?: readonly ProviderId[];
  /** Cheap, liquid, and certain to exist on every equity feed. */
  readonly probeSymbols?: readonly string[];
  /**
   * Asset classes to probe beyond equities. An adapter that claims to cover options but fails the
   * probe has a key without the entitlement, which is a different problem from a revoked key.
   */
  readonly entitlementProbes?: Readonly<Partial<Record<AssetClass, readonly string[]>>>;
  /**
   * Loads each vendor's venue and condition tables and registers them, so venue labels and
   * condition flags come from the vendor rather than from a hand-written table. Costs one or two
   * REST calls per provider.
   */
  /**
   * Also open a stream for this long. Without it, doctor probes REST only — and the failure most
   * likely in production is a socket that connects, authenticates and then goes quiet, which REST
   * cannot see.
   */
  readonly streamProbeMs?: number;
  readonly loadReference?: readonly (() => Promise<{
    provider: ProviderId;
    venues: number;
    conditions: number;
    conditionsFlagged: number;
  }>)[];
}

const DEFAULT_PROBE = ['AAPL'];
const DEFAULT_ENTITLEMENT_PROBES = {
  option: ['AAPL240119C00190000'],
  future: ['ESZ4'],
} as const;

/**
 * Validates every configured key by actually using it, then reports coverage, latency, and quota
 * headroom. This is the command you run when something looks wrong.
 *
 * The distinction that matters: an equity probe failing on auth means the key is dead, while an
 * equity probe passing and an options probe failing on auth means the key is alive but not
 * entitled. Reporting both as "auth failed" would send you looking for the wrong problem.
 */
export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const probeSymbols = options.probeSymbols ?? DEFAULT_PROBE;
  const entitlementProbes = options.entitlementProbes ?? DEFAULT_ENTITLEMENT_PROBES;
  const checks: DoctorCheck[] = [];

  for (const adapter of options.adapters) {
    const capabilities = [...adapter.capabilities].sort();
    const headroom = options.ledger?.headroom(adapter.id, 'rest');
    const startedAt = Date.now();

    let status: DoctorStatus;
    let detail: string;
    let latencyMs: number | undefined;
    let snapshotAgeMs: number | undefined;

    try {
      const quotes = await adapter.snapshot({ symbols: probeSymbols, assetClass: 'equity' });
      latencyMs = Date.now() - startedAt;
      status = 'ok';
      detail = `${quotes.length} quote${quotes.length === 1 ? '' : 's'} for ${probeSymbols.join(', ')}`;
      for (const quote of quotes) {
        const age = ageMs(quote.tsEvent);
        if (snapshotAgeMs === undefined || age < snapshotAgeMs) snapshotAgeMs = age;
      }
    } catch (error) {
      latencyMs = Date.now() - startedAt;
      ({ status, detail } = classify(error));
    }

    // Only probe entitlements once the key itself is known to work.
    if (status === 'ok') {
      for (const [assetClass, symbols] of Object.entries(entitlementProbes)) {
        if (!adapter.supports('quote_l1', assetClass as AssetClass)) continue;
        try {
          await adapter.snapshot({ symbols, assetClass: assetClass as AssetClass });
        } catch (error) {
          const classified = classify(error);
          if (classified.status === 'auth_failed' || classified.status === 'not_supported') {
            status = 'no_entitlement';
            detail = `equities ok, ${assetClass} refused: ${classified.detail}`;
          }
        }
      }
    }

    /*
     * The failure REST cannot see: a socket that connects, authenticates, and then sends nothing.
     *
     * Silence on its own proves nothing — outside market hours every feed is silent. So it is only a
     * problem when the REST snapshot came back with current data, which means something is trading.
     * Same corroboration the router uses for staleness.
     */
    let streamed: number | undefined;
    if (status === 'ok' && options.streamProbeMs && options.streamProbeMs > 0) {
      const schema = pickStreamSchema(adapter);
      if (schema) {
        streamed = await countStreamed(adapter, schema, probeSymbols, options.streamProbeMs);
        const marketLooksOpen = snapshotAgeMs !== undefined && snapshotAgeMs < options.streamProbeMs * 10;
        if (streamed === 0 && marketLooksOpen) {
          status = 'silent';
          detail = `connected and authenticated, but no ${schema} messages in ${options.streamProbeMs}ms while REST data was ${snapshotAgeMs}ms old`;
        } else if (streamed === 0) {
          detail += `; stream silent for ${options.streamProbeMs}ms, and REST data is ${snapshotAgeMs ?? 'unknown'}ms old, so the market is probably closed`;
        } else {
          detail += `; ${streamed} ${schema} message${streamed === 1 ? '' : 's'} streamed`;
        }
      }
    }

    // A working key that is nearly out of window budget is the third thing worth knowing.
    if (status === 'ok' && headroom?.nearCeiling) {
      status = 'near_ceiling';
      detail = `${headroom.used}/${headroom.limit} requests used in the current window`;
    }

    checks.push({
      provider: adapter.id,
      status,
      detail,
      latencyMs,
      capabilities,
      ...(headroom ? { headroom } : { headroom: undefined }),
      streamed,
      snapshotAgeMs,
    });
  }

  const reference: ReferenceLoad[] = [];
  for (const load of options.loadReference ?? []) {
    try {
      const result = await load();
      reference.push({ ...result, error: undefined });
    } catch (error) {
      // A reference table that will not load is worth reporting, not worth failing over.
      reference.push({
        provider: 'polygon',
        venues: 0,
        conditions: 0,
        conditionsFlagged: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const coverage: Record<string, ProviderId[]> = {};
  for (const schema of SCHEMAS) {
    coverage[schema] = options.adapters
      .filter(
        (adapter) =>
          adapter.supports(schema, 'equity') &&
          checks.find((c) => c.provider === adapter.id)?.status !== 'auth_failed',
      )
      .map((adapter) => adapter.id);
  }

  return {
    checks,
    reference,
    coverage,
    missing: options.missing ?? [],
    ok: checks.length > 0 && checks.every((c) => c.status === 'ok' || c.status === 'near_ceiling'),
  };
}

/** The cheapest live schema this adapter can stream: quotes if it has them, else whatever it has. */
function pickStreamSchema(adapter: ProviderAdapter): Schema | undefined {
  for (const preferred of ['quote_l1', 'trades', 'bars_1m'] as const) {
    if (adapter.capabilities.has(preferred)) return preferred;
  }
  return [...adapter.capabilities][0];
}

/** Opens a stream for a fixed window and counts what arrives. Never throws. */
async function countStreamed(
  adapter: ProviderAdapter,
  schema: Schema,
  symbols: readonly string[],
  durationMs: number,
): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), durationMs);
  let count = 0;
  try {
    for await (const message of adapter.stream({ symbols, schema, signal: controller.signal })) {
      if (message.kind !== 'control') count += 1;
      // A single message answers the question; no need to hold the socket for the full window.
      if (count >= 1) break;
    }
  } catch {
    // A stream that refuses to open is already covered by the snapshot probe's classification.
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return count;
}

function classify(error: unknown): { status: DoctorStatus; detail: string } {
  if (!isConduitError(error)) {
    return { status: 'unreachable', detail: error instanceof Error ? error.message : String(error) };
  }
  switch (error.code) {
    case 'auth':
      return { status: 'auth_failed', detail: error.message };
    case 'rate_limit':
      return { status: 'rate_limited', detail: error.message };
    case 'coverage':
      return { status: 'not_supported', detail: error.message };
    default:
      return { status: 'unreachable', detail: error.message };
  }
}
