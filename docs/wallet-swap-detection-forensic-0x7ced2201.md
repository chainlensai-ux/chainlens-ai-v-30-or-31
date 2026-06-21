# Forensic Audit — Swap Detection Collapse on `0x7ced220197449bd80b71a7ace9e89b1be1103014`

**Date:** 2026-06-21
**Scope:** `lib/server/walletSnapshot.ts` (read-only — no logic changed)
**Observed symptom:** 216 indexed events → 211 `unknown_direction` events → **0 swap candidates**
**Question:** Where, exactly, is valid swap evidence first discarded?

> **Environment caveat.** This report is a *code-level* forensic trace. No provider
> API keys are configured in the audit sandbox (`MORALIS_API_KEY`, `GOLDRUSH_KEY`,
> `ALCHEMY_*`, `ZERION_KEY` are all unset), so a live scan against this wallet could
> not be executed here. The three counts above are taken as given (they come from a
> real `walletSwapDetectionDebug` block) and the pipeline is traced deterministically
> against them. Real per-bucket integers and sample tx hashes for *this* wallet live in
> the diagnostic fields named in §7 — run the scan with `debug: true` to populate them.
> No transaction hashes are invented below.

---

## 1. Where each number is produced

| Number | Variable | Location |
|---|---|---|
| **216** indexed events | `totalEvidenceEvents = evidenceList.length` | `buildSwapDetection` `4442`; `evidenceList` built by `buildTxEvidenceFromEvents` `4315`, fed by `events` `9929`/`10348` |
| **211** unknown_direction | `directionCounts.unknown` | `4446`; surfaced as `unknownDirectionEvents` `4771` and reason bucket `unknown_direction` `4800` |
| **0** swap candidates | `swapCandidateEvents` | `4743` |

The remaining **216 − 211 = 5** events are the only wallet-side (`buy`/`sell`) legs.

---

## 2. Provider attribution — the 211 unknowns can *only* be GoldRush

The three activity providers attribute `direction` completely differently, and only
one of them can ever emit an `unknown`-direction **evidence** event:

| Provider | Direction rule | Keeps `unknown`? |
|---|---|---|
| **Moralis** `normalizeMoralisTransfers` | `to===wallet?buy:from===wallet?sell:unknown` `3051` | **No** — `if (direction==='unknown'){ skippedNotWalletSide++; continue }` `3052` (dropped) |
| **Alchemy** `fetchAlchemyPnlEvents` | direction assigned **by query**: `fromAddress` batch → `sell`, `toAddress` batch → `buy` `2948-2949` | **No** — every row is wallet-side by construction |
| **GoldRush** `fetchGoldrushPnlEvents` | `to===wallet?buy:from===wallet?sell:unknown` `2860` (transfers[]) and `2886` (decoded log_events) | **Yes** — final `.filter` keys only on `contract.startsWith('0x') && amount>0` `2893`, **not** on direction |

**Conclusion:** a population of 211 retained `unknown`-direction events is a *signature*
of the GoldRush `transactions_v3?with-logs=true` path. Moralis would have dropped them at
normalization; Alchemy cannot produce them. This wallet's evidence is GoldRush-sourced
(base eager/deferred fetch at `9615`, result consumed at `9822`/`9939`).

---

## 3. Why 211 of 216 legs are `unknown`

GoldRush `transactions_v3` returns up to 50 transactions (`items.slice(0,50)` `2823`),
and for **each** transaction emits up to 12 transfer legs
(`transfers.slice(0,12)` `2851`, or `log_events.slice(0,12)` `2869`). Those legs include
**every ERC20 movement inside the transaction**, not just the wallet's own legs:
router→pool, pool→router, pool→pool, fee transfers, hops through intermediate tokens, etc.

For each leg the direction is decided by the **literal Transfer `from`/`to`** vs. the
scanned wallet (`2860`/`2886`). Any leg whose `from` and `to` are both non-wallet
addresses (the overwhelming majority in routed/aggregated swaps) becomes `unknown` and is
**retained** as context. Hence 211 internal/third-party legs vs. only 5 boundary legs
where the wallet is the direct counterparty.

This is the **first transformation that strips swap-relevant structure**: the moment a
multi-hop swap is flattened into individual Transfer legs and each leg is judged in
isolation against the wallet address, the "swap" as a unit is gone — only 1–2 boundary
legs per swap survive as wallet-side, and the quote leg may not survive at all (§5).

---

## 4. Pipeline trace (normalization → FIFO inputs)

