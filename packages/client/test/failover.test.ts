import { describe, expect, it } from 'vitest';
import {
  AuthError,
  CoverageError,
  RateLimitError,
  isControl,
  isMarketMessage,
  msToNs,
  type CdmMessage,
  type ControlMessage,
} from '@conduit/core';
import { ConduitClient } from '../src/client.js';
import type { RouterEvent } from '../src/config.js';
import { FakeAdapter } from './fake-adapter.js';

/** Collects into an array in the background so the test can assert on order and timing. */
function collect(stream: AsyncIterable<CdmMessage>) {
  const messages: CdmMessage[] = [];
  const stamps: number[] = [];
  let error: unknown;
  const done = (async () => {
    try {
      for await (const message of stream) {
        messages.push(message);
        stamps.push(Date.now());
      }
    } catch (e) {
      error = e;
    }
  })();
  return {
    messages,
    stamps,
    done,
    get error() {
      return error;
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const FAST = {
  strategy: 'ordered' as const,
  probeIntervalMs: 20,
  staleAfterMs: 150,
  maxConsecutiveFailures: 2,
  healthWindowMs: 100,
};

const T0 = msToNs(1_704_205_800_000);

describe('phase 2 acceptance: revoked key mid-stream', () => {
  it('fails over in under 2 seconds, emits ProviderSwitch, and leaves no longer gap', async () => {
    const polygon = new FakeAdapter('polygon');
    const alpaca = new FakeAdapter('alpaca');
    const events: RouterEvent[] = [];
    const client = new ConduitClient({
      providers: [polygon, alpaca],
      failover: FAST,
      onEvent: (e) => events.push(e),
    });

    const sub = await client.subscribe({ symbols: ['AAPL'], schema: 'quote_l1' });
    const sink = collect(sub);

    polygon.emitQuote('AAPL', T0, 185.1);
    await waitFor(() => sink.messages.length === 1);
    const lastGoodAt = Date.now();
    expect(sub.activeProvider).toBe('polygon');

    // Revoke the key mid-stream.
    polygon.failNow(new AuthError('key revoked', { provider: 'polygon' }));

    await waitFor(() => sub.activeProvider === 'alpaca', 2_000);
    const switchedAt = Date.now();
    expect(switchedAt - lastGoodAt).toBeLessThan(2_000);

    // The switch is announced on the consumer's own stream, before the new data.
    await waitFor(() => sink.messages.some(isControl));
    const control = sink.messages.find(isControl) as ControlMessage;
    expect(control.control).toBe('provider_switch');
    expect(control.previousProvider).toBe('polygon');
    expect(control.provider).toBe('alpaca');
    expect(control.reason).toContain('key revoked');
    expect(control.symbols).toEqual(['AAPL']);

    // Data resumes from the new provider, and the gap is inside the failover window.
    alpaca.emitQuote('AAPL', T0 + 1_000_000_000n, 185.2);
    await waitFor(() => sink.messages.filter(isMarketMessage).length === 2);
    const resumedAt = sink.stamps.at(-1)!;
    expect(resumedAt - lastGoodAt).toBeLessThan(2_000);
    expect(sub.switchCount).toBe(1);
    expect(events.map((e) => e.type)).toContain('switch');

    await sub.close();
    await client.close();
    await sink.done;
  });

  it('drops the replayed history a new provider sends, keeping the consumer in order', async () => {
    const polygon = new FakeAdapter('polygon');
    const alpaca = new FakeAdapter('alpaca');
    const client = new ConduitClient({ providers: [polygon, alpaca], failover: FAST });
    const sub = await client.subscribe({ symbols: ['AAPL'], schema: 'quote_l1' });
    const sink = collect(sub);

    polygon.emitQuote('AAPL', T0 + 5_000_000_000n, 185.5);
    await waitFor(() => sink.messages.length === 1);
    polygon.failNow(new AuthError('key revoked', { provider: 'polygon' }));
    await waitFor(() => sub.activeProvider === 'alpaca', 2_000);

    // Alpaca comes up and replays two seconds of history the consumer already has.
    alpaca.emitQuote('AAPL', T0 + 3_000_000_000n, 185.3);
    alpaca.emitQuote('AAPL', T0 + 4_000_000_000n, 185.4);
    alpaca.emitQuote('AAPL', T0 + 6_000_000_000n, 185.6);

    await waitFor(() => sub.droppedOutOfOrder === 2);
    const forwarded = sink.messages.filter(isMarketMessage);
    expect(forwarded).toHaveLength(2);
    // Timestamps only move forward.
    expect(forwarded[1]!.tsEvent).toBeGreaterThan(forwarded[0]!.tsEvent);

    await sub.close();
    await client.close();
    await sink.done;
  });
});

describe('health-based failover', () => {
  it('switches when the active provider goes stale', async () => {
    const polygon = new FakeAdapter('polygon', { staleAfterMs: 100 });
    const alpaca = new FakeAdapter('alpaca');
    const client = new ConduitClient({ providers: [polygon, alpaca], failover: FAST });
    const sub = await client.subscribe({ symbols: ['AAPL'], schema: 'quote_l1' });
    const sink = collect(sub);

    polygon.emitQuote('AAPL', T0);
    await waitFor(() => sink.messages.length === 1);
    // No further messages: the staleness clock runs past staleAfterMs.
    await waitFor(() => sub.activeProvider === 'alpaca', 2_000);
    const control = sink.messages.find(isControl) as ControlMessage;
    expect(control.reason).toMatch(/no message for \d+ms/);

    await sub.close();
    await client.close();
    await sink.done;
  });

  it('switches at the configured consecutive-failure threshold', async () => {
    const polygon = new FakeAdapter('polygon', { maxConsecutiveFailures: 2 });
    const alpaca = new FakeAdapter('alpaca');
    const client = new ConduitClient({ providers: [polygon, alpaca], failover: FAST });
    const sub = await client.subscribe({ symbols: ['AAPL'], schema: 'quote_l1' });
    const sink = collect(sub);

    polygon.recordFailures(1);
    await new Promise((r) => setTimeout(r, 60));
    expect(sub.activeProvider).toBe('polygon');

    polygon.recordFailures(1);
    await waitFor(() => sub.activeProvider === 'alpaca', 2_000);
    expect((sink.messages.find(isControl) as ControlMessage).reason).toContain(
      'consecutive failures',
    );

    await sub.close();
    await client.close();
    await sink.done;
  });

  it('treats a rate limit as a reason to move, not to stop', async () => {
    const polygon = new FakeAdapter('polygon');
    const alpaca = new FakeAdapter('alpaca');
    const client = new ConduitClient({ providers: [polygon, alpaca], failover: FAST });
    const sub = await client.subscribe({ symbols: ['AAPL'], schema: 'quote_l1' });
    const sink = collect(sub);

    polygon.failNow(new RateLimitError('429', { provider: 'polygon', retryAfterMs: 60_000 }));
    await waitFor(() => sub.activeProvider === 'alpaca', 2_000);
    expect(sink.error).toBeUndefined();

    await sub.close();
    await client.close();
    await sink.done;
  });

  it('fails back to the higher-priority provider once it recovers', async () => {
    const polygon = new FakeAdapter('polygon');
    const alpaca = new FakeAdapter('alpaca');
    const events: RouterEvent[] = [];
    const client = new ConduitClient({
      providers: [polygon, alpaca],
      failover: { ...FAST, healthWindowMs: 50 },
      onEvent: (e) => events.push(e),
    });
    const sub = await client.subscribe({ symbols: ['AAPL'], schema: 'quote_l1' });
    const sink = collect(sub);

    polygon.failNow(new Error('socket died'));
    await waitFor(() => sub.activeProvider === 'alpaca', 2_000);
    alpaca.emitQuote('AAPL', T0);

    // Polygon comes back: a fresh message puts it back to healthy.
    await new Promise((r) => setTimeout(r, 60));
    polygon.emitQuote('AAPL', T0);
    await waitFor(() => sub.activeProvider === 'polygon', 2_000);
    expect(events.map((e) => e.type)).toContain('recovered');
    expect(sub.switchCount).toBe(2);

    await sub.close();
    await client.close();
    await sink.done;
  });

  it('surfaces the error when there is nowhere left to fail over to', async () => {
    const polygon = new FakeAdapter('polygon');
    const client = new ConduitClient({ providers: [polygon], failover: FAST });
    const sub = await client.subscribe({ symbols: ['AAPL'], schema: 'quote_l1' });
    const sink = collect(sub);

    polygon.failNow(new AuthError('key revoked', { provider: 'polygon' }));
    await waitFor(() => sink.error !== undefined, 2_000);
    expect(sink.error).toBeInstanceOf(AuthError);

    await client.close();
  });

  it('treats a clean stream end as a failure worth failing over', async () => {
    const polygon = new FakeAdapter('polygon');
    const alpaca = new FakeAdapter('alpaca');
    const client = new ConduitClient({ providers: [polygon, alpaca], failover: FAST });
    const sub = await client.subscribe({ symbols: ['AAPL'], schema: 'quote_l1' });
    const sink = collect(sub);

    polygon.endNow();
    await waitFor(() => sub.activeProvider === 'alpaca', 2_000);

    await sub.close();
    await client.close();
    await sink.done;
  });
});

describe('coverage selection', () => {
  it('only considers providers that cover the schema and asset class', async () => {
    const polygon = new FakeAdapter('polygon', { capabilities: ['quote_l1', 'trades', 'bars_1m'] });
    const databento = new FakeAdapter('databento', {
      capabilities: ['quote_l1', 'depth_10'],
      assetClasses: ['future'],
    });
    const client = new ConduitClient({ providers: [polygon, databento], failover: FAST });

    expect(client.coverage('quote_l1', 'equity')).toEqual(['polygon']);
    expect(client.coverage('depth_10', 'future')).toEqual(['databento']);
    expect(client.coverage('bars_1d', 'equity')).toEqual([]);
    await client.close();
  });

  it('explains what was configured when nothing covers the request', async () => {
    const polygon = new FakeAdapter('polygon', { capabilities: ['quote_l1'] });
    const client = new ConduitClient({ providers: [polygon], failover: FAST });
    await expect(client.subscribe({ symbols: ['ESZ4'], schema: 'depth_10' })).rejects.toThrow(
      /no configured provider covers depth_10 for equity\. Configured: polygon\(quote_l1\)/,
    );
    await client.close();
  });

  it('honours a symbol-level coverage override', async () => {
    const polygon = new FakeAdapter('polygon');
    const alpaca = new FakeAdapter('alpaca');
    const client = new ConduitClient({
      providers: [polygon, alpaca],
      coverage: { polygon: { symbols: ['AAPL'] } },
      failover: FAST,
    });
    expect(client.coverage('quote_l1', 'equity', ['AAPL'])).toEqual(['polygon', 'alpaca']);
    expect(client.coverage('quote_l1', 'equity', ['BRK.B'])).toEqual(['alpaca']);
    await client.close();
  });

  it('skips a provider whose stream() throws CoverageError synchronously', async () => {
    const databento = new FakeAdapter('databento', {
      streamError: new CoverageError('replay window required', { provider: 'databento' }),
    });
    const alpaca = new FakeAdapter('alpaca');
    const client = new ConduitClient({ providers: [databento, alpaca], failover: FAST });
    const sub = await client.subscribe({ symbols: ['AAPL'], schema: 'quote_l1' });
    const sink = collect(sub);

    await waitFor(() => sub.activeProvider === 'alpaca', 2_000);
    alpaca.emitQuote('AAPL', T0);
    await waitFor(() => sink.messages.filter(isMarketMessage).length === 1);

    await sub.close();
    await client.close();
    await sink.done;
  });
});

describe('strategies', () => {
  it('manual never switches on its own, but switchTo works', async () => {
    const polygon = new FakeAdapter('polygon');
    const alpaca = new FakeAdapter('alpaca');
    const client = new ConduitClient({
      providers: [polygon, alpaca],
      preferredProvider: 'polygon',
      failover: { ...FAST, strategy: 'manual' },
    });
    const sub = await client.subscribe({ symbols: ['AAPL'], schema: 'quote_l1' });
    const sink = collect(sub);

    polygon.recordFailures(5);
    await new Promise((r) => setTimeout(r, 100));
    expect(sub.activeProvider).toBe('polygon');
    expect(sub.switchCount).toBe(0);

    await sub.switchTo('alpaca', 'operator decision');
    expect(sub.activeProvider).toBe('alpaca');
    const control = sink.messages.find(isControl) as ControlMessage;
    expect(control.reason).toBe('operator decision');

    await expect(sub.switchTo('databento')).rejects.toThrow(CoverageError);
    await sub.close();
    await client.close();
    await sink.done;
  });

  it('requires preferredProvider for the manual strategy', () => {
    expect(
      () =>
        new ConduitClient({
          providers: [new FakeAdapter('polygon')],
          failover: { strategy: 'manual' },
        }),
    ).toThrow(/requires preferredProvider/);
  });

  it('lowest-latency orders by a measured probe and keeps unprobeable providers last', async () => {
    const slow = new FakeAdapter('polygon', { snapshotLatencyMs: 60 });
    const fast = new FakeAdapter('alpaca', { snapshotLatencyMs: 1 });
    const unprobeable = new FakeAdapter('databento', {
      snapshotError: new CoverageError('no snapshot endpoint', { provider: 'databento' }),
    });
    const client = new ConduitClient({
      providers: [slow, fast, unprobeable],
      failover: { ...FAST, strategy: 'lowest-latency' },
    });
    const sub = await client.subscribe({ symbols: ['AAPL'], schema: 'quote_l1' });
    expect(sub.activeProvider).toBe('alpaca');
    await sub.close();
    await client.close();
  });

  it('rejects duplicate providers and an empty provider list', () => {
    expect(() => new ConduitClient({ providers: [] })).toThrow(/at least one provider/);
    expect(
      () => new ConduitClient({ providers: [new FakeAdapter('polygon'), new FakeAdapter('polygon')] }),
    ).toThrow(/configured twice/);
  });
});

describe('snapshot routing', () => {
  it('falls through to the next covering provider on failure', async () => {
    const polygon = new FakeAdapter('polygon', {
      snapshotError: new AuthError('revoked', { provider: 'polygon' }),
    });
    const alpaca = new FakeAdapter('alpaca');
    const client = new ConduitClient({ providers: [polygon, alpaca], failover: FAST });

    const quotes = await client.snapshot({ symbols: ['AAPL'] });
    expect(quotes).toHaveLength(1);
    expect(quotes[0]!.provider).toBe('alpaca');
    expect(polygon.snapshotCalls).toBe(1);
    await client.close();
  });

  it('reports every failure when no provider answers', async () => {
    const polygon = new FakeAdapter('polygon', {
      snapshotError: new AuthError('revoked', { provider: 'polygon' }),
    });
    const client = new ConduitClient({ providers: [polygon], failover: FAST });
    await expect(client.snapshot({ symbols: ['AAPL'] })).rejects.toThrow(/polygon: revoked/);
    await client.close();
  });
});

describe('lifecycle', () => {
  it('closes every provider and stops the watchdog', async () => {
    const polygon = new FakeAdapter('polygon');
    const alpaca = new FakeAdapter('alpaca');
    const client = new ConduitClient({ providers: [polygon, alpaca], failover: FAST });
    const sub = await client.subscribe({ symbols: ['AAPL'], schema: 'quote_l1' });
    await client.close();
    expect(polygon.closed).toBe(true);
    expect(alpaca.closed).toBe(true);
    await expect(client.subscribe({ symbols: ['AAPL'], schema: 'quote_l1' })).rejects.toThrow(
      /closed/,
    );
    await sub.close();
  });

  it('ends the subscription when the caller aborts', async () => {
    const polygon = new FakeAdapter('polygon');
    const client = new ConduitClient({ providers: [polygon], failover: FAST });
    const controller = new AbortController();
    const sub = await client.subscribe({
      symbols: ['AAPL'],
      schema: 'quote_l1',
      signal: controller.signal,
    });
    const sink = collect(sub);
    polygon.emitQuote('AAPL', T0);
    await waitFor(() => sink.messages.length === 1);
    controller.abort();
    await sink.done;
    expect(sink.error).toBeUndefined();
    await client.close();
  });

  it('releases the provider stream when the consumer breaks out of the loop', async () => {
    const polygon = new FakeAdapter('polygon');
    const client = new ConduitClient({ providers: [polygon], failover: FAST });
    const sub = await client.subscribe({ symbols: ['AAPL'], schema: 'quote_l1' });
    polygon.emitQuote('AAPL', T0);
    for await (const _ of sub) break;
    await waitFor(() => polygon.openStreams === 0, 2_000);
    await client.close();
  });
});
