import type { ProviderId, Schema } from '@conduit/core';
import type { RouterEvent } from './config.js';
import type { Subscription } from './subscription.js';

export interface FailoverIncident {
  readonly at: Date;
  readonly from: ProviderId | undefined;
  readonly to: ProviderId;
  readonly schema: Schema | undefined;
  readonly reason: string;
  /** Milliseconds since the previous incident, or undefined for the first. */
  readonly sinceLastMs: number | undefined;
}

export interface FailoverAuditReport {
  readonly switches: number;
  readonly degradations: number;
  readonly recoveries: number;
  readonly byProvider: Readonly<Record<string, number>>;
  readonly incidents: readonly FailoverIncident[];
  /** Messages the router suppressed because a switch would have replayed them out of order. */
  readonly droppedOutOfOrder: number;
  /**
   * Switches that happened close enough together to look like thrashing rather than one failure.
   * A provider that flaps is a configuration problem, not a failover success.
   */
  readonly rapidSwitches: number;
}

export interface FailoverAuditOptions {
  /** Two switches inside this window count as thrashing. Default 10s. */
  readonly thrashWindowMs?: number;
  readonly maxIncidents?: number;
  readonly now?: () => Date;
}

/**
 * Metric 2 of the Phase 5 go/no-go gate: how many failover events fire, and whether any of them
 * corrupted downstream state.
 *
 * Corruption is not directly observable from here, but its two mechanisms are: out-of-order
 * messages reaching the consumer, which `droppedOutOfOrder` shows the router prevented, and a
 * provider flapping, which `rapidSwitches` counts. A run with switches, zero dropped messages, and
 * zero rapid switches is the shape of a failover that worked.
 */
export class FailoverAudit {
  #incidents: FailoverIncident[] = [];
  #byProvider = new Map<string, number>();
  #degradations = 0;
  #recoveries = 0;
  #rapidSwitches = 0;
  #lastSwitchAt: number | undefined;
  #thrashWindowMs: number;
  #maxIncidents: number;
  #now: () => Date;
  #subscriptions = new Set<Subscription>();

  constructor(options: FailoverAuditOptions = {}) {
    this.#thrashWindowMs = options.thrashWindowMs ?? 10_000;
    this.#maxIncidents = options.maxIncidents ?? 1_000;
    this.#now = options.now ?? (() => new Date());
  }

  /** Pass this as the client's `onEvent`. */
  get onEvent(): (event: RouterEvent) => void {
    return (event) => this.record(event);
  }

  /** Subscriptions to read droppedOutOfOrder from when the report is built. */
  watch(subscription: Subscription): void {
    this.#subscriptions.add(subscription);
  }

  record(event: RouterEvent): void {
    switch (event.type) {
      case 'switch': {
        const at = this.#now();
        const sinceLastMs =
          this.#lastSwitchAt === undefined ? undefined : at.getTime() - this.#lastSwitchAt;
        if (sinceLastMs !== undefined && sinceLastMs < this.#thrashWindowMs) {
          this.#rapidSwitches += 1;
        }
        this.#lastSwitchAt = at.getTime();
        this.#byProvider.set(event.provider, (this.#byProvider.get(event.provider) ?? 0) + 1);
        if (this.#incidents.length < this.#maxIncidents) {
          this.#incidents.push({
            at,
            from: event.previousProvider,
            to: event.provider,
            schema: event.schema,
            reason: event.reason,
            sinceLastMs,
          });
        }
        return;
      }
      case 'degraded':
        this.#degradations += 1;
        return;
      case 'recovered':
        this.#recoveries += 1;
        return;
      default:
        return;
    }
  }

  report(): FailoverAuditReport {
    let dropped = 0;
    for (const subscription of this.#subscriptions) dropped += subscription.droppedOutOfOrder;
    return {
      switches: this.#incidents.length,
      degradations: this.#degradations,
      recoveries: this.#recoveries,
      byProvider: Object.fromEntries(this.#byProvider),
      incidents: this.#incidents,
      droppedOutOfOrder: dropped,
      rapidSwitches: this.#rapidSwitches,
    };
  }

  /** One line per incident, for a dogfood log. */
  format(): string {
    const report = this.report();
    const lines = [
      `switches=${report.switches} degraded=${report.degradations} recovered=${report.recoveries} ` +
        `dropped=${report.droppedOutOfOrder} thrash=${report.rapidSwitches}`,
    ];
    for (const incident of report.incidents) {
      lines.push(
        `  ${incident.at.toISOString()} ${incident.from ?? '(none)'} -> ${incident.to} ` +
          `[${incident.schema ?? 'any'}] ${incident.reason}`,
      );
    }
    return lines.join('\n');
  }
}