```
GoldRush transactions_v3 (with-logs)        fetchGoldrushPnlEvents  2712
  └─ per tx: up to 12 Transfer legs          2851 / 2869
  └─ direction = to/from === wallet          2860 / 2886         ← unknowns KEPT  2893
        │  216 legs total, 211 unknown, 5 wallet-side
        ▼
event dedup + merge (GR∪Alchemy)            9930-9943
        ▼
buildTxEvidenceFromEvents                    4288
  └─ leg dedup (txHash:contract:from:to:amt) 4305-4312
  └─ evidenceList carries e.direction as-is  4331            ← 216 = totalEvents 4341
        ▼
buildSwapDetection                           4393
  ├─ directionCounts.unknown = 211           4446
  ├─ usableEvents = direction!=='unknown'    4465-4469       ← 211 EXCLUDED from FIFO/pricing
  ├─ byTx / txCtxMap (router, hasBuy/hasSell)4519-4537
  ├─ Direction Reconstruction V2 (unknowns)  4591-4665       ← recovers 0 here (§5)
  └─ wallet-side classification (the 5)      4683-4737       ← promotes 0 here (§5)
        ▼
swapCandidateEvents = 0                       4743
        ▼
readyForPriceAtTime = false                   4754   → price-at-time, FIFO get no swap inputs
```

---

## 5. The decisive discard — two structural gates, neither cleared

The 5 wallet-side legs and the 211 unknown legs each have a promotion path. **Both close.**

### 5a. The 211 unknowns — Direction Reconstruction V2 (`4591-4665`)
An `unknown` leg can be promoted *only* if its **own** `fromAddress`/`toAddress` equals the
wallet — `inferWalletSideDirection` `4573-4579`. For genuine pool↔pool / third-party legs
that is `null`, so every one routes to:

```
unknownDirectionRejectedNoWalletSideCount++        4615
unknownDirectionUsedAsContextOnlyCount++           4616   → context-only, never a candidate  4617-4619
```

This is **correct** behaviour (those legs really aren't the wallet's), but it means
reconstruction recovers nothing for this wallet: `unknownDirectionPromotedToSwapCandidate = 0`.

### 5b. The 5 wallet-side legs — classification (`4683-4737`)
A wallet-side `buy`/`sell` becomes a swap candidate only if one of these holds:

| Path | Condition | Gate |
|---|---|---|
| Router (high) | `txToKnownRouter && walletIsInitiator` | `4683` |
| Router (med) | `txToKnownRouter && !walletIsInitiator` | `4694` |
| Pairing (med) | `hasInboundOutbound && txHasStableOrWeth` | `4705` |
| Pairing (med) | `hasInboundOutbound && hasMultipleDistinctTokens` | `4708` |
| Aggregator (med) | `walletIsInitiator && hasMultipleDistinctTokens && (hasBuy\|\|hasSell) && txHasStableOrWeth` | `4714` |

where `hasInboundOutbound = hasBuy && hasSell` **within the same tx** (`4533`) and
`txToKnownRouter` requires `tx.to_address ∈ KNOWN_DEX_ROUTERS ∪ EXTENDED_DEX_ROUTERS`
(`4526-4529`).

With 0 candidates, **none** of those held for any of the 5 legs. The two dominant
root causes (mutually compatible):

1. **No wallet-side quote leg ⇒ `hasInboundOutbound` is false.** The quote side of the
   swap is the WETH/USDC/ETH the wallet paid or received. If a swap is paid in **native
   ETH**, there is *no ERC20 Transfer* for it — native value transfer is invisible to both
   `transfers[]` and decoded ERC20 `Transfer` log_events. So the only wallet-side leg is the
   token *receipt* (`buy`), `hasSell` stays false, `hasInboundOutbound` is false, and the leg
   falls to `4731`: **`airdrop_candidate` — "Inbound-only transfer — no matching wallet-side
   outbound in tx."** A token *sale* into ETH symmetrically falls to `4733` (`transfer` —
   "Outbound-only").
2. **Unrecognised router ⇒ `txToKnownRouter` is false.** If the wallet swapped through a
   router/aggregator whose address is not in `KNOWN_DEX_ROUTERS`/`EXTENDED_DEX_ROUTERS`, the
   router promotion paths (`4683`/`4694`) cannot fire even when `tx.to_address` was captured
   (it is, from `t.to_address` `2846`). Inspect `topUnknownTxToAddresses` `4844` to see the
   exact unrecognised routers this wallet used.

