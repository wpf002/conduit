import { describe, expect, it, vi } from 'vitest';
import { RateLimitError, msToNs, type UsageRecord } from '@conduit/core';
import { UsageLedger } from '../src/ledger.js';
import { MemoryLedgerStore } from '../src/store.js';
import { DEFAULT_QUOTAS, RateLimitGovernor } from '../src/governor.js';
import { DEFAULT_COST_MODEL, costOf, mergeCostModel } from '../src/cost.js';

const T0 = 1_704_205_800_000;

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    provider: 'polygon',
    kind: 'ws_message',
    count: 1,
    atNs: msToNs(T0),
    ...overrides,
  };
}

describe('cost model', () => {
  it('defaults to zero per unit rather than inventing a price', () => {
    // A flat-rate plan costs nothing per message. A fabricated number here would show up in a
    // spend report as if it were real.
    expect(costOf(record(), DEFAULT_COST_MODEL)).toBe(0);
  });

  it('applies an override per provider and kind', () => {
    const model = mergeCostModel(DEFAULT_COST_MODEL, {
      perUnit: { polygon: { rest: 2_000, ws_message: 1 } },
    });
    expect(costOf(record({ kind: 'rest' }), model)).toBe(2_000);
    expect(costOf(record({ kind: 'ws_message', count: 1_000 }), model)).toBe(1_000);
    // Untouched providers keep the default.
    expect(costOf(record({ provider: 'alpaca', kind: 'rest' }), model)).toBe(0);
  });

  it('keeps cost integral over a million messages', () => {
    const model = mergeCostModel(DEFAULT_COST_MODEL, { perUnit: { polygon: { ws_message: 1 } } });
    let total = 0;
    for (let i = 0; i < 1_000_000; i += 1) total += costOf(record(), model);
    expect(total).toBe(1_000_000);
    expect(Number.isInteger(total)).toBe(true);
  });

  it('rejects a fractional per-unit cost rather than producing a float total', () => {
    const model = mergeCostModel(DEFAULT_COST_MODEL, { perUnit: { polygon: { rest: 0.5 } } });
    expect(() => costOf(record({ kind: 'rest' }), model)).toThrow(RangeError);
  });
});

