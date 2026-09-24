import type { HealthSnapshot, HealthState } from './adapter.js';
import type { ProviderId } from './ids.js';
import { nowNs, ageMs } from './time.js';
import { redact } from './redact.js';

export interface HealthTrackerOptions {
  readonly provider: ProviderId;
  /** No market message for this long while connected means degraded. */
  readonly staleAfterMs: number;
  readonly maxConsecutiveFailures: number;
}

/**
 * Shared by every adapter so the router sees one health vocabulary. Adapters report events; this
 * decides state. Nothing here touches the network.
 */
export class HealthTracker {
  readonly provider: ProviderId;

  #staleAfterMs: number;
  #maxConsecutiveFailures: number;
  #connected = false;
  #consecutiveFailures = 0;
  #reconnectCount = 0;
  #messagesReceived = 0;
  #lastMessageNs: bigint | undefined;
  #lastError: string | undefined;

  constructor(options: HealthTrackerOptions) {
    this.provider = options.provider;
    this.#staleAfterMs = options.staleAfterMs;
    this.#maxConsecutiveFailures = options.maxConsecutiveFailures;
  }

  recordConnected(): void {
    this.#connected = true;
    this.#consecutiveFailures = 0;
    this.#lastError = undefined;
  }

  recordDisconnected(): void {
    this.#connected = false;
  }

  recordReconnect(): void {
    this.#reconnectCount += 1;
  }

  /** A market message arrived. Resets both the failure count and the staleness clock. */
  recordMessage(count = 1): void {
    this.#messagesReceived += count;
    this.#lastMessageNs = nowNs();
    this.#consecutiveFailures = 0;
  }

  recordFailure(error: unknown): void {
    this.#consecutiveFailures += 1;
    this.#lastError = redact(error instanceof Error ? error.message : String(error));
  }

  get consecutiveFailures(): number {
    return this.#consecutiveFailures;
  }

  get lastMessageAgeMs(): number | undefined {
    return this.#lastMessageNs === undefined ? undefined : ageMs(this.#lastMessageNs);
  }

  get isStale(): boolean {
    const age = this.lastMessageAgeMs;
    return this.#connected && age !== undefined && age > this.#staleAfterMs;
  }

  #state(): HealthState {
    if (this.#consecutiveFailures >= this.#maxConsecutiveFailures) return 'down';
    if (!this.#connected) return this.#consecutiveFailures > 0 ? 'degraded' : 'down';
    if (this.isStale) return 'degraded';
    if (this.#consecutiveFailures > 0) return 'degraded';
    return 'healthy';
  }

  snapshot(): HealthSnapshot {
    return {
      provider: this.provider,
      state: this.#state(),
      connected: this.#connected,
      consecutiveFailures: this.#consecutiveFailures,
      lastMessageAgeMs: this.lastMessageAgeMs,
      reconnectCount: this.#reconnectCount,
      messagesReceived: this.#messagesReceived,
      lastError: this.#lastError,
      observedAtNs: nowNs(),
    };
  }
}

export interface BackoffOptions {
  readonly baseMs: number;
  readonly maxMs: number;
  /** Fraction of the delay to randomize, 0 to 1. */
  readonly jitter: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 250, maxMs: 30_000, jitter: 0.3 };

/** Exponential with full-range jitter on the configured fraction. attempt is 0-based. */
export function backoffDelayMs(
  attempt: number,
  options: BackoffOptions = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(options.maxMs, options.baseMs * 2 ** Math.max(0, attempt));
  const jitterSpan = exponential * options.jitter;
  return Math.round(exponential - jitterSpan + random() * jitterSpan * 2);
}
