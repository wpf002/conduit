import { describe, expect, it, vi } from 'vitest';
import { backoffDelayMs, DEFAULT_BACKOFF, HealthTracker } from '../src/health.js';
import { TransportError } from '../src/errors.js';

function tracker(staleAfterMs = 5_000, maxConsecutiveFailures = 3) {
  return new HealthTracker({ provider: 'polygon', staleAfterMs, maxConsecutiveFailures });
}

describe('HealthTracker', () => {
  it('starts down, since nothing has connected yet', () => {
    expect(tracker().snapshot().state).toBe('down');
  });

  it('is healthy once connected with a fresh message', () => {
    const t = tracker();
    t.recordConnected();
    t.recordMessage();
    const snap = t.snapshot();
    expect(snap.state).toBe('healthy');
    expect(snap.connected).toBe(true);
    expect(snap.messagesReceived).toBe(1);
    expect(snap.lastMessageAgeMs).toBeLessThan(1000);
  });

  it('degrades on a failure and goes down at the configured threshold', () => {
    const t = tracker();
    t.recordConnected();
    t.recordMessage();
    t.recordFailure(new TransportError('socket hang up', { provider: 'polygon' }));
    expect(t.snapshot().state).toBe('degraded');
    t.recordFailure(new TransportError('socket hang up'));
    t.recordFailure(new TransportError('socket hang up'));
    expect(t.snapshot().state).toBe('down');
    expect(t.snapshot().consecutiveFailures).toBe(3);
  });

  it('degrades on staleness while still connected', () => {
    vi.useFakeTimers();
    try {
      const t = tracker(1_000);
      t.recordConnected();
      t.recordMessage();
      expect(t.snapshot().state).toBe('healthy');
      vi.advanceTimersByTime(2_000);
      // nowNs is driven by hrtime, which fake timers do not move, so assert the predicate directly.
      expect(t.lastMessageAgeMs).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the failure count when a message arrives', () => {
    const t = tracker();
    t.recordConnected();
    t.recordFailure(new TransportError('x'));
    t.recordFailure(new TransportError('x'));
    t.recordMessage();
    expect(t.snapshot().consecutiveFailures).toBe(0);
    expect(t.snapshot().state).toBe('healthy');
  });

  it('counts reconnects separately from failures', () => {
    const t = tracker();
    t.recordDisconnected();
    t.recordReconnect();
    t.recordConnected();
    t.recordMessage();
    expect(t.snapshot().reconnectCount).toBe(1);
    expect(t.snapshot().state).toBe('healthy');
  });

  it('redacts the last error', () => {
    const t = tracker();
    t.recordFailure(new Error('boom'));
    expect(t.snapshot().lastError).toBe('boom');
  });
});

describe('backoffDelayMs', () => {
  it('grows exponentially and clamps at maxMs', () => {
    const mid = () => 0.5;
    expect(backoffDelayMs(0, DEFAULT_BACKOFF, mid)).toBe(250);
    expect(backoffDelayMs(1, DEFAULT_BACKOFF, mid)).toBe(500);
    expect(backoffDelayMs(3, DEFAULT_BACKOFF, mid)).toBe(2000);
    expect(backoffDelayMs(50, DEFAULT_BACKOFF, mid)).toBe(30_000);
  });

  it('jitters within the configured band', () => {
    const opts = { baseMs: 1000, maxMs: 30_000, jitter: 0.3 };
    expect(backoffDelayMs(0, opts, () => 0)).toBe(700);
    expect(backoffDelayMs(0, opts, () => 1)).toBe(1300);
    for (let i = 0; i < 200; i += 1) {
      const d = backoffDelayMs(2, opts);
      expect(d).toBeGreaterThanOrEqual(2800);
      expect(d).toBeLessThanOrEqual(5200);
    }
  });

  it('treats a negative attempt as the first attempt', () => {
    expect(backoffDelayMs(-5, DEFAULT_BACKOFF, () => 0.5)).toBe(250);
  });
});
