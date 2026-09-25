import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AuthError,
  CoverageError,
  RateLimitError,
  SchemaError,
  assertCdmInvariants,
  dateToNs,
  isBar,
  nsToIso,
  type CdmMessage,
  type ProviderAdapter,
} from '@conduit/core';
import { tiingo } from '../src/tiingo/index.js';
import { normalizeTiingoBar } from '../src/tiingo/normalize.js';

/** A real-shaped Tiingo end-of-day record: raw and adjusted side by side, plus the split factor. */
const EOD = {
  date: '2024-01-02T00:00:00.000Z',
  close: 185.64,
  high: 188.44,
  low: 183.89,
  open: 187.15,
  volume: 82_488_200,
  adjClose: 92.82,
  adjHigh: 94.22,
  adjLow: 91.945,
  adjOpen: 93.575,
  adjVolume: 164_976_400,
  divCash: 0,
  splitFactor: 2,
};

describe('tiingo normalization', () => {
  it('uses the raw prices by default, because that is what printed', () => {
    const bar = normalizeTiingoBar(EOD, 'AAPL');
    expect(isBar(bar!) && bar!.open).toBe(187.15);
    expect(isBar(bar!) && bar!.close).toBe(185.64);
    expect(isBar(bar!) && bar!.volume).toBe(82_488_200);
    expect(() => assertCdmInvariants(bar!)).not.toThrow();
  });

  it('uses the adjusted set when asked, which is a different number not a formatting choice', () => {
    const bar = normalizeTiingoBar(EOD, 'AAPL', { priceField: 'adjusted' });
    expect(isBar(bar!) && bar!.open).toBe(93.575);
    expect(isBar(bar!) && bar!.close).toBe(92.82);
    expect(isBar(bar!) && bar!.volume).toBe(164_976_400);
    // Same bar, prices differing by the split factor. Mixing the two across dates is the bug this
    // option exists to make explicit.
    expect(normalizeTiingoBar(EOD, 'AAPL')!.kind).toBe('bar');
  });

  it('keeps the other set, dividends and split factor in raw', () => {
    const bar = normalizeTiingoBar(EOD, 'AAPL');
    expect((bar!.raw as typeof EOD).adjClose).toBe(92.82);
    expect((bar!.raw as typeof EOD).splitFactor).toBe(2);
  });

  it('spans exactly one day', () => {
    const bar = normalizeTiingoBar(EOD, 'AAPL');
    expect(bar!.tsEvent).toBe(1704153600000000000n);
    expect(isBar(bar!) && bar!.tsEventEnd - bar!.tsEvent).toBe(86_400_000_000_000n);
    expect(isBar(bar!) && bar!.interval).toBe('1d');
  });

  it('accepts a bare date with no time part', () => {
    const bar = normalizeTiingoBar({ ...EOD, date: '2024-01-02' }, 'AAPL');
    expect(nsToIso(bar!.tsEvent)).toBe('2024-01-02T00:00:00.000000000Z');
  });

  it('throws SchemaError on a malformed record rather than emitting NaN', () => {
    expect(() => normalizeTiingoBar({ ...EOD, close: null }, 'AAPL')).toThrow(SchemaError);
    expect(() => normalizeTiingoBar({ ...EOD, date: 'last tuesday' }, 'AAPL')).toThrow(/ISO-8601/);
  });

  it('ignores a payload that is not a bar', () => {
    expect(normalizeTiingoBar({ detail: 'Not found' }, 'AAPL')).toBeUndefined();
    expect(normalizeTiingoBar(null, 'AAPL')).toBeUndefined();
  });
});

// ------------------------------------------------------------------------ replay
interface FakeTiingo {
  readonly url: string;
  readonly requests: { path: string; auth: string | undefined }[];
  status: number;
  body: unknown;
  close(): Promise<void>;
}

