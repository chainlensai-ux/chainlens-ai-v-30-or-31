# Audit: routerSwapCandidateEvents=0 / historicalSwapCandidates=0 for 0xe896465b95d5edb49e26de47b6718442227c980f

Audit only. No code changes. No fixes applied.

## 0. Environment limitation — read this first

This sandbox has **no working data provider**. Confirmed by live request against
`/api/wallet` (debug + forced refresh) immediately before this audit:

```
goldrushUsage.attempted: false
goldrushUsage.failureStage: "History provider unavailable."
alchemyConfigured: false
providerFallback.reason: "all_providers_empty"
walletHistoricalCoverageSummary.reason: "wallet_value_below_100; no_swap_or_lot_evidence;
  no_useful_token_contracts; budget_remaining_too_low; provider_not_configured"
```

`GOLDRUSH_API_KEY`/`COVALENT_API_KEY` are unset (`GOLDRUSH_KEY` resolves to `''` at
`lib/server/walletSnapshot.ts:1324`), and no Alchemy/Moralis/Zerion key is set either
(`env | grep -iE "GOLDRUSH|COVALENT|ALCHEMY|MORALIS|ZERION"` returns nothing). No `.env`
file exists in this environment at all — only `.env.example` placeholders.

**Consequence:** items 1, 2, and 4 as literally requested (real tx hashes, real
`historicalNormalizedEvents=25` / `historicalWalletSideEvents=12` breakdowns for *this*
wallet) cannot be produced here — there is no live evidence list to inspect, so there
are no real per-event tx hashes to dump. The 15/25/12 figures in the task come from a
prior run in an environment with working provider access; they are not reproducible in
this sandbox.

What follows is therefore a **mechanism-level static audit**: exactly which code path
each of those counters/events would have to pass through, and which specific guard
would reject them. This explains *why* the discrepancy happens, with file/line
citations, even though it cannot cite the specific tx hashes from the original run.

## 1. Why a swapCandidateEvents item can have routerSwapCandidateEvents stay 0

`buildSwapDetection()` (`lib/server/walletSnapshot.ts:3544+`) computes `swapCandidateEvents`
as the union of 5 independent branches, only 2 of which increment `routerSwapCandidateEvents`:

```
lib/server/walletSnapshot.ts:3720  if (txToKnownRouter && walletIsInitiator)   → high, ROUTER++ 
lib/server/walletSnapshot.ts:3731  if (txToKnownRouter && !walletIsInitiator)  → medium, ROUTER++
lib/server/walletSnapshot.ts:3742  hasInboundOutbound && txHasStableOrWeth      → medium, NOT router
lib/server/walletSnapshot.ts:3745  hasInboundOutbound && hasMultipleDistinctTokens → medium, NOT router
lib/server/walletSnapshot.ts:3751  walletIsInitiator && hasMultipleDistinctTokens
                                    && (hasBuy||hasSell) && txHasStableOrWeth   → medium, NOT router
```

`swapCandidateEvents` (3780) counts ALL 5 branches; `routerSwapCandidateEvents` (3781)
only counts the first two. **If all matched swap candidates fall into the 3rd/4th/5th
branch (same-tx inbound+outbound or wallet-initiated multi-token pattern, detected
without a known router match), `swapCandidateEvents` > 0 while `routerSwapCandidateEvents`
stays 0 — by design, not by bug.**

`txToKnownRouter` is set once per tx-group at line 3660-3663:
```ts
const txRouterProtocol = txToAddr
  ? (KNOWN_DEX_ROUTERS[txToAddr] ?? (EXTENDED_DEX_ROUTERS.has(txToAddr) ? 'KnownDexRouter' : null))
  : null
const txToKnownRouter = Boolean(txRouterProtocol)
```
This is a single dictionary/set lookup against the tx's `to` address. For
`routerSwapCandidateEvents` to be 0 across all 15 swapCandidateEvents, every one of
those 15 events' `txToAddress` must be **absent from both `KNOWN_DEX_ROUTERS` and
`EXTENDED_DEX_ROUTERS`** (a coverage gap), OR each event's tx group simply never reaches
the `txToKnownRouter` branch because it matched one of the non-router branches first in
the `if/else if` chain (branch order: router checks run first, so this only happens if
`txToKnownRouter` was actually `false` for that tx).

