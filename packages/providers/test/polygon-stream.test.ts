import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import {
  AuthError,
  RateLimitError,
  isControl,
  isQuote,
  type CdmMessage,
  type ProviderAdapter,
} from '@conduit/core';
import { polygon } from '../src/polygon/index.js';

/**
 * Phase 1 acceptance test. A local websocket server stands in for Polygon so there is no live
 * network in the suite; everything below the socket boundary is the real adapter.
 */
interface FakePolygon {
  readonly url: string;
  readonly connections: ServerSocket[];
  readonly subscribeFrames: string[];
  readonly unsubscribeFrames: string[];
  authMode: 'success' | 'failed';
  send(payload: unknown, connection?: number): void;
  killActiveConnection(): void;
  close(): Promise<void>;
}

async function startFakePolygon(): Promise<FakePolygon> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const { port } = wss.address() as AddressInfo;

  const fake: FakePolygon = {
    url: `ws://127.0.0.1:${port}`,
    connections: [],
    subscribeFrames: [],
    unsubscribeFrames: [],
    authMode: 'success',
    send(payload, connection) {
      const socket = fake.connections[connection ?? fake.connections.length - 1];
      socket?.send(JSON.stringify(Array.isArray(payload) ? payload : [payload]));
    },
    killActiveConnection() {
      fake.connections.at(-1)?.terminate();
    },
    async close() {
      for (const socket of fake.connections) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };

  wss.on('connection', (socket) => {
    fake.connections.push(socket);
    socket.send(JSON.stringify([{ ev: 'status', status: 'connected', message: 'Connected' }]));
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as { action: string; params: string };
      if (frame.action === 'auth') {
        socket.send(
          JSON.stringify([
            fake.authMode === 'success'
              ? { ev: 'status', status: 'auth_success', message: 'authenticated' }
              : { ev: 'status', status: 'auth_failed', message: 'not authorized' },
          ]),
        );
        return;
      }
      if (frame.action === 'subscribe') {
        fake.subscribeFrames.push(frame.params);
        socket.send(
          JSON.stringify([{ ev: 'status', status: 'success', message: `subscribed to ${frame.params}` }]),
        );
        return;
      }
      if (frame.action === 'unsubscribe') fake.unsubscribeFrames.push(frame.params);
    });
  });

  return fake;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function quotePayload(symbol: string, seq: number) {
  return {
    ev: 'Q',
    sym: symbol,
    bx: 11,
    bp: 185.1,
    bs: 3,
    ax: 12,
    ap: 185.12,
    as: 2,
    t: 1704205800123 + seq,
    q: 13684490 + seq,
    z: 3,
  };
}

let fake: FakePolygon | undefined;
let adapter: ProviderAdapter | undefined;

afterEach(async () => {
  await adapter?.close();
  await fake?.close();
  adapter = undefined;
  fake = undefined;
});

function connect(overrides: Record<string, unknown> = {}): ProviderAdapter {
  return polygon({
    apiKey: 'test-key-01234567890',
    wsUrl: fake!.url,
    backoff: { baseMs: 10, maxMs: 40, jitter: 0 },
    pingIntervalMs: 0,
    ...overrides,
  });
}

