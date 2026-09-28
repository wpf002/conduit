import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { HealthTracker, RateLimitError } from '@conduit/core';
import { ReconnectingSocket } from '../src/ws.js';

let wss: WebSocketServer | undefined;
let socket: ReconnectingSocket | undefined;

afterEach(async () => {
  await socket?.close();
  await new Promise<void>((resolve) => (wss ? wss.close(() => resolve()) : resolve()));
  socket = undefined;
  wss = undefined;
});

async function serve(): Promise<{ url: string; connections: ServerSocket[] }> {
  wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss!.once('listening', resolve));
  const { port } = wss.address() as AddressInfo;
  const connections: ServerSocket[] = [];
  wss.on('connection', (c) => connections.push(c));
  return { url: `ws://127.0.0.1:${port}`, connections };
}

function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error('timed out'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe('binary frames', () => {
  it('reports a clear failure rather than feeding msgpack to JSON.parse', async () => {
    const { url, connections } = await serve();
    const health = new HealthTracker({
      provider: 'alpaca',
      staleAfterMs: 10_000,
      maxConsecutiveFailures: 3,
    });
    const text: string[] = [];
    socket = new ReconnectingSocket({
      url,
      health,
      pingIntervalMs: 0,
      onOpen: () => {},
      onText: (data) => text.push(data),
    });
    socket.start();

    await waitFor(() => connections.length === 1);
    // A msgpack frame: fixmap with one key. Not valid UTF-8 JSON.
    connections[0]!.send(Buffer.from([0x81, 0xa1, 0x54, 0xa1, 0x71]));

    await waitFor(() => health.snapshot().consecutiveFailures > 0);
    expect(health.snapshot().lastError).toMatch(/msgpack/);
    // And it did not reach the text handler as mojibake.
    expect(text).toEqual([]);
  });

  it('hands binary to a handler when one is supplied', async () => {
    const { url, connections } = await serve();
    const health = new HealthTracker({
      provider: 'alpaca',
      staleAfterMs: 10_000,
      maxConsecutiveFailures: 3,
    });
    const frames: Buffer[] = [];
    socket = new ReconnectingSocket({
      url,
      health,
      pingIntervalMs: 0,
      onOpen: () => {},
      onText: () => {},
      onBinary: (data) => frames.push(data),
    });
    socket.start();

    await waitFor(() => connections.length === 1);
    connections[0]!.send(Buffer.from([0x81, 0xa1, 0x54]));
    await waitFor(() => frames.length === 1);
    expect(health.snapshot().consecutiveFailures).toBe(0);
  });

  it('still delivers text frames as text', async () => {
    const { url, connections } = await serve();
    const health = new HealthTracker({
      provider: 'polygon',
      staleAfterMs: 10_000,
      maxConsecutiveFailures: 3,
    });
    const text: string[] = [];
    socket = new ReconnectingSocket({
      url,
      health,
      pingIntervalMs: 0,
      onOpen: () => {},
      onText: (data) => text.push(data),
    });
    socket.start();
    await waitFor(() => connections.length === 1);
    connections[0]!.send('[{"ev":"status"}]');
    await waitFor(() => text.length === 1);
    expect(text[0]).toBe('[{"ev":"status"}]');
  });
});

describe('a socket that opens but never becomes productive', () => {
  /**
   * Alpaca's 406 "connection limit exceeded" arrives as an application frame on a socket that
   * completed its handshake perfectly, and the server then closes. Live against a real key this
   * reconnected forever at the base delay and the consumer was never told: `for await` sat on a
   * subscription that had no chance of ever delivering a message.
   */
  async function rejectOnOpen(): Promise<{ url: string; opens: () => number }> {
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((resolve) => wss!.once('listening', resolve));
    const { port } = wss.address() as AddressInfo;
    let opens = 0;
    wss.on('connection', (c) => {
      opens += 1;
      c.send(JSON.stringify({ T: 'error', code: 406, msg: 'connection limit exceeded' }));
      setTimeout(() => c.close(), 5);
    });
    return { url: `ws://127.0.0.1:${port}`, opens: () => opens };
  }

  it('keeps backing off instead of resetting the delay on every open', async () => {
    const { url } = await rejectOnOpen();
    const health = new HealthTracker({
      provider: 'alpaca',
      staleAfterMs: 10_000,
      maxConsecutiveFailures: 99,
    });
    const attempts: number[] = [];
    socket = new ReconnectingSocket({
      url,
      health,
      pingIntervalMs: 0,
      backoff: { baseMs: 5, maxMs: 10_000, jitter: 0 },
      onOpen: () => {},
      onText: () => {},
      onReconnect: (attempt) => attempts.push(attempt),
    });
    socket.start();

    await waitFor(() => attempts.length >= 3, 5_000);
    // The ordinal has to climb. Resetting it on 'open' made every retry the first retry, so the
    // delay never grew and a rejected socket hammered the provider at the base interval.
    expect(attempts.slice(0, 3)).toEqual([1, 2, 3]);
  });

  it('gives up and tells the consumer rather than retrying in silence', async () => {
    const { url } = await rejectOnOpen();
    const health = new HealthTracker({
      provider: 'alpaca',
      staleAfterMs: 10_000,
      maxConsecutiveFailures: 99,
    });
    let fatal: unknown;
    socket = new ReconnectingSocket({
      url,
      health,
      pingIntervalMs: 0,
      backoff: { baseMs: 5, maxMs: 20, jitter: 0 },
      maxUnproductiveAttempts: 3,
      onOpen: () => {},
      onText: () => {},
      onFatal: (error) => (fatal = error),
    });
    socket.start();

    await waitFor(() => fatal !== undefined, 5_000);
    expect(String(fatal)).toMatch(/never delivered/i);
    expect(socket.fatalError).toBeDefined();
  });

  it('restores the full retry budget once a socket has been productive', async () => {
    const { url, connections } = await serve();
    const health = new HealthTracker({
      provider: 'alpaca',
      staleAfterMs: 10_000,
      maxConsecutiveFailures: 99,
    });
    let fatal: unknown;
    const attempts: number[] = [];
    socket = new ReconnectingSocket({
      url,
      health,
      pingIntervalMs: 0,
      backoff: { baseMs: 5, maxMs: 20, jitter: 0 },
      maxUnproductiveAttempts: 2,
      onOpen: () => {},
      onText: () => {},
      onFatal: (error) => (fatal = error),
      onReconnect: (attempt) => attempts.push(attempt),
    });
    socket.start();

    await waitFor(() => connections.length === 1);
    socket.markProductive();
    connections[0]!.close();

    // One drop after a productive session must not count toward a budget spent earlier.
    await waitFor(() => attempts.length >= 1);
    expect(attempts[0]).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fatal).toBeUndefined();
  });
});