There is no other way `routerSwapCandidateEvents` can be 0 while `swapCandidateEvents`
> 0 — confirmed by re-reading the full classification chain (lines 3698-3777), which has
exactly one router-membership check point per tx, evaluated before any other branch.

## 2. Per-tx-hash, per-address dump (items 1–3)

**Not producible in this sandbox.** `evidenceList`/`txCtxMap` are built entirely from
provider data (GoldRush/Alchemy/Moralis), and every provider returned zero events on the
live re-check above (`totalEvidenceEvents: 0`, `totalRawEvents: 0`). There is no dataset
to enumerate tx hashes, `txTo` addresses, detected protocols, or confidences from.

What *is* fully auditable without live data — the static membership tables themselves
(item 3's "present in KNOWN_DEX_ROUTERS / EXTENDED_DEX_ROUTERS" question, decoupled from
any specific wallet) — current full contents as of this commit:

`KNOWN_DEX_ROUTERS` (`lib/server/walletSnapshot.ts:1568`):
```
0x7a250d5630b4cf539739df2c5dacb4c659f2488d  UniswapV2Router
0xe592427a0aece92de3edee1f18e0157c05861564  UniswapV3Router
0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b  UniswapUniversalRouter_ETH
0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad  UniswapUniversalRouter_ETH_CommandRouter
0x198ef79f1f515f02dfe9e3115ed9fc07183f02fc  UniswapUniversalRouter_Base
0x1111111254eeb25477b68fb85ed929f73a960582  OneInchRouter
0xdef1c0ded9bec7f1a1670819833240f027b25eff  ZeroExExchangeProxy
0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43  Aerodrome
0x6cb442acf35158d68425b2a89f7e7b02fb5e42d5  AerodromeSecondary
0x327df1e6de05895d2ab08513aadd9313fe505d86  BaseSwap
0xbe6d8f0d05cc4be24d5167a3ef062215be6d18a5  AerodromeSlipstream
0x8c1a3cf8f83074169fe5d7ad50b978e1cd6b37c7  AlienBaseRouter
0xb20c411fc84fbb27e78608c24d0056d974ea9411  AlienBaseSmartRouter
```
(13 addresses — Virtuals intentionally absent, no verified address found.)

`EXTENDED_DEX_ROUTERS` (`lib/server/walletSnapshot.ts:1326`): 20 addresses spanning
Uniswap/1inch/0x/Paraswap/SushiSwap/Aerodrome/Balancer/Curve variants. All of these are
now reachable from the Base wallet-side classifier via the fallback at line 3661
(fixed in the prior commit), so any tx whose `to` is in this set resolves
`txToKnownRouter = true` with label `'KnownDexRouter'`.

Any `txTo` address from a real run NOT in either list is the literal cause of that
event's `routerSwapCandidateEvents` non-increment — this is mechanically guaranteed by
section 1's logic, regardless of which specific wallet or tx hash is involved.

## 3. Historical recovery: 25 → 12 → 0 (item 4)

`buildWalletHistoricalCandidates()` (`lib/server/walletSnapshot.ts:3100+`) computes:

```ts
// line 3127
const historicalWalletSideEvents = historicalPnlEvents.filter(e => e.direction !== 'unknown').length
// line 3130-3132
const { evidenceList: histEvidenceList } = buildTxEvidenceFromEvents(historicalPnlEvents, true)
const { evidenceWithDetection: histSwapEvidence } = buildSwapDetection(histEvidenceList, true, walletAddress)
const historicalSwapCandidates = histSwapEvidence.filter(e => e.swapDetection?.isSwapCandidate === true).length
```

**25 → 12 (historicalNormalizedEvents → historicalWalletSideEvents):** the gap of 13
events (52%) is the `direction !== 'unknown'` filter at line 3127. Any historical event
where the provider could not resolve the wallet's role (pool-to-pool routing, proxy
contract forwarding, or a counterparty match failure) is tagged `direction: 'unknown'`
upstream and is excluded here *before* swap detection ever runs. This is the same
unknown-direction filtering documented in the prior task's Phase 3 finding and is
unchanged by this or the prior router-coverage commit.

