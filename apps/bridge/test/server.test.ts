import { describe, expect, it } from 'vitest';
import { ConduitClient } from '@conduit/client';
import { BridgeServer } from '../src/server.js';
import { FakeAdapter } from './fake-adapter.js';

const T0 = 1_704_205_800_000_000_000n;

function harness(adapters = [new FakeAdapter('polygon'), new FakeAdapter('alpaca')]) {
  const written: Record<string, unknown>[] = [];
  const client = new ConduitClient({
    providers: adapters,
    failover: { probeIntervalMs: 20, staleAfterMs: 5_000, maxConsecutiveFailures: 2 },
  });
  const server = new BridgeServer({
    client,
    write: (line) => {
      written.push(JSON.parse(line) as Record<string, unknown>);
      return true;
    },
  });
  return { server, written, adapters, client };
}

async function settle(ms = 30): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe('bridge server', () => {
  it('announces providers and coverage on ready', () => {
    const { server, written } = harness();
    server.ready();
    expect(written[0]).toMatchObject({
      type: 'ready',
      providers: ['polygon', 'alpaca'],
    });
    expect((written[0] as { coverage: Record<string, string[]> }).coverage['quote_l1']).toEqual([
      'polygon',
      'alpaca',
    ]);
  });

  it('answers a summary with timestamps as strings', async () => {
    const { server, written } = harness();
    server.feed('{"id":1,"op":"summary","symbols":["AAPL"]}\n');
    await settle();
    const result = written.find((w) => w['type'] === 'result') as {
      id: number;
      data: { symbol: string; tsEvent: string; lastPx: number }[];
    };
    expect(result.id).toBe(1);
    expect(result.data[0]!.symbol).toBe('AAPL');
    // A nanosecond epoch does not fit a double, so it crosses as a decimal string.
    expect(typeof result.data[0]!.tsEvent).toBe('string');
    expect(BigInt(result.data[0]!.tsEvent)).toBeGreaterThan(0n);
  });

  it('streams subscription messages against the handle that asked for them', async () => {
    const { server, written, adapters } = harness();
    server.feed('{"id":7,"op":"subscribe","symbols":["AAPL"],"schema":"quote_l1"}\n');
    await settle();
    expect(written.find((w) => w['type'] === 'result')).toMatchObject({
      id: 7,
      data: { subscribed: true },
    });

    adapters[0]!.emitQuote('AAPL', T0);
    await settle();
    const message = written.find((w) => w['type'] === 'message') as {
      id: number;
      data: { symbol: string; tsEvent: string };
    };
    expect(message.id).toBe(7);
    expect(message.data.symbol).toBe('AAPL');
    expect(message.data.tsEvent).toBe(T0.toString());
    await server.close();
  });

  it('forwards control messages, so a failover is visible to the consumer', async () => {
    const { server, written, adapters } = harness();
    server.feed('{"id":1,"op":"subscribe","symbols":["AAPL"],"schema":"quote_l1"}\n');
    await settle();
    adapters[0]!.failNow(new Error('socket died'));
    await settle(200);

    const control = written.find(
      (w) => w['type'] === 'message' && (w['data'] as { kind: string }).kind === 'control',
    ) as { data: { control: string; previousProvider: string } };
    expect(control.data.control).toBe('provider_switch');
    expect(control.data.previousProvider).toBe('polygon');
    await server.close();
  });

  it('closes a subscription on unsubscribe and stops sending', async () => {
    const { server, written, adapters } = harness();
    server.feed('{"id":3,"op":"subscribe","symbols":["AAPL"],"schema":"quote_l1"}\n');
    await settle();
    expect(server.openSubscriptions).toBe(1);

    server.feed('{"id":3,"op":"unsubscribe"}\n');
    await settle();
    expect(written.some((w) => w['type'] === 'end' && w['id'] === 3)).toBe(true);
    expect(server.openSubscriptions).toBe(0);

    const before = written.length;
    adapters[0]!.emitQuote('AAPL', T0);
    await settle();
    expect(written.length).toBe(before);
    await server.close();
  });

  it('refuses a duplicate subscription id rather than losing the first', async () => {
    const { server, written } = harness();
    server.feed('{"id":5,"op":"subscribe","symbols":["AAPL"],"schema":"quote_l1"}\n');
    await settle();
    server.feed('{"id":5,"op":"subscribe","symbols":["MSFT"],"schema":"quote_l1"}\n');
    await settle();
    expect(written.find((w) => w['type'] === 'error')).toMatchObject({
      id: 5,
      message: 'id 5 is already subscribed',
    });
    expect(server.openSubscriptions).toBe(1);
    await server.close();
  });

  it('reports a coverage gap as a typed error, not a crash', async () => {
    const { server, written } = harness([new FakeAdapter('polygon', { capabilities: ['quote_l1'] })]);
    server.feed('{"id":9,"op":"subscribe","symbols":["ESZ4"],"schema":"depth_10"}\n');
    await settle();
    expect(written.find((w) => w['type'] === 'error')).toMatchObject({ id: 9, code: 'coverage' });
    await server.close();
  });

  it('reports a malformed request without an id against 0', async () => {
    const { server, written } = harness();
    server.feed('garbage\n{"id":1,"op":"health"}\n');
    await settle();
    expect(written[0]).toMatchObject({ type: 'error', id: 0, code: 'bad_request' });
    // And keeps processing the rest of the stream.
    expect(written.some((w) => w['type'] === 'result' && w['id'] === 1)).toBe(true);
    await server.close();
  });

  it('handles a request split across two chunks', async () => {
    const { server, written } = harness();
    server.feed('{"id":4,"op":');
    server.feed('"health"}\n');
    await settle();
    expect(written.find((w) => w['type'] === 'result')).toMatchObject({ id: 4 });
    await server.close();
  });

  it('serializes health, which contains a bigint', async () => {
    const { server, written } = harness();
    server.feed('{"id":2,"op":"health"}\n');
    await settle();
    const result = written.find((w) => w['type'] === 'result') as {
      data: Record<string, { observedAtNs: string; state: string }>;
    };
    expect(typeof result.data['polygon']!.observedAtNs).toBe('string');
    expect(result.data['polygon']!.state).toBe('unknown');
    await server.close();
  });

  it('shuts down on request', async () => {
    let shutdown = false;
    const { written, client } = harness();
    const server = new BridgeServer({
      client,
      write: (line) => {
        written.push(JSON.parse(line) as Record<string, unknown>);
        return true;
      },
      onShutdown: () => (shutdown = true),
    });
    server.feed('{"id":1,"op":"shutdown"}\n');
    await settle();
    expect(shutdown).toBe(true);
    expect(written.find((w) => w['type'] === 'result')).toMatchObject({ data: { closing: true } });
  });
});
