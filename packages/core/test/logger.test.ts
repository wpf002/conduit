import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOOP_LOGGER, createLogger, type LogRecord } from '../src/logger.js';
import { clearSecrets, registerSecret } from '../src/redact.js';

afterEach(clearSecrets);

describe('createLogger', () => {
  it('is a no-op without a sink, so the library stays silent by default', () => {
    expect(createLogger(undefined)).toBe(NOOP_LOGGER);
    expect(() => createLogger(undefined)({ level: 'error', msg: 'x' })).not.toThrow();
  });

  it('filters below the threshold before the sink is called', () => {
    const seen: LogRecord[] = [];
    const log = createLogger((r) => seen.push(r), { level: 'warn' });
    log({ level: 'debug', msg: 'a' });
    log({ level: 'info', msg: 'b' });
    log({ level: 'warn', msg: 'c' });
    log({ level: 'error', msg: 'd' });
    expect(seen.map((r) => r.msg)).toEqual(['c', 'd']);
  });

  it('defaults to info', () => {
    const seen: LogRecord[] = [];
    const log = createLogger((r) => seen.push(r));
    log({ level: 'debug', msg: 'dropped' });
    log({ level: 'info', msg: 'kept' });
    expect(seen.map((r) => r.msg)).toEqual(['kept']);
  });

  it('redacts credentials from the message and from the fields', () => {
    registerSecret('polygon-key-0123456789');
    const seen: LogRecord[] = [];
    const log = createLogger((r) => seen.push(r), { level: 'debug' });
    log({
      level: 'error',
      msg: 'auth failed for polygon-key-0123456789',
      fields: { url: 'wss://x?apiKey=polygon-key-0123456789', nested: { k: 'polygon-key-0123456789' } },
    });
    expect(seen[0]!.msg).not.toContain('0123456789');
    expect(JSON.stringify(seen[0]!.fields)).not.toContain('0123456789');
  });

  it('swallows a throwing sink rather than breaking the caller', () => {
    const log = createLogger(() => {
      throw new Error('logger is broken');
    });
    expect(() => log({ level: 'error', msg: 'x' })).not.toThrow();
  });

  it('passes provider, schema and symbol through', () => {
    const seen: LogRecord[] = [];
    const log = createLogger((r) => seen.push(r));
    log({ level: 'info', msg: 'x', provider: 'alpaca', schema: 'quote_l1', symbol: 'AAPL' });
    expect(seen[0]).toMatchObject({ provider: 'alpaca', schema: 'quote_l1', symbol: 'AAPL' });
  });

  it('does not evaluate the sink for a filtered record', () => {
    const sink = vi.fn();
    const log = createLogger(sink, { level: 'error' });
    log({ level: 'info', msg: 'x' });
    expect(sink).not.toHaveBeenCalled();
  });
});