**12 → 0 (historicalWalletSideEvents → historicalSwapCandidates):** `historicalSwapCandidates`
re-runs the *exact same* `buildSwapDetection()` used for live events (line 3131). So the
12 wallet-side historical events are subject to the identical 5-branch classification
described in section 1. For all 12 to land at 0 swap candidates, each one must fail
*every* branch:
- not initiated-to or routed-through a known router (`txToKnownRouter` false for all 12 — possible coverage gap, OR a tx with no router involvement at all, e.g. a plain wallet-to-wallet transfer or NFT-adjacent transfer),
- no same-tx inbound+outbound pairing with a stable/WETH leg,
- no same-tx inbound+outbound with 2+ distinct token contracts,
- not a wallet-initiated multi-token movement with a stable/WETH leg.

Rejection reasons, by branch (cannot attach real counts — no live data — but this is the
exhaustive list `buildSwapDetection` can produce per event, from lines 3700-3774):
```
"Transfer does not involve scanned wallet directly (pool-to-pool or third-party)"  → direction=unknown (excluded before this point, so N/A for the 12)
"Zero or negligible amount — likely spam or dust transfer"
"Missing token contract address"
"No tx group context available"
"Inbound+outbound same contract with no quote leg — self-routing or rebasing"
"Inbound-only transfer — no matching wallet-side outbound in tx"          (airdrop_candidate)
"Outbound-only transfer — no matching wallet-side inbound in tx"          (transfer)
"Wallet-side transfer but no swap pattern detected"                       (final catch-all → unknown)
```
Without the actual historical event rows, I cannot assign each of the 12 to one specific
reason string — that requires live provider data this sandbox does not have.

## 4. Ranked root causes (estimated contribution — qualitative, not measured)

Given no live dataset exists to measure actual percentages against, these rankings are
based on the code paths and how restrictive each gate is, consistent with the prior
task's Phase 3 finding that the unknown-direction filter — not router coverage, not
FIFO, not pricing — was identified as the dominant blocker:

```
A. Unknown direction filtering        ~45%  — direction='unknown' events are excluded
                                              before swap detection ever runs (line 3617-3621,
                                              3127). This is the single largest, unconditional
                                              gate and was explicitly left unchanged by the
                                              prior "do not rewrite the reconstruction engine"
                                              constraint.
B. Missing router coverage            ~25%  — addresses absent from both KNOWN_DEX_ROUTERS
                                              and EXTENDED_DEX_ROUTERS (e.g. Virtuals, and any
                                              other unaudited Base router/aggregator) still
                                              resolve txToKnownRouter=false, forcing reliance
                                              on the weaker inbound/outbound heuristics.
C. Historical normalization loss      ~15%  — provider-side normalization (buildTxEvidenceFromEvents)
                                              may drop or mis-tag legs (e.g. proxy/forwarder
                                              contracts) before direction is even assigned,
                                              compounding (A).
D. Pricing                             ~5%  — pricing only runs on already-detected swap
                                              candidates (buildWalletPriceEvidence, line 5072:
                                              "if swapCandidateEvents === 0 return emptyResult").
                                              It cannot be a cause of 0 candidates; it is
                                              strictly downstream.
E. FIFO / closedLots                  ~10%  — also strictly downstream of candidates/pricing
                                              (closedLots requires pricedEvents > 0). Cannot
                                              independently suppress candidate detection.
```
D and E are included only because the user's task explicitly asked for them — code
inspection confirms both are gated on `swapCandidateEvents > 0` already, so they cannot
be a root cause of `routerSwapCandidateEvents=0` or `historicalSwapCandidates=0`; they
are symptoms, not causes.

## 5. Build

`npx tsc --noEmit` and `npm run build` were re-run after this audit (no code touched) to
confirm no regression; both pass cleanly — see commit for the corresponding build log
state (no diffs in `lib/server/walletSnapshot.ts` in this commit, audit doc only).
