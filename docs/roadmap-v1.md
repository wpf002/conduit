# Roadmap to v1

Written 2026-09-25, after Phases 0–4 of the build roadmap.

## What v1 means here

**A version you would depend on in production without reading its source.**

Not a feature count. Today the library is 258 tests green, and every one of those tests runs against
a fake server written from the same documentation the adapter was written from. That makes the suite
a test of internal consistency, not of correctness against reality. v1 is the point where that stops
being true.

## What v1 is not

Unchanged from the build roadmap, and worth restating because scope creep here is expensive:

- Not HFT. The target tier is 10–500ms.
- Not order routing. Data only.
- Not a cost-optimizing router. The router selects for coverage and health.
- Not a hosted service. No Conduit-operated component ever touches ticks.

---

## M1 — Conformance against primary sources

**Status: largely done without a key. See [conformance.md](conformance.md).**

The original form of this milestone required a live provider and blocked everything behind it. That
was wrong: most of what live testing gives you is knowledge of the wire format, and the vendors
publish that in their own open-source SDKs. Reading their encoders found two bugs that no amount of
documentation reading had — Databento's JSON has two shapes per numeric field, and Alpaca's stream
is msgpack unless you ask otherwise.

What remains genuinely key-gated is narrow, listed in
[conformance.md](conformance.md#what-this-cannot-give-you), and none of it blocks M2 or M3: auth,
reconnect against a real server, Databento's rate limits, the shape of a real entitlement error, and
sustained behaviour over a session.

### The original plan, for whenever a key does exist

Not one line of this library has spoken to a real provider. The adapters, the normalizers, the error
taxonomy and the reference loaders were all built from published docs, and three separate audits
already found that those docs contradicted my assumptions — quote sizes were 100x wrong, the
participant timestamp had the wrong name and unit, and the venue table was invented. Every one of
those was found by reading, not by running. The ones left will be found by running.

| Task | Notes |
|---|---|
| One key in `.env` | Alpaca's Basic plan is $0 and covers quotes, trades and bars on IEX. Cheapest possible first contact. |
| `conduit doctor` against it | Exercises auth, snapshot, coverage, quota headroom and the reference loaders in one command |
| 24h capture into `.fixtures/` | `node scripts/capture-fixtures.mjs --provider alpaca --minutes 1440` |
| Replay the real capture through the normalizers | Assert zero `SchemaError` across every message type seen |
| Resolve the remaining `verify` rows | cdm-draft rows 2 and 9, and Databento's undocumented rate limits |
| Promote the real capture to a committed fixture | **Scrub first.** Captured payloads are licensed market data; only a scrubbed, small, non-redistributable sample goes in git, and only if the vendor's terms allow it. If in doubt, keep it in `.fixtures/` and out of the repo. |

**Acceptance:** a 30-minute live stream with zero unhandled rejections and zero `SchemaError`, plus a
replay of the 24h capture through the CDM invariants with zero failures.

**Expect this to break things.** Budget for finding several wrong field shapes rather than none.

*Effort: an afternoon, whenever a key appears. Cost: $0 on Alpaca's Basic plan.*

---

## M2 — Make the README true

The provider table currently promises more than the code does.

| Gap | Resolution |
|---|---|
| ~~Tiingo is in the provider table with no adapter~~ | **Done.** bars_1d, replay-only, raw prices by default with an `adjusted` option |
| Databento is listed as a provider but is replay-only | Either implement the live DBN/TCP gateway with CRAM auth, or state replay-only in the table itself rather than in a linked doc |
| `depth_10` exists only as Databento replay | No live depth at all. Say so, or build it. |
| Polygon and Alpaca adapters are equity/ETF only | Options and futures throw `CoverageError`. Either extend one adapter or narrow the claim. |

The Databento live gateway is the largest single unknown in this milestone: its protocol is binary
DBN over raw TCP with a CRAM handshake that [docs/databento-live.md](databento-live.md) records as
not reconstructible from published docs. It needs a key and a packet capture before it needs code.

**Acceptance:** a test that asserts each adapter's `capabilities` and supported asset classes, and
fails if the README table and the code disagree. Make the docs a test.

**Done** — `packages/providers/test/readme-conformance.test.ts` parses the table out of the README
and checks every cell against the built adapters. It caught a real bug on its first run: the Polygon
adapter accepted a replay window and ignored it, so a historical request silently returned live data.
It now throws `CoverageError`.

*Effort: 2–4 weeks, dominated by the Databento decision.*

---

## M3 — Operational integrity

The things that surface after a week of uptime rather than in a test.

| Gap | Why it matters |
|---|---|
| **Sequence gaps are captured and ignored.** `seq` is on every Polygon and Databento message and nothing reads it. | A dropped packet is invisible. Emit a gap control message so the consumer can decide whether to trust the window. |
| **Backpressure is silent.** `AsyncQueue` drops the oldest past `highWaterMark` and only increments a counter nobody reads. | A slow consumer silently loses data. It needs a control message, not a field. |
| **Market-closed hours.** `staleAfterMs` marks a provider degraded when no message arrives, and no message arrives overnight or at the weekend. | The router will thrash between healthy providers every night. Needs a session calendar or a "no data expected" state. |
| **No logging interface.** The library is silent by design, with `onEvent` as the only hook. | Diagnosing a live incident means adding print statements to a dependency. |
| **`conduit doctor` cannot see a stream.** It probes REST only. | The failure mode most likely in production — a socket that connects, authenticates, and then goes quiet — is the one doctor cannot detect. |

**Acceptance:** a soak run across a real session boundary (close, overnight, open) with zero spurious
failovers, plus a gap-injection test that produces exactly one gap message.

*Effort: 2–3 weeks. The market-closed item is the one that will bite first.*

---

## M4 — Dogfood

The build roadmap's own go/no-go gate, unchanged, and already instrumented:
[docs/phase-5-dogfood.md](phase-5-dogfood.md).

Three metrics over four weeks of live use in one real consumer: escape hatches leaking into calling
code, failover events and whether any corrupted downstream state, and hours saved against hours
spent.

**Acceptance:** metric 1 trending toward its two-field baseline, zero downstream incidents, and
migration hours below the original integration's hours.

**Three of the four outcomes end with Conduit staying an internal package.** That is the expected
result, not the failure case, and reaching it still means v1 — just not a published one.

*Effort: 4 weeks of calendar, mostly waiting and watching.*

---

## M5 — Release engineering

**Only if M4 clears.** Skip entirely if Conduit stays internal; an internal package needs none of it.

| Task | Notes |
|---|---|
| Versioning | Every package is `0.0.0`. Add Changesets, adopt semver, generate a CHANGELOG. |
| Publish pipeline | npm publish from CI with provenance, on a tag |
| API reference | Typedoc from the existing TSDoc, which is already written for it |
| License decision | `core` + `providers` + `symbology` go MIT, or the repo stays all-rights-reserved. The repo is public and unlicensed today. |
| Install smoke test | `pnpm add @conduit/client @conduit/providers` on a clean machine, run the README quickstart verbatim |

**Acceptance:** the quickstart in the README works, copied and pasted, on a machine that has never
seen this repo.

*Effort: 1 week.*

---

## Sequencing

```
M1' ──► M2 ──► M3 ──► M4 ──► M5
 │              │      │       │
 │              │      │       └── skip if internal
 │              │      └───────── go/no-go
 │              └──────────────── does not need a key
 └── done from vendor SDK source; the key-gated residual is small and parallel
```

M1 is no longer a gate. Its key-gated residual runs in parallel with M2 and M3 whenever a key
appears, and neither of those needs one. The principle that made M1 first still holds though: read
the vendor's own code before writing another adapter, or you get four adapters wrong the same way.

## Known unknowns

Things that cannot be resolved from a desk, listed so they are not mistaken for oversights:

- Databento's live gateway handshake, and whether its live feed offers JSON at all
- Databento's rate limits
- Databento's raw symbol spelling for class shares
- Whether OpenFIGI's real answers match the resolver's expectations — the 200-symbol acceptance
  fixture is synthetic and tests resolution logic, not OpenFIGI's data
- What exchange redistribution licences cost, which is closed rather than answered
  ([licensing-probe.md](licensing-probe.md))
