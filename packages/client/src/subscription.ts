import {
  CoverageError,
  isConduitError,
  isMarketMessage,
  nowNs,
  type CdmMessage,
  type ControlMessage,
  type ProviderAdapter,
  type ProviderId,
  type Schema,
  type StreamRequest,
} from '@conduit/core';
import { AsyncQueue } from '@conduit/providers';
import type { ResolvedConfig, RouterEvent } from './config.js';

export interface SubscribeRequest {
  readonly symbols: readonly string[];
  readonly schema: Schema;
  readonly assetClass?: StreamRequest['assetClass'];
  readonly start?: bigint;
  readonly end?: bigint;
  readonly signal?: AbortSignal;
}

export interface Subscription extends AsyncIterable<CdmMessage> {
  readonly activeProvider: ProviderId;
  /** How many times the router moved this subscription to a different provider. */
  readonly switchCount: number;
  /** Messages dropped because a switch would otherwise have replayed older data. */
  readonly droppedOutOfOrder: number;
  /** Moves to a named provider. The only way to switch under the 'manual' strategy. */
  switchTo(provider: ProviderId, reason?: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * One consumer stream, fed by whichever of the user's providers is currently healthy.
 *
 * Sequence continuity beats completeness on a switch: a provider that comes up mid-stream will
 * generally replay a little history, and forwarding it would hand the consumer out-of-order
 * messages. Anything at or behind the per-symbol high-water mark is dropped and counted.
 */
export class ManagedSubscription implements Subscription {
  #config: ResolvedConfig;
  #request: SubscribeRequest;
  #candidates: readonly ProviderAdapter[];
  #queue = new AsyncQueue<CdmMessage>();
  #activeIndex = 0;
  #abort: AbortController | undefined;
  #watchdog: NodeJS.Timeout | undefined;
  #switchCount = 0;
  #dropped = 0;
  #closed = false;
  #switching: Promise<void> | undefined;
  #attachedAtMs = 0;
  /** Last forwarded venue timestamp per symbol. */
  #highWater = new Map<string, bigint>();

  constructor(
    config: ResolvedConfig,
    request: SubscribeRequest,
    candidates: readonly ProviderAdapter[],
  ) {
    this.#config = config;
    this.#request = request;
    this.#candidates = candidates;
  }

  get activeProvider(): ProviderId {
    return this.#candidates[this.#activeIndex]!.id;
  }

  get switchCount(): number {
    return this.#switchCount;
  }

  get droppedOutOfOrder(): number {
    return this.#dropped;
  }

  start(): void {
    this.#attach(this.#activeIndex);
    if (this.#config.failover.strategy !== 'manual') this.#startWatchdog();
    if (this.#request.signal) {
      if (this.#request.signal.aborted) void this.close();
      else this.#request.signal.addEventListener('abort', () => void this.close(), { once: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<CdmMessage> {
    const queue = this.#queue;
    const self = this;
    return (async function* () {
      try {
        for await (const message of queue) yield message;
      } finally {
        await self.close();
      }
    })();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#watchdog) clearInterval(this.#watchdog);
    this.#watchdog = undefined;
    this.#abort?.abort();
    this.#queue.end();
  }

  async switchTo(provider: ProviderId, reason = 'requested by the caller'): Promise<void> {
    const index = this.#candidates.findIndex((a) => a.id === provider);
    if (index === -1) {
      throw new CoverageError(
        `${provider} does not cover ${this.#request.schema} for these symbols`,
        { provider, schema: this.#request.schema },
      );
    }
    await this.#switch(index, reason);
  }

  // ------------------------------------------------------------------ internals
  #emit(event: RouterEvent): void {
    this.#config.onEvent?.(event);
  }

  #control(
    control: ControlMessage['control'],
    reason: string,
    previousProvider?: ProviderId,
  ): void {
    const message: ControlMessage = {
      kind: 'control',
      control,
      provider: this.activeProvider,
      ...(previousProvider ? { previousProvider } : {}),
      reason,
      symbols: this.#request.symbols,
      tsConduitRecv: nowNs(),
    };
    this.#queue.push(message);
  }

  #forward(message: CdmMessage): void {
    if (isMarketMessage(message)) {
      const high = this.#highWater.get(message.symbol);
      if (high !== undefined && message.tsEvent <= high) {
        this.#dropped += 1;
        return;
      }
      this.#highWater.set(message.symbol, message.tsEvent);
    }
    this.#queue.push(message);
  }

  #attach(index: number): void {
    if (this.#closed) return;
    const adapter = this.#candidates[index];
    if (!adapter) return;

    this.#activeIndex = index;
    this.#attachedAtMs = Date.now();
    const abort = new AbortController();
    this.#abort = abort;

    let stream: AsyncIterable<CdmMessage>;
    try {
      stream = adapter.stream({
        symbols: this.#request.symbols,
        schema: this.#request.schema,
        ...(this.#request.assetClass ? { assetClass: this.#request.assetClass } : {}),
        ...(this.#request.start === undefined ? {} : { start: this.#request.start }),
        ...(this.#request.end === undefined ? {} : { end: this.#request.end }),
        signal: abort.signal,
      });
    } catch (error) {
      // A synchronous CoverageError means this provider cannot serve the request after all.
      void this.#handleStreamFailure(index, error);
      return;
    }

    void this.#pump(index, stream, abort);
  }

  async #pump(
    index: number,
    stream: AsyncIterable<CdmMessage>,
    abort: AbortController,
  ): Promise<void> {
    try {
      for await (const message of stream) {
        if (abort.signal.aborted) break;
        this.#forward(message);
      }
      // A clean end that nobody asked for still means this provider stopped serving.
      if (!abort.signal.aborted && !this.#closed) {
        await this.#handleStreamFailure(index, new Error('provider stream ended'));
      }
    } catch (error) {
      if (abort.signal.aborted || this.#closed) return;
      await this.#handleStreamFailure(index, error);
    }
  }

  async #handleStreamFailure(index: number, error: unknown): Promise<void> {
    if (this.#closed) return;
    const reason = error instanceof Error ? error.message : String(error);
    const failed = this.#candidates[index]!.id;
    this.#emit({
      type: 'degraded',
      provider: failed,
      schema: this.#request.schema,
      reason,
      atMs: Date.now(),
    });

    if (this.#config.failover.strategy === 'manual') {
      this.#control('provider_degraded', reason);
      // Under 'manual' the caller decides. A fatal error still has to reach them.
      if (isConduitError(error) && !error.retryable) this.#queue.fail(error);
      return;
    }

    const next = this.#nextCandidate(index);
    if (next === undefined) {
      // Nowhere to go: surface the failure rather than stalling the consumer silently.
      this.#queue.fail(error);
      return;
    }
    await this.#switch(next, reason);
  }

  /** The next covering provider that is not already known to be down, preferring earlier ones. */
  #nextCandidate(excluding: number): number | undefined {
    const ordered = [
      ...this.#candidates.keys(),
    ].filter((i) => i !== excluding);
    const healthy = ordered.filter((i) => this.#candidates[i]!.health().state !== 'down');
    return healthy[0] ?? ordered[0];
  }

  async #switch(index: number, reason: string): Promise<void> {
    if (this.#closed || index === this.#activeIndex) return;
    // Serialize switches: two watchdog ticks must not both move the subscription.
    if (this.#switching) {
      await this.#switching;
      if (this.#closed || index === this.#activeIndex) return;
    }

    const previous = this.activeProvider;
    const run = (async () => {
      this.#abort?.abort();
      this.#switchCount += 1;
      // The control message goes out before the new provider's first tick, so a strategy sees the
      // switch ahead of the data it explains.
      this.#activeIndex = index;
      this.#control('provider_switch', reason, previous);
      this.#attach(index);
      this.#emit({
        type: 'switch',
        provider: this.activeProvider,
        previousProvider: previous,
        schema: this.#request.schema,
        reason,
        atMs: Date.now(),
      });
    })();

    this.#switching = run.finally(() => {
      this.#switching = undefined;
    });
    await this.#switching;
  }

  #startWatchdog(): void {
    const { probeIntervalMs, staleAfterMs, maxConsecutiveFailures, healthWindowMs } =
      this.#config.failover;

    this.#watchdog = setInterval(() => {
      if (this.#closed) return;
      const active = this.#candidates[this.#activeIndex]!;
      const health = active.health();

      const failing = health.consecutiveFailures >= maxConsecutiveFailures;
      const stale =
        health.lastMessageAgeMs !== undefined && health.lastMessageAgeMs > staleAfterMs;
      const down = health.state === 'down';

      if (failing || stale || down) {
        const reason = failing
          ? `${health.consecutiveFailures} consecutive failures`
          : stale
            ? `no message for ${health.lastMessageAgeMs}ms`
            : `health state ${health.state}`;
        const next = this.#nextCandidate(this.#activeIndex);
        if (next !== undefined) void this.#switch(next, reason);
        return;
      }

      // Fail back to a higher-priority provider once it has looked healthy for healthWindowMs.
      if (this.#activeIndex === 0) return;
      if (Date.now() - this.#attachedAtMs < healthWindowMs) return;
      for (let i = 0; i < this.#activeIndex; i += 1) {
        const candidate = this.#candidates[i]!;
        if (candidate.health().state === 'healthy') {
          this.#emit({
            type: 'recovered',
            provider: candidate.id,
            schema: this.#request.schema,
            reason: 'recovered and higher priority',
            atMs: Date.now(),
          });
          void this.#switch(i, `${candidate.id} recovered`);
          return;
        }
      }
    }, probeIntervalMs);
    this.#watchdog.unref?.();
  }
}
