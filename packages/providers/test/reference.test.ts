import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthError, CdmFlags, RateLimitError, hasFlag } from '@conduit/core';
import {
  fetchAlpacaConditions,
  fetchAlpacaExchanges,
  fetchPolygonConditions,
  fetchPolygonExchanges,
  flagsFromConditionName,
  loadAlpacaReference,
  loadPolygonReference,
} from '../src/reference.js';
import { clearVenueMaps, venueLabelFor } from '../src/venues.js';
import { clearConditionFlags, conditionFlags } from '../src/conditions.js';

interface FakeApi {
  readonly url: string;
  readonly paths: string[];
  readonly headers: Record<string, string | undefined>[];
  status: number;
  routes: Record<string, unknown>;
  close(): Promise<void>;
}

async function startFakeApi(routes: Record<string, unknown>): Promise<FakeApi> {
  const state = { status: 200, routes };
  const paths: string[] = [];
  const headers: Record<string, string | undefined>[] = [];

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]!;
    paths.push(req.url ?? '');
    headers.push({
      authorization: req.headers.authorization,
      keyId: req.headers['apca-api-key-id'] as string | undefined,
      secret: req.headers['apca-api-secret-key'] as string | undefined,
    });
    if (state.status !== 200) {
      res.writeHead(state.status);
      res.end('nope');
      return;
    }
    const body = state.routes[path];
    res.writeHead(body === undefined ? 404 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body ?? { error: 'no route' }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    paths,
    headers,
    get status() {
      return state.status;
    },
    set status(v: number) {
      state.status = v;
    },
    get routes() {
      return state.routes;
    },
    set routes(v: Record<string, unknown>) {
      state.routes = v;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const POLYGON_ROUTES = {
  '/v3/reference/exchanges': {
    results: [
      { id: 11, name: 'Nasdaq BX', mic: 'XBOS', operating_mic: 'XNAS' },
      { id: 62, name: 'OTC FINRA ORF', operating_mic: 'FINR' },
      { id: 15, name: 'IEX', mic: 'IEXG', operating_mic: 'IEXG' },
      { id: 99, name: 'No MIC at all' },
      { name: 'No id either', mic: 'XXXX' },
    ],
  },
  '/v3/reference/conditions': {
    results: [
      { id: 37, name: 'Odd Lot Trade' },
      { id: 12, name: 'Form T' },
      { id: 16, name: 'Sold Out Of Sequence' },
      { id: 0, name: 'Regular Sale' },
      { id: 'nope', name: 'Bad id' },
    ],
  },
};

const ALPACA_ROUTES = {
  '/v2/stocks/meta/exchanges': { A: 'NYSE American (AMEX)', B: 'Nasdaq OMX BX', V: 'IEX', X: '' },
  '/v2/stocks/meta/conditions/trade': {
    I: 'Odd Lot Trade',
    T: 'Form T',
    '@': 'Regular Sale',
    Z: 'Sold Out Of Sequence',
  },
};

let api: FakeApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
  clearVenueMaps();
  clearConditionFlags();
});

