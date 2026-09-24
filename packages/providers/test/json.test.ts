import { describe, expect, it } from 'vitest';
import { parseJsonLossless, quoteLongIntegers } from '../src/json.js';

describe('quoteLongIntegers', () => {
  it('quotes integers too large for a double, in value and array position', () => {
    expect(quoteLongIntegers('{"t":1704205800123456789}')).toBe('{"t":"1704205800123456789"}');
    expect(quoteLongIntegers('[1704205800123456789,1704205800123456790]')).toBe(
      '["1704205800123456789","1704205800123456790"]',
    );
  });

  it('leaves safe integers, floats, and negatives-that-fit alone', () => {
    const safe = '{"t":1704205800123,"p":185.12,"v":-42,"e":1.7e18}';
    expect(quoteLongIntegers(safe)).toBe(safe);
  });

  it('never touches digits inside a string, including escaped quotes', () => {
    const text = '{"id":"1704205800123456789","note":"x\\"1704205800123456789\\"y"}';
    expect(quoteLongIntegers(text)).toBe(text);
  });

  it('quotes a long negative integer as one token', () => {
    expect(quoteLongIntegers('{"t":-1704205800123456789}')).toBe('{"t":"-1704205800123456789"}');
  });
});

describe('parseJsonLossless', () => {
  it('round-trips a 19-digit epoch through BigInt exactly', () => {
    const parsed = parseJsonLossless('{"ts_event":1704205800123456789}') as { ts_event: string };
    expect(BigInt(parsed.ts_event)).toBe(1704205800123456789n);
  });

  it('matches JSON.parse when nothing needs quoting', () => {
    const text = '[{"ev":"Q","sym":"AAPL","t":1704205800123,"bp":185.1}]';
    expect(parseJsonLossless(text)).toEqual(JSON.parse(text));
  });

  it('propagates a syntax error rather than returning a half-parsed value', () => {
    expect(() => parseJsonLossless('{"t":170420580012345678')).toThrow(SyntaxError);
  });
});
