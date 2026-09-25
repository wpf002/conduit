import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { HealthTracker } from '@conduit/core';
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