describe('flagsFromConditionName', () => {
  it('recognises the semantics the CDM actually models', () => {
    expect(hasFlag(flagsFromConditionName('Odd Lot Trade'), CdmFlags.OddLot)).toBe(true);
    expect(hasFlag(flagsFromConditionName('Form T'), CdmFlags.TradeThroughExempt)).toBe(true);
    expect(hasFlag(flagsFromConditionName('Extended Hours Trade'), CdmFlags.TradeThroughExempt)).toBe(true);
    expect(hasFlag(flagsFromConditionName('Sold Out Of Sequence'), CdmFlags.OutOfSequence)).toBe(true);
    expect(hasFlag(flagsFromConditionName('Prior Reference Price'), CdmFlags.OutOfSequence)).toBe(true);
    expect(hasFlag(flagsFromConditionName('Trading Halt'), CdmFlags.Halted)).toBe(true);
    expect(hasFlag(flagsFromConditionName('Corrected Consolidated Close'), CdmFlags.Correction)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(flagsFromConditionName('ODD LOT TRADE')).toBe(flagsFromConditionName('odd lot trade'));
  });

  it('returns nothing for a condition the CDM does not model', () => {
    expect(flagsFromConditionName('Regular Sale')).toBe(0);
    expect(flagsFromConditionName('Intermarket Sweep')).toBe(0);
    expect(flagsFromConditionName('')).toBe(0);
  });
});

describe('fetchPolygonExchanges', () => {
  it('prefers mic, falls back to operating_mic, and skips entries with neither', async () => {
    api = await startFakeApi(POLYGON_ROUTES);
    const table = await fetchPolygonExchanges({ apiKey: 'pk-test-0123456789', baseUrl: api.url });
    expect(table.labels).toEqual({ 11: 'XBOS', 62: 'FINR', 15: 'IEXG' });
    expect(table.count).toBe(3);
  });

  it('sends the key as a bearer header, never in the query string', async () => {
    api = await startFakeApi(POLYGON_ROUTES);
    await fetchPolygonExchanges({ apiKey: 'pk-test-0123456789', baseUrl: api.url });
    expect(api.headers[0]!.authorization).toBe('Bearer pk-test-0123456789');
    expect(api.paths[0]).not.toContain('pk-test');
    expect(api.paths[0]).toContain('asset_class=stocks');
  });

  it('maps HTTP status onto the error taxonomy', async () => {
    api = await startFakeApi(POLYGON_ROUTES);
    api.status = 403;
    await expect(
      fetchPolygonExchanges({ apiKey: 'pk-test-0123456789', baseUrl: api.url }),
    ).rejects.toThrow(AuthError);
    api.status = 429;
    await expect(
      fetchPolygonExchanges({ apiKey: 'pk-test-0123456789', baseUrl: api.url }),
    ).rejects.toThrow(RateLimitError);
  });
});

describe('fetchPolygonConditions', () => {
  it('keeps every name and flags only the ones the CDM models', async () => {
    api = await startFakeApi(POLYGON_ROUTES);
    const table = await fetchPolygonConditions({ apiKey: 'pk-test-0123456789', baseUrl: api.url });
    expect(table.names).toEqual({
      37: 'Odd Lot Trade',
      12: 'Form T',
      16: 'Sold Out Of Sequence',
      0: 'Regular Sale',
    });
    // Regular Sale is recognised but carries no flag.
    expect(Object.keys(table.flags).sort()).toEqual(['12', '16', '37']);
  });
});

describe('alpaca reference', () => {
  it('reads code-to-name for exchanges and skips blanks', async () => {
    api = await startFakeApi(ALPACA_ROUTES);
    const table = await fetchAlpacaExchanges({
      keyId: 'AKTEST0123456789',
      secret: 'secret-0123456789',
      baseUrl: api.url,
    });
    expect(table.labels).toEqual({ A: 'NYSE American (AMEX)', B: 'Nasdaq OMX BX', V: 'IEX' });
  });

  it('sends both halves of the credential as headers', async () => {
    api = await startFakeApi(ALPACA_ROUTES);
    await fetchAlpacaExchanges({
      keyId: 'AKTEST0123456789',
      secret: 'secret-0123456789',
      baseUrl: api.url,
    });
    expect(api.headers[0]!.keyId).toBe('AKTEST0123456789');
    expect(api.headers[0]!.secret).toBe('secret-0123456789');
  });

  it('reads the trade condition table for the requested tape', async () => {
    api = await startFakeApi(ALPACA_ROUTES);
    const table = await fetchAlpacaConditions({
      keyId: 'AKTEST0123456789',
      secret: 'secret-0123456789',
      baseUrl: api.url,
      tape: 'A',
    });
    expect(api.paths[0]).toContain('tape=A');
    expect(table.names['I']).toBe('Odd Lot Trade');
    expect(Object.keys(table.flags).sort()).toEqual(['I', 'T', 'Z']);
  });
});

describe('loading registers both tables', () => {
  it('populates the venue and condition registries for Massive', async () => {
    api = await startFakeApi(POLYGON_ROUTES);
    expect(venueLabelFor('polygon', '62')).toBeUndefined();

    const report = await loadPolygonReference({ apiKey: 'pk-test-0123456789', baseUrl: api.url });
    expect(report).toEqual({
      provider: 'polygon',
      venues: 3,
      conditions: 4,
      conditionsFlagged: 3,
    });
    expect(venueLabelFor('polygon', 62)).toBe('FINR');
    expect(hasFlag(conditionFlags('polygon', [37], 500), CdmFlags.OddLot)).toBe(true);
  });

  it('populates them for Alpaca, keyed on its own vocabulary', async () => {
    api = await startFakeApi(ALPACA_ROUTES);
    const report = await loadAlpacaReference({
      keyId: 'AKTEST0123456789',
      secret: 'secret-0123456789',
      baseUrl: api.url,
    });
    expect(report.provider).toBe('alpaca');
    expect(venueLabelFor('alpaca', 'V')).toBe('IEX');
    expect(hasFlag(conditionFlags('alpaca', ['I'], 500), CdmFlags.OddLot)).toBe(true);
    // Registering Alpaca's table does not answer for Massive's codes.
    expect(conditionFlags('polygon', [37], 500)).toBe(0);
  });
});
