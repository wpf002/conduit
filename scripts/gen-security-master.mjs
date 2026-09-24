#!/usr/bin/env node
/**
 * Builds the Phase 3 acceptance fixture: a 200-query security master that deliberately includes
 * class shares, preferreds, warrants, units, ADRs, a ticker change, a delisting, and a ticker that
 * was reused after one.
 *
 * The FIGIs are synthetic. They are shaped exactly like real ones — 'BBG', eight characters from
 * the FIGI alphabet, a check digit — and are deterministic per ticker, so the fixture is stable
 * across runs. What this fixture tests is resolution logic: vendor spellings, temporal windows, and
 * ticker reuse. It does not test whether OpenFIGI's real answers are correct; that needs a live run
 * with a key.
 *
 *   node scripts/gen-security-master.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const OUT = 'packages/symbology/test/fixtures/security-master.json';

// The FIGI alphabet excludes A, E, I, O and U to avoid look-alikes and accidental words.
const ALPHABET = '0123456789BCDFGHJKLMNPQRSTVWXYZ';

function figiFor(seed) {
  const hash = createHash('sha256').update(`conduit-fixture:${seed}`).digest();
  let body = '';
  for (let i = 0; i < 8; i += 1) body += ALPHABET[hash[i] % ALPHABET.length];
  return `BBG${body}${hash[8] % 10}`;
}

const instruments = [];
const queries = [];

function instrument(ticker, opts = {}) {
  const record = {
    figi: opts.figi ?? figiFor(ticker),
    // The key in `instruments` may be a disambiguating label (CBRE-old); the ticker is what the
    // instrument actually trades as.
    ticker: opts.ticker ?? ticker,
    name: opts.name ?? `${ticker} Inc`,
    assetClass: opts.assetClass ?? 'equity',
    exchangeMic: opts.exchangeMic ?? 'XNAS',
    currency: 'USD',
    active: opts.active ?? true,
    mappings: opts.mappings ?? [
      { symbol: ticker, validFrom: '2000-01-01T00:00:00.000Z', validTo: null },
    ],
  };
  instruments.push(record);
  return record;
}

function query(symbol, provider, asOf, expectFigi, why) {
  queries.push({ symbol, provider, asOf, expectFigi, why });
}

// ------------------------------------------------------------------ plain names
const PLAIN = [
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'GOOG', 'TSLA', 'JPM', 'XOM', 'UNH',
  'JNJ', 'V', 'PG', 'MA', 'HD', 'CVX', 'MRK', 'ABBV', 'PEP', 'KO',
  'COST', 'WMT', 'MCD', 'CSCO', 'CRM', 'ACN', 'ADBE', 'AMD', 'INTC', 'QCOM',
  'TXN', 'NFLX', 'CMCSA', 'PFE', 'T', 'VZ', 'BAC', 'WFC', 'GS', 'MS',
  'F', 'GM', 'GE', 'BA', 'CAT', 'DE', 'MMM', 'HON', 'LMT', 'RTX',
];
for (const ticker of PLAIN) {
  const record = instrument(ticker);
  query(ticker, 'polygon', '2024-06-03T00:00:00.000Z', record.figi, 'plain ticker');
}

// ETFs, which OpenFIGI classifies as ETP rather than Common Stock.
for (const ticker of ['SPY', 'QQQ', 'IWM', 'VTI', 'VOO', 'EEM', 'TLT', 'GLD', 'XLF', 'ARKK']) {
  const record = instrument(ticker, { assetClass: 'etf', exchangeMic: 'ARCX' });
  query(ticker, 'alpaca', '2024-06-03T00:00:00.000Z', record.figi, 'etf');
}

// ---------------------------------------------------------------- class shares
// Every vendor spells these differently. The same instrument has to resolve from all four.
const CLASS_SHARES = [
  ['BRK', 'B', 'Berkshire Hathaway'],
  ['BF', 'B', 'Brown-Forman'],
  ['LEN', 'B', 'Lennar'],
  ['HEI', 'A', 'HEICO'],
  ['MOG', 'A', 'Moog'],
  ['CWEN', 'A', 'Clearway Energy'],
  ['LGF', 'B', 'Lions Gate'],
  ['CRD', 'B', 'Crawford'],
];
for (const [root, cls, name] of CLASS_SHARES) {
  const record = instrument(`${root}.${cls}`, {
    figi: figiFor(`${root}/${cls}`),
    name,
    exchangeMic: 'XNYS',
    mappings: [
      { symbol: `${root}.${cls}`, validFrom: '2000-01-01T00:00:00.000Z', validTo: null },
      { symbol: `${root} ${cls}`, validFrom: '2000-01-01T00:00:00.000Z', validTo: null },
      { symbol: `${root}/${cls}`, validFrom: '2000-01-01T00:00:00.000Z', validTo: null },
      { symbol: `${root}-${cls}`, validFrom: '2000-01-01T00:00:00.000Z', validTo: null },
    ],
  });
  query(`${root}.${cls}`, 'polygon', '2024-06-03T00:00:00.000Z', record.figi, 'class share, dot');
  query(`${root}.${cls}`, 'alpaca', '2024-06-03T00:00:00.000Z', record.figi, 'class share, dot');
  query(`${root} ${cls}`, 'databento', '2024-06-03T00:00:00.000Z', record.figi, 'class share, space');
  query(`${root}-${cls}`, 'tiingo', '2024-06-03T00:00:00.000Z', record.figi, 'class share, dash');
}

// ------------------------------------------- preferreds, warrants, rights, units
const NON_COMMON = [
  ['WFC.PL', 'preferred series L'],
  ['BAC.PK', 'preferred series K'],
  ['SCHW.PD', 'preferred series D'],
  ['DWAC.WS', 'warrant'],
  ['IPOF.U', 'unit'],
  ['GHC.RT', 'right'],
];
for (const [ticker, what] of NON_COMMON) {
  const [root, suffix] = ticker.split('.');
  const record = instrument(ticker, {
    figi: figiFor(`${root}/${suffix}`),
    name: `${root} ${what}`,
    exchangeMic: 'XNYS',
    mappings: [
      { symbol: ticker, validFrom: '2010-01-01T00:00:00.000Z', validTo: null },
      { symbol: `${root} ${suffix}`, validFrom: '2010-01-01T00:00:00.000Z', validTo: null },
      { symbol: `${root}/${suffix}`, validFrom: '2010-01-01T00:00:00.000Z', validTo: null },
      { symbol: `${root}-${suffix}`, validFrom: '2010-01-01T00:00:00.000Z', validTo: null },
    ],
  });
  query(ticker, 'polygon', '2024-06-03T00:00:00.000Z', record.figi, what);
  query(`${root} ${suffix}`, 'databento', '2024-06-03T00:00:00.000Z', record.figi, `${what}, space`);
}

// --------------------------------------------------------------------- ADRs
for (const ticker of ['BABA', 'TSM', 'NVO', 'SAP', 'TM', 'SHEL']) {
  const record = instrument(ticker, { name: `${ticker} ADR`, exchangeMic: 'XNYS' });
  query(ticker, 'polygon', '2024-06-03T00:00:00.000Z', record.figi, 'adr');
}

// ------------------------------------------------------------- ticker change
// A rename keeps the FIGI: that is the point of using FIGI as the primary key. The mapping is
// what moves, and the old spelling stays valid for the window in which it was correct.
const meta = instrument('META', {
  figi: figiFor('META'),
  name: 'Meta Platforms',
  exchangeMic: 'XNAS',
  mappings: [
    { symbol: 'FB', validFrom: '2012-05-18T00:00:00.000Z', validTo: '2022-06-09T00:00:00.000Z' },
    { symbol: 'META', validFrom: '2022-06-09T00:00:00.000Z', validTo: null },
  ],
});
query('FB', 'polygon', '2021-06-01T00:00:00.000Z', meta.figi, 'pre-rename spelling, in window');
query('META', 'polygon', '2024-06-03T00:00:00.000Z', meta.figi, 'post-rename spelling');
query('META', 'polygon', '2021-06-01T00:00:00.000Z', null, 'post-rename spelling before it existed');

const block = instrument('XYZ', {
  figi: figiFor('XYZ-block'),
  name: 'Block',
  mappings: [
    { symbol: 'SQ', validFrom: '2015-11-19T00:00:00.000Z', validTo: '2025-01-13T00:00:00.000Z' },
    { symbol: 'XYZ', validFrom: '2025-01-13T00:00:00.000Z', validTo: null },
  ],
});
query('SQ', 'alpaca', '2020-01-02T00:00:00.000Z', block.figi, 'pre-rename spelling');
query('XYZ', 'alpaca', '2025-06-02T00:00:00.000Z', block.figi, 'post-rename spelling');

// ----------------------------------------------------------------- delistings
const delisted = instrument('TWTR', {
  figi: figiFor('TWTR'),
  name: 'Twitter',
  active: false,
  mappings: [
    { symbol: 'TWTR', validFrom: '2013-11-07T00:00:00.000Z', validTo: '2022-10-28T00:00:00.000Z' },
  ],
});
query('TWTR', 'polygon', '2021-06-01T00:00:00.000Z', delisted.figi, 'delisted, queried in window');
query('TWTR', 'polygon', '2024-06-03T00:00:00.000Z', null, 'delisted, queried after delisting');

const bbby = instrument('BBBY', {
  figi: figiFor('BBBY'),
  name: 'Bed Bath & Beyond',
  active: false,
  mappings: [
    { symbol: 'BBBY', validFrom: '1992-06-01T00:00:00.000Z', validTo: '2023-09-29T00:00:00.000Z' },
  ],
});
query('BBBY', 'polygon', '2022-01-03T00:00:00.000Z', bbby.figi, 'delisted, queried in window');
query('BBBY', 'polygon', '2024-06-03T00:00:00.000Z', null, 'delisted, queried after delisting');

// ------------------------------------------------------------- reused tickers
// The specific failure mode that silently corrupts a backtest: the same string, two companies,
// disjoint windows. Resolution has to be as-of the query date, not as-of today.
const reusedOld = instrument('CBRE-old', {
  figi: figiFor('CBRE-1996'),
  ticker: 'CBRE',
  name: 'Original CBRE listing',
  active: false,
  mappings: [
    { symbol: 'CBRE', validFrom: '1996-01-02T00:00:00.000Z', validTo: '2001-07-20T00:00:00.000Z' },
  ],
});
const reusedNew = instrument('CBRE-new', {
  figi: figiFor('CBRE-2004'),
  ticker: 'CBRE',
  name: 'CBRE Group',
  mappings: [
    { symbol: 'CBRE', validFrom: '2004-06-10T00:00:00.000Z', validTo: null },
  ],
});
query('CBRE', 'polygon', '1999-03-01T00:00:00.000Z', reusedOld.figi, 'reused ticker, first tenant');
query('CBRE', 'polygon', '2024-06-03T00:00:00.000Z', reusedNew.figi, 'reused ticker, second tenant');
query('CBRE', 'polygon', '2003-01-02T00:00:00.000Z', null, 'reused ticker, gap between tenants');

const reusedFbOld = meta; // FB, 2012-2022
const reusedFbNew = instrument('FBAR', {
  figi: figiFor('FB-2024'),
  ticker: 'FB',
  name: 'A different company that took the freed FB ticker',
  mappings: [{ symbol: 'FB', validFrom: '2024-03-01T00:00:00.000Z', validTo: null }],
});
query('FB', 'polygon', '2024-06-03T00:00:00.000Z', reusedFbNew.figi, 'freed ticker, new tenant');
query('FB', 'polygon', '2019-01-02T00:00:00.000Z', reusedFbOld.figi, 'freed ticker, old tenant');
query('FB', 'polygon', '2023-01-03T00:00:00.000Z', null, 'freed ticker, gap');

// ------------------------------------------------------- fill out to 200 queries
let filler = 0;
while (queries.length < 200) {
  filler += 1;
  const ticker = `ZZ${String(filler).padStart(3, '0')}`;
  const record = instrument(ticker, { name: `Filler ${filler}` });
  query(ticker, 'polygon', '2024-06-03T00:00:00.000Z', record.figi, 'plain ticker');
}

mkdirSync('packages/symbology/test/fixtures', { recursive: true });
writeFileSync(
  OUT,
  JSON.stringify(
    {
      generatedBy: 'scripts/gen-security-master.mjs',
      note: 'Synthetic, deterministic FIGIs. Tests resolution logic, not OpenFIGI data accuracy.',
      instrumentCount: instruments.length,
      queryCount: queries.length,
      instruments,
      queries,
    },
    null,
    2,
  ) + '\n',
);

const byWhy = queries.reduce((acc, q) => ((acc[q.why] = (acc[q.why] ?? 0) + 1), acc), {});
console.log(`wrote ${OUT}: ${instruments.length} instruments, ${queries.length} queries`);
console.log(byWhy);
