import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthError, RateLimitError, SchemaError } from '@conduit/core';
import {
  KEYED_BATCH_SIZE,
  KEYED_RATE_LIMIT,
  OpenFigiClient,
  RateLimiter,
  UNKEYED_BATCH_SIZE,
  UNKEYED_RATE_LIMIT,
} from '../src/openfigi.js';

describe('RateLimiter', () => {
  it('allows up to the limit inside one minute, then delays', () => {
    let now = 1_000_000;
    const limiter = new RateLimiter(3, () => now);
    for (let i = 0; i < 3; i += 1) {
      expect(limiter.delayMs()).toBe(0);
      limiter.record();
    }
    expect(limiter.delayMs()).toBe(60_000);
    now += 30_000;
    expect(limiter.delayMs()).toBe(30_000);
    now += 30_001;
    expect(limiter.delayMs()).toBe(0);
  });

  it('slides rather than resetting on a fixed boundary', () => {
    let now = 0;
    const limiter = new RateLimiter(2, () => now);
    limiter.record();
    now = 40_000;
    limiter.record();
    now = 61_000;
    // The first request has aged out; the second has not.
    expect(limiter.delayMs()).toBe(0);
  });

  it('waits through acquire without busy-looping', async () => {
    let now = 0;
    const slept: number[] = [];
    const limiter = new RateLimiter(1, () => now);
    await limiter.acquire();
    await limiter.acquire(async (ms) => {
      slept.push(ms);
      now += ms;
    });
    expect(slept).toEqual([60_000]);
  });
});

interface FakeFigi {
  readonly url: string;
  readonly requests: { body: unknown; apiKey: string | undefined }[];
  status: number;
  respond: (body: unknown[]) => unknown[];
  close(): Promise<void>;
}

async function startFakeFigi(): Promise<FakeFigi> {
  const state = {
    status: 200,
    respond: (body: unknown[]) =>
      body.map((job) => {
        const idValue = (job as { idValue: string }).idValue;
        if (idValue.startsWith('NOPE')) return { warning: 'No identifier found.' };
        return {
          data: [
            {
              figi: 'BBG000B9XRY4',
              name: `${idValue} Inc`,
              ticker: idValue,
              exchCode: 'US',
              compositeFIGI: 'BBG000B9XRY4',
              securityType: 'Common Stock',
            },
          ],
        };
      }),
  };
  const requests: { body: unknown; apiKey: string | undefined }[] = [];

  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw) as unknown[];
      requests.push({ body, apiKey: req.headers['x-openfigi-apikey'] as string | undefined });
      if (state.status !== 200) {
        res.writeHead(state.status, { 'retry-after': '5' });
        res.end('nope');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(state.respond(body)));
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
    get respond() {
      return state.respond;
    },
    set respond(v: (body: unknown[]) => unknown[]) {
      state.respond = v;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let figi: FakeFigi | undefined;
afterEach(async () => {
  await figi?.close();
  figi = undefined;
});

describe('OpenFigiClient', () => {
  it('uses the keyed limits when a key is given and the unkeyed ones otherwise', () => {
    const unkeyed = new OpenFigiClient();
    expect(unkeyed.batchSize).toBe(UNKEYED_BATCH_SIZE);
    expect(unkeyed.rateLimit).toBe(UNKEYED_RATE_LIMIT);
    const keyed = new OpenFigiClient({ apiKey: 'figi-key-0123456789' });
    expect(keyed.batchSize).toBe(KEYED_BATCH_SIZE);
    expect(keyed.rateLimit).toBe(KEYED_RATE_LIMIT);
  });

  it('splits into batches of the size the limit allows', async () => {
    figi = await startFakeFigi();
    const client = new OpenFigiClient({ baseUrl: figi.url, sleep: async () => {} });
    const jobs = Array.from({ length: 25 }, (_, i) => ({ symbol: `SYM${i}` }));
    const results = await client.map(jobs);
    expect(results).toHaveLength(25);
    // 25 jobs at 10 per request, unkeyed.
    expect(figi.requests).toHaveLength(3);
    expect((figi.requests[0]!.body as unknown[]).length).toBe(10);
    expect((figi.requests[2]!.body as unknown[]).length).toBe(5);
  });

  it('sends the key in the header, never the body', async () => {
    figi = await startFakeFigi();
    const client = new OpenFigiClient({
      apiKey: 'figi-key-0123456789',
      baseUrl: figi.url,
      sleep: async () => {},
    });
    await client.map([{ symbol: 'AAPL' }]);
    expect(figi.requests[0]!.apiKey).toBe('figi-key-0123456789');
    expect(JSON.stringify(figi.requests[0]!.body)).not.toContain('figi-key');
  });

  it('converts symbols to the OpenFIGI convention before sending', async () => {
    figi = await startFakeFigi();
    const client = new OpenFigiClient({ baseUrl: figi.url, sleep: async () => {} });
    await client.map([{ symbol: 'BRK.B' }, { symbol: 'BRK B' }]);
    const sent = figi.requests[0]!.body as { idType: string; idValue: string }[];
    expect(sent.map((j) => j.idValue)).toEqual(['BRK/B', 'BRK/B']);
    expect(sent[0]!.idType).toBe('TICKER');
  });

  it('reports an unmatched symbol as unmatched rather than throwing', async () => {
    figi = await startFakeFigi();
    const client = new OpenFigiClient({ baseUrl: figi.url, sleep: async () => {} });
    const [matched, unmatched] = await client.map([{ symbol: 'AAPL' }, { symbol: 'NOPE1' }]);
    expect(matched!.kind).toBe('matched');
    expect(unmatched!.kind).toBe('unmatched');
    expect(unmatched!.kind === 'unmatched' && unmatched.reason).toBe('No identifier found.');
  });

  it('keeps results aligned with the jobs that produced them', async () => {
    figi = await startFakeFigi();
    const client = new OpenFigiClient({ baseUrl: figi.url, sleep: async () => {} });
    const jobs = [{ symbol: 'AAPL' }, { symbol: 'NOPE1' }, { symbol: 'MSFT' }];
    const results = await client.map(jobs);
    expect(results.map((r) => r.job.symbol)).toEqual(['AAPL', 'NOPE1', 'MSFT']);
  });

  it('maps status codes onto the error taxonomy', async () => {
    figi = await startFakeFigi();
    const client = new OpenFigiClient({ baseUrl: figi.url, sleep: async () => {} });

    figi.status = 401;
    await expect(client.map([{ symbol: 'AAPL' }])).rejects.toThrow(AuthError);

    figi.status = 429;
    await expect(client.map([{ symbol: 'AAPL' }])).rejects.toThrow(RateLimitError);
  });

  it('rejects a response whose length does not match the request', async () => {
    figi = await startFakeFigi();
    figi.respond = () => [];
    const client = new OpenFigiClient({ baseUrl: figi.url, sleep: async () => {} });
    await expect(client.map([{ symbol: 'AAPL' }])).rejects.toThrow(SchemaError);
  });
});
