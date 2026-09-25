import { describe, expect, it } from 'vitest';
import { SequenceTracker } from '../src/sequence.js';

function tracker(scope: 'symbol' | 'stream' | 'none' = 'symbol') {
  return new SequenceTracker({ provider: 'polygon', scope });
}

describe('SequenceTracker', () => {
  it('is off by default, because a channel counter cannot be checked per symbol', () => {
    const t = new SequenceTracker({ provider: 'polygon' });
    expect(t.scope).toBe('none');
    expect(t.check('AAPL', 1n)).toBeUndefined();
    expect(t.check('AAPL', 9_999n)).toBeUndefined();
    expect(t.gaps).toBe(0);
  });

  it('establishes a baseline on the first message without reporting a gap', () => {
    const t = tracker();
    expect(t.check('AAPL', 500n)).toBeUndefined();
    expect(t.gaps).toBe(0);
  });

  it('accepts consecutive numbers', () => {
    const t = tracker();
    t.check('AAPL', 10n);
    expect(t.check('AAPL', 11n)).toBeUndefined();
    expect(t.check('AAPL', 12n)).toBeUndefined();
    expect(t.gaps).toBe(0);
  });

  it('reports a forward jump with the count of what is missing', () => {
    const t = tracker();
    t.check('AAPL', 10n);
    const gap = t.check('AAPL', 15n);
    expect(gap).toEqual({
      symbol: 'AAPL',
      expectedSeq: 11n,
      receivedSeq: 15n,
      missing: 4n,
    });
    expect(t.gaps).toBe(1);
    expect(t.missing).toBe(4n);
  });

  it('tracks each symbol separately under symbol scope', () => {
    const t = tracker('symbol');
    t.check('AAPL', 10n);
    t.check('MSFT', 900n);
    // Interleaving does not create a gap for either.
    expect(t.check('AAPL', 11n)).toBeUndefined();
    expect(t.check('MSFT', 901n)).toBeUndefined();
    expect(t.gaps).toBe(0);
    expect(t.tracked).toBe(2);
  });

  it('shares one counter across symbols under stream scope', () => {
    const t = tracker('stream');
    t.check('AAPL', 10n);
    // A channel counter increments across symbols, so this is consecutive, not a gap.
    expect(t.check('MSFT', 11n)).toBeUndefined();
    expect(t.check('AAPL', 12n)).toBeUndefined();
    expect(t.gaps).toBe(0);
    expect(t.tracked).toBe(1);
  });

  it('counts a backward sequence as out of order, not as a gap', () => {
    const t = tracker();
    t.check('AAPL', 20n);
    expect(t.check('AAPL', 15n)).toBeUndefined();
    expect(t.outOfOrder).toBe(1);
    expect(t.gaps).toBe(0);
    // And the baseline did not move backwards, so the next in-order message is not a false gap.
    expect(t.check('AAPL', 21n)).toBeUndefined();
    expect(t.gaps).toBe(0);
  });

  it('ignores a repeated sequence number', () => {
    const t = tracker();
    t.check('AAPL', 20n);
    expect(t.check('AAPL', 20n)).toBeUndefined();
    expect(t.outOfOrder).toBe(0);
    expect(t.gaps).toBe(0);
  });

  it('ignores messages with no sequence number at all, as Alpaca sends', () => {
    const t = tracker();
    expect(t.check('AAPL', undefined)).toBeUndefined();
    expect(t.tracked).toBe(0);
  });

  it('drops its baseline on reset, since numbering restarts on a new connection', () => {
    const t = tracker();
    t.check('AAPL', 5_000n);
    t.reset();
    // Renumbered from 1 after a reconnect. Without the reset this would look like a huge gap.
    expect(t.check('AAPL', 1n)).toBeUndefined();
    expect(t.gaps).toBe(0);
  });

  it('handles sequences beyond Number.MAX_SAFE_INTEGER', () => {
    const t = tracker();
    t.check('AAPL', 9_007_199_254_740_993n);
    const gap = t.check('AAPL', 9_007_199_254_740_996n);
    expect(gap!.missing).toBe(2n);
  });
});
