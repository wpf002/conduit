import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import {
  AuthError,
  CdmFlags,
  SchemaError,
  assertCdmInvariants,
  hasFlag,
  isBar,
  isQuote,
  isTrade,
  nsToIso,
  type CdmMessage,
  type MarketMessage,
  type ProviderAdapter,
} from '@conduit/core';
import { alpaca } from '../src/alpaca/index.js';
import { normalizeAlpacaMessage } from '../src/alpaca/normalize.js';

const payloads = readFileSync(join(import.meta.dirname, 'fixtures/alpaca-iex.ndjson'), 'utf8')
  .split('\n')
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l) as unknown);

describe('alpaca fixture replay', () => {
  const normalized = payloads
    .map((p) => normalizeAlpacaMessage(p))
    .filter((m): m is MarketMessage => m !== undefined);

  it('emits only market messages, skipping control frames', () => {
    expect(normalized).toHaveLength(6);
  });

  it('satisfies every CDM invariant', () => {
    for (const message of normalized) expect(() => assertCdmInvariants(message)).not.toThrow();
  });

  it('keeps all nine digits of the RFC-3339 timestamp', () => {
    const quote = normalizeAlpacaMessage(payloads[3]);
    expect(quote!.tsEvent).toBe(1704205800123456789n);
    expect(nsToIso(quote!.tsEvent)).toBe('2024-01-02T14:30:00.123456789Z');
  });

  it('has no sequence number on any message, because Alpaca sends none', () => {
    // docs/cdm-draft.md row 3: gap detection is impossible on this feed.
    expect(normalized.every((m) => m.seq === undefined)).toBe(true);
  });

  it('converts quote round lots to shares and keeps trade sizes as shares', () => {
    // Alpaca still documents quote sizes as round lots. Massive moved to shares on 2025-11-03, so
    // the two adapters deliberately disagree here; do not "fix" this to match Polygon's.
    const quote = normalizeAlpacaMessage(payloads[3]);
    expect(isQuote(quote!) && quote!.bidSz).toBe(300);
    const trade = normalizeAlpacaMessage(payloads[6]);
    expect(isTrade(trade!) && trade!.sz).toBe(400);
  });

  it("carries Alpaca's own single-character venue code verbatim", () => {
    const quote = normalizeAlpacaMessage(payloads[3]);
    expect(isQuote(quote!) && quote!.bidVenue).toBe('V');
    const trade = normalizeAlpacaMessage(payloads[6]);
    expect(isTrade(trade!) && trade!.venue).toBe('K');
  });

  it('maps character condition codes to the same flags Polygon integers map to', () => {
    const oddLot = normalizeAlpacaMessage(payloads[5]);
    expect(hasFlag(oddLot!.flags, CdmFlags.OddLot)).toBe(true);
    expect(hasFlag(oddLot!.flags, CdmFlags.Derived)).toBe(false);
    const formT = normalizeAlpacaMessage(payloads[6]);
    expect(hasFlag(formT!.flags, CdmFlags.TradeThroughExempt)).toBe(true);
  });

  it('distinguishes minute from daily bars and derives the window end', () => {
    const minute = normalizeAlpacaMessage(payloads[7]);
    expect(isBar(minute!) && minute!.interval).toBe('1m');
    expect(isBar(minute!) && minute!.tsEventEnd - minute!.tsEvent).toBe(60_000_000_000n);
    const daily = normalizeAlpacaMessage(payloads[8]);
    expect(isBar(daily!) && daily!.interval).toBe('1d');
    expect(isBar(daily!) && daily!.trades).toBe(220_000);
  });

  it('throws SchemaError on a timestamp that is not RFC-3339', () => {
    expect(() => normalizeAlpacaMessage({ T: 'q', S: 'AAPL', bp: 1, bs: 1, ap: 2, as: 1, t: 1704205800 })).toThrow(
      SchemaError,
    );
  });
});

// ---------------------------------------------------------------- live socket
interface FakeAlpaca {
  readonly url: string;
  readonly connections: ServerSocket[];
  readonly frames: Record<string, unknown>[];
  authMode: 'success' | 'failed';
  send(payload: unknown): void;
  close(): Promise<void>;
}

