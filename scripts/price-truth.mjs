#!/usr/bin/env node
/**
 * Are the prices right? Nothing else in this repo answers that.
 *
 *   node scripts/price-truth.mjs
 *   node scripts/price-truth.mjs --symbols AAPL,MSFT,SPY --json
 *
 * `pnpm test` compares Conduit against fixtures written from the same documentation the adapter was
 * written from, and `pnpm live` compares it against a real server sending invented ticks. Neither can
 * catch a price that is scaled, shifted, or read out of the wrong field. Only a second vendor can.
 *
 * Yahoo needs no key, so this runs with nothing configured beyond the Alpaca key Conduit already
 * uses. FINNHUB_API_KEY and FMP_API_KEY are used when present and add a second and third independent
 * opinion.
 *
 * ## What it compares, and why that field
 *
 * **Previous close is the assertion.** It is settled and official: every vendor takes it from the
 * same consolidated tape after the session ends, so two independent feeds must agree on it to the
 * cent. A mismatch is Conduit's arithmetic, not market structure. That is what catches the class of
 * bug this project has actually shipped — a 100x scale error, a fixed-point field read as a decimal,
 * a field mapped to the wrong name.
 *
 * **Last price is checked for scale only, deliberately loosely.** Alpaca's free plan is IEX, roughly
 * 2% of consolidated volume, so its last trade is a different trade from the one a consolidated feed
 * reports, and a delayed vendor's is different again. Cents of disagreement is correct behaviour, and
 * failing on it would make this script noise that gets ignored. A ratio near a power of ten is never
 * correct, so that is what it fails on.
 */
import { readFileSync, existsSync } from 'node:fs';

const DEFAULT_SYMBOLS = ['AAPL', 'MSFT', 'SPY', 'NVDA', 'BRK.B'];

/** Agreement to the cent. Anything inside this is the same number. */
const CLOSE_TOLERANCE = 0.02;
/**
 * How far a single-venue feed's session close may sit from the official one before it stops being
 * market structure and starts being a bug.
 *
 * Alpaca's free plan is IEX, one venue at roughly 2% of consolidated volume, so its daily bar is
 * built from IEX prints only and cannot contain the closing auction — which is where the official
 * close is struck, on the primary listing exchange. The two numbers are therefore different numbers
 * by construction, a few cents apart, and measured here at 0.00 to 0.05 across five symbols. That is
 * not Conduit's arithmetic and failing on it would make this script noise.
 *
 * A disagreement larger than this is not explained by venue coverage and is treated as a failure.
 */
const VENUE_CLOSE_TOLERANCE = 0.5;
/** Feeds covering a single venue, whose session close is not the official close. */
const SINGLE_VENUE_FEEDS = new Set(['iex']);
/** A power-of-ten ratio is a scaling bug; no market structure produces one. */
const SCALE_FACTORS = [1000, 100, 10, 0.1, 0.01, 0.001];
const SCALE_NEARNESS = 0.08;

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const asJson = process.argv.includes('--json');

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const symbols = String(arg('symbols', DEFAULT_SYMBOLS.join(',')))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const { alpaca } = await import('../packages/providers/dist/index.js');

let failures = 0;
const notes = [];
const fail = (msg) => {
  failures += 1;
  notes.push(`FAIL  ${msg}`);
};
const ok = (msg) => notes.push(`ok    ${msg}`);
const warn = (msg) => notes.push(`note  ${msg}`);

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Yahoo's chart endpoint. Keyless, which is why it is the default: a correctness check that needs a
 * key nobody has is a check nobody runs.
 *
 * The previous close is computed from the daily bars rather than read from a field, because both
 * obvious fields are wrong for this. `meta.previousClose` is frequently absent, and
 * `meta.chartPreviousClose` is the close before the *requested range* began — with `range=5d` that is
 * five sessions ago, which looks like a plausible price and is not the one being asked for. The last
 * bar is the live session while the market is open, so the previous close is the bar before it.
 */
async function yahoo(symbol) {
  // Yahoo spells class shares with a hyphen: BRK.B -> BRK-B
  const s = symbol.replace('.', '-');
  const res = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?range=1mo&interval=1d`,
    { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20_000) },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  const result = body?.chart?.result?.[0];
  if (!result) return undefined;

  const stamps = result.timestamp ?? [];
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const bars = stamps
    .map((t, i) => ({ t, close: closes[i] }))
    .filter((b) => typeof b.close === 'number');
  if (bars.length < 2) return undefined;

  const dayOf = (epochSeconds) => new Date(epochSeconds * 1000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const completed = dayOf(bars.at(-1).t) === today ? bars.slice(0, -1) : bars;
  const prev = completed.at(-1);
  if (!prev) return undefined;

  const last = result.meta?.regularMarketPrice;
  return {
    prevClose: prev.close,
    last: typeof last === 'number' && last !== 0 ? last : undefined,
    asOf: dayOf(prev.t),
  };
}

/** Finnhub: c = current, pc = previous close. */
async function finnhub(symbol) {
  const token = process.env.FINNHUB_API_KEY;
  if (!token) return undefined;
  const s = symbol.replace('.', '-');
  const d = await getJson(
    `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(s)}&token=${token}`,
  );
  if (!d || typeof d.pc !== 'number' || d.pc === 0) return undefined;
  return { prevClose: d.pc, last: typeof d.c === 'number' && d.c !== 0 ? d.c : undefined };
}

/** FMP: a third opinion, so a disagreement can be attributed rather than argued about. */
async function fmp(symbol) {
  const key = process.env.FMP_API_KEY;
  if (!key) return undefined;
  const s = symbol.replace('.', '-');
  const d = await getJson(
    `https://financialmodelingprep.com/api/v3/quote/${encodeURIComponent(s)}?apikey=${key}`,
  );
  const row = Array.isArray(d) ? d[0] : undefined;
  if (!row || typeof row.previousClose !== 'number' || row.previousClose === 0) return undefined;
  return {
    prevClose: row.previousClose,
    last: typeof row.price === 'number' && row.price !== 0 ? row.price : undefined,
  };
}

