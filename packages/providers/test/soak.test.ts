import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { polygon } from '../src/polygon/index.js';

/**
 * The full Phase 1 acceptance run: 50 symbols for 30 minutes with zero unhandled rejections and
 * periodic forced reconnects. Too slow for CI, so it is opt-in:
 *
 *   CONDUIT_SOAK=1 pnpm --filter @conduit/providers test
 *   CONDUIT_SOAK=1 CONDUIT_SOAK_MINUTES=30 pnpm --filter @conduit/providers test
 */
const enabled = process.env['CONDUIT_SOAK'] === '1';
const minutes = Number(process.env['CONDUIT_SOAK_MINUTES'] ?? '30');

describe.skipIf(!enabled)('soak', () => {
  it(
    `streams 50 symbols for ${minutes}m with forced reconnects`,
    async () => {
      const rejections: unknown[] = [];
      const onRejection = (reason: unknown) => rejections.push(reason);
      process.on('unhandledRejection', onRejection);

      const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      await new Promise<void>((resolve) => wss.once('listening', resolve));
      const { port } = wss.address() as AddressInfo;
      const sockets: import('ws').WebSocket[] = [];
      let subscribeCount = 0;

      wss.on('connection', (socket) => {
        sockets.push(socket);
        socket.on('message', (raw) => {
          const frame = JSON.parse(raw.toString()) as { action: string };
          if (frame.action === 'auth') {
            socket.send(JSON.stringify([{ ev: 'status', status: 'auth_success', message: 'ok' }]));
          }
          if (frame.action === 'subscribe') subscribeCount += 1;
        });
      });

      const symbols = Array.from({ length: 50 }, (_, i) => `SYM${i}`);
      const adapter = polygon({
        apiKey: 'soak-key-0123456789',
        wsUrl: `ws://127.0.0.1:${port}`,
        backoff: { baseMs: 50, maxMs: 1_000, jitter: 0.2 },
        highWaterMark: 50_000,
        includeRaw: false,
      });

      let received = 0;
      const deadline = Date.now() + minutes * 60_000;
      const producer = setInterval(() => {
        const live = sockets.at(-1);
        if (live?.readyState !== 1) return;
        live.send(
          JSON.stringify(
            symbols.map((sym, i) => ({
              ev: 'Q',
              sym,
              bx: 11,
              bp: 100 + i / 100,
              bs: 3,
              ax: 12,
              ap: 100.01 + i / 100,
              as: 2,
              t: Date.now(),
              q: received + i,
            })),
          ),
        );
      }, 100);
      // Kill the socket every 45s; the consumer must never notice.
      const killer = setInterval(() => sockets.at(-1)?.terminate(), 45_000);

      try {
        for await (const _ of adapter.stream({ symbols, schema: 'quote_l1' })) {
          received += 1;
          if (Date.now() > deadline) break;
        }
      } finally {
        clearInterval(producer);
        clearInterval(killer);
        await adapter.close();
        await new Promise<void>((resolve) => wss.close(() => resolve()));
        process.off('unhandledRejection', onRejection);
      }

      expect(rejections).toEqual([]);
      expect(received).toBeGreaterThan(10_000);
      expect(subscribeCount).toBeGreaterThan(1);
      expect(adapter.health().reconnectCount).toBeGreaterThan(0);
    },
    minutes * 60_000 + 120_000,
  );
});