describe('RateLimitGovernor', () => {
  it('has a limit for every provider that has an adapter, and none for one that does not', () => {
    // Tiingo has no adapter yet, so it has no ceiling either: an unused number is just another
    // unverified value to trip over later.
    expect(Object.keys(DEFAULT_QUOTAS).sort()).toEqual(['alpaca', 'databento', 'polygon']);
  });

  it('uses the free-tier ceilings both vendors publish', () => {
    expect(DEFAULT_QUOTAS.polygon).toEqual({ windowSec: 60, maxRequests: 5 });
    expect(DEFAULT_QUOTAS.alpaca).toEqual({ windowSec: 60, maxRequests: 200 });
  });

  it('refuses locally instead of letting the provider answer 429', async () => {
    let now = T0;
    const governor = new RateLimitGovernor({
      quotas: { polygon: { windowSec: 60, maxRequests: 2 } },
      mode: 'refuse',
      now: () => now,
    });

    await governor.acquire('polygon', 'rest');
    await governor.acquire('polygon', 'rest');
    await expect(governor.acquire('polygon', 'rest')).rejects.toThrow(RateLimitError);
    expect(governor.refusals).toBe(1);
  });

  it('reports retryAfterMs from the window, so a caller can back off correctly', async () => {
    let now = T0;
    const governor = new RateLimitGovernor({
      quotas: { polygon: { windowSec: 60, maxRequests: 1 } },
      mode: 'refuse',
      now: () => now,
    });
    await governor.acquire('polygon', 'rest');
    now += 20_000;
    try {
      await governor.acquire('polygon', 'rest');
      expect.unreachable('should have refused');
    } catch (error) {
      expect((error as RateLimitError).retryAfterMs).toBe(40_000);
    }
  });

  it('queues until there is room when told to queue', async () => {
    let now = T0;
    const slept: number[] = [];
    const governor = new RateLimitGovernor({
      quotas: { polygon: { windowSec: 60, maxRequests: 1 } },
      mode: 'queue',
      now: () => now,
      sleep: async (ms) => {
        slept.push(ms);
        now += ms;
      },
    });

    await governor.acquire('polygon', 'rest');
    await governor.acquire('polygon', 'rest');
    expect(slept).toEqual([60_000]);
    expect(governor.waits).toBe(1);
  });

  it('slides the window rather than resetting it', async () => {
    let now = T0;
    const governor = new RateLimitGovernor({
      quotas: { polygon: { windowSec: 60, maxRequests: 2 } },
      mode: 'refuse',
      now: () => now,
    });
    await governor.acquire('polygon', 'rest');
    now += 30_000;
    await governor.acquire('polygon', 'rest');
    now += 31_000;
    // The first has aged out, the second has not.
    await expect(governor.acquire('polygon', 'rest')).resolves.toBeUndefined();
    expect(governor.headroom('polygon', 'rest').used).toBe(2);
  });

  it('reports headroom and flags a key approaching its ceiling', async () => {
    let now = T0;
    const governor = new RateLimitGovernor({
      quotas: { polygon: { windowSec: 60, maxRequests: 5 } },
      now: () => now,
      warnAt: 0.8,
    });

    for (let i = 0; i < 3; i += 1) await governor.acquire('polygon', 'rest');
    expect(governor.headroom('polygon', 'rest')).toMatchObject({
      used: 3,
      limit: 5,
      utilization: 0.6,
      nearCeiling: false,
    });

    await governor.acquire('polygon', 'rest');
    expect(governor.headroom('polygon', 'rest').nearCeiling).toBe(true);
  });

  it('does not limit what the provider does not limit', async () => {
    const governor = new RateLimitGovernor({ quotas: { polygon: { windowSec: 60 } } });
    for (let i = 0; i < 1_000; i += 1) await governor.acquire('polygon', 'rest');
    expect(governor.headroom('polygon', 'rest')).toMatchObject({
      limit: undefined,
      utilization: undefined,
      nearCeiling: false,
    });
  });

  it('takes an override for a paid tier', async () => {
    const governor = new RateLimitGovernor({
      quotas: { polygon: { windowSec: 60, maxRequests: 1 } },
      mode: 'refuse',
    });
    governor.setQuota('polygon', { windowSec: 60, maxRequests: 100 });
    for (let i = 0; i < 100; i += 1) await governor.acquire('polygon', 'rest');
    await expect(governor.acquire('polygon', 'rest')).rejects.toThrow(RateLimitError);
  });

  it('counts a multi-unit reservation as multiple units', async () => {
    const governor = new RateLimitGovernor({
      quotas: { alpaca: { windowSec: 60, maxRequests: 10 } },
      mode: 'refuse',
    });
    await governor.acquire('alpaca', 'ws_subscribe', 8);
    expect(governor.headroom('alpaca', 'ws_subscribe').used).toBe(8);
    await expect(governor.acquire('alpaca', 'ws_subscribe', 5)).rejects.toThrow(RateLimitError);
  });
});

