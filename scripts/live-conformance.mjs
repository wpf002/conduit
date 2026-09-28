#!/usr/bin/env node
/**
 * Does it actually work? This is the script that answers that, against a real server.
 *
 *   node scripts/live-conformance.mjs
 *   node scripts/live-conformance.mjs --window 300000     # a longer soak
 *
 * It runs against Alpaca's **test stream** (`/v2/test`, symbol `FAKEPACA`), which is a real Alpaca
 * server speaking the real protocol with synthetic ticks. That distinction is the whole point:
 *
 *   - It DOES settle the protocol. Auth handshake, subscription acks, frame shapes, timestamp
 *     precision, normalization, reconnect and resubscription are all exercised against the vendor's
 *     own implementation rather than against a fake written from the vendor's documentation. Every
 *     bug found on 2026-09-28 was in exactly that gap.
 *   - It does NOT settle price correctness. The ticks are invented, so nothing here proves a price
 *     Conduit emits equals a price that printed. That needs the production feed and a second source.
 *
 * It also needs no data entitlement and does not contend for the production feed's connection slot,
 * so it runs on a free key, outside market hours, on a plan with no subscription.
 *
 * Requires ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY in .env. Exits non-zero on any failure.
 */
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';

// `ws` belongs to @conduit/providers, not to the workspace root, so resolve it from there.
const WebSocket = createRequire(new URL('../packages/providers/package.json', import.meta.url))('ws');

const TEST_WS = 'wss://stream.data.alpaca.markets/v2/test';
const SYMBOL = 'FAKEPACA';

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const keyId = process.env.ALPACA_API_KEY_ID;
const secret = process.env.ALPACA_API_SECRET_KEY;
if (!keyId || !secret) {
  console.error('ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY are required (see .env.example)');
  process.exit(2);
}

const { alpaca } = await import('../packages/providers/dist/index.js');
const { assertCdmInvariants } = await import('../packages/core/dist/index.js');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const WINDOW_MS = Number(arg('window', 60_000));

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

/**
 * The precision assertion, which is the one that matters most: a 19-digit nanosecond epoch does not
 * fit a double, so any path that touches it as a number silently truncates. This compares the
 * bigint against the digits in the vendor's own ISO string.
 */
function nsFromIso(iso) {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d+)Z$/.exec(iso);
  if (!m) return undefined;
  const frac = m[2].padEnd(9, '0').slice(0, 9);
  return BigInt(Date.parse(`${m[1]}Z`)) * 1_000_000n + BigInt(frac);
}

async function collect(schema, windowMs, onAdapter) {
  // The socketFactory seam exists for tests; here it hands the script the live socket so a real
  // connection can be dropped from underneath a running subscription.
  const sockets = [];
  const adapter = alpaca({
    keyId,
    secret,
    wsUrl: TEST_WS,
    // This script is the reason allowSyntheticData exists. Everything else — the CLI, the bridge, any
    // consumer — is refused this endpoint, because FAKEPACA's prices are invented.
    allowSyntheticData: true,
    pingIntervalMs: 0,
    socketFactory: (url) => {
      const socket = new WebSocket(url);
      sockets.push(socket);
      return socket;
    },
  });
  const seen = { messages: 0, invariantErrors: 0, precisionErrors: 0, nonBigint: 0, kinds: {} };
  let thrown;
  const stop = new Promise((r) => setTimeout(r, windowMs));
  const run = (async () => {
    for await (const m of adapter.stream({ symbols: [SYMBOL], schema })) {
      seen.messages += 1;
      seen.kinds[m.kind] = (seen.kinds[m.kind] ?? 0) + 1;
      if (typeof m.tsEvent !== 'bigint') seen.nonBigint += 1;
      try {
        assertCdmInvariants(m);
      } catch {
        seen.invariantErrors += 1;
      }
      const iso = m.raw?.t;
      if (typeof iso === 'string') {
        const expected = nsFromIso(iso);
        if (expected !== undefined && expected !== m.tsEvent) seen.precisionErrors += 1;
      }
    }
  })().catch((error) => (thrown = error));

  if (onAdapter) void onAdapter(adapter, seen, sockets);
  await Promise.race([run, stop]);
  // Snapshot before close(), which records a disconnect and would report every run as 'down'.
  const health = adapter.health();
  await adapter.close();
  return { ...seen, thrown, health };
}

console.log(`live conformance against ${TEST_WS} (${SYMBOL})\n`);

