import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AuthError,
  CdmFlags,
  CoverageError,
  RateLimitError,
  assertCdmInvariants,
  dateToNs,
  hasFlag,
  isDepth,
  isQuote,
  type CdmMessage,
  type ProviderAdapter,
} from '@conduit/core';
import { databento } from '../src/databento/index.js';
import { normalizeDatabentoRecord, dbnPrice } from '../src/databento/normalize.js';

/** int64 max, Databento's marker for an absent price. */
const UNDEF = '9223372036854775807';

const MBP_1 = {
  hd: { ts_event: '1704205800123456789', rtype: 1, publisher_id: 2, instrument_id: 32 },
  price: '185110000000',
  size: 100,
  action: 'M',
  side: 'B',
  flags: 130,
  depth: 0,
  ts_recv: '1704205800123500000',
  sequence: 774_512,
  levels: [
    { bid_px: '185100000000', ask_px: '185120000000', bid_sz: 300, ask_sz: 200, bid_ct: 3, ask_ct: 2 },
  ],
  symbol: 'AAPL',
};

const TRADE = {
  hd: { ts_event: '1704205800124000000', rtype: 0, publisher_id: 2, instrument_id: 32 },
  price: '185115000000',
  size: 50,
  action: 'T',
  side: 'A',
  flags: 32,
  depth: 0,
  ts_recv: '1704205800124100000',
  sequence: 774_513,
  symbol: 'AAPL',
};

const OHLCV_1M = {
  hd: { ts_event: '1704205800000000000', rtype: 32, publisher_id: 2, instrument_id: 32 },
  open: '185000000000',
  high: '185200000000',
  low: '184950000000',
  close: '185100000000',
  volume: 12043,
  symbol: 'AAPL',
};

const MBP_10 = {
  hd: { ts_event: '1704205800500000000', rtype: 10, publisher_id: 2, instrument_id: 41 },
  price: '500025000000000',
  size: 1,
  action: 'M',
  side: 'B',
  flags: 32,
  depth: 0,
  ts_recv: '1704205800500100000',
  sequence: 90_001,
  levels: [
    { bid_px: '5000250000000', ask_px: '5000500000000', bid_sz: 10, ask_sz: 8, bid_ct: 4, ask_ct: 3 },
    { bid_px: '5000000000000', ask_px: '5000750000000', bid_sz: 22, ask_sz: 14, bid_ct: 9, ask_ct: 6 },
    { bid_px: UNDEF, ask_px: UNDEF, bid_sz: 0, ask_sz: 0, bid_ct: 0, ask_ct: 0 },
  ],
  symbol: 'ESZ4',
};

describe('databento normalization', () => {
  it('scales fixed-point int64 prices by 1e-9', () => {
    const quote = normalizeDatabentoRecord(MBP_1, 'quote_l1');
    expect(isQuote(quote!) && quote!.bidPx).toBe(185.1);
    expect(isQuote(quote!) && quote!.askPx).toBe(185.12);
    expect(dbnPrice('1000000000', 'x')).toBe(1);
  });

  it('reads the 19-digit nanosecond timestamp exactly', () => {
    const quote = normalizeDatabentoRecord(MBP_1, 'quote_l1');
    expect(quote!.tsEvent).toBe(1704205800123456789n);
  });

  it('keeps the sequence number, which Alpaca has no equivalent for', () => {
    expect(normalizeDatabentoRecord(MBP_1, 'quote_l1')!.seq).toBe(774512n);
  });

  it('treats int64 max as an absent price rather than a real level', () => {
    expect(dbnPrice(UNDEF, 'bid_px')).toBeUndefined();
    const oneSided = normalizeDatabentoRecord(
      { ...MBP_1, levels: [{ ...MBP_1.levels[0], bid_px: UNDEF }] },
      'quote_l1',
    );
    expect(isQuote(oneSided!) && oneSided!.bidPx).toBe(0);
    expect(isQuote(oneSided!) && oneSided!.bidSz).toBe(0);
    expect(() => assertCdmInvariants(oneSided!)).not.toThrow();
  });

  it('maps the SNAPSHOT bit and ignores the flags with no cross-vendor meaning', () => {
    const trade = normalizeDatabentoRecord(TRADE, 'trades');
    expect(hasFlag(trade!.flags, CdmFlags.Snapshot)).toBe(true);
    // flags 130 has neither SNAPSHOT nor anything else Conduit models.
    expect(normalizeDatabentoRecord(MBP_1, 'quote_l1')!.flags).toBe(0);
  });

  it('builds a ten-level book, dropping empty levels and keeping order', () => {
    const depth = normalizeDatabentoRecord(MBP_10, 'depth_10');
    expect(isDepth(depth!) && depth!.bids).toEqual([
      { px: 5000.25, sz: 10, orders: 4 },
      { px: 5000, sz: 22, orders: 9 },
    ]);
    expect(isDepth(depth!) && depth!.asks[0]).toEqual({ px: 5000.5, sz: 8, orders: 3 });
    expect(() => assertCdmInvariants(depth!)).not.toThrow();
  });

  it('derives the bar window from the requested schema', () => {
    const minute = normalizeDatabentoRecord(OHLCV_1M, 'bars_1m');
    expect(minute!.kind).toBe('bar');
    const daily = normalizeDatabentoRecord(OHLCV_1M, 'bars_1d');
    expect(daily!.kind === 'bar' && daily.tsEventEnd - daily.tsEvent).toBe(86_400_000_000_000n);
  });

  it('skips metadata records that share the stream', () => {
    expect(normalizeDatabentoRecord({ version: 2, dataset: 'XNAS.ITCH' }, 'trades')).toBeUndefined();
    expect(normalizeDatabentoRecord(null, 'trades')).toBeUndefined();
  });

  it('demands a symbol rather than emitting a message without one', () => {
    const noSymbol = { ...MBP_1, symbol: undefined };
    expect(() => normalizeDatabentoRecord(noSymbol, 'quote_l1')).toThrow(/map_symbols=true/);
    // Unless the caller can map instrument_id itself.
    const mapped = normalizeDatabentoRecord(noSymbol, 'quote_l1', {
      symbolForInstrumentId: (id) => (id === 32 ? 'AAPL' : undefined),
    });
    expect(mapped!.symbol).toBe('AAPL');
  });
});