describe('UsageLedger', () => {
  it('buffers and writes in batches rather than one insert per message', async () => {
    const store = new MemoryLedgerStore();
    const ledger = new UsageLedger({ store, batchSize: 100, flushIntervalMs: 60_000 });

    for (let i = 0; i < 99; i += 1) ledger.record(record());
    expect(await store.size()).toBe(0);
    expect(ledger.totals().buffered).toBe(99);

    ledger.record(record());
    await ledger.flush();
    expect(await store.size()).toBe(100);
    expect(ledger.totals().buffered).toBe(0);
    await ledger.close();
  });

  it('flushes on a timer for a feed that never fills a batch', async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryLedgerStore();
      const ledger = new UsageLedger({ store, batchSize: 1_000, flushIntervalMs: 100 });
      ledger.record(record());
      expect(await store.size()).toBe(0);
      await vi.advanceTimersByTimeAsync(150);
      expect(await store.size()).toBe(1);
      await ledger.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the events when a write fails instead of dropping them', async () => {
    const store = new MemoryLedgerStore();
    const failing = {
      ...store,
      append: vi.fn().mockRejectedValueOnce(new Error('database is down')),
      spend: store.spend.bind(store),
      countSince: store.countSince.bind(store),
      getQuota: store.getQuota.bind(store),
      setQuota: store.setQuota.bind(store),
      size: store.size.bind(store),
    };
    const ledger = new UsageLedger({ store: failing, batchSize: 1, flushIntervalMs: 60_000 });
    ledger.record(record());
    await ledger.flush();
    // Still held, ready for the next attempt.
    expect(ledger.totals().buffered).toBe(1);
    expect(ledger.totals().written).toBe(0);
  });

  it('never throws into the data path from a broken sink', () => {
    const ledger = new UsageLedger({
      store: {
        append: () => Promise.reject(new Error('down')),
        spend: async () => [],
        countSince: async () => 0,
        getQuota: async () => null,
        setQuota: async () => {},
        size: async () => 0,
      },
      batchSize: 1,
    });
    expect(() => ledger.sink(record())).not.toThrow();
  });

  it('attributes spend by provider, schema, and kind', async () => {
    const ledger = new UsageLedger({
      store: new MemoryLedgerStore(),
      costModel: { perUnit: { polygon: { ws_message: 2 }, alpaca: { ws_message: 5 } } },
      batchSize: 1_000,
    });

    ledger.record(record({ provider: 'polygon', schema: 'quote_l1', count: 10 }));
    ledger.record(record({ provider: 'polygon', schema: 'trades', count: 5 }));
    ledger.record(record({ provider: 'alpaca', schema: 'quote_l1', count: 4 }));
    ledger.record(record({ provider: 'polygon', kind: 'rest', schema: 'quote_l1' }));

    const since = new Date(T0 - 1);
    expect(await ledger.spend(since, 'provider')).toEqual([
      { key: 'polygon', events: 3, units: 16, costMicro: 30 },
      { key: 'alpaca', events: 1, units: 4, costMicro: 20 },
    ]);
    expect(await ledger.spend(since, 'schema')).toEqual([
      { key: 'quote_l1', events: 3, units: 15, costMicro: 40 },
      { key: 'trades', events: 1, units: 5, costMicro: 10 },
    ]);
    expect((await ledger.spend(since, 'kind')).map((r) => r.key)).toEqual(['ws_message', 'rest']);
    expect(ledger.totals().costMicro).toBe(50);
    await ledger.close();
  });

  it('excludes events before the window', async () => {
    const ledger = new UsageLedger({ store: new MemoryLedgerStore(), batchSize: 1_000 });
    ledger.record(record({ atNs: msToNs(T0 - 86_400_000) }));
    ledger.record(record({ atNs: msToNs(T0) }));
    const rows = await ledger.spend(new Date(T0 - 1_000), 'provider');
    expect(rows[0]!.events).toBe(1);
    await ledger.close();
  });

  it('feeds the governor from recorded usage, so counts include the stream', async () => {
    const governor = new RateLimitGovernor({
      quotas: { polygon: { windowSec: 60, maxRequests: 3 } },
      mode: 'refuse',
    });
    const ledger = new UsageLedger({ store: new MemoryLedgerStore(), governor, batchSize: 1_000 });

    ledger.record(record({ kind: 'rest' }));
    ledger.record(record({ kind: 'rest' }));
    expect(ledger.headroom('polygon', 'rest').used).toBe(2);
    await ledger.acquire('polygon', 'rest');
    await expect(ledger.acquire('polygon', 'rest')).rejects.toThrow(RateLimitError);
    await ledger.close();
  });

  it('hands an adapter hooks bound to one provider', async () => {
    const store = new MemoryLedgerStore();
    const ledger = new UsageLedger({
      store,
      governor: { quotas: { polygon: { windowSec: 60, maxRequests: 1 } }, mode: 'refuse' },
      batchSize: 1,
    });
    const hooks = ledger.hooksFor('polygon');

    await hooks.acquire!('rest', 1);
    await expect(hooks.acquire!('rest', 1)).rejects.toThrow(RateLimitError);

    hooks.sink!(record({ kind: 'ws_message', count: 7 }));
    await ledger.flush();
    expect(store.events[0]).toMatchObject({ provider: 'polygon', kind: 'ws_message', count: 7 });
    await ledger.close();
  });
});