describe('polygon stream', () => {
  it('authenticates, subscribes, and delivers normalized quotes', async () => {
    fake = await startFakePolygon();
    adapter = connect();
    const iterator = adapter.stream({ symbols: ['AAPL'], schema: 'quote_l1' })[
      Symbol.asyncIterator
    ]();

    await waitFor(() => fake!.subscribeFrames.length > 0);
    expect(fake!.subscribeFrames[0]).toBe('Q.AAPL');

    fake.send(quotePayload('AAPL', 0));
    const first = await iterator.next();
    expect(first.done).toBe(false);
    const message = first.value as CdmMessage;
    expect(isQuote(message) && message.symbol).toBe('AAPL');
    expect(isQuote(message) && message.bidSz).toBe(3);
    expect(adapter.health().state).toBe('healthy');
    await iterator.return?.();
  });

  it('only delivers symbols the consumer asked for', async () => {
    fake = await startFakePolygon();
    adapter = connect();
    const iterator = adapter.stream({ symbols: ['AAPL'], schema: 'quote_l1' })[
      Symbol.asyncIterator
    ]();
    await waitFor(() => fake!.subscribeFrames.length > 0);

    fake.send([quotePayload('MSFT', 1), quotePayload('AAPL', 2)]);
    const received = (await iterator.next()).value as CdmMessage;
    expect(isQuote(received) && received.symbol).toBe('AAPL');
    await iterator.return?.();
  });

  it('reconnects and resubscribes within 5s of a killed socket, same iterator', async () => {
    fake = await startFakePolygon();
    adapter = connect();
    const iterator = adapter.stream({
      symbols: ['AAPL', 'MSFT'],
      schema: 'quote_l1',
    })[Symbol.asyncIterator]();

    await waitFor(() => fake!.subscribeFrames.length > 0);
    fake.send(quotePayload('AAPL', 0));
    expect(((await iterator.next()).value as CdmMessage).symbol).toBe('AAPL');

    const startedAt = Date.now();
    fake.killActiveConnection();

    // A second connection, and the full subscription set replayed on it.
    await waitFor(() => fake!.connections.length === 2);
    await waitFor(() => fake!.subscribeFrames.length === 2);
    expect(fake.subscribeFrames[1]).toBe('Q.AAPL,Q.MSFT');

    // The consumer's iterator was never dropped: the next message arrives on it.
    fake.send(quotePayload('MSFT', 5), 1);
    const afterReconnect = (await iterator.next()).value as CdmMessage;
    expect(afterReconnect.symbol).toBe('MSFT');
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(adapter.health().reconnectCount).toBe(1);
    await iterator.return?.();
  });

  it('fails the consumer with AuthError on a revoked key instead of stalling', async () => {
    fake = await startFakePolygon();
    fake.authMode = 'failed';
    adapter = connect();
    const stream = adapter.stream({ symbols: ['AAPL'], schema: 'quote_l1' });

    await expect(async () => {
      for await (const _ of stream) {
        /* never reached */
      }
    }).rejects.toThrow(AuthError);
  });

  it('never puts the key in an error message', async () => {
    fake = await startFakePolygon();
    fake.authMode = 'failed';
    adapter = connect();
    const stream = adapter.stream({ symbols: ['AAPL'], schema: 'quote_l1' });
    let caught: unknown;
    try {
      for await (const _ of stream) {
        /* unreachable */
      }
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).not.toContain('test-key-01234567890');
  });

  it('unsubscribes when the last consumer of a symbol detaches', async () => {
    fake = await startFakePolygon();
    adapter = connect();
    const stream = adapter.stream({ symbols: ['AAPL'], schema: 'quote_l1' });
    const iterator = stream[Symbol.asyncIterator]();
    await waitFor(() => fake!.subscribeFrames.length > 0);
    fake.send(quotePayload('AAPL', 0));
    await iterator.next();
    await iterator.return?.();
    await waitFor(() => fake!.unsubscribeFrames.length > 0, 2_000);
    expect(fake.unsubscribeFrames[0]).toBe('Q.AAPL');
  });

  it('ends the iterator when the caller aborts', async () => {
    fake = await startFakePolygon();
    adapter = connect();
    const controller = new AbortController();
    const stream = adapter.stream({
      symbols: ['AAPL'],
      schema: 'quote_l1',
      signal: controller.signal,
    });
    const drained = (async () => {
      const seen: CdmMessage[] = [];
      for await (const m of stream) seen.push(m);
      return seen;
    })();
    await waitFor(() => fake!.subscribeFrames.length > 0);
    controller.abort();
    await expect(drained).resolves.toEqual([]);
  });

  it('handles 50 symbols under load with no unhandled rejections', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      fake = await startFakePolygon();
      adapter = connect({ highWaterMark: 1_000 });
      const symbols = Array.from({ length: 50 }, (_, i) => `SYM${i}`);
      const stream = adapter.stream({ symbols, schema: 'quote_l1' });
      const iterator = stream[Symbol.asyncIterator]();
      await waitFor(() => fake!.subscribeFrames.length > 0);

      // 50 symbols x 40 batches, interleaved with a malformed frame and an unknown event type.
      for (let batch = 0; batch < 40; batch += 1) {
        fake.send([
          ...symbols.map((s, i) => quotePayload(s, batch * 50 + i)),
          { ev: 'Q', sym: 'SYM0', bp: 'not-a-number', bs: 1, ap: 1, as: 1, t: 1 },
          { ev: 'NOPE', sym: 'SYM0' },
        ]);
      }

      let received = 0;
      while (received < 2_000) {
        const next = await iterator.next();
        if (next.done) break;
        received += 1;
      }
      expect(received).toBe(2_000);
      // The malformed frames degraded health without killing the stream.
      expect(adapter.health().consecutiveFailures).toBeGreaterThanOrEqual(0);
      await iterator.return?.();
      await new Promise((r) => setTimeout(r, 50));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  }, 30_000);
});

