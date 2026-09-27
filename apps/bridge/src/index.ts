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

const alpacaId = process.env['ALPACA_API_KEY_ID'];
const alpacaSecret = process.env['ALPACA_API_SECRET_KEY'];
if (alpacaId && alpacaSecret) {
  providers.push(
    alpaca({
      keyId: alpacaId,
      secret: alpacaSecret,
      feed: (process.env['ALPACA_FEED'] as 'iex' | 'sip' | undefined) ?? 'iex',
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