### 5c. The receipt-level second chance also yields nothing
`buildSwapDetection` is not the last word — when `swapCandidateEvents === 0` **and**
unknown-direction events exist **and** a Base RPC URL is available, a **Base Unknown-Direction
Swap Reconstruction Pass** fetches raw receipts to recover hidden quote legs (gated at
`10497-10503`). For 0 candidates to survive, this pass either (a) did not run —
`reason: 'no_rpc_available'` `10502` (likely when `ALCHEMY_BASE_KEY` is unset) or
`'no_unknown_direction_events'` `10500` — or (b) ran and still found no wallet-side quote
leg (consistent with native-ETH swaps in cause #1). Read `_baseUnknownSwapReconDebug.reason`
to distinguish.

---

## 6. First stage where valid swap evidence is discarded

> **`fetchGoldrushPnlEvents`, direction attribution at `walletSnapshot.ts:2860` / `:2886`.**

This is the earliest point where swap semantics are lost: a routed swap is flattened into
isolated Transfer legs and each leg's direction is decided purely by whether the **literal
ERC20 `from`/`to` equals the wallet**. Every non-boundary leg collapses to `unknown` (→ the
211), and any quote leg paid/received as **native ETH** produces no leg at all. By the time
`buildSwapDetection` runs, the structural prerequisites it tests for (`hasInboundOutbound`,
`txToKnownRouter`) are already unsatisfiable for these 5 legs — the evidence was thinned
upstream, then formally rejected at the classification gates in §5b.

Note this is a *fidelity* limitation of the flatten-and-attribute approach, **not** a bug in
`buildSwapDetection`: the classifier is correctly refusing to invent a swap from a single
inbound leg with no provable counter-leg. The fix space is upstream/parallel (receipt-level
quote-leg recovery, native-ETH leg synthesis, router allow-list coverage), not in the
classifier's thresholds.

---

## 7. Counts per rejection bucket

Counts that are **fully determined** by the three reported numbers:

| Bucket | Count | Source field |
|---|---:|---|
| `unknown_direction` (not wallet-side) | **211** | `directionCounts.unknown` `4446`; `unknownReasonBucketCounts.unknown_direction` `4800` |
| wallet-side legs (`buy`+`sell`) | **5** | `directionCounts.inbound + .outbound` `4444-4445` |
| `unknownDirectionPromotedToSwapCandidate` | **0** | `4631` (none cleared §5a) |
| `unknownDirectionRejectedNoWalletSide` | **≈211** | `4615` (all pool/third-party legs) |
| `swapCandidateEvents` | **0** | `4743` |
| `routerSwapCandidateEvents` | **0** | `4744` |
| `sameTxInboundOutboundCandidates` | **0** | `4746` |

Counts that are **data-dependent** (the split of the 5 wallet-side legs, and the
sub-bucketing of the 211) — read these directly from `walletSwapDetectionDebug`:

| What to read | Field | Location |
|---|---|---|
| How the 5 wallet-side legs ended up | `airdropCandidateEvents` / `transferEvents` / `unknownEvents` | `4751`/`4750`/`4753` |
| Per-bucket breakdown of all unknown-kind events | `unknownReasonBucketBreakdown[]` (`count`, `distinctTxCount`, `distinctTokenCount`) | `4833-4838` |
| Dominant cause | `topUnknownReasonByCount` / `…ByTxCount` / `…ByTokenCount` | `4839-4841` |
| Whether pairing or router was the miss for wallet-side legs | `unknownPairingEvents` / `unknownRouterEvents` | `4778`/`4774` |
| Unrecognised routers this wallet used | `topUnknownTxToAddresses` / `…WithSwapLikeContext` | `4844-4851` |
| Reconstruction outcomes | `reconstructedUnknownDirectionEvents`, `unknownDirectionRejectedLowConfidence` | `4892`/`4897` |
| **Sample tx hashes (real)** | `sampleGroupedTxs`, `sampleUnknowns`, `sampleContextOnlyUnknownDirectionEvents`, `sampleSwapCandidates` | `4854`/`4884`/`4899`/`4883` |
| Base receipt second-chance outcome | `_baseUnknownSwapReconDebug.reason` | `10493-10503` |

**To populate the real integers and hashes for `0x7ced…3014`:** run the scanner with
`debug: true` (e.g. `?debug=1` on `/api/wallet` or `fetchWalletSnapshot(addr,{deepActivity:true,
debug:true})`) and read `snapshot._diagnostics.walletSwapDetectionDebug` plus
`walletGoldrushHistoryDiag` (confirms GoldRush as source) and `_baseUnknownSwapReconDebug`.

---

## 8. Summary

1. Evidence is **GoldRush-sourced** — only GoldRush retains `unknown`-direction legs (§2).
2. **216** = GoldRush transfer legs across ≤50 txs; **211** are internal/third-party legs that
   are correctly `unknown` because the wallet is neither the literal `from` nor `to` (§3).
3. The **5** wallet-side legs produce **0** swap candidates because, per leg, there is no
   provable same-tx wallet-side counter-leg (`hasInboundOutbound=false`, typically because the
   quote side was **native ETH** and therefore invisible) **and** the tx `to` address is not a
   recognised router (`txToKnownRouter=false`) (§5b).
4. Neither rescue path fires: Direction Reconstruction V2 needs a wallet-side own-leg the 211
   don't have (§5a); the Base receipt second-chance was either ungated-out or found no hidden
   wallet-side quote leg (§5c).
5. **First discard point:** GoldRush per-leg direction attribution at `2860`/`2886` (§6) —
   a fidelity limit of flatten-then-attribute, not a classifier threshold bug.

No logic was modified in this audit.
