import type { Schema } from '@conduit/core';

/**
 * What the adapter has been asked to stream. Held separately from the socket so a reconnect can
 * replay the whole set — resubscribing from this registry is what makes a reconnect invisible to
 * the consumer.
 */
export class SubscriptionRegistry {
  #entries = new Map<Schema, Set<string>>();

  add(schema: Schema, symbols: readonly string[]): string[] {
    let set = this.#entries.get(schema);
    if (!set) {
      set = new Set();
      this.#entries.set(schema, set);
    }
    const added: string[] = [];
    for (const symbol of symbols) {
      if (!set.has(symbol)) {
        set.add(symbol);
        added.push(symbol);
      }
    }
    return added;
  }

  remove(schema: Schema, symbols: readonly string[]): string[] {
    const set = this.#entries.get(schema);
    if (!set) return [];
    const removed: string[] = [];
    for (const symbol of symbols) {
      if (set.delete(symbol)) removed.push(symbol);
    }
    if (set.size === 0) this.#entries.delete(schema);
    return removed;
  }

  symbols(schema: Schema): readonly string[] {
    return [...(this.#entries.get(schema) ?? [])];
  }

  /** Every (schema, symbols) pair currently subscribed, for replay after a reconnect. */
  all(): readonly { schema: Schema; symbols: readonly string[] }[] {
    return [...this.#entries].map(([schema, set]) => ({ schema, symbols: [...set] }));
  }

  get size(): number {
    let total = 0;
    for (const set of this.#entries.values()) total += set.size;
    return total;
  }

  clear(): void {
    this.#entries.clear();
  }
}
