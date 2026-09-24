/**
 * Streams quotes from whichever of your configured keys is healthy, and prints every failover.
 *
 *   pnpm build && node --env-file=.env examples/failover.ts
 *
 * Works with whichever subset of keys you have. Missing ones are skipped rather than failing.
 */
import { ConduitClient } from '@conduit/client';
import { alpaca, polygon } from '@conduit/providers';
import { isControl, nsToIso, type ProviderAdapter } from '@conduit/core';

const providers: ProviderAdapter[] = [];
if (process.env['POLYGON_API_KEY']) {
  providers.push(polygon({ apiKey: process.env['POLYGON_API_KEY'] }));
}
if (process.env['ALPACA_API_KEY_ID'] && process.env['ALPACA_API_SECRET_KEY']) {
  providers.push(
    alpaca({
      keyId: process.env['ALPACA_API_KEY_ID'],
      secret: process.env['ALPACA_API_SECRET_KEY'],
      feed: 'iex',
    }),
  );
}

if (providers.length === 0) {
  console.error('No provider keys in the environment. Fill .env first.');
  process.exit(1);
}

const conduit = new ConduitClient({
  providers,
  failover: { strategy: 'ordered', healthWindowMs: 30_000, staleAfterMs: 15_000 },
  onEvent: (event) => console.warn(`[router] ${event.type} ${event.provider}: ${event.reason}`),
});

console.log('coverage for quote_l1/equity:', conduit.coverage('quote_l1', 'equity').join(', '));

const controller = new AbortController();
process.on('SIGINT', () => controller.abort());

const sub = await conduit.subscribe({
  symbols: ['AAPL', 'MSFT', 'SPY'],
  schema: 'quote_l1',
  signal: controller.signal,
});

let count = 0;
for await (const message of sub) {
  if (isControl(message)) {
    console.warn(`[switch] ${message.previousProvider} -> ${message.provider}: ${message.reason}`);
    continue;
  }
  count += 1;
  if (count % 50 === 0) {
    console.log(
      `${message.symbol} ${message.provider} ${nsToIso(message.tsEvent)} (${count} messages, ${sub.switchCount} switches, ${sub.droppedOutOfOrder} dropped)`,
    );
  }
}

await conduit.close();
