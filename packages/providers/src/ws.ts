import WebSocket from 'ws';
import {
  AuthError,
  backoffDelayMs,
  DEFAULT_BACKOFF,
  TransportError,
  redact,
  type BackoffOptions,
  type ConduitError,
  type HealthTracker,
  type Logger,
} from '@conduit/core';

export interface SocketContext {
  /** Sends a text frame. No-op if the socket is not open. */
  send(frame: string): void;
}

export interface ReconnectingSocketOptions {
  readonly url: string;
  readonly health: HealthTracker;
  readonly backoff?: BackoffOptions;
  /** Auth and resubscribe live here; called on every open, including reconnects. */
  readonly onOpen: (ctx: SocketContext) => void;
  readonly onText: (data: string, ctx: SocketContext) => void;
  /**
   * Binary frames. Without a handler, one is reported as a transport failure naming msgpack, which
   * is the only reason a market data socket sends binary: Alpaca's stream speaks msgpack when the
   * connection asks for it with `Content-Type: application/msgpack`, and its own SDK defaults to
   * that. Conduit asks for JSON, so a binary frame means something negotiated differently.
   */
  readonly onBinary?: (data: Buffer, ctx: SocketContext) => void;
  /** Client-side keepalive. A missing pong terminates the socket and forces a reconnect. */
  readonly pingIntervalMs?: number;
  /**
   * How long an open socket may go without the caller calling markProductive() before it is
   * terminated and retried. The keepalive cannot cover this case: a server that answers pings while
   * never answering the auth frame keeps a socket that looks alive and delivers nothing, and the
   * consumer waits on it indefinitely. 0 disables the check.
   */
  readonly productiveTimeoutMs?: number;
  readonly pongTimeoutMs?: number;
  /** Called when retrying cannot help — a revoked key, for instance. Stops the reconnect loop. */
  readonly onFatal?: (error: ConduitError) => void;
  /**
   * How many times the socket may open, fail to become productive, and close before the failure is
   * reported to the caller as fatal. Without a cap a socket that completes its handshake and is then
   * rejected at the application level reconnects forever while the consumer waits on a subscription
   * that cannot ever deliver. Alpaca's 406 "connection limit exceeded" behaves exactly this way.
   */
  readonly maxUnproductiveAttempts?: number;
  readonly onReconnect?: (attempt: number, delayMs: number) => void;
  /** Already wrapped by createLogger, so it filters, redacts and cannot throw. */
  readonly logger?: Logger;
}

/** Test seam for ReconnectingSocket and the adapters that build one. */
export type SocketFactory = (url: string) => WebSocket;

/**
 * One socket, reconnected forever with exponential backoff and jitter, until close() or a fatal
 * error. Auth and resubscription are the caller's job via onOpen, which is invoked on every open.
 */
export class ReconnectingSocket {
  #options: ReconnectingSocketOptions;
  #factory: SocketFactory;
  #socket: WebSocket | undefined;
  #closed = false;
  #attempt = 0;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #pingTimer: NodeJS.Timeout | undefined;
  #pongTimer: NodeJS.Timeout | undefined;
  #productiveTimer: NodeJS.Timeout | undefined;
  #fatal: ConduitError | undefined;
  #unproductive = 0;
  #notedError: ConduitError | undefined;

  constructor(
    options: ReconnectingSocketOptions,
    factory: SocketFactory = (url) => new WebSocket(url),
  ) {
    this.#options = options;
    this.#factory = factory;
  }

  get connected(): boolean {
    return this.#socket?.readyState === WebSocket.OPEN;
  }

  get fatalError(): ConduitError | undefined {
    return this.#fatal;
  }

