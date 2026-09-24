# Phase 0 gate 2 — draft CDM and provider disagreements

Status: **provisional.** The field-level analysis below is from vendor documentation and
reference payloads. It is not yet confirmed against a real 24-hour capture, because that needs
live keys. Run `node scripts/capture-fixtures.mjs --provider all --minutes 1440`, then revisit
every row marked **verify**.

The point of this document is to record where the three feeds genuinely disagree, so the
escape-hatch ratio in the kill criteria can be counted rather than guessed.

## Draft CDM

Every message carries both a venue timestamp and a Conduit ingress timestamp, both `bigint`
nanoseconds. Prices are `number`; cost is integer micro-units; neither is ever the other.

```ts
type CdmBase = {
  figi: string;          // '' until @conduit/symbology lands in Phase 3
  symbol: string;        // as the provider spelled it
  provider: ProviderId;
  tsEvent: bigint;       // venue timestamp, ns
  tsConduitRecv: bigint; // our ingress, ns
  seq?: bigint;          // provider sequence number where one exists
};

type QuoteTick = CdmBase & { kind: 'quote'; bidPx; bidSz; askPx; askSz; bidVenue?; askVenue?; flags? };
type TradeTick = CdmBase & { kind: 'trade'; px; sz; tradeId?; venue?; flags? };
type Bar       = CdmBase & { kind: 'bar'; interval; open; high; low; close; volume; vwap?; trades?; tsEventEnd };
type Depth     = CdmBase & { kind: 'depth'; bids: Level[]; asks: Level[] };
```

## Where the providers disagree

| # | Field | Polygon | Alpaca | Databento | CDM decision | Escape hatch |
|---|---|---|---|---|---|---|
| 1 | Venue timestamp | `t`, SIP, **ms** | `t`, RFC-3339 string, **ns** | `ts_event`, uint64 **ns** | `bigint` ns; Polygon × 1e6 | no (lossy, not leaky) |
| 2 | Second timestamp | `y` participant ns on some types | none | `ts_recv` ns | `tsEvent` from venue, `tsConduitRecv` ours; `y`/`ts_recv` dropped | no |
| 3 | Sequence number | `q` per symbol | **none** | `sequence` | `seq?` optional; gap detection only where present | no |
| 4 | Condition codes | `c: number[]` SIP ints | `c: string[]` char codes | `flags` bitfield + `action`/`side` chars | `flags?: number` Conduit bitfield + `raw` passthrough | **yes** |
| 5 | Venue identity | `x`/`bx`/`ax` Polygon numeric ids, `z` tape | `x` single-char code | `publisher_id` + dataset | MIC where mappable, else `undefined` | **yes** |
| 6 | Price encoding | float | float | int64 fixed-point, scale 1e-9 | `number`; Databento ÷ 1e9 | no |
| 7 | Quote size units | lots vs shares — **verify** | lots vs shares — **verify** | shares | shares; per-provider multiplier in adapter | no, if the multiplier is a constant |
| 8 | Quote update semantics | full two-sided per message | full two-sided per message | `mbp-1` is an incremental book event with `action`/`side`; both sides present in `levels[0]` | two-sided snapshot; Databento adapter reconstructs | **yes** |
| 9 | Class-share spelling | `BRK.B` | `BRK.B` | raw symbol may be `BRK B` — **verify** | Phase 3 `SymbolMap` | no (that's the whole point of symbology) |
| 10 | Bar window | `AM` has `s` and `e` | `t` is bar start only | `ts_event` is bar start | `tsEvent` = start, `tsEventEnd` = start + interval | no |
| 11 | Bar extras | `vw`, `av`, `op` | `vw`, `n` | none in `ohlcv-1m` | `vwap?`, `trades?`; `av`/`op` dropped | no |
| 12 | Depth | L2 requires a separate feed | not offered | `mbp-10` native | `depth_10` capability is Databento-only; others throw `CoverageError` | no (coverage, not schema) |

## Escape-hatch count against the kill criteria

The criterion is provider-specific escape hatches in more than ~20% of message types.

| Message type | Escape hatch needed | Which |
|---|---|---|
| `quote_l1` | yes | #4 conditions, #5 venue, #8 Databento book reconstruction |
| `trades` | yes | #4 conditions, #5 venue |
| `bars_1m` | no | — |
| `bars_1d` | no | — |
| `depth_10` | no | single provider, nothing to reconcile |

2 of 5 message types, **40%** — above the 20% threshold. Both failures are the same two fields:
condition codes and venue identity.

**Provisional verdict: scope down as the roadmap prescribes, but narrowly.** The unified schema
holds for prices, sizes, timestamps, and bar structure, which is the part that strategy code
actually reads. It does not hold for condition codes and venue identity, which have no shared
vocabulary across vendors and cannot be normalized without inventing one.

So the CDM carries a Conduit-level `flags` bitfield for the handful of semantics that are real
across all three (odd lot, out of sequence, trade-through exempt, halted), and every message keeps
a typed `raw` reference for the provider-specific remainder. Consumers that only read prices and
sizes never touch `raw`. Consumers doing condition-code analysis are writing provider-specific
code either way, and Conduit's job there is to hand them the original payload instead of pretending
to normalize it.

This is the "three good clients with a shared shape" outcome for two fields out of twelve, not for
the whole project. Phase 1 proceeds.

## Phase 5 tracking hook

Escape-hatch leakage into calling code is metric #1 of the Phase 5 go/no-go gate. The baseline is
this table: **two fields**. If Crossbar's migration needs `raw` for anything other than condition
codes or venue identity, that's a regression and it gets recorded here.
