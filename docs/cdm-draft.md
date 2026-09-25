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
| 1 | Venue timestamp | `t`, SIP, **ms** (confirmed) | `t`, RFC-3339 string, **ns** (confirmed) | `ts_event`, uint64 **ns** | `bigint` ns; Polygon × 1e6 | no (lossy, not leaky) |
| 2 | Second timestamp | `pt` participant, **ms**, omitted on OTC via FINRA ORF (id 62) | none | `ts_recv` ns | `tsEvent` from venue, `tsConduitRecv` ours; `pt`/`ts_recv` stay in `raw` | no |
| 3 | Sequence number | `q` per symbol | **none** | `sequence` | `seq?` optional; gap detection only where present | no |
| 4 | Condition codes | `c: number[]` SIP ints | `c: string[]` char codes | `flags` bitfield + `action`/`side` chars | `flags?: number` Conduit bitfield + `raw` passthrough | **yes** |
| 5 | Venue identity | `x`/`bx`/`ax` numeric ids, `z` tape | `x` single-char code | `publisher_id` + dataset | **the vendor's own code, verbatim** — no MIC translation | **yes** |
| 6 | Price encoding | float | float | int64 fixed-point, scale 1e-9 | `number`; Databento ÷ 1e9 | no |
| 7 | Quote size units | **shares** since 2025-11-03 (was round lots) | **round lots**, still | shares | shares; multiplier is per adapter, not shared — Massive 1x, Alpaca 100x | no |
| 8 | Quote update semantics | full two-sided per message | full two-sided per message | `mbp-1` is an incremental book event with `action`/`side`; both sides present in `levels[0]` | two-sided snapshot; Databento adapter reconstructs | **yes** |
| 9 | Class-share spelling | `BRK.B` | `BRK.B` | raw symbol may be `BRK B` — **verify** | Phase 3 `SymbolMap` | no (that's the whole point of symbology) |
| 10 | Bar window | `AM` has `s` and `e` | `t` is bar start only | `ts_event` is bar start | `tsEvent` = start, `tsEventEnd` = start + interval | no |
| 11 | Bar extras | `vw`, `av`, `op` | `vw`, `n` | none in `ohlcv-1m` | `vwap?`, `trades?`; `av`/`op` dropped | no |
| 12 | Depth | L2 requires a separate feed | not offered | `mbp-10` native | `depth_10` capability is Databento-only; others throw `CoverageError` | no (coverage, not schema) |

## Row 7 resolved, 2026-09-25

Checked against the vendors' own field documentation rather than a capture, because the answer
turned out to be a dated migration rather than an ambiguity.

- **Massive (formerly Polygon)** moved stocks quote `bid_size` / `ask_size` from round lots to
  **shares on 2025-11-03**, across the REST API, the websocket stream, and flat files. Flat files
  dated before the cutover stayed in round lots while historical regeneration ran.
- **Alpaca** still documents both as **round lots**.
- Trade sizes were always shares on both.

The adapter defaults were wrong for Massive: it multiplied quote sizes by 100, overstating every one
by 100x. Fixed — `quoteSizeUnits` now defaults to `'shares'` for Massive and stays `'lots'` for
Alpaca, and the `'lots'` option remains for replaying pre-cutover flat files.

This is the failure mode the `verify` markers existed for. A 100x size error is not visibly wrong in
a log; it surfaces as bad fills in anything that conditions on quoted size.

## Rows 2 and 5 resolved, 2026-09-25

Same method, same day. Two more of my own assumptions turned out to be wrong.

**Row 2.** The participant timestamp is `pt`, not `y`, and it is in **milliseconds**, not
nanoseconds. It is also optional: "Omitted on OTC trades reported through the FINRA ORF (exchange
62), which have no participant timestamp." There is a third timestamp, `trft`, for the TRF. None of
them enter the CDM; they stay in `raw`.

**Row 5 — venue identity.** This file previously said the CDM would carry "MIC where mappable". The
implementation did that with a hand-written numeric-id-to-MIC table that I wrote from memory, and it
was wrong: it mapped Massive id 62 to MEMX, while Massive's own trade documentation says 62 is the
FINRA ORF. Both vendors serve their real code tables only from authenticated reference endpoints.

So the CDM now carries **the vendor's own venue code verbatim**, as a string, and does not claim it
is a MIC. Consumers that want MICs register a map they trust via `registerVenueMap()` and resolve
with `micFor()`. A wrong venue label is worse than an untranslated one, because a strategy filtering
on venue acts on it silently.

**Also found while reading the trade docs:** `ds` is "the trade size including fractional shares,
represented as a string". The adapter read only `s`, which truncates a fractional-share trade. It now
prefers `ds` when present.

**Still needing a live capture or vendor support:** Databento's raw symbol spelling for class shares
(row 9), and whether its JSON encoding renders 64-bit fields as strings or numbers. Neither is
documented publicly; the adapter already accepts both shapes for the second.

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
this table: **two fields**. If the first migration needs `raw` for anything other than condition
codes or venue identity, that's a regression and it gets recorded here.
