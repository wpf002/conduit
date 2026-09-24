#!/usr/bin/env node
/**
 * Phase 0 gate 2 — raw payload capture.
 *
 * Writes newline-delimited JSON to .fixtures/<provider>-<schema>.ndjson so the same 20 symbols
 * can be normalized by hand into a draft CDM. .fixtures/ is gitignored; every line is also run
 * through scrubLine() so a credential echoed back by a provider can never reach disk.
 *
 *   node scripts/capture-fixtures.mjs --provider polygon --minutes 60
 *   node scripts/capture-fixtures.mjs --provider all --minutes 1440
 *
 * Zero dependencies: Node 22+ global WebSocket and fetch only.
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SYMBOLS = [
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'BRK.B', 'JPM', 'XOM',
  'SPY', 'QQQ', 'IWM', 'GME', 'F', 'BAC', 'PLTR', 'AMD', 'INTC', 'RIVN',
];

const OUT_DIR = '.fixtures';

// ------------------------------------------------------------------ env + args
function loadEnv() {
  if (!existsSync('.env')) return;
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

/** Every secret value currently in the environment, longest first. */
function secrets() {
  return [
    process.env.POLYGON_API_KEY,
    process.env.ALPACA_API_KEY_ID,
    process.env.ALPACA_API_SECRET_KEY,
    process.env.DATABENTO_API_KEY,
    process.env.TIINGO_API_KEY,
    process.env.OPENFIGI_API_KEY,
  ]
    .filter((v) => typeof v === 'string' && v.length >= 8)
    .sort((a, b) => b.length - a.length);
}

const SECRETS = [];

/** Replace any configured credential with a marker. Applied to every byte written or logged. */
export function scrubLine(line) {
  let out = line;
  for (const s of SECRETS) out = out.split(s).join('[REDACTED]');
  return out;
}

function log(...parts) {
  console.log(scrubLine(parts.join(' ')));
}

// ------------------------------------------------------------------- ndjson out
function writer(name) {
  mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, `${name}.ndjson`);
  let n = 0;
  return {
    path,
    write(obj) {
      appendFileSync(path, scrubLine(JSON.stringify(obj)) + '\n');
      n += 1;
    },
    get count() {
      return n;
    },
  };
}

