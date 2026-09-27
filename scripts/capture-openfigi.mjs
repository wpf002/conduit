#!/usr/bin/env node
/**
 * Refreshes packages/symbology/test/fixtures/openfigi-live.json from the live OpenFIGI v3 API.
 *
 * No API key needed — OpenFIGI allows 25 requests a minute unkeyed, and this uses three. Set
 * OPENFIGI_API_KEY to raise the limit if you extend the case list.
 *
 *   pnpm build && node scripts/capture-openfigi.mjs
 */
import { writeFileSync } from 'node:fs';
import { OpenFigiClient, SymbologyResolver, MemorySymbologyStore } from '../packages/symbology/dist/index.js';

/** Each case exists to exercise something the synthetic fixture can only pretend to test. */
const CASES = [
  ['AAPL', 'plain'], ['MSFT', 'plain'], ['NVDA', 'plain'], ['JPM', 'plain'], ['XOM', 'plain'],
  ['SPY', 'etf'], ['QQQ', 'etf'], ['IWM', 'etf'], ['GLD', 'etf'],
  ['BRK.B', 'class share'], ['BRK.A', 'class share'], ['BF.B', 'class share'],
  ['GOOG', 'class share'], ['GOOGL', 'class share'], ['HEI.A', 'class share'],
  ['META', 'renamed'], ['XYZ', 'renamed'], ['FB', 'freed ticker'], ['SQ', 'freed ticker'],
  ['TWTR', 'delisted'], ['CBRE', 'reused'], ['BABA', 'adr'], ['TSM', 'adr'],
  ['NOSUCHTICKERXYZ', 'unresolvable'],
];

const apiKey = process.env.OPENFIGI_API_KEY;
const resolver = new SymbologyResolver({
  store: new MemorySymbologyStore(),
  openFigi: new OpenFigiClient(apiKey ? { apiKey } : {}),
});

await resolver.prime(CASES.map(([symbol]) => symbol));

const rows = [];
for (const [symbol, why] of CASES) {
  const instrument = await resolver.resolve(symbol);
  rows.push({
    symbol,
    why,
    figi: instrument?.figi ?? null,
    ticker: instrument?.ticker ?? null,
    name: instrument?.name ?? null,
  });
}

writeFileSync(
  'packages/symbology/test/fixtures/openfigi-live.json',
  JSON.stringify(
    {
      note: 'Captured from the live OpenFIGI v3 mapping API, unkeyed, with exchCode US. Real FIGIs.',
      capturedAt: new Date().toISOString().slice(0, 10),
      exchCode: 'US',
      rows,
    },
    null,
    2,
  ) + '\n',
);

const resolved = rows.filter((r) => r.figi).length;
console.log(`captured ${rows.length} cases, ${resolved} resolved, in ${resolver.stats().openFigiCalls} requests`);
