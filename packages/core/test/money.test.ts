import { describe, expect, it } from 'vitest';
import {
  addMicros,
  centsToMicros,
  formatMicros,
  micros,
  microsToCents,
  sumMicros,
  ZERO_MICROS,
} from '../src/money.js';

describe('micros', () => {
  it('rejects non-integers so no float ever enters the cost path', () => {
    expect(() => micros(1.5)).toThrow(RangeError);
    expect(() => micros(Number.NaN)).toThrow(RangeError);
    expect(() => micros(Number.MAX_SAFE_INTEGER + 2)).toThrow(RangeError);
  });

  it('sums exactly where floats would not', () => {
    // 0.1 + 0.2 in dollars is the canonical float failure; in micros it is exact.
    expect(addMicros(micros(100_000), micros(200_000))).toBe(300_000);
    const tenth = micros(100_000);
    expect(sumMicros(Array.from({ length: 10 }, () => tenth))).toBe(1_000_000);
  });

  it('converts cents', () => {
    expect(centsToMicros(1)).toBe(10_000);
    expect(microsToCents(micros(15_000))).toBe(2);
    expect(microsToCents(ZERO_MICROS)).toBe(0);
  });

  it('formats', () => {
    expect(formatMicros(micros(1_500_000))).toBe('1.50 USD');
    expect(formatMicros(micros(1))).toBe('0.000001 USD');
    expect(formatMicros(micros(-2_000_000), 'EUR')).toBe('-2.00 EUR');
  });
});