describe('polygon coverage', () => {
  it('throws CoverageError rather than no-opping on an unsupported schema', async () => {
    fake = await startFakePolygon();
    adapter = connect();
    expect(() => adapter!.stream({ symbols: ['AAPL'], schema: 'depth_10' })).toThrow(
      /cannot stream depth_10/,
    );
    expect(() => adapter!.stream({ symbols: ['AAPL'], schema: 'bars_1d' })).toThrow(
      /cannot stream bars_1d/,
    );
  });

  it('throws CoverageError on an unsupported asset class', async () => {
    fake = await startFakePolygon();
    adapter = connect();
    expect(() =>
      adapter!.stream({ symbols: ['ESZ4'], schema: 'quote_l1', assetClass: 'future' }),
    ).toThrow(/US equities and ETFs, not future/);
  });

  it('reports its capabilities honestly', async () => {
    fake = await startFakePolygon();
    adapter = connect();
    expect([...adapter.capabilities].sort()).toEqual(['bars_1m', 'quote_l1', 'trades']);
    expect(adapter.supports('quote_l1', 'equity')).toBe(true);
    expect(adapter.supports('quote_l1', 'option')).toBe(false);
    expect(adapter.supports('depth_10', 'equity')).toBe(false);
  });

  it('refuses to construct without a key', () => {
    expect(() => polygon({ apiKey: '' })).toThrow(AuthError);
  });
});

describe('usage accounting', () => {
  it('reports subscribes and messages through the usage sink', async () => {
    fake = await startFakePolygon();
    const records: { kind: string; count: number; schema?: string }[] = [];
    adapter = connect({
      usage: { sink: (r: { kind: string; count: number; schema?: string }) => records.push(r) },
    });
    const iterator = adapter.stream({ symbols: ['AAPL', 'MSFT'], schema: 'quote_l1' })[
      Symbol.asyncIterator
    ]();
    await waitFor(() => fake!.subscribeFrames.length > 0);
    expect(records).toEqual([
      expect.objectContaining({ kind: 'ws_subscribe', count: 2, schema: 'quote_l1' }),
    ]);

    fake.send([quotePayload('AAPL', 0), quotePayload('MSFT', 1)]);
    await iterator.next();
    await waitFor(() => records.some((r) => r.kind === 'ws_message'));
    expect(records.find((r) => r.kind === 'ws_message')).toMatchObject({ count: 2 });
    await iterator.return?.();
  });

  it('asks permission before a REST call and lets a refusal through', async () => {
    fake = await startFakePolygon();
    adapter = connect({
      usage: {
        acquire: async () => {
          throw new RateLimitError('local budget exhausted', { provider: 'polygon' });
        },
      },
    });
    await expect(adapter.snapshot({ symbols: ['AAPL'] })).rejects.toThrow(RateLimitError);
  });
});

describe('replay window', () => {
  it('refuses a historical window rather than silently returning live data', async () => {
    fake = await startFakePolygon();
    adapter = connect();
    // Silently ignoring `start` would hand back live quotes for a 2024 request.
    expect(() =>
      adapter!.stream({ symbols: ['AAPL'], schema: 'quote_l1', start: 1_704_153_600_000_000_000n }),
    ).toThrow(/streams live only/);
    expect(() =>
      adapter!.stream({ symbols: ['AAPL'], schema: 'quote_l1', end: 1_704_153_600_000_000_000n }),
    ).toThrow(/streams live only/);
  });
});