async function startFakeTiingo(): Promise<FakeTiingo> {
  const state = { status: 200, body: [EOD] as unknown };
  const requests: { path: string; auth: string | undefined }[] = [];
  const server: Server = createServer((req, res) => {
    requests.push({ path: req.url ?? '', auth: req.headers.authorization });
    res.writeHead(state.status, { 'content-type': 'application/json', 'retry-after': '3' });
    res.end(JSON.stringify(state.body));
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
    get body() {
      return state.body;
    },
    set body(v: unknown) {
      state.body = v;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let api: FakeTiingo | undefined;
let adapter: ProviderAdapter | undefined;

afterEach(async () => {
  await adapter?.close();
  await api?.close();
  adapter = undefined;
  api = undefined;
});

const WINDOW = {
  start: dateToNs(new Date('2024-01-02T00:00:00Z')),
  end: dateToNs(new Date('2024-01-31T00:00:00Z')),
};

async function drain(stream: AsyncIterable<CdmMessage>): Promise<CdmMessage[]> {
  const out: CdmMessage[] = [];
  for await (const m of stream) out.push(m);
  return out;
}

describe('tiingo replay', () => {
  it('requests one ticker per call with the window as dates', async () => {
    api = await startFakeTiingo();
    adapter = tiingo({ apiKey: 'tiingo-test-0123456789', baseUrl: api.url });
    const bars = await drain(
      adapter.stream({ symbols: ['AAPL', 'MSFT'], schema: 'bars_1d', ...WINDOW }),
    );
    expect(bars).toHaveLength(2);
    expect(api.requests).toHaveLength(2);
    expect(api.requests[0]!.path).toContain('/tiingo/daily/AAPL/prices');
    expect(api.requests[0]!.path).toContain('startDate=2024-01-02');
    expect(api.requests[0]!.path).toContain('endDate=2024-01-31');
    expect(api.requests[1]!.path).toContain('/tiingo/daily/MSFT/prices');
  });

  it('sends the token as a header, never in the query string', async () => {
    api = await startFakeTiingo();
    adapter = tiingo({ apiKey: 'tiingo-test-0123456789', baseUrl: api.url });
    await drain(adapter.stream({ symbols: ['AAPL'], schema: 'bars_1d', ...WINDOW }));
    expect(api.requests[0]!.auth).toBe('Token tiingo-test-0123456789');
    // Tiingo also accepts ?token=, which would put the key in every access log.
    expect(api.requests[0]!.path).not.toContain('token=');
  });

  it('skips an unknown ticker without failing the whole replay', async () => {
    api = await startFakeTiingo();
    api.status = 404;
    adapter = tiingo({ apiKey: 'tiingo-test-0123456789', baseUrl: api.url });
    const bars = await drain(
      adapter.stream({ symbols: ['NOSUCHTICKER'], schema: 'bars_1d', ...WINDOW }),
    );
    expect(bars).toEqual([]);
    expect(adapter.health().lastError).toMatch(/no data for NOSUCHTICKER/);
  });

  it('maps status onto the error taxonomy', async () => {
    api = await startFakeTiingo();
    adapter = tiingo({ apiKey: 'tiingo-test-0123456789', baseUrl: api.url });
    api.status = 401;
    await expect(
      drain(adapter.stream({ symbols: ['AAPL'], schema: 'bars_1d', ...WINDOW })),
    ).rejects.toThrow(AuthError);
    api.status = 429;
    try {
      await drain(adapter.stream({ symbols: ['AAPL'], schema: 'bars_1d', ...WINDOW }));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitError);
      expect((error as RateLimitError).retryAfterMs).toBe(3000);
    }
  });

  it('reports usage per symbol, because the endpoint is per ticker', async () => {
    api = await startFakeTiingo();
    const records: { kind: string; symbol?: string }[] = [];
    adapter = tiingo({
      apiKey: 'tiingo-test-0123456789',
      baseUrl: api.url,
      usage: { sink: (r) => records.push(r) },
    });
    await drain(adapter.stream({ symbols: ['AAPL', 'MSFT', 'SPY'], schema: 'bars_1d', ...WINDOW }));
    expect(records.filter((r) => r.kind === 'rest')).toHaveLength(3);
    expect(records.map((r) => r.symbol)).toEqual(['AAPL', 'MSFT', 'SPY']);
  });
});

describe('tiingo coverage', () => {
  it('serves daily bars and nothing else', async () => {
    api = await startFakeTiingo();
    adapter = tiingo({ apiKey: 'tiingo-test-0123456789', baseUrl: api.url });
    expect([...adapter.capabilities]).toEqual(['bars_1d']);
    for (const schema of ['quote_l1', 'trades', 'bars_1m', 'depth_10'] as const) {
      expect(() => adapter!.stream({ symbols: ['AAPL'], schema, start: 1n })).toThrow(
        /bars_1d only/,
      );
    }
  });

  it('refuses a live subscription, having no streaming feed', async () => {
    api = await startFakeTiingo();
    adapter = tiingo({ apiKey: 'tiingo-test-0123456789', baseUrl: api.url });
    expect(() => adapter!.stream({ symbols: ['AAPL'], schema: 'bars_1d' })).toThrow(
      /no streaming feed/,
    );
  });

  it('rejects snapshot, having no quotes at all', async () => {
    api = await startFakeTiingo();
    adapter = tiingo({ apiKey: 'tiingo-test-0123456789', baseUrl: api.url });
    await expect(adapter.snapshot({ symbols: ['AAPL'] })).rejects.toThrow(CoverageError);
  });

  it('requires a key', () => {
    expect(() => tiingo({ apiKey: '' })).toThrow(AuthError);
  });
});
