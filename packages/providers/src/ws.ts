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
  /** Client-side keepalive. A missing pong terminates the socket and forces a reconnect. */
  readonly pingIntervalMs?: number;
  readonly pongTimeoutMs?: number;
  /** Called when retrying cannot help — a revoked key, for instance. Stops the reconnect loop. */
  readonly onFatal?: (error: ConduitError) => void;
  readonly onReconnect?: (attempt: number, delayMs: number) => void;
}

type SocketFactory = (url: string) => WebSocket;

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
  #fatal: ConduitError | undefined;

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

  /** Marks the failure fatal, stops reconnecting, and reports it to the caller. */
  fail(error: ConduitError): void {
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

  #clearTimers(): void {
    for (const timer of [this.#reconnectTimer, this.#pingTimer, this.#pongTimer]) {
      if (timer) clearTimeout(timer);
    }
    this.#reconnectTimer = undefined;
    this.#pingTimer = undefined;
    this.#pongTimer = undefined;
  }

  #scheduleReconnect(reason: string): void {
    if (this.#closed || this.#fatal) return;
    const delay = backoffDelayMs(this.#attempt, this.#options.backoff ?? DEFAULT_BACKOFF);
    this.#attempt += 1;
    this.#options.onReconnect?.(this.#attempt, delay);
    this.#options.health.recordFailure(new TransportError(redact(reason)));
    this.#reconnectTimer = setTimeout(() => {
      this.#options.health.recordReconnect();
      this.#connect();
    }, delay);
    this.#reconnectTimer.unref?.();
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
      this.#attempt = 0;
      this.#options.health.recordConnected();
      this.#startKeepalive(socket);
      this.#options.onOpen(ctx);
    });

    socket.on('message', (data: WebSocket.RawData) => {
      this.#options.onText(data.toString(), ctx);
    });

    socket.on('error', (error: Error) => {
      // 'error' is always followed by 'close', which is where the reconnect is scheduled.
      this.#options.health.recordFailure(new TransportError(redact(error.message)));
    });

    socket.on('close', (code: number, reasonBuf: Buffer) => {
      this.#clearTimers();
      this.#options.health.recordDisconnected();
      if (this.#socket === socket) this.#socket = undefined;
      if (this.#closed || this.#fatal) return;
      const reason = reasonBuf.length > 0 ? reasonBuf.toString() : `code ${code}`;
      // 1008/4001-class policy closes on a market data feed almost always mean a bad key.
      if (code === 1008) {
        this.fail(new AuthError(`socket rejected: ${redact(reason)}`));
        return;
      }
      this.#scheduleReconnect(`socket closed: ${reason}`);
    });
  }
}