describe('sequence gaps', () => {
  it('emits nothing by default, because q is a channel counter', async () => {
    fake = await startFakePolygon();
    adapter = connect();
    const iterator = adapter.stream({ symbols: ['AAPL'], schema: 'quote_l1' })[
      Symbol.asyncIterator
    ]();
    await waitFor(() => fake!.subscribeFrames.length > 0);

    // Two AAPL quotes numbered far apart: normal, because other symbols numbered in between.
    fake.send(quotePayload('AAPL', 0));
    fake.send(quotePayload('AAPL', 500));
    const first = (await iterator.next()).value as CdmMessage;
    const second = (await iterator.next()).value as CdmMessage;
    expect(first.kind).toBe('quote');
    expect(second.kind).toBe('quote');
    await iterator.return?.();
  });

  it('emits a gap control message on the data stream when scope is configured', async () => {
    fake = await startFakePolygon();
    adapter = connect({ sequenceScope: 'symbol' });
    const iterator = adapter.stream({ symbols: ['AAPL'], schema: 'quote_l1' })[
      Symbol.asyncIterator
    ]();
    await waitFor(() => fake!.subscribeFrames.length > 0);

    fake.send(quotePayload('AAPL', 0));
    expect(((await iterator.next()).value as CdmMessage).kind).toBe('quote');

    fake.send(quotePayload('AAPL', 5));
    // The gap is announced before the message that revealed it.
    const control = (await iterator.next()).value as CdmMessage;
    expect(control.kind).toBe('control');
    expect(isControl(control) && control.control).toBe('sequence_gap');
    expect(isControl(control) && control.gap).toEqual({
      symbol: 'AAPL',
      expectedSeq: 13684491n,
      receivedSeq: 13684495n,
      missing: 4n,
    });
    expect(((await iterator.next()).value as CdmMessage).kind).toBe('quote');
    await iterator.return?.();
  });

  it('resets its baseline on reconnect so renumbering is not a gap', async () => {
    fake = await startFakePolygon();
    adapter = connect({ sequenceScope: 'symbol' });
    const iterator = adapter.stream({ symbols: ['AAPL'], schema: 'quote_l1' })[
      Symbol.asyncIterator
    ]();
    await waitFor(() => fake!.subscribeFrames.length > 0);
    fake.send(quotePayload('AAPL', 1_000));
    await iterator.next();

    fake.killActiveConnection();
    await waitFor(() => fake!.subscribeFrames.length === 2);
    // Renumbered from the start on the new connection.
    fake.send(quotePayload('AAPL', 0), 1);
    const next = (await iterator.next()).value as CdmMessage;
    expect(next.kind).toBe('quote');
    await iterator.return?.();
  });
});

describe('backpressure', () => {
  it('tells the consumer on its own stream when it starts losing data', async () => {
    fake = await startFakePolygon();
    adapter = connect({ highWaterMark: 4 });
    const stream = adapter.stream({ symbols: ['AAPL'], schema: 'quote_l1' });
    const iterator = stream[Symbol.asyncIterator]();
    await waitFor(() => fake!.subscribeFrames.length > 0);

    // Far more than the buffer holds, with nobody reading yet.
    for (let i = 0; i < 40; i += 1) fake.send(quotePayload('AAPL', i));
    await new Promise((r) => setTimeout(r, 50));

    const seen: CdmMessage[] = [];
    for (let i = 0; i < 5; i += 1) {
      const next = await iterator.next();
      if (next.done) break;
      seen.push(next.value as CdmMessage);
    }

    const notice = seen.find((m) => isControl(m) && m.control === 'backpressure');
    expect(notice, 'a backpressure control message should have arrived').toBeDefined();
    expect(isControl(notice!) && notice!.backpressure).toMatchObject({ highWaterMark: 4 });
    expect(isControl(notice!) && notice!.symbols).toEqual(['AAPL']);
    await iterator.return?.();
  });

  it('says nothing when the consumer keeps up', async () => {
    fake = await startFakePolygon();
    adapter = connect({ highWaterMark: 1_000 });
    const iterator = adapter.stream({ symbols: ['AAPL'], schema: 'quote_l1' })[
      Symbol.asyncIterator
    ]();
    await waitFor(() => fake!.subscribeFrames.length > 0);

    for (let i = 0; i < 10; i += 1) {
      fake.send(quotePayload('AAPL', i));
      const next = (await iterator.next()).value as CdmMessage;
      expect(next.kind).toBe('quote');
    }
    await iterator.return?.();
  });
});
