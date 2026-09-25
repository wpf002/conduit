import { describe, expect, it } from 'vitest';
import {
  AuthError,
  CoverageError,
  HealthTracker,
  RateLimitError,
  TransportError,
  UNRESOLVED_FIGI,
  nowNs,
  type AssetClass,
  type CdmMessage,
  type HealthSnapshot,
  type ProviderAdapter,
  type ProviderId,
  type QuoteTick,
  type Schema,
  type SnapshotRequest,
  type StreamRequest,
} from '@conduit/core';
import { MemoryLedgerStore, UsageLedger } from '@conduit/ledger';
import { runDoctor } from '../src/doctor.js';
import { parseDuration } from '../src/env.js';

interface ProbeAdapterOptions {
  readonly capabilities?: readonly Schema[];
  readonly assetClasses?: readonly AssetClass[];
  /** Thrown for an equity probe. */
  readonly equityError?: Error;
  /** Thrown for any non-equity probe, which is how an entitlement gap looks. */
  readonly nonEquityError?: Error;
  readonly latencyMs?: number;
  /** How old the snapshot's data is. Fresh means something is trading. */
  readonly snapshotAgeMs?: number;
  /** Messages the stream emits. An empty array is a socket that connects and says nothing. */
  readonly streamMessages?: number;
}

/** A provider that fails in exactly the way the test is about. */
class ProbeAdapter implements ProviderAdapter {
  readonly id: ProviderId;
  readonly capabilities: ReadonlySet<Schema>;
  #assetClasses: ReadonlySet<AssetClass>;
  #options: ProbeAdapterOptions;
  #health: HealthTracker;

