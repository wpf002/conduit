import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProviderAdapter, Schema } from '@conduit/core';
import { alpaca } from '../src/alpaca/index.js';
import { databento } from '../src/databento/index.js';
import { polygon } from '../src/polygon/index.js';
import { tiingo } from '../src/tiingo/index.js';

/**
 * The README's provider table is a promise to whoever reads it. This asserts the code keeps it.
 *
 * It exists because the table has been wrong twice: it claimed Polygon served daily bars and depth,
 * and it listed Tiingo as a provider for months with no adapter behind it. A table nobody checks
 * drifts, so this makes the docs a test rather than a hope.
 */
const README = readFileSync(join(import.meta.dirname, '../../../README.md'), 'utf8');

interface Claim {
  readonly provider: string;
  readonly quotes: boolean;
  readonly trades: boolean;
  readonly bars: readonly Schema[];
  readonly depth: boolean;
  readonly live: boolean;
  readonly replay: boolean;
}

function parseProviderTable(): Claim[] {
  const lines = README.split('\n');
  const header = lines.findIndex((l) => /^\|\s*Provider\s*\|\s*Quotes\s*\|/.test(l));
  if (header === -1) throw new Error('README has no provider table with the expected columns');

  const claims: Claim[] = [];
  // Skip the header and the separator row.
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith('|')) break;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 7) continue;
    const [provider, quotes, trades, bars, depth, live, replay] = cells as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const barSchemas: Schema[] = [];
    if (bars.includes('1m')) barSchemas.push('bars_1m');
    if (bars.includes('1d')) barSchemas.push('bars_1d');
    claims.push({
      provider: provider.toLowerCase(),
      quotes: quotes === 'yes',
      trades: trades === 'yes',
      bars: barSchemas,
      depth: depth === 'yes',
      live: live === 'yes',
      replay: replay === 'yes',
    });
  }
  return claims;
}

/** Constructed with throwaway credentials; nothing here makes a network call. */
function adapters(): Record<string, ProviderAdapter> {
  return {
    polygon: polygon({ apiKey: 'readme-conformance-key' }),
    alpaca: alpaca({ keyId: 'readme-conformance-id', secret: 'readme-conformance-secret' }),
    databento: databento({ apiKey: 'readme-conformance-key', dataset: 'XNAS.ITCH' }),
    tiingo: tiingo({ apiKey: 'readme-conformance-key' }),
  };
}

/** Does the adapter accept a subscription of this shape, or throw CoverageError? */
function accepts(adapter: ProviderAdapter, schema: Schema, replay: boolean): boolean {
  try {
    adapter.stream({
      symbols: ['AAPL'],
      schema,
      ...(replay ? { start: 1_704_153_600_000_000_000n } : {}),
    });
    return true;
  } catch {
    return false;
  }
}

describe('the README provider table', () => {
  const claims = parseProviderTable();
  const built = adapters();

  it('lists every adapter this package exports, and no others', () => {
    expect(claims.map((c) => c.provider).sort()).toEqual(Object.keys(built).sort());
  });

  it.each(claims)('$provider serves exactly what the table claims', (claim) => {
    const adapter = built[claim.provider];
    expect(adapter, `README lists ${claim.provider} but no adapter exists`).toBeDefined();

    const capabilities = adapter!.capabilities;
    expect(capabilities.has('quote_l1'), 'quotes').toBe(claim.quotes);
    expect(capabilities.has('trades'), 'trades').toBe(claim.trades);
    expect(capabilities.has('depth_10'), 'depth').toBe(claim.depth);
    expect(capabilities.has('bars_1m'), 'bars 1m').toBe(claim.bars.includes('bars_1m'));
    expect(capabilities.has('bars_1d'), 'bars 1d').toBe(claim.bars.includes('bars_1d'));
  });

  it.each(claims)('$provider supports live and replay as the table claims', (claim) => {
    const adapter = built[claim.provider]!;
    const schema = [...adapter.capabilities][0]!;
    const assetClass = claim.provider === 'databento' ? 'future' : 'equity';

    // Live means a subscription with no time window is accepted.
    let live = false;
    try {
      adapter.stream({ symbols: ['AAPL'], schema, assetClass });
      live = true;
    } catch {
      live = false;
    }
    expect(live, `${claim.provider} live`).toBe(claim.live);

    let replay = false;
    try {
      adapter.stream({
        symbols: ['AAPL'],
        schema,
        assetClass,
        start: 1_704_153_600_000_000_000n,
      });
      replay = true;
    } catch {
      replay = false;
    }
    expect(replay, `${claim.provider} replay`).toBe(claim.replay);
  });

  it('never claims a schema no adapter serves', () => {
    const claimed = new Set<Schema>();
    for (const claim of claims) {
      if (claim.quotes) claimed.add('quote_l1');
      if (claim.trades) claimed.add('trades');
      if (claim.depth) claimed.add('depth_10');
      for (const bar of claim.bars) claimed.add(bar);
    }
    const served = new Set<Schema>();
    for (const adapter of Object.values(built)) {
      for (const schema of adapter.capabilities) served.add(schema);
    }
    expect([...claimed].sort()).toEqual([...served].sort());
  });
});

export { accepts };
