/**
 * Bridges callback-driven socket frames to a single AsyncIterable the consumer holds across
 * reconnects. The queue outlives the socket, which is what keeps the consumer's `for await` loop
 * alive when a provider drops.
 */
export interface OverflowInfo {
  readonly droppedThisEpisode: number;
  readonly droppedTotal: number;
  readonly buffered: number;
  readonly highWaterMark: number;
}

export interface AsyncQueueOptions {
  /** Above this many buffered items, the oldest are dropped. Memory bound beats completeness. */
  readonly highWaterMark: number;
  /**
   * Called once when dropping starts, not once per dropped item. A consumer falling behind loses
   * data silently otherwise, and a counter nobody reads is not a signal.
   */
  readonly onOverflow?: (info: OverflowInfo) => void;
  /** Called once when the buffer has drained back to half the high water mark. */
  readonly onRecover?: (info: OverflowInfo) => void;
}

export class AsyncQueue<T> implements AsyncIterable<T> {
  #buffer: T[] = [];
  /** Never dropped, drained before #buffer. Bounded by two messages per overflow episode. */
  #urgent: T[] = [];
  #waiting: ((result: IteratorResult<T>) => void) | undefined;
  #failWaiting: ((err: unknown) => void) | undefined;
  #error: unknown;
  #ended = false;
  #dropped = 0;
  #highWaterMark: number;
  #onOverflow: ((info: OverflowInfo) => void) | undefined;
  #onRecover: ((info: OverflowInfo) => void) | undefined;
  /** True between the first drop and the buffer draining to half the high water mark. */
  #overflowing = false;
  #episodeDropped = 0;

  constructor(options: AsyncQueueOptions = { highWaterMark: 100_000 }) {
    this.#highWaterMark = options.highWaterMark;
    this.#onOverflow = options.onOverflow;
    this.#onRecover = options.onRecover;
  }

  get overflowing(): boolean {
    return this.#overflowing;
  }

  #info(): OverflowInfo {
    return {
      droppedThisEpisode: this.#episodeDropped,
      droppedTotal: this.#dropped,
      buffered: this.#buffer.length,
      highWaterMark: this.#highWaterMark,
    };
  }

  get size(): number {
    return this.#buffer.length + this.#urgent.length;
  }

  /** Items discarded because the consumer could not keep up. Surfaced by `conduit doctor`. */
  get dropped(): number {
    return this.#dropped;
  }

  get ended(): boolean {
    return this.#ended;
  }

  push(item: T): void {
    if (this.#ended) return;
    const waiting = this.#waiting;
    if (waiting) {
      this.#waiting = undefined;
      this.#failWaiting = undefined;
      waiting({ value: item, done: false });
      return;
    }
    this.#buffer.push(item);
    let droppedNow = 0;
    while (this.#buffer.length > this.#highWaterMark) {
      this.#buffer.shift();
      this.#dropped += 1;
      droppedNow += 1;
    }
    if (droppedNow === 0) return;

    this.#episodeDropped += droppedNow;
    if (!this.#overflowing) {
      this.#overflowing = true;
      this.#onOverflow?.(this.#info());
    }
  }

  /**
   * Enqueues into a lane that is never dropped and is drained first, for a message about the queue's
   * own state.
   *
   * It needs its own lane rather than a place in the buffer: appending to a buffer that is already
   * overflowing means the next few pushes evict it from the front, so the notice about dropping would
   * be the thing dropped. Draining it first also reads correctly — the consumer is told it is behind
   * before being handed whatever survived.
   */
  pushUrgent(item: T): void {
    if (this.#ended) return;
    const waiting = this.#waiting;
    if (waiting) {
      this.#waiting = undefined;
      this.#failWaiting = undefined;
      waiting({ value: item, done: false });
      return;
    }
    this.#urgent.push(item);
  }

  /** Terminates the iterator with an error. Only for failures the consumer must see. */
  fail(error: unknown): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#error = error;
    const failWaiting = this.#failWaiting;
    this.#waiting = undefined;
    this.#failWaiting = undefined;
    failWaiting?.(error);
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    const waiting = this.#waiting;
    this.#waiting = undefined;
    this.#failWaiting = undefined;
    waiting?.({ value: undefined, done: true });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      const urgent = this.#urgent.shift();
      if (urgent !== undefined) {
        yield urgent;
        continue;
      }
      const buffered = this.#buffer.shift();
      if (buffered !== undefined) {
        // Recovery is drained to half, not to empty: reporting at the high water mark itself would
        // flap once per message while the consumer hovers at the boundary.
        if (this.#overflowing && this.#buffer.length <= this.#highWaterMark / 2) {
          this.#overflowing = false;
          const info = this.#info();
          this.#episodeDropped = 0;
          this.#onRecover?.(info);
        }
        yield buffered;
        continue;
      }
      if (this.#error !== undefined) throw this.#error;
      if (this.#ended) return;

      const next = await new Promise<IteratorResult<T>>((resolve, reject) => {
        this.#waiting = resolve;
        this.#failWaiting = reject;
      });
      if (next.done) return;
      yield next.value;
    }
  }
}