// ------------------------------------------------------------------ providers
function capturePolygon(deadline) {
  const key = process.env.POLYGON_API_KEY;
  if (!key) return Promise.resolve(log('polygon: POLYGON_API_KEY unset, skipping'));

  const out = writer('polygon-stocks');
  return new Promise((resolve) => {
    const ws = new WebSocket('wss://socket.polygon.io/stocks');
    const done = () => {
      try {
        ws.close();
      } catch {}
      log(`polygon: ${out.count} messages -> ${out.path}`);
      resolve();
    };
    const timer = setTimeout(done, deadline - Date.now());

    ws.addEventListener('open', () => ws.send(JSON.stringify({ action: 'auth', params: key })));
    ws.addEventListener('message', (ev) => {
      let batch;
      try {
        batch = JSON.parse(ev.data);
      } catch {
        return;
      }
      for (const msg of Array.isArray(batch) ? batch : [batch]) {
        if (msg.ev === 'status') {
          log('polygon status:', msg.status, msg.message ?? '');
          if (msg.status === 'auth_success') {
            const params = SYMBOLS.flatMap((s) => [`Q.${s}`, `T.${s}`, `AM.${s}`]).join(',');
            ws.send(JSON.stringify({ action: 'subscribe', params }));
          }
          if (msg.status === 'auth_failed') {
            clearTimeout(timer);
            done();
          }
          continue;
        }
        out.write({ tsRecv: Date.now(), raw: msg });
      }
    });
    ws.addEventListener('error', () => log('polygon: socket error'));
    ws.addEventListener('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function captureAlpaca(deadline) {
  const keyId = process.env.ALPACA_API_KEY_ID;
  const secret = process.env.ALPACA_API_SECRET_KEY;
  if (!keyId || !secret) return Promise.resolve(log('alpaca: credentials unset, skipping'));

  const out = writer('alpaca-iex');
  return new Promise((resolve) => {
    const ws = new WebSocket('wss://stream.data.alpaca.markets/v2/iex');
    const done = () => {
      try {
        ws.close();
      } catch {}
      log(`alpaca: ${out.count} messages -> ${out.path}`);
      resolve();
    };
    const timer = setTimeout(done, deadline - Date.now());

    ws.addEventListener('open', () =>
      ws.send(JSON.stringify({ action: 'auth', key: keyId, secret })),
    );
    ws.addEventListener('message', (ev) => {
      let batch;
      try {
        batch = JSON.parse(ev.data);
      } catch {
        return;
      }
      for (const msg of Array.isArray(batch) ? batch : [batch]) {
        if (msg.T === 'success' || msg.T === 'error' || msg.T === 'subscription') {
          log('alpaca control:', JSON.stringify(msg));
          if (msg.msg === 'authenticated') {
            // Alpaca wants its own symbol spelling: BRK.B is BRK.B on Alpaca, BRK-B on Polygon.
            ws.send(
              JSON.stringify({
                action: 'subscribe',
                quotes: SYMBOLS,
                trades: SYMBOLS,
                bars: SYMBOLS,
              }),
            );
          }
          if (msg.T === 'error') {
            clearTimeout(timer);
            done();
          }
          continue;
        }
        out.write({ tsRecv: Date.now(), raw: msg });
      }
    });
    ws.addEventListener('error', () => log('alpaca: socket error'));
    ws.addEventListener('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Databento's live feed is binary DBN over raw TCP with CRAM auth, which is out of scope for a
 * fixture script. The historical JSON endpoint returns the same logical records, which is what
 * the normalizer needs to see.
 */
async function captureDatabento() {
  const key = process.env.DATABENTO_API_KEY;
  if (!key) return log('databento: DATABENTO_API_KEY unset, skipping');

  const out = writer('databento-xnas-itch');
  const day = arg('date', new Date(Date.now() - 4 * 86_400_000).toISOString().slice(0, 10));
  const auth = 'Basic ' + Buffer.from(`${key}:`).toString('base64');

  for (const schema of ['mbp-1', 'trades', 'ohlcv-1m']) {
    const body = new URLSearchParams({
      dataset: 'XNAS.ITCH',
      symbols: SYMBOLS.join(','),
      schema,
      encoding: 'json',
      start: `${day}T14:30:00Z`,
      end: `${day}T14:35:00Z`,
      stype_in: 'raw_symbol',
    });
    const res = await fetch('https://hist.databento.com/v0/timeseries.get_range', {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      log(`databento ${schema}: HTTP ${res.status}`, scrubLine(await res.text()).slice(0, 200));
      continue;
    }
    const text = await res.text();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.write({ tsRecv: Date.now(), schema, raw: JSON.parse(line) });
      } catch {
        /* partial line at EOF */
      }
    }
  }
  log(`databento: ${out.count} records -> ${out.path}`);
}

async function captureTiingo() {
  const key = process.env.TIINGO_API_KEY;
  if (!key) return log('tiingo: TIINGO_API_KEY unset, skipping');

  const out = writer('tiingo-eod');
  for (const symbol of SYMBOLS) {
    const url = new URL(`https://api.tiingo.com/tiingo/daily/${symbol}/prices`);
    url.searchParams.set('startDate', '2024-01-02');
    url.searchParams.set('endDate', '2024-01-31');
    const res = await fetch(url, { headers: { Authorization: `Token ${key}` } });
    if (!res.ok) {
      log(`tiingo ${symbol}: HTTP ${res.status}`);
      continue;
    }
    for (const bar of await res.json()) out.write({ tsRecv: Date.now(), symbol, raw: bar });
  }
  log(`tiingo: ${out.count} records -> ${out.path}`);
}

// ------------------------------------------------------------------------ main
async function main() {
  loadEnv();
  SECRETS.push(...secrets());

  const provider = arg('provider', 'all');
  const minutes = Number(arg('minutes', '60'));
  const deadline = Date.now() + minutes * 60_000;

  log(`capture: provider=${provider} minutes=${minutes} symbols=${SYMBOLS.length}`);
  if (SECRETS.length === 0) {
    log('capture: no credentials found in .env or environment — nothing to capture');
    return;
  }

  const jobs = [];
  if (provider === 'all' || provider === 'polygon') jobs.push(capturePolygon(deadline));
  if (provider === 'all' || provider === 'alpaca') jobs.push(captureAlpaca(deadline));
  if (provider === 'all' || provider === 'databento') jobs.push(captureDatabento());
  if (provider === 'all' || provider === 'tiingo') jobs.push(captureTiingo());
  await Promise.all(jobs);
}

await main();
