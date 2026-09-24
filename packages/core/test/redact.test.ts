import { afterEach, describe, expect, it } from 'vitest';
import { clearSecrets, redact, redactValue, registerSecret, secretCount } from '../src/redact.js';
import { AuthError, RateLimitError } from '../src/errors.js';

afterEach(clearSecrets);

describe('redact', () => {
  it('masks a registered credential anywhere in the string', () => {
    registerSecret('pk_live_abcdef123456');
    expect(redact('GET /v2/last?apiKey=pk_live_abcdef123456 failed')).toBe(
      'GET /v2/last?apiKey=[REDACTED] failed',
    );
  });

  it('ignores values too short to be credentials', () => {
    registerSecret('abc');
    expect(secretCount()).toBe(0);
    expect(redact('abc')).toBe('abc');
  });

  it('masks the longest match first when one secret contains another', () => {
    registerSecret('secretvalue');
    registerSecret('secretvalue_extended');
    expect(redact('key=secretvalue_extended')).toBe('key=[REDACTED]');
  });

  it('walks objects and arrays without mutating them', () => {
    registerSecret('token_1234567890');
    const input = { headers: { auth: 'Bearer token_1234567890' }, list: ['token_1234567890'] };
    const out = redactValue(input);
    expect(out.headers.auth).toBe('Bearer [REDACTED]');
    expect(out.list[0]).toBe('[REDACTED]');
    expect(input.headers.auth).toBe('Bearer token_1234567890');
  });
});

describe('errors scrub on construction', () => {
  it('never carries a credential in .message', () => {
    registerSecret('APCA-SECRET-0987654321');
    const err = new AuthError('auth failed for key APCA-SECRET-0987654321', {
      provider: 'alpaca',
    });
    expect(err.message).not.toContain('0987654321');
    expect(err.toString()).toBe('AuthError [alpaca]: auth failed for key [REDACTED]');
  });

  it('keeps retryAfterMs on a rate limit', () => {
    const err = new RateLimitError('slow down', { provider: 'polygon', retryAfterMs: 1200 });
    expect(err.retryAfterMs).toBe(1200);
    expect(err.retryable).toBe(true);
    expect(err.code).toBe('rate_limit');
  });
});