// ------------------------------------------------------------------ http replay
interface FakeHist {
  readonly url: string;
  readonly requests: { body: string; auth: string | undefined }[];
  status: number;
  lines: string[];
  close(): Promise<void>;
}

async function startFakeHist(): Promise<FakeHist> {
  const state = { status: 200, lines: [] as string[] };
  const requests: { body: string; auth: string | undefined }[] = [];

  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requests.push({ body, auth: req.headers.authorization });
      if (state.status !== 200) {
        res.writeHead(state.status, { 'retry-after': '2' });
        res.end('error');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      // Written in two chunks with a line split across the boundary, to exercise the buffering.
      const text = state.lines.map((l) => l + '\n').join('');
      const mid = Math.floor(text.length / 2);
      res.write(text.slice(0, mid));
      res.end(text.slice(mid));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    get status() {
      return state.status;
    },
    set status(v: number) {
      state.status = v;
    },
    get lines() {
      return state.lines;
    },
    set lines(v: string[]) {
      state.lines = v;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let hist: FakeHist | undefined;
let adapter: ProviderAdapter | undefined;

afterEach(async () => {
  await adapter?.close();
  await hist?.close();
  adapter = undefined;
  hist = undefined;
});

function connect(): ProviderAdapter {
  return databento({
    apiKey: 'db-test-key-0123456789',
    dataset: 'XNAS.ITCH',
    baseUrl: hist!.url,
  });
}

const WINDOW = {
  start: dateToNs(new Date('2024-01-02T14:30:00Z')),
  end: dateToNs(new Date('2024-01-02T14:35:00Z')),
};

async function drain(stream: AsyncIterable<CdmMessage>): Promise<CdmMessage[]> {
  const out: CdmMessage[] = [];
  for await (const message of stream) out.push(message);
  return out;
}

describe('databento replay', () => {
  it('streams newline-delimited records across chunk boundaries', async () => {
    hist = await startFakeHist();
    hist.lines = [JSON.stringify(MBP_1), JSON.stringify(MBP_1), JSON.stringify(MBP_1)];
    adapter = connect();
    const messages = await drain(
      adapter.stream({ symbols: ['AAPL'], schema: 'quote_l1', ...WINDOW }),
    );
    expect(messages).toHaveLength(3);
    expect(messages.every((m) => m.symbol === 'AAPL')).toBe(true);
  });

  it('asks for map_symbols and the right vendor schema name', async () => {
    hist = await startFakeHist();
    hist.lines = [JSON.stringify(MBP_10)];
    adapter = connect();
    await drain(adapter.stream({ symbols: ['ESZ4'], schema: 'depth_10', assetClass: 'future', ...WINDOW }));
    const body = new URLSearchParams(hist.requests[0]!.body);
    expect(body.get('schema')).toBe('mbp-10');
    expect(body.get('map_symbols')).toBe('true');
    expect(body.get('encoding')).toBe('json');
    expect(body.get('stype_in')).toBe('raw_symbol');
    expect(body.get('start')).toBe('2024-01-02T14:30:00.000000000Z');
  });

  it('sends the key as HTTP basic and never in the query string', async () => {
    hist = await startFakeHist();
    hist.lines = [JSON.stringify(TRADE)];
    adapter = connect();
    await drain(adapter.stream({ symbols: ['AAPL'], schema: 'trades', ...WINDOW }));
    expect(hist.requests[0]!.auth).toBe(
      `Basic ${Buffer.from('db-test-key-0123456789:').toString('base64')}`,
    );
    expect(hist.requests[0]!.body).not.toContain('db-test-key');
  });

  it('skips a malformed record and keeps replaying the rest', async () => {
    hist = await startFakeHist();
    hist.lines = [JSON.stringify(MBP_1), '{"hd":{"ts_event":"nope"}}', JSON.stringify(MBP_1)];
    adapter = connect();
    const messages = await drain(
      adapter.stream({ symbols: ['AAPL'], schema: 'quote_l1', ...WINDOW }),
    );
    expect(messages).toHaveLength(2);
    // The good record after the bad one cleared the failure count, which is the intended
    // behaviour: consecutive means consecutive.
    expect(adapter.health().consecutiveFailures).toBe(0);
  });

  it('records a malformed record as a health failure', async () => {
    hist = await startFakeHist();
    hist.lines = [JSON.stringify(MBP_1), '{"hd":{"ts_event":"nope"},"symbol":"AAPL","levels":[]}'];
    adapter = connect();
    await drain(adapter.stream({ symbols: ['AAPL'], schema: 'quote_l1', ...WINDOW }));
    expect(adapter.health().consecutiveFailures).toBe(1);
    expect(adapter.health().lastError).toMatch(/ts_event/);
  });

  it('maps HTTP status to the error class the router dispatches on', async () => {
    hist = await startFakeHist();
    adapter = connect();

    hist.status = 401;
    await expect(drain(adapter.stream({ symbols: ['AAPL'], schema: 'trades', ...WINDOW }))).rejects.toThrow(
      AuthError,
    );

    hist.status = 429;
    const rateLimited = drain(adapter.stream({ symbols: ['AAPL'], schema: 'trades', ...WINDOW }));
    await expect(rateLimited).rejects.toThrow(RateLimitError);

    hist.status = 422;
    await expect(drain(adapter.stream({ symbols: ['AAPL'], schema: 'trades', ...WINDOW }))).rejects.toThrow(
      CoverageError,
    );
  });

  it('carries retryAfterMs off the Retry-After header', async () => {
    hist = await startFakeHist();
    hist.status = 429;
    adapter = connect();
    try {
      await drain(adapter.stream({ symbols: ['AAPL'], schema: 'trades', ...WINDOW }));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitError);
      expect((error as RateLimitError).retryAfterMs).toBe(2000);
    }
  });

  it('stops the request when the consumer breaks out early', async () => {
    hist = await startFakeHist();
    hist.lines = Array.from({ length: 50 }, () => JSON.stringify(MBP_1));
    adapter = connect();
    let seen = 0;
    for await (const _ of adapter.stream({ symbols: ['AAPL'], schema: 'quote_l1', ...WINDOW })) {
      seen += 1;
      if (seen === 2) break;
    }
    expect(seen).toBe(2);
  });
});

describe('databento coverage', () => {
  it('is the only adapter that covers depth', async () => {
    hist = await startFakeHist();
    adapter = connect();
    expect([...adapter.capabilities].sort()).toEqual([
      'bars_1d',
      'bars_1m',
      'depth_10',
      'quote_l1',
      'trades',
    ]);
    expect(adapter.supports('depth_10', 'future')).toBe(true);
  });

  it('refuses a live subscription rather than pretending to serve one', async () => {
    hist = await startFakeHist();
    adapter = connect();
    expect(() => adapter!.stream({ symbols: ['AAPL'], schema: 'quote_l1' })).toThrow(
      /replays a historical window/,
    );
  });

  it('rejects snapshot, which the historical API has no endpoint for', async () => {
    hist = await startFakeHist();
    adapter = connect();
    await expect(adapter.snapshot({ symbols: ['AAPL'] })).rejects.toThrow(CoverageError);
  });

  it('requires a dataset', () => {
    expect(() => databento({ apiKey: 'k'.repeat(12), dataset: '' })).toThrow(CoverageError);
  });
});
