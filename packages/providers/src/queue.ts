/**
 * Bridges callback-driven socket frames to a single AsyncIterable the consumer holds across
 * reconnects. The queue outlives the socket, which is what keeps the consumer's `for await` loop
 * alive when a provider drops.
 */
export interface AsyncQueueOptions {
  /** Above this many buffered items, the oldest are dropped. Memory bound beats completeness. */
  readonly highWaterMark: number;
}

export class AsyncQueue<T> implements AsyncIterable<T> {
  #buffer: T[] = [];
  #waiting: ((result: IteratorResult<T>) => void) | undefined;
  #failWaiting: ((err: unknown) => void) | undefined;
  #error: unknown;
  #ended = false;
  #dropped = 0;
  #highWaterMark: number;

  constructor(options: AsyncQueueOptions = { highWaterMark: 100_000 }) {
    this.#highWaterMark = options.highWaterMark;
  }

  get size(): number {
    return this.#buffer.length;
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
    while (this.#buffer.length > this.#highWaterMark) {
      this.#buffer.shift();
      this.#dropped += 1;
    }
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
      const buffered = this.#buffer.shift();
      if (buffered !== undefined) {
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
