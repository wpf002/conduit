import type { AssetClass, ProviderId, Schema } from './ids.js';
import { redact } from './redact.js';

/**
 * The router's behaviour is driven entirely by which of these it catches, so the taxonomy is
 * closed and every adapter maps its provider's failures into it.
 */
export type ConduitErrorCode =
  | 'auth'
  | 'rate_limit'
  | 'coverage'
  | 'transport'
  | 'upstream_stale'
  | 'schema';

export interface ConduitErrorOptions {
  readonly provider?: ProviderId;
  readonly cause?: unknown;
}

export abstract class ConduitError extends Error {
  abstract readonly code: ConduitErrorCode;

  /** Whether retrying the same provider can succeed. Distinct from whether to fail over. */
  abstract readonly retryable: boolean;

  readonly provider: ProviderId | undefined;

  constructor(message: string, options: ConduitErrorOptions = {}) {
    super(redact(message), options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.provider = options.provider;
  }

  override toString(): string {
    const where = this.provider ? ` [${this.provider}]` : '';
    return `${this.name}${where}: ${this.message}`;
  }
}

/** Key rejected, expired, revoked, or missing an entitlement. Never retry, always fail over. */
export class AuthError extends ConduitError {
  override readonly code = 'auth' as const;
  override readonly retryable = false;
}

/** Provider refused for volume. Retry after retryAfterMs, or fail over immediately. */
export class RateLimitError extends ConduitError {
  override readonly code = 'rate_limit' as const;
  override readonly retryable = true;
  readonly retryAfterMs: number | undefined;

  constructor(
    message: string,
    options: ConduitErrorOptions & { readonly retryAfterMs?: number } = {},
  ) {
    super(message, options);
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** This provider cannot serve this symbol/schema/asset class at all. Not a health signal. */
export class CoverageError extends ConduitError {
  override readonly code = 'coverage' as const;
  override readonly retryable = false;
  readonly schema: Schema | undefined;
  readonly assetClass: AssetClass | undefined;
  readonly symbol: string | undefined;

  constructor(
    message: string,
    options: ConduitErrorOptions & {
      readonly schema?: Schema;
      readonly assetClass?: AssetClass;
      readonly symbol?: string;
    } = {},
  ) {
    super(message, options);
    this.schema = options.schema;
    this.assetClass = options.assetClass;
    this.symbol = options.symbol;
  }
}

/** Socket, DNS, TLS, HTTP 5xx. Retryable with backoff; counts toward consecutive failures. */
export class TransportError extends ConduitError {
  override readonly code = 'transport' as const;
  override readonly retryable = true;
}

/** Connected and authenticated, but no message for longer than staleAfterMs. */
export class UpstreamStaleError extends ConduitError {
  override readonly code = 'upstream_stale' as const;
  override readonly retryable = true;
  readonly lastMessageAgeMs: number;

  constructor(message: string, options: ConduitErrorOptions & { lastMessageAgeMs: number }) {
    super(message, options);
    this.lastMessageAgeMs = options.lastMessageAgeMs;
  }
}

/** A payload that did not match the provider's documented shape. A Conduit bug or a vendor change. */
export class SchemaError extends ConduitError {
  override readonly code = 'schema' as const;
  override readonly retryable = false;
  readonly field: string | undefined;

  constructor(message: string, options: ConduitErrorOptions & { readonly field?: string } = {}) {
    super(message, options);
    this.field = options.field;
  }
}

export function isConduitError(value: unknown): value is ConduitError {
  return value instanceof ConduitError;
}

/** True when the router should stop using this provider rather than retry it. */
export function isFatalForProvider(error: unknown): boolean {
  return isConduitError(error) && !error.retryable;
}
