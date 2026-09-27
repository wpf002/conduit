import { describe, expect, it } from 'vitest';
import { LineReader, encodeBigints, parseRequest } from '../src/protocol.js';

describe('encodeBigints', () => {
  it('converts a nanosecond timestamp to a decimal string that survives JSON', () => {
    const encoded = encodeBigints({ tsEvent: 1704205800123456789n }) as { tsEvent: string };
    expect(encoded.tsEvent).toBe('1704205800123456789');
    // The whole reason this exists: the number form loses the last three digits.
    expect(JSON.parse(JSON.stringify(encoded)).tsEvent).toBe('1704205800123456789');
    expect(BigInt(encoded.tsEvent)).toBe(1704205800123456789n);
  });

  it('walks arrays, nested objects and Sets', () => {
    expect(encodeBigints([1n, { a: [2n] }])).toEqual(['1', { a: ['2'] }]);
    expect(encodeBigints({ caps: new Set(['quote_l1']) })).toEqual({ caps: ['quote_l1'] });
  });

  it('leaves everything else alone', () => {
    const input = { s: 'x', n: 1.5, b: true, z: null, u: undefined };
    expect(encodeBigints(input)).toEqual(input);
  });

  it('makes a whole CDM message serializable', () => {
    const quote = {
      kind: 'quote',
      symbol: 'AAPL',
      tsEvent: 1704205800123456789n,
      tsConduitRecv: 1704205800125000000n,
      seq: 99n,
      bidPx: 185.1,
    };
    expect(() => JSON.stringify(quote)).toThrow(TypeError);
    expect(() => JSON.stringify(encodeBigints(quote))).not.toThrow();
  });
});

describe('parseRequest', () => {
  it('accepts a well-formed request', () => {
    expect(parseRequest('{"id":1,"op":"summary","symbols":["AAPL"]}')).toEqual({
      id: 1,
      op: 'summary',
      symbols: ['AAPL'],
    });
  });

  it('carries a replay window through as strings', () => {
    const parsed = parseRequest('{"id":2,"op":"subscribe","schema":"bars_1d","start":"1704153600000000000"}');
    expect(parsed).toMatchObject({ schema: 'bars_1d', start: '1704153600000000000' });
  });

  it('rejects malformed input with a reason rather than throwing', () => {
    expect(parseRequest('not json')).toEqual({ error: 'not JSON' });
    expect(parseRequest('[]')).toEqual({ error: 'id must be a number' });
    expect(parseRequest('{"op":"summary"}')).toEqual({ error: 'id must be a number' });
    expect(parseRequest('{"id":1,"op":"nope"}')).toEqual({ error: 'unknown op: nope' });
    expect(parseRequest('{"id":1,"op":"summary","symbols":"AAPL"}')).toEqual({
      error: 'symbols must be an array of strings',
    });
    expect(parseRequest('{"id":1,"op":"summary","symbols":[1]}')).toEqual({
      error: 'symbols must be an array of strings',
    });
  });
});

describe('LineReader', () => {
  it('holds a partial line until its newline arrives', () => {
    const reader = new LineReader();
    expect(reader.push('{"id":1,')).toEqual([]);
    expect(reader.buffered).toBeGreaterThan(0);
    expect(reader.push('"op":"health"}\n')).toEqual(['{"id":1,"op":"health"}']);
    expect(reader.buffered).toBe(0);
  });

  it('splits several lines in one chunk', () => {
    expect(new LineReader().push('a\nb\nc\n')).toEqual(['a', 'b', 'c']);
  });

  it('handles a newline split across chunks', () => {
    const reader = new LineReader();
    expect(reader.push('a')).toEqual([]);
    expect(reader.push('\nb')).toEqual(['a']);
    expect(reader.push('\n')).toEqual(['b']);
  });
});
