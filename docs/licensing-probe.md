# Phase 0 gate 1 — licensing probe

Status: **drafted, not sent.** Send both, record replies inline under each, then update
[Resolution](#resolution).

## Why this gate exists

The BYO-key architecture has zero redistribution exposure because market data never transits
Conduit-operated infrastructure. That claim needs confirmation from the two vendors with the
strictest terms before any adapter code is worth writing. The second question is the more
important one: if a redistribution agreement is cheap, the hosted design with cost routing beats
this one outright and the roadmap should be reconsidered rather than continued.

## Email 1 — Polygon.io business development

> **To:** bd@polygon.io
> **Subject:** Terms question: client library where each user supplies their own API key
>
> Hi,
>
> I'm building an open-source TypeScript client library for market data. The architecture is
> bring-your-own-key: each user configures their own Polygon API key, the library runs inside
> their own process, and data flows directly from your API to their machine. No component I
> operate ever receives, stores, caches, or forwards quotes, trades, or bars — or anything
> derived from them. The only thing any hosted piece would ever see is metadata: which providers
> a user configured, health signals, request counts, and symbol identifiers.
>
> Two questions:
>
> 1. Is that arrangement within the Market Data Terms of Service as written, given that no
>    redistribution, dissemination, sublicensing, or transmission to a third party occurs?
> 2. Separately, what would a redistribution or Edge User agreement cost? I want to understand
>    the option even though the current design doesn't require one.
>
> Happy to send the architecture diagram if that's useful.
>
> Thanks,
> Will Foti

**Reply:** _(paste here)_

## Email 2 — Databento business development

> **To:** sales@databento.com
> **Subject:** Terms question: BYO-key client library, no data through our infrastructure
>
> Hi,
>
> I'm building an open-source TypeScript client library that normalizes several market data
> vendors behind one interface. Each user supplies their own Databento API key and the library
> runs in their own process — data goes from your API straight to their machine. Nothing I
> operate touches raw or derived market data; any hosted component sees only configuration,
> health signals, and usage counters.
>
> 1. Does that fall within your standard license as a licensed-user tool rather than
>    redistribution?
> 2. What would a redistribution license cost if I later wanted to serve data from my own
>    infrastructure?
>
> Thanks,
> Will Foti

**Reply:** _(paste here)_

## Resolution

| Question | Polygon | Databento |
|---|---|---|
| BYO-key within terms? | pending | pending |
| Redistribution cost | pending | pending |

**Decision rule:** if redistribution comes back affordable from both, stop and reconsider the
hosted design with cost routing before continuing to Phase 1. If either says BYO-key is out of
terms, that provider's adapter is removed rather than shipped.
