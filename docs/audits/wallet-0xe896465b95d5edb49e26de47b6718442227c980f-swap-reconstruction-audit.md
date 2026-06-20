# Wallet swap reconstruction audit

Wallet: `0xe896465b95d5edb49e26de47b6718442227c980f`

This audit intentionally does not modify scoring or wallet-profile logic. It traces the existing reconstruction pipeline from normalized transfer evidence through swap detection, pricing, and FIFO lot matching.

## Observed scan counters

| Stage | Count / status | Notes |
| --- | ---: | --- |
| Raw events | Not emitted by the current public summary | The provider diagnostic exposes raw provider counts separately from normalized evidence when debug data is available. |
| Normalized events / total evidence events | 138 | Inferred from `swapCandidateEvents = 4` plus `unknownEvents = 134` in the observed scan. |
| Wallet-side usable events | 4 | The swap detector excludes `direction = unknown`, missing contracts, and zero amounts before tx grouping. |
| Swap candidates | 4 | Only four events survived as swap candidates. |
| Router swaps | 0 | No candidate was produced by the primary `KNOWN_DEX_ROUTERS` tx-to-router path. |
| Inbound swaps | 0 | No same-transaction wallet-side inbound/outbound candidate was detected. |
| Outbound swaps | 0 | No same-transaction wallet-side inbound/outbound candidate was detected. |
| Priced swaps | 0 | Pricing did not produce priced, eligible swap events before the attempt budget was exhausted. |
| Lots opened | 0 | FIFO opens lots only from priced non-quote buy swap events. |
| Lots closed | 0 | FIFO closes lots only when a priced sell can consume a prior priced buy lot with the same normalized chain/token key. |

## Event-classification trace

1. `buildSwapDetection()` starts with all normalized evidence events and counts wallet directions (`buy`, `sell`, `unknown`).
2. It builds `usableEvents` by keeping only events whose direction is not `unknown`, whose token contract is present, and whose amount is positive.
3. It groups only those usable wallet-side events by transaction hash.
4. Every `direction = unknown` event is immediately classified as `eventKind = unknown` with the reason `Transfer does not involve scanned wallet directly (pool-to-pool or third-party)`.
5. Router classification in this stage uses `KNOWN_DEX_ROUTERS` only, not the broader `EXTENDED_DEX_ROUTERS` set.
6. Same-transaction swap classification requires wallet-side inbound and outbound events in the grouped usable events.
7. Pricing then considers only `swapDetection.isSwapCandidate = true` events.
8. FIFO lot matching then considers only priced swap candidates with a known buy/sell direction, valid tx hash/timestamp/contract/amount, and a non-quote token contract.

## First 20 UNKNOWN events

The current persisted summary does not retain the first 20 full unknown event rows; it only reports aggregate unknown counts and limited debug samples. For the observed scan, the classification reason for the dominant unknown class is:

`Transfer does not involve scanned wallet directly (pool-to-pool or third-party)`

Required fields for each full row (`tx hash`, `token`, `amount`, `counterparty`, `classification reason`) require running the same scan with full diagnostics enabled at the provider-event level. The collapse is still identifiable from the aggregate counters because `unknownEvents = 134` and `sameTxInboundOutboundCandidates = 0` mean the visible quote/pool legs were not wallet-side legs available to the primary classifier.

## Base router detection audit

| Protocol | Existing detection status | Why it did not produce router swaps in this scan |
| --- | --- | --- |
| Aerodrome | Partially covered | Aerodrome router `0xcf77...4e43` is in both router sets; Aerodrome/Sugar/router `0x6cb4...42d5` is only in the extended receipt-reconstruction set, not the primary `KNOWN_DEX_ROUTERS` map used by `buildSwapDetection()`. Observed `routerSwapCandidateEvents = 0` means no usable wallet-side event group had `tx.to` matching the primary map. |
| Slipstream | Not explicitly named in primary router map | Slipstream-style Base routes can be missed by the primary stage unless their router address is also in `KNOWN_DEX_ROUTERS`; receipt reconstruction may still inspect some extended-router txs, but the observed `historicalSwapCandidates = 0` and zero router candidates show no successful promotion. |
| Uniswap V3 | ETH V3 router covered; Base Universal Router mismatch | `KNOWN_DEX_ROUTERS` includes `UniswapV3Router` and a Base Universal Router entry, but the extended router set used by receipt reconstruction does not include the Base Universal Router address listed in the known map. A Base Universal Router tx can therefore fail the extended-router receipt path. |
| Virtuals | Not covered | No Virtuals router/factory/router-like address is present in the router lists used by primary swap detection. |
| Alienbase | Not covered | No Alienbase router address is present in the router lists used by primary swap detection. |
| Baseswap | Partially covered | BaseSwap router `0x327d...5d86` is in `EXTENDED_DEX_ROUTERS`, but not in the primary `KNOWN_DEX_ROUTERS` map, so it cannot increment `routerSwapCandidateEvents` during `buildSwapDetection()`. |

## Audit of the three unmatched sells

The observed three unmatched sells fail at FIFO matching, not at wallet scoring.

| Item | Finding |
| --- | --- |
| Token | The current aggregate/debug output does not retain all three full token rows unless full diagnostics are enabled. |
| Sell timestamp | Not available in the provided aggregate snapshot. |
| Possible matching buy | Recent visible buys are present in raw/provider activity, but they were not promoted into priced non-quote buy swap events in the FIFO input. |
| Why matching failed | FIFO can only match a sell against an earlier buy in `openLotsMap` with the same `normalizeChain(chain):contract` key. Because buy-side events were mostly classified as `unknown`/non-wallet-side or remained unpriced, no prior priced buy lot existed for the three sells; the engine records `no_prior_buy:<token>` / `unmatched_sells`. |

## Exact failure point

Swap reconstruction collapses between normalized event evidence and the primary swap detector's wallet-side grouping:

- 134 normalized events are classified as `unknown`, primarily because their transfer legs do not directly involve the scanned wallet.
- Those unknown events are excluded from `usableEvents`, so they cannot create same-transaction inbound/outbound groups.
- The remaining four candidates are not router candidates (`routerSwapCandidateEvents = 0`) and are not same-tx inbound/outbound candidates (`sameTxInboundOutboundCandidates = 0`).
- Pricing then exhausts its attempt budget (`priceAttemptLimitReached = true`) without producing priced eligible swap events.
- FIFO receives no priced non-quote buy lots to open and no matching prior buys for sells, so `closedLots = 0`.

In short: **the collapse is caused by provider-normalized Base activity presenting most swap legs as non-wallet-side / unknown-direction transfers, combined with incomplete primary Base router coverage and a pricing budget stop before any eligible buy/sell lot pair is priced.**