describe('a pre-auth rejection', () => {
  /**
   * Alpaca sends 406 within 50ms and then holds the socket open until its own 10s auth timeout. Left
   * to close on its own, every retry cost ten seconds of silence and the four-attempt budget took
   * over forty seconds to spend.
   */
  it('starts the retry immediately instead of waiting for the server to hang up', async () => {
    const { url, connections } = await serve();
    const health = new HealthTracker({
      provider: 'alpaca',
      staleAfterMs: 10_000,
      maxConsecutiveFailures: 99,
    });
    socket = new ReconnectingSocket({
      url,
      health,
      pingIntervalMs: 0,
      backoff: { baseMs: 5, maxMs: 20, jitter: 0 },
      onOpen: () => {},
      onText: () => {},
    });
    socket.start();
    await waitFor(() => connections.length === 1);

    const started = Date.now();
    socket.noteError(new RateLimitError('connection limit exceeded'));
    // The server here never closes anything, which is the point: the client has to.
    await waitFor(() => connections.length >= 2, 2_000);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('a socket that opens and then says nothing', () => {
  /**
   * The failure this exists for, observed live on 2026-09-28: the socket completed its handshake,
   * the adapter sent its auth frame, and the server never answered. The keepalive could not help —
   * pings were answered — so the connection stayed open and idle and the consumer waited on it
   * forever. Nothing in the library bounded "connected but never useful".
   */
  it('terminates and retries a socket that never becomes productive in time', async () => {
    const { url, connections } = await serve();
    const health = new HealthTracker({
      provider: 'alpaca',
      staleAfterMs: 10_000,
      maxConsecutiveFailures: 99,
    });
    const logs: string[] = [];
    let reconnects = 0;
    socket = new ReconnectingSocket({
      url,
      health,
      pingIntervalMs: 0,
      backoff: { baseMs: 5, maxMs: 20, jitter: 0 },
      productiveTimeoutMs: 40,
      onOpen: () => {},
      onText: () => {},
      onReconnect: () => (reconnects += 1),
      logger: (record) => logs.push(record.msg),
    });
    socket.start();

    // The server accepts the connection and then ignores it, which is the whole point.
    await waitFor(() => connections.length === 1);
    await waitFor(() => reconnects >= 1, 2_000);
    expect(logs).toContain('never became productive; terminating');
    // And it opened a second time rather than sitting on the dead one.
    await waitFor(() => connections.length >= 2, 2_000);
  });

  it('leaves a productive socket alone', async () => {
    const { url, connections } = await serve();
    const health = new HealthTracker({
      provider: 'alpaca',
      staleAfterMs: 10_000,
      maxConsecutiveFailures: 99,
    });
    let reconnects = 0;
    socket = new ReconnectingSocket({
      url,
      health,
      pingIntervalMs: 0,
      productiveTimeoutMs: 40,
      onOpen: () => {},
      onText: () => {},
      onReconnect: () => (reconnects += 1),
    });
    socket.start();

    await waitFor(() => connections.length === 1);
    socket.markProductive();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(reconnects).toBe(0);
    expect(socket.connected).toBe(true);
  });
});
