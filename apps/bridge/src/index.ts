#!/usr/bin/env node
/**
 * Conduit as a subprocess, for consumers that are not TypeScript.
 *
 * Reads newline-delimited JSON requests on stdin and writes responses on stdout. Diagnostics go to
 * stderr so they never corrupt the protocol stream.
 *
 *   node apps/bridge/dist/index.js
 *
 * The parent process owns its lifetime. There is no socket and no port, so there is nothing
 * listening to secure, and market data goes provider → this process → the parent's pipe without
 * leaving the machine.
 */
import { config as loadDotenv } from 'dotenv';
import { consoleLogger, type ProviderAdapter } from '@conduit/core';
import { ConduitClient } from '@conduit/client';
import { alpaca, databento, polygon, tiingo } from '@conduit/providers';
import { BridgeServer } from './server.js';

loadDotenv({ quiet: true });

const logger = consoleLogger({
  level: (process.env['CONDUIT_LOG_LEVEL'] as 'debug' | 'info' | 'warn' | 'error') ?? 'warn',
});

const providers: ProviderAdapter[] = [];
const polygonKey = process.env['POLYGON_API_KEY'];
if (polygonKey) providers.push(polygon({ apiKey: polygonKey, logger }));

/**
 * ALPACA_FEED, validated rather than cast. The `as 'iex' | 'sip'` this replaces let any string
 * through, and Alpaca's sandbox is a feed name away from a real one: ALPACA_FEED=test built
 * wss://stream.data.alpaca.markets/v2/test and served invented FAKEPACA prices to whatever was
 * consuming this process, silently. The adapter now refuses that too; this is the earlier, clearer
 * error.
 */
function alpacaFeed(): 'iex' | 'sip' | 'delayed_sip' {
  const raw = process.env['ALPACA_FEED'];
  if (raw === undefined || raw === '') return 'iex';
  if (raw === 'iex' || raw === 'sip' || raw === 'delayed_sip') return raw;
  throw new Error(
    `ALPACA_FEED must be iex, sip or delayed_sip; received ${JSON.stringify(raw)}. ` +
      `"test" is Alpaca's sandbox and serves prices nobody traded at.`,
  );
}

const alpacaId = process.env['ALPACA_API_KEY_ID'];
const alpacaSecret = process.env['ALPACA_API_SECRET_KEY'];
if (alpacaId && alpacaSecret) {
  providers.push(
    alpaca({
      keyId: alpacaId,
      secret: alpacaSecret,
      feed: alpacaFeed(),
      logger,
    }),
  );
}

const databentoKey = process.env['DATABENTO_API_KEY'];
const dataset = process.env['DATABENTO_DATASET'];
if (databentoKey && dataset) providers.push(databento({ apiKey: databentoKey, dataset }));

const tiingoKey = process.env['TIINGO_API_KEY'];
if (tiingoKey) providers.push(tiingo({ apiKey: tiingoKey }));

if (providers.length === 0) {
  process.stderr.write('conduit-bridge: no provider keys in the environment\n');
  process.exit(1);
}

// The bridge is what a non-TypeScript consumer sees, and it cannot inspect the adapters it got. A
// consumer asked for market data; handing it a vendor sandbox's invented prices over the same
// interface is worse than handing it nothing, because nothing fails loudly. Refuse to start.
const synthetic = providers.filter((p) => p.synthetic).map((p) => p.id);
if (synthetic.length > 0 && process.env['CONDUIT_ALLOW_SYNTHETIC'] !== '1') {
  process.stderr.write(
    `conduit-bridge: ${synthetic.join(', ')} is configured against a vendor sandbox that serves ` +
      `invented prices. Refusing to serve it. Set CONDUIT_ALLOW_SYNTHETIC=1 only if a fake price is ` +
      `genuinely what the consumer wants.\n`,
  );
  process.exit(1);
}

const server = new BridgeServer({
  client: new ConduitClient({
    providers,
    onEvent: (event) =>
      logger({
        level: 'warn',
        msg: `router ${event.type}`,
        provider: event.provider,
        fields: { reason: event.reason },
      }),
  }),
  write: (line) => process.stdout.write(line),
  onShutdown: () => process.exit(0),
});

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => server.feed(chunk));
// The parent closing its end is the normal way this exits.
process.stdin.on('end', () => void server.close().then(() => process.exit(0)));
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void server.close().then(() => process.exit(0)));
}

server.ready();
