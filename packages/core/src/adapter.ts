import type { CdmMessage, MarketMessage, QuoteTick } from './cdm.js';
import type { AssetClass, ProviderId, Schema } from './ids.js';

export type HealthState = 'healthy' | 'degraded' | 'down';

export interface HealthSnapshot {
  readonly provider: ProviderId;
  readonly state: HealthState;
  readonly connected: boolean;
  readonly consecutiveFailures: number;
  /** Milliseconds since the last market message, or undefined if none has arrived yet. */
  readonly lastMessageAgeMs: number | undefined;
  readonly reconnectCount: number;
  readonly messagesReceived: number;
  /** Already redacted. Safe to log. */
  readonly lastError: string | undefined;
  readonly observedAtNs: bigint;
}

export interface SnapshotRequest {
  readonly symbols: readonly string[];
  readonly assetClass?: AssetClass;
}

export interface StreamRequest {
  readonly symbols: readonly string[];
  readonly schema: Schema;
  readonly assetClass?: AssetClass;
  /**
   * Replay window, nanoseconds. Omitted means live. Providers whose only interface is historical
   * (Databento's HTTP API) require it; live-only providers throw CoverageError when it is given.
   */
  readonly start?: bigint;
  readonly end?: bigint;
  /** Aborting ends the iterator cleanly; it does not reject. */
  readonly signal?: AbortSignal;
}

/**
 * Every adapter implements all of this. A schema or asset class a provider cannot serve throws
 * CoverageError — never a silent no-op, and never an empty iterator.
 */
export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly capabilities: ReadonlySet<Schema>;

  health(): HealthSnapshot;
  supports(schema: Schema, assetClass: AssetClass): boolean;
  snapshot(req: SnapshotRequest): Promise<QuoteTick[]>;
  stream(req: StreamRequest): AsyncIterable<CdmMessage>;
  close(): Promise<void>;
}

/** A factory so consumer config reads as `polygon({ apiKey })` rather than `new PolygonAdapter`. */
export type AdapterFactory = () => ProviderAdapter;

export interface NormalizeResult {
  readonly messages: readonly MarketMessage[];
  /** Payloads the adapter recognized but chose not to emit, by reason. For `conduit doctor`. */
  readonly skipped: number;
}