  constructor(id: ProviderId, options: ProbeAdapterOptions = {}) {
    this.id = id;
    this.#options = options;
    this.capabilities = new Set(options.capabilities ?? ['quote_l1', 'trades']);
    this.#assetClasses = new Set(options.assetClasses ?? ['equity', 'etf']);
    this.#health = new HealthTracker({
      provider: id,
      staleAfterMs: 10_000,
      maxConsecutiveFailures: 3,
    });
  }

  health(): HealthSnapshot {
    return this.#health.snapshot();
  }

  supports(schema: Schema, assetClass: AssetClass): boolean {
    return this.capabilities.has(schema) && this.#assetClasses.has(assetClass);
  }

  async snapshot(req: SnapshotRequest): Promise<QuoteTick[]> {
    if (this.#options.latencyMs) {
      await new Promise((r) => setTimeout(r, this.#options.latencyMs));
    }
    const assetClass = req.assetClass ?? 'equity';
    if (assetClass === 'equity' || assetClass === 'etf') {
      if (this.#options.equityError) throw this.#options.equityError;
    } else if (this.#options.nonEquityError) {
      throw this.#options.nonEquityError;
    }
    const ageNs = BigInt(this.#options.snapshotAgeMs ?? 0) * 1_000_000n;
    return req.symbols.map((symbol) => ({
      kind: 'quote' as const,
      figi: UNRESOLVED_FIGI,
      symbol,
      provider: this.id,
      tsEvent: nowNs() - ageNs,
      tsConduitRecv: nowNs(),
      bidPx: 100,
      bidSz: 100,
      askPx: 100.01,
      askSz: 100,
    }));
  }

  stream(req: StreamRequest): AsyncIterable<CdmMessage> {
    const count = this.#options.streamMessages ?? 0;
    const provider = this.id;
    const symbol = req.symbols[0] ?? 'AAPL';
    const signal = req.signal;
    return {
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < count; i += 1) {
          yield {
            kind: 'quote' as const,
            figi: UNRESOLVED_FIGI,
            symbol,
            provider,
            tsEvent: nowNs(),
            tsConduitRecv: nowNs(),
            bidPx: 100,
            bidSz: 100,
            askPx: 100.01,
            askSz: 100,
          };
        }
        // A silent socket: connected, nothing to say, until the caller gives up.
        await new Promise<void>((resolve) => {
          if (signal?.aborted) return resolve();
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    };
  }

  async close(): Promise<void> {}
}

describe('phase 4 acceptance: conduit doctor', () => {
  it('detects a revoked key', async () => {
    const report = await runDoctor({
      adapters: [
        new ProbeAdapter('polygon', {
          equityError: new AuthError('polygon rejected the API key', { provider: 'polygon' }),
        }),
        new ProbeAdapter('alpaca'),
      ],
    });

    expect(report.checks[0]).toMatchObject({ provider: 'polygon', status: 'auth_failed' });
    expect(report.checks[1]).toMatchObject({ provider: 'alpaca', status: 'ok' });
    expect(report.ok).toBe(false);
    // A dead key is removed from the coverage it claimed.
    expect(report.coverage['quote_l1']).toEqual(['alpaca']);
  });

  it('detects a key without an options entitlement, and does not call it revoked', async () => {
    const report = await runDoctor({
      adapters: [
        new ProbeAdapter('polygon', {
          assetClasses: ['equity', 'etf', 'option'],
          nonEquityError: new AuthError('NOT_AUTHORIZED: options data not included in your plan', {
            provider: 'polygon',
          }),
        }),
      ],
      entitlementProbes: { option: ['AAPL240119C00190000'] },
    });

    const check = report.checks[0]!;
    expect(check.status).toBe('no_entitlement');
    expect(check.detail).toContain('equities ok');
    expect(check.detail).toContain('option refused');
    // The distinction matters: this key works, it just does not cover options.
    expect(check.status).not.toBe('auth_failed');
  });

  it('detects a key approaching its rate ceiling', async () => {
    const ledger = new UsageLedger({
      store: new MemoryLedgerStore(),
      governor: { quotas: { polygon: { windowSec: 60, maxRequests: 5 } }, warnAt: 0.8 },
    });
    for (let i = 0; i < 4; i += 1) await ledger.acquire('polygon', 'rest');

    const report = await runDoctor({ adapters: [new ProbeAdapter('polygon')], ledger });
    const check = report.checks[0]!;
    expect(check.status).toBe('near_ceiling');
    expect(check.detail).toMatch(/[45]\/5 requests used/);
    expect(check.headroom?.nearCeiling).toBe(true);
    // Near the ceiling is a warning, not a failure: the key still works.
    expect(report.ok).toBe(true);
    await ledger.close();
  });

  it('reports all three conditions in one run', async () => {
    const ledger = new UsageLedger({
      store: new MemoryLedgerStore(),
      governor: { quotas: { databento: { windowSec: 60, maxRequests: 2 } }, warnAt: 0.8 },
    });
    await ledger.acquire('databento', 'rest');
    await ledger.acquire('databento', 'rest');

    const report = await runDoctor({
      adapters: [
        new ProbeAdapter('polygon', { equityError: new AuthError('revoked') }),
        new ProbeAdapter('alpaca', {
          assetClasses: ['equity', 'option'],
          nonEquityError: new AuthError('no options entitlement'),
        }),
        new ProbeAdapter('databento', { capabilities: ['quote_l1', 'depth_10'] }),
      ],
      ledger,
      entitlementProbes: { option: ['AAPL240119C00190000'] },
    });

    expect(report.checks.map((c) => `${c.provider}:${c.status}`)).toEqual([
      'polygon:auth_failed',
      'alpaca:no_entitlement',
      'databento:near_ceiling',
    ]);
    await ledger.close();
  });
});

describe('doctor classification', () => {
  it('separates a rate limit from an auth failure', async () => {
    const report = await runDoctor({
      adapters: [
        new ProbeAdapter('polygon', {
          equityError: new RateLimitError('429', { provider: 'polygon', retryAfterMs: 1_000 }),
        }),
      ],
    });
    expect(report.checks[0]!.status).toBe('rate_limited');
    // Rate limited is not auth failed, so coverage is unaffected.
    expect(report.coverage['quote_l1']).toEqual(['polygon']);
  });

  it('separates a transport failure from a credential problem', async () => {
    const report = await runDoctor({
      adapters: [
        new ProbeAdapter('polygon', { equityError: new TransportError('getaddrinfo ENOTFOUND') }),
      ],
    });
    expect(report.checks[0]!.status).toBe('unreachable');
  });

  it('does not treat a provider without a snapshot endpoint as broken coverage', async () => {
    const report = await runDoctor({
      adapters: [
        new ProbeAdapter('databento', {
          capabilities: ['quote_l1', 'depth_10'],
          assetClasses: ['future'],
          equityError: new CoverageError('databento historical has no snapshot endpoint'),
        }),
      ],
    });
    expect(report.checks[0]!.status).toBe('not_supported');
    expect(report.checks[0]!.capabilities).toEqual(['depth_10', 'quote_l1']);
  });

  it('measures latency and reports capabilities', async () => {
    const report = await runDoctor({
      adapters: [new ProbeAdapter('alpaca', { latencyMs: 25 })],
    });
    expect(report.checks[0]!.latencyMs).toBeGreaterThanOrEqual(20);
    expect(report.checks[0]!.capabilities).toEqual(['quote_l1', 'trades']);
  });

  it('reports schemas nothing covers and keys that are not configured', async () => {
    const report = await runDoctor({
      adapters: [new ProbeAdapter('polygon', { capabilities: ['quote_l1'] })],
      missing: ['databento', 'tiingo'],
    });
    expect(report.coverage['depth_10']).toEqual([]);
    expect(report.missing).toEqual(['databento', 'tiingo']);
  });

  it('is not ok with no providers at all', async () => {
    expect((await runDoctor({ adapters: [] })).ok).toBe(false);
  });
});

describe('parseDuration', () => {
  it('reads the forms conduit spend accepts', () => {
    expect(parseDuration('90s')).toBe(90_000);
    expect(parseDuration('30m')).toBe(1_800_000);
    expect(parseDuration('24h')).toBe(86_400_000);
    expect(parseDuration('7d')).toBe(604_800_000);
    expect(parseDuration('2w')).toBe(1_209_600_000);
    expect(parseDuration(' 7 D ')).toBe(604_800_000);
  });

  it('rejects anything else rather than guessing a window', () => {
    for (const bad of ['7', 'd', 'seven days', '-1d', '1y', '']) {
      expect(() => parseDuration(bad)).toThrow(/cannot read/);
    }
  });
});

describe('reference table loading', () => {
  it('reports what each vendor table returned', async () => {
    const report = await runDoctor({
      adapters: [new ProbeAdapter('polygon')],
      loadReference: [
        async () => ({ provider: 'polygon', venues: 42, conditions: 80, conditionsFlagged: 11 }),
      ],
    });
    expect(report.reference).toEqual([
      { provider: 'polygon', venues: 42, conditions: 80, conditionsFlagged: 11, error: undefined },
    ]);
  });

  it('reports a failed load without failing the run', async () => {
    const report = await runDoctor({
      adapters: [new ProbeAdapter('polygon')],
      loadReference: [
        async () => {
          throw new AuthError('polygon rejected the key on a reference request');
        },
      ],
    });
    expect(report.reference[0]!.error).toMatch(/rejected the key/);
    // The key itself probed fine, so the run is still ok.
    expect(report.ok).toBe(true);
  });

  it('loads nothing when no loaders are given', async () => {
    const report = await runDoctor({ adapters: [new ProbeAdapter('polygon')] });
    expect(report.reference).toEqual([]);
  });
});

describe('stream probe', () => {
  it('flags a socket that connects and then says nothing while the market is trading', async () => {
    const report = await runDoctor({
      // REST data is current, so something is printing. The stream sending nothing is a real fault.
      adapters: [new ProbeAdapter('polygon', { snapshotAgeMs: 50, streamMessages: 0 })],
      streamProbeMs: 60,
    });
    const check = report.checks[0]!;
    expect(check.status).toBe('silent');
    expect(check.streamed).toBe(0);
    expect(check.detail).toMatch(/no quote_l1 messages in 60ms/);
    expect(report.ok).toBe(false);
  });

  it('does not flag silence when the REST data is stale too', async () => {
    const report = await runDoctor({
      // Nothing has printed for ten minutes. The market is closed; silence is correct.
      adapters: [new ProbeAdapter('polygon', { snapshotAgeMs: 600_000, streamMessages: 0 })],
      streamProbeMs: 60,
    });
    const check = report.checks[0]!;
    expect(check.status).toBe('ok');
    expect(check.detail).toMatch(/market is probably closed/);
    expect(report.ok).toBe(true);
  });

  it('reports a healthy stream', async () => {
    const report = await runDoctor({
      adapters: [new ProbeAdapter('polygon', { snapshotAgeMs: 10, streamMessages: 3 })],
      streamProbeMs: 500,
    });
    expect(report.checks[0]!.status).toBe('ok');
    expect(report.checks[0]!.streamed).toBe(1);
    expect(report.checks[0]!.detail).toMatch(/1 quote_l1 message streamed/);
  });

  it('skips the probe when not asked', async () => {
    const report = await runDoctor({ adapters: [new ProbeAdapter('polygon')] });
    expect(report.checks[0]!.streamed).toBeUndefined();
  });

  it('does not probe a stream for a key that already failed auth', async () => {
    const report = await runDoctor({
      adapters: [new ProbeAdapter('polygon', { equityError: new AuthError('revoked') })],
      streamProbeMs: 60,
    });
    expect(report.checks[0]!.status).toBe('auth_failed');
    expect(report.checks[0]!.streamed).toBeUndefined();
  });

  it('reports how old the REST data was, so silence can be judged', async () => {
    const report = await runDoctor({
      adapters: [new ProbeAdapter('polygon', { snapshotAgeMs: 1_234 })],
      streamProbeMs: 40,
    });
    expect(report.checks[0]!.snapshotAgeMs).toBeGreaterThanOrEqual(1_234);
  });
});
