import { describe as group, expect, it } from 'vitest';
import { registerSecret } from '@conduit/core';
import { describe } from '../src/describe.js';

group('describe', () => {
  it('keeps the cause under a Prisma invocation header', () => {
    // Verbatim shape of a real Prisma 7 error, which is why the header-only version was useless.
    const error = new Error(
      '\nInvalid `prisma.symbolMap.findMany()` invocation:\n\n\nDatabase `conduit` does not exist on the database server',
    );
    const out = describe(error);
    expect(out).toContain('does not exist on the database server');
    expect(out).toContain('Invalid `prisma.symbolMap.findMany()` invocation:');
  });

  it('leaves an ordinary single-line error alone', () => {
    expect(describe(new Error('alpaca auth failed (402)'))).toBe('alpaca auth failed (402)');
  });

  it('does not duplicate a header that is the only line', () => {
    expect(describe(new Error('something failed:'))).toBe('something failed:');
  });

  it('takes the first line when there is no header', () => {
    expect(describe(new Error('first thing\nsecond thing'))).toBe('first thing');
  });

  it('falls back to the name when the message is blank', () => {
    const error = new Error('\n\n  \n');
    error.name = 'TransportError';
    expect(describe(error)).toBe('TransportError');
  });

  it('redacts a credential that reached an error message', () => {
    // Secrets are registered by the adapter that owns them, which is what an adapter does at
    // construction; reading process.env here would test a mechanism that does not exist.
    const secret = 'PKTESTKEY0123456789';
    registerSecret(secret);
    expect(describe(new Error(`auth failed for ${secret}`))).not.toContain(secret);
  });

  it('passes a non-Error through', () => {
    expect(describe('plain string')).toBe('plain string');
  });
});