// ---------------------------------------------------------------- per-schema normalization
// bars_1m gets its own window because a minute bar arrives once a minute. bars_1d is absent from this
// list because the test stream does not serve it: subscribing to dailyBars returns an acknowledgement
// with the channel missing, so there is nothing to verify against here.
const SCHEMA_WINDOWS = { trades: 20_000, quote_l1: 20_000, bars_1m: 80_000 };
for (const [schema, floor] of Object.entries(SCHEMA_WINDOWS)) {
  const r = await collect(schema, Math.max(floor, WINDOW_MS / 3));
  check(r.thrown === undefined, `${schema}: stream did not throw`, r.thrown ? String(r.thrown) : '');
  check(r.messages > 0, `${schema}: received messages`, `${r.messages} (${JSON.stringify(r.kinds)})`);
  check(r.invariantErrors === 0, `${schema}: every message satisfies the CDM invariants`);
  check(r.nonBigint === 0, `${schema}: every tsEvent is a bigint`);
  check(
    r.precisionErrors === 0,
    `${schema}: nanosecond precision survives normalization`,
    'compared against the vendor ISO string',
  );
}

// ---------------------------------------------------------------- reconnect and resubscribe
// The fake servers reconnect correctly because they implement what the adapter expects. This drops a
// real connection mid-stream and checks that data resumes, which means auth and every subscription
// were replayed against the vendor's own server.
{
  let droppedAt = 0;
  const r = await collect('trades', Math.max(45_000, WINDOW_MS), async (_adapter, seen, sockets) => {
    // Wait for the first message, then kill the socket from underneath the subscription. terminate()
    // sends no close frame, which is what an actual network failure looks like.
    const deadline = Date.now() + 25_000;
    while (seen.messages === 0 && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 100));
    }
    droppedAt = seen.messages;
    sockets.at(-1)?.terminate();
  });
  check(droppedAt > 0, 'reconnect: a message arrived before the drop', `${droppedAt} messages`);
  check(
    r.health.reconnectCount > 0,
    'reconnect: the socket actually reconnected',
    `reconnectCount=${r.health.reconnectCount}`,
  );
  check(
    r.messages > droppedAt,
    'reconnect: data resumed afterwards, so auth and subscriptions were replayed',
    `${droppedAt} before, ${r.messages} total`,
  );
  check(r.invariantErrors === 0, 'reconnect: no malformed message after resubscribing');
  check(r.health.state === 'healthy', 'reconnect: health recovered', r.health.state);
}

// ---------------------------------------------------------------- the router, over a real feed
// Every failover test in the suite runs between two fakes. This one puts a provider that cannot serve
// anything ahead of a real one and checks that the switch happens and real data arrives after it.
{
  const { ConduitClient } = await import('../packages/client/dist/index.js');
  const { CoverageError } = await import('../packages/core/dist/index.js');

  const broken = {
    id: 'polygon',
    capabilities: new Set(['trades', 'quote_l1']),
    synthetic: false,
    health: () => ({
      provider: 'polygon',
      state: 'down',
      connected: false,
      consecutiveFailures: 9,
      reconnectCount: 0,
      messagesReceived: 0,
      observedAtNs: 0n,
    }),
    supports: () => true,
    snapshot: async () => {
      throw new CoverageError('broken on purpose', { provider: 'polygon' });
    },
    summary: async () => {
      throw new CoverageError('broken on purpose', { provider: 'polygon' });
    },
    stream: () => ({
      // eslint-disable-next-line require-yield
      async *[Symbol.asyncIterator]() {
        throw new CoverageError('broken on purpose', { provider: 'polygon' });
      },
    }),
    close: async () => {},
  };

  const real = alpaca({
    keyId,
    secret,
    wsUrl: TEST_WS,
    allowSyntheticData: true,
    pingIntervalMs: 0,
    socketFactory: (url) => new WebSocket(url),
  });

  const client = new ConduitClient({
    providers: [broken, real],
    failover: { strategy: 'ordered', healthWindowMs: 30_000 },
  });

  let switched;
  let message;
  try {
    const sub = await client.subscribe({ symbols: [SYMBOL], schema: 'trades' });
    const deadline = Date.now() + 40_000;
    for await (const m of sub) {
      if (m.kind === 'control') {
        if (m.control === 'provider_switch' || m.control === 'provider_degraded') switched = m;
        continue;
      }
      message = m;
      break;
    }
    if (Date.now() > deadline) throw new Error('timed out');
  } catch (error) {
    check(false, 'router: subscribing past a broken provider', String(error));
  }
  await client.close();

  check(
    message !== undefined,
    'router: real data arrived past a provider that cannot serve it',
    message ? `${message.kind} ${message.symbol} from ${message.provider}` : 'nothing arrived',
  );
  check(
    message?.provider === 'alpaca',
    'router: the surviving provider is the working one',
    String(message?.provider),
  );
}

console.log(failures === 0 ? '\nlive conformance passed' : `\nlive conformance FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