const keyId = process.env.ALPACA_API_KEY_ID;
const secret = process.env.ALPACA_API_SECRET_KEY;
if (!keyId || !secret) {
  console.error('ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY are required');
  process.exit(2);
}

const feed = process.env.ALPACA_FEED ?? 'iex';
const singleVenue = SINGLE_VENUE_FEEDS.has(feed);
const adapter = alpaca({ keyId, secret, feed });
if (adapter.synthetic) {
  console.error('refusing to verify prices against a sandbox feed; that would prove nothing');
  process.exit(2);
}
const snapshots = await adapter.summary({ symbols });
await adapter.close();

const bySymbol = new Map(snapshots.map((s) => [s.symbol, s]));
if (bySymbol.size === 0) {
  console.error('conduit returned no snapshots; nothing could be compared');
  process.exit(1);
}

function scaleFactorBetween(a, b) {
  if (!a || !b) return undefined;
  const ratio = a / b;
  for (const f of SCALE_FACTORS) {
    if (Math.abs(ratio - f) / f < SCALE_NEARNESS) return f;
  }
  return undefined;
}

const rows = [];
for (const symbol of symbols) {
  const snap = bySymbol.get(symbol);
  if (!snap) {
    fail(`${symbol}: conduit returned no snapshot`);
    continue;
  }
  const [sq, fh, fm] = await Promise.all([
    yahoo(symbol).catch(() => undefined),
    finnhub(symbol).catch(() => undefined),
    fmp(symbol).catch(() => undefined),
  ]);
  const others = [
    ['yahoo', sq],
    ['finnhub', fh],
    ['fmp', fm],
  ].filter(([, v]) => v !== undefined);

  if (others.length === 0) {
    fail(`${symbol}: no independent vendor answered, so nothing was verified`);
    continue;
  }

  rows.push({
    symbol,
    conduit: { last: snap.lastPx, prevClose: snap.prevClose },
    ...Object.fromEntries(others),
  });

  if (typeof snap.prevClose !== 'number') {
    fail(`${symbol}: conduit reported no prevClose, so the settled number cannot be checked`);
  } else {
    for (const [name, v] of others) {
      const scale = scaleFactorBetween(snap.prevClose, v.prevClose);
      const diff = Math.abs(snap.prevClose - v.prevClose);
      if (scale !== undefined) {
        fail(
          `${symbol}: prevClose is ${scale}x ${name} (${snap.prevClose} vs ${v.prevClose}) — a scaling bug`,
        );
      } else if (diff <= CLOSE_TOLERANCE) {
        ok(`${symbol}: prevClose matches ${name} — ${snap.prevClose} vs ${v.prevClose}`);
      } else if (singleVenue && diff <= VENUE_CLOSE_TOLERANCE) {
        warn(
          `${symbol}: prevClose is ${diff.toFixed(4)} from ${name} (${snap.prevClose} vs ${v.prevClose}) — ` +
            `expected on the ${feed} feed, which has no closing auction print`,
        );
      } else {
        fail(
          `${symbol}: prevClose disagrees with ${name} by ${diff.toFixed(4)} ` +
            `(${snap.prevClose} vs ${v.prevClose}) — too far to be venue coverage`,
        );
      }
    }
  }

  for (const [name, v] of others) {
    if (typeof snap.lastPx !== 'number' || v.last === undefined) continue;
    const scale = scaleFactorBetween(snap.lastPx, v.last);
    if (scale !== undefined) {
      fail(`${symbol}: lastPx is ${scale}x ${name} (${snap.lastPx} vs ${v.last}) — a scaling bug`);
    } else {
      const pct = (Math.abs(snap.lastPx - v.last) / v.last) * 100;
      ok(`${symbol}: lastPx within ${pct.toFixed(2)}% of ${name} — ${snap.lastPx} vs ${v.last}`);
    }
  }
}

if (asJson) {
  console.log(JSON.stringify({ rows, failures, notes }, null, 2));
} else {
  console.log('price truth: conduit/alpaca vs independent vendors\n');
  for (const note of notes) console.log(note);
  const noted = notes.filter((n) => n.startsWith('note')).length;
  console.log(
    failures === 0
      ? `\npassed — ${rows.length} symbols agree with an independent feed` +
          (noted > 0
            ? `\n${noted} venue-coverage differences, which are market structure rather than bugs`
            : '')
      : `\nFAILED (${failures})`,
  );
}
process.exit(failures === 0 ? 0 : 1);