  start(): void {
    if (this.#closed || this.#socket) return;
    this.#connect();
  }

  send(frame: string): void {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(frame);
  }

  /**
   * The caller's signal that this connection reached a useful state — authenticated, subscribed, or
   * delivering data. It resets the backoff and the unproductive-attempt budget, so a feed that has
   * worked for hours and then drops gets a full retry allowance rather than one inherited from a
   * rejection earlier in the process's life.
   */
  markProductive(): void {
    this.#attempt = 0;
    this.#unproductive = 0;
    this.#notedError = undefined;
    if (this.#productiveTimer) clearTimeout(this.#productiveTimer);
    this.#productiveTimer = undefined;
  }

  /**
   * Records an application-level error on a socket that has not become productive. If the
   * unproductive budget runs out this is the error the caller is given, so its class survives: the
   * router has to see a connection cap as a rate limit and a bad key as an auth failure, and a
   * generic transport error would lose that distinction.
   */
  noteError(error: ConduitError): void {
    this.#notedError = error;
    // Do not wait for the server to decide it is done with us. Alpaca sends 406 within 50ms and
    // then holds the connection open until its own 10s auth timeout, so leaving it to close on its
    // own made every retry cost ten seconds of silence. Terminating now starts the backoff
    // immediately, and the 'close' event it triggers is what schedules the retry.
    const socket = this.#socket;
    if (!socket || this.#closed || this.#fatal) return;
    this.#log('warn', 'rejected before becoming productive; terminating', { code: error.code });
    try {
      socket.terminate();
    } catch {
      /* already gone */
    }
  }

  /** Marks the failure fatal, stops reconnecting, and reports it to the caller. */
  fail(error: ConduitError): void {
    this.#log('error', 'fatal, not retrying', { code: error.code, error: error.message });
    this.#fatal = error;
    this.#options.health.recordFailure(error);
    this.#options.onFatal?.(error);
    void this.close();
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#clearTimers();
    const socket = this.#socket;
    this.#socket = undefined;
    if (!socket) return;
    this.#options.health.recordDisconnected();
    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      try {
        socket.close();
      } catch {
        resolve();
      }
      // A server that never answers the close handshake must not hang shutdown.
      setTimeout(() => {
        try {
          socket.terminate();
        } catch {
          /* already gone */
        }
        resolve();
      }, 1_000).unref?.();
    });
  }

  #log(
    level: 'debug' | 'info' | 'warn' | 'error',
    msg: string,
    fields?: Record<string, unknown>,
  ): void {
    this.#options.logger?.({
      level,
      msg,
      provider: this.#options.health.provider,
      ...(fields ? { fields } : {}),
    });
  }

  #clearTimers(): void {
    for (const timer of [
      this.#reconnectTimer,
      this.#pingTimer,
      this.#pongTimer,
      this.#productiveTimer,
    ]) {
      if (timer) clearTimeout(timer);
    }
    this.#reconnectTimer = undefined;
    this.#pingTimer = undefined;
    this.#pongTimer = undefined;
    this.#productiveTimer = undefined;
  }

  #scheduleReconnect(reason: string): void {
    if (this.#closed || this.#fatal) return;

    this.#unproductive += 1;
    const cap = this.#options.maxUnproductiveAttempts;
    if (cap !== undefined && this.#unproductive > cap) {
      this.fail(
        this.#notedError ??
          new TransportError(
            `socket opened ${this.#unproductive} times and never delivered data: ${redact(reason)}`,
          ),
      );
      return;
    }

    const delay = backoffDelayMs(this.#attempt, this.#options.backoff ?? DEFAULT_BACKOFF);
    this.#attempt += 1;
    // #attempt was incremented above, so it is already this reconnect's ordinal.
    this.#log('warn', 'reconnecting', { attempt: this.#attempt, delayMs: delay, reason });
    this.#options.onReconnect?.(this.#attempt, delay);
    this.#options.health.recordFailure(new TransportError(redact(reason)));
    this.#reconnectTimer = setTimeout(() => {
      this.#options.health.recordReconnect();
      this.#connect();
    }, delay);
    this.#reconnectTimer.unref?.();
  }

  #startProductiveTimer(socket: WebSocket): void {
    const timeout = this.#options.productiveTimeoutMs ?? 0;
    if (timeout <= 0) return;
    this.#productiveTimer = setTimeout(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      this.#log('warn', 'never became productive; terminating', { timeoutMs: timeout });
      this.#options.health.recordFailure(
        new TransportError(`socket never became productive within ${timeout}ms`),
      );
      try {
        // terminate() rather than close(): a server that has ignored us this long will not answer a
        // close handshake either, and the 'close' event is what schedules the retry.
        socket.terminate();
      } catch {
        /* already gone */
      }
    }, timeout);
    this.#productiveTimer.unref?.();
  }

  #startKeepalive(socket: WebSocket): void {
    const interval = this.#options.pingIntervalMs ?? 20_000;
    const pongTimeout = this.#options.pongTimeoutMs ?? 10_000;
    if (interval <= 0) return;

    const schedule = (): void => {
      this.#pingTimer = setTimeout(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        try {
          socket.ping();
        } catch {
          return;
        }
        this.#pongTimer = setTimeout(() => {
          // No pong: the TCP connection is dead even though readyState still says OPEN.
          try {
            socket.terminate();
          } catch {
            /* already gone */
          }
        }, pongTimeout);
        this.#pongTimer.unref?.();
      }, interval);
      this.#pingTimer.unref?.();
    };

    socket.on('pong', () => {
      if (this.#pongTimer) clearTimeout(this.#pongTimer);
      this.#pongTimer = undefined;
      schedule();
    });
    schedule();
  }

  #connect(): void {
    if (this.#closed) return;

    let socket: WebSocket;
    try {
      socket = this.#factory(this.#options.url);
    } catch (error) {
      this.#scheduleReconnect(error instanceof Error ? error.message : 'socket construction failed');
      return;
    }
    this.#socket = socket;
    const ctx: SocketContext = { send: (frame) => this.send(frame) };

    socket.on('open', () => {
      // Deliberately not resetting #attempt here. A socket can complete its handshake and still be
      // useless — rejected by an application-level error frame — and resetting on 'open' made every
      // such retry the first retry, so the delay never grew and the provider got hammered.
      this.#log('info', 'socket open');
      this.#options.health.recordConnected();
      this.#startKeepalive(socket);
      this.#startProductiveTimer(socket);
      this.#options.onOpen(ctx);
    });

    socket.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) {
        const onBinary = this.#options.onBinary;
        if (onBinary) {
          onBinary(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer), ctx);
          return;
        }
        // Feeding this to JSON.parse would produce an opaque parse failure every frame.
        this.#log('error', 'binary frame on a JSON socket; the peer is likely speaking msgpack');
        this.#options.health.recordFailure(
          new TransportError(
            'received a binary frame on a socket expecting JSON; the peer is likely speaking msgpack',
          ),
        );
        return;
      }
      this.#options.onText(data.toString(), ctx);
    });

    socket.on('error', (error: Error) => {
      // 'error' is always followed by 'close', which is where the reconnect is scheduled.
      this.#log('warn', 'socket error', { error: error.message });
      this.#options.health.recordFailure(new TransportError(redact(error.message)));
    });

    socket.on('close', (code: number, reasonBuf: Buffer) => {
      this.#clearTimers();
      this.#options.health.recordDisconnected();
      if (this.#socket === socket) this.#socket = undefined;
      if (this.#closed || this.#fatal) return;
      const reason = reasonBuf.length > 0 ? reasonBuf.toString() : `code ${code}`;
      this.#log('info', 'socket closed', { code, reason });
      // 1008/4001-class policy closes on a market data feed almost always mean a bad key.
      if (code === 1008) {
        this.fail(new AuthError(`socket rejected: ${redact(reason)}`));
        return;
      }
      this.#scheduleReconnect(`socket closed: ${reason}`);
    });
  }
}
