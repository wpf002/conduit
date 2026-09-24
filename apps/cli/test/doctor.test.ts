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
    return req.symbols.map((symbol) => ({
      kind: 'quote' as const,
      figi: UNRESOLVED_FIGI,
      symbol,
      provider: this.id,
      tsEvent: nowNs(),
      tsConduitRecv: nowNs(),
      bidPx: 100,
      bidSz: 100,
      askPx: 100.01,
      askSz: 100,
    }));
  }

  stream(_req: StreamRequest): AsyncIterable<CdmMessage> {
    return { async *[Symbol.asyncIterator]() {} };
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