async function startFakeAlpaca(): Promise<FakeAlpaca> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const { port } = wss.address() as AddressInfo;

  const fake: FakeAlpaca = {
    url: `ws://127.0.0.1:${port}`,
    connections: [],
    frames: [],
    authMode: 'success',
    send(payload) {
      fake.connections
        .at(-1)
        ?.send(JSON.stringify(Array.isArray(payload) ? payload : [payload]));
    },
    async close() {
      for (const socket of fake.connections) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };

  wss.on('connection', (socket) => {
    fake.connections.push(socket);
    socket.send(JSON.stringify([{ T: 'success', msg: 'connected' }]));
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      fake.frames.push(frame);
      if (frame['action'] === 'auth') {
        socket.send(
          JSON.stringify([
            fake.authMode === 'success'
              ? { T: 'success', msg: 'authenticated' }
              : { T: 'error', code: 402, msg: 'auth failed' },
          ]),
        );
      }
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

let fake: FakeAlpaca | undefined;
let adapter: ProviderAdapter | undefined;

afterEach(async () => {
  await adapter?.close();
  await fake?.close();
  adapter = undefined;
  fake = undefined;
});

function connect(): ProviderAdapter {
  return alpaca({
    keyId: 'AKTESTKEYID0123456',
    secret: 'alpaca-secret-0123456789',
    wsUrl: fake!.url,
    backoff: { baseMs: 10, maxMs: 40, jitter: 0 },
    pingIntervalMs: 0,
  });
}

describe('alpaca stream', () => {
  it('subscribes with the per-schema array shape Alpaca expects', async () => {
    fake = await startFakeAlpaca();
    adapter = connect();
    const iterator = adapter.stream({ symbols: ['AAPL'], schema: 'bars_1d' })[
      Symbol.asyncIterator
    ]();
    await waitFor(() => fake!.frames.some((f) => f['action'] === 'subscribe'));
    const subscribe = fake.frames.find((f) => f['action'] === 'subscribe');
    expect(subscribe).toEqual({ action: 'subscribe', dailyBars: ['AAPL'] });

    fake.send(payloads[8]);
    const bar = (await iterator.next()).value as CdmMessage;
    expect(isBar(bar) && bar.interval).toBe('1d');
    await iterator.return?.();
  });

  it('fails the consumer on an auth error code', async () => {
    fake = await startFakeAlpaca();
    fake.authMode = 'failed';
    adapter = connect();
    await expect(async () => {
      for await (const _ of adapter!.stream({ symbols: ['AAPL'], schema: 'quote_l1' })) {
        /* unreachable */
      }
    }).rejects.toThrow(AuthError);
  });

  it('treats a connection-limit error as retryable rather than fatal', async () => {
    fake = await startFakeAlpaca();
    adapter = connect();
    const iterator = adapter.stream({ symbols: ['AAPL'], schema: 'quote_l1' })[
      Symbol.asyncIterator
    ]();
    await waitFor(() => fake!.frames.some((f) => f['action'] === 'subscribe'));
    fake.send({ T: 'error', code: 406, msg: 'connection limit exceeded' });
    await waitFor(() => adapter!.health().consecutiveFailures > 0, 2_000);
    // Still live: a rate limit is a health signal, not a terminal state.
    fake.send(payloads[3]);
    const quote = (await iterator.next()).value as CdmMessage;
    expect(quote.symbol).toBe('AAPL');
    await iterator.return?.();
  });

  it('never leaks the secret into an error', async () => {
    fake = await startFakeAlpaca();
    fake.authMode = 'failed';
    adapter = connect();
    let caught: unknown;
    try {
      for await (const _ of adapter.stream({ symbols: ['AAPL'], schema: 'quote_l1' })) {
        /* unreachable */
      }
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).not.toContain('alpaca-secret-0123456789');
    expect(String(caught)).not.toContain('AKTESTKEYID0123456');
  });
});

describe('alpaca coverage', () => {
  it('covers daily bars, which Polygon does not, and no depth', async () => {
    fake = await startFakeAlpaca();
    adapter = connect();
    expect([...adapter.capabilities].sort()).toEqual([
      'bars_1d',
      'bars_1m',
      'quote_l1',
      'trades',
    ]);
    expect(() => adapter!.stream({ symbols: ['AAPL'], schema: 'depth_10' })).toThrow(
      /no depth_10 feed/,
    );
  });

  it('refuses a replay window, since the stream is live only', async () => {
    fake = await startFakeAlpaca();
    adapter = connect();
    expect(() =>
      adapter!.stream({ symbols: ['AAPL'], schema: 'quote_l1', start: 1n }),
    ).toThrow(/streams live only/);
  });

  it('requires both halves of the credential', () => {
    expect(() => alpaca({ keyId: 'x', secret: '' })).toThrow(AuthError);
    expect(() => alpaca({ keyId: '', secret: 'y' })).toThrow(AuthError);
  });
});
