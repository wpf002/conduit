import {
  CoverageError,
  ageMs,
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
  /** True while every candidate is silent, so the quiet period is reported once rather than per tick. */
  #quiet = false;
  #lastProbeAtMs = 0;
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

  /**
   * A candidate whose data is meaningfully fresher than the active one's. "Meaningfully" is half the
   * active provider's silence: a provider that is nearly as quiet is not evidence of anything, and
   * switching to it would just move the problem.
   */
  #fresherCandidate(activeIndex: number, activeAgeMs: number): number | undefined {
    const threshold = activeAgeMs / 2;
    for (const [index, candidate] of this.#candidates.entries()) {
      if (index === activeIndex) continue;
      const health = candidate.health();
      if (health.state === 'down') continue;
      // Never having received a message is not the same as having received one recently.
      if (health.lastMessageAgeMs === undefined) continue;
      if (health.lastMessageAgeMs < threshold) return index;
    }
    return undefined;
  }

  /**
   * Asks a standby whether the market is trading. A snapshot is one request and answers the only
   * question that matters when the active provider goes quiet: is everything quiet, or just this one?
   *
   * Switches when a standby returns data meaningfully fresher than the active provider's silence.
   * Stays put when the standby's data is just as old, which is what a closed market looks like, and
   * says so once rather than every tick.
   */
  async #probeForOpenMarket(activeAgeMs: number): Promise<void> {
    if (this.#closed) return;
    const threshold = activeAgeMs / 2;
    const probeSymbols = this.#request.symbols.slice(0, 1);

    for (const [index, candidate] of this.#candidates.entries()) {
      if (index === this.#activeIndex) continue;
      // No health pre-filter: the snapshot itself is the check, and a provider that has never been
      // used reports 'unknown', which is not a reason to skip it.

      try {
        const quotes = await candidate.snapshot({
          symbols: probeSymbols,
          ...(this.#request.assetClass ? { assetClass: this.#request.assetClass } : {}),
        });
        const freshest = quotes.reduce<number | undefined>((best, quote) => {
          const age = ageMs(quote.tsEvent);
          return best === undefined || age < best ? age : best;
        }, undefined);

        if (freshest !== undefined && freshest < threshold) {
          this.#quiet = false;
          await this.#switch(
            index,
            `no message for ${activeAgeMs}ms while ${candidate.id} has data ${freshest}ms old`,
          );
          return;
        }
        // The standby answered and its data is just as old. The market is closed.
        this.#reportQuiet(activeAgeMs, `${candidate.id} is ${freshest ?? 'equally'}ms behind too`);
        return;
      } catch {
        // This standby cannot be probed — a replay-only provider, or its own key is bad. Try the next.
        continue;
      }
    }

    // Nothing could be probed, so there is no evidence either way. Doing nothing forever is worse
    // than one switch, so fall back to the absolute rule.
    const next = this.#nextCandidate(this.#activeIndex);
    if (next !== undefined) {
      await this.#switch(next, `no message for ${activeAgeMs}ms and no standby could be probed`);
    }
  }

  #reportQuiet(activeAgeMs: number, detail: string): void {
    if (this.#quiet) return;
    this.#quiet = true;
    this.#emit({
      type: 'probe',
      provider: this.activeProvider,
      schema: this.#request.schema,
      reason: `every provider is silent (${activeAgeMs}ms; ${detail}); treating this as a closed market rather than failing over`,
      atMs: Date.now(),
    });
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

      // Failures and disconnection are evidence about this provider specifically.
      const failing = health.consecutiveFailures >= maxConsecutiveFailures;
      const down = health.state === 'down';
      const stale =
        health.lastMessageAgeMs !== undefined && health.lastMessageAgeMs > staleAfterMs;

      if (failing || down) {
        const reason = failing
          ? `${health.consecutiveFailures} consecutive failures`
          : `health state ${health.state}`;
        const next = this.#nextCandidate(this.#activeIndex);
        if (next !== undefined) void this.#switch(next, reason);
        return;
      }

      /*
       * Staleness is relative, not absolute. Outside market hours no provider sends anything, so an
       * absolute rule marks every candidate stale at once and the subscription switches every tick
       * for as long as the market is closed — all night, every night, and through every holiday.
       *
       * A silent provider is only worth leaving if somewhere else is measurably less silent. If
       * everything is quiet, the market is closed or the venue is down, and switching achieves
       * nothing but churn.
       */
      if (stale) {
        const activeAgeMs = health.lastMessageAgeMs!;

        // Cheap path: another candidate is already streaming recent data for someone else.
        const fresher = this.#fresherCandidate(this.#activeIndex, activeAgeMs);
        if (fresher !== undefined) {
          void this.#switch(
            fresher,
            `no message for ${activeAgeMs}ms while ${this.#candidates[fresher]!.id} is current`,
          );
          return;
        }

        // Otherwise ask. One snapshot answers whether anything is trading at all, and it is the only
        // evidence available: the router streams from the active provider only, so a standby has no
        // message history to compare against.
        const probeBackoffMs = Math.max(probeIntervalMs, staleAfterMs);
        if (Date.now() - this.#lastProbeAtMs < probeBackoffMs) return;
        this.#lastProbeAtMs = Date.now();
        void this.#probeForOpenMarket(activeAgeMs);
        return;
      }
      this.#quiet = false;

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
