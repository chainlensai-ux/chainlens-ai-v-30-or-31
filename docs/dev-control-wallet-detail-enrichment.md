# Dev Control selected-wallet enrichment

Base: ff2069cb141b18fe71ae0fadf629083c3301e0e1 (main; fast-forwarded from the initial ca7fbb15 task base). Scope: EVM Token Scanner Dev Control selected-wallet panel; no graph redesign, new providers, or scan-time wallet fanout.

## Evidence-path audit

1. Token Scanner collects a bounded holder page and normalizes rank, amount and supply percentage.
2. Dev Control keeps deployer/linked-wallet evidence separately from holder membership. Cluster nodes retain rank/percentage only for matched indexed positions.
3. The old selected panel consulted indexed position for supply/rank and ran the cheap balance endpoint only for deployers on ETH/Base. It discarded the endpoint's native balance. Linked/cluster nodes never received that balance check.
4. The old deployer resolver incorrectly inferred launch receipt from present holdings or transfers to *other* linked wallets. Shared copy then substituted holder-index absence for unrelated history/current-balance fields.

## Changes

- Every explicitly selected EVM wallet gets the existing balance endpoint: balanceOf + native balance only.
- The existing panel renders immediately. The async result is tied to chain/token/wallet; cancelled replies cannot update another selection.
- Browser and server requests use singleflight and a 60-second bounded cache. Server native balance keys are chain ID + wallet, independent of token. No scan-time calls and no per-node GoldRush/Moralis calls.
- Raw token integers are retained and scaled with separately recorded provider-verified decimals. The legacy scanner's assumed 18-decimal fallback is **not** accepted as verified. Unknown decimals show base units.
- Percent uses existing on-chain or provider total supply, never a sum of indexed balances.
- Successful positive balance means Yes; successful zero means No; absent/failed direct evidence stays Unknown even if an indexed snapshot shows holdings. Existing indexed supply and rank remain explicitly labeled as an indexed snapshot.
- Indexed rank/percentage remain intact beside current direct evidence; balanceOf cannot manufacture rank.
- Native failures resolve to Unavailable rather than perpetual Not checked.
- Additive per-field provenance distinguishes current RPC evidence, indexed position, missing rank and unestablished launch receipt.
- Old cached scan payloads remain compatible: missing verified metadata never defaults to guessed decimals/supply. Existing cache/schema and scan budgets are unchanged.

## Launch window

A confirmed deployment transaction is the anchor, not pool creation or current holdings. A positive token transfer in that transaction proves receipt. If an observed token transfer in the deployment transaction also provides its timestamp, positive token transfers from that timestamp through +24 hours (inclusive) prove receipt in the launch window. External/native funding is excluded.

The server reuses already collected token transfers and same-chain cached launch proofs. No history calls are added. Undated non-deployment edges, inferred origin transactions, missing transfers and current holder positions do not establish launch allocation. Existing bounded history does not prove completeness, so missing proof is **Not established**, never No.

## Real before/after replay

Captured 2026-10-03. These are real provider observations replayed through the baseline and new resolvers, not a claim that the new code is already deployed.

Token: DEGEN / Base, 0x4ed4e862860bed51a9570b96d89af5e1b0efefed.
Creator: 0x3c12b77ae8b7dd1feb63d1d6a2a819acda0a41d2.
Creator identity: existing Blockscout address endpoint. The wallet is absent from all 50 addresses in the returned holder page. Base's existing RPC proves token balance zero and native balance 0.000108924211354521 ETH.

| Field | Baseline panel | Updated panel |
| --- | --- | --- |
| Supply | Not in indexed holder rows | 0 DEGEN · 0.00% — Direct on-chain balance |
| Rank | Not in indexed holder rows | Outside indexed holder set |
| Current holder | No (existing successful zero check) | No — Direct balance check |
| Native balance | Not checked (response discarded) | 0.000108924 ETH |
| Launch receipt | Not in indexed holder rows | Not established — No verified launch-window transfer evidence |

Exact addresses, observation times, balance result and public source URLs are retained in tests/fixtures/wallet-detail-degen-live.json. Holder and RPC reads are independent latest observations, not an atomic block snapshot.

Second real fixture: ASTEROID / Ethereum origin wallet 0xe843439d8c0917961aa7076e2f8b25c6d1b92778, absent from the returned 50 holders. The deployed balance endpoint returned failed token/native checks. The new resolver correctly displays Unknown current holder and Unavailable balances, with Not established launch receipt. The failure payload is retained in tests/fixtures/wallet-detail-asteroid-live.json; no balance was fabricated to make the fixture look complete.

## Final validation comparison

Baseline: untouched main `ff2069cb141b18fe71ae0fadf629083c3301e0e1`. An archive of that exact revision was verified against all 1,659 tracked Git blobs: zero mismatches. Both trees use the same Node/dependencies/environment and commands. No unrelated source changes or test exclusions were used.

| Command | Baseline exit | Working-tree exit | Baseline failures | Working-tree failures | New failures introduced |
| --- | ---: | ---: | --- | --- | ---: |
| `npx tsc --noEmit --incremental false` | 2 | 2 | Six invalid Next exports listed below | Identical six | 0 |
| `npm run build -- --webpack` | 1 | 1 | Invalid FOMO route export after successful compilation | Identical failure | 0 |
| Full suite command below | 1 | 1 | 35 tests listed below | Identical 35 (names + file paths compared) | 0 |
| `node --import tsx scripts/test-devscore-clustermap-evidence.mjs` | 1 | 1 | Legacy simulationStatus source assertion | Identical | 0 |
| `node --import tsx scripts/test-token-scanner-base-state-copy-consistency.mjs` | 1 | 1 | One legacy copy assertion (25 pass) | Identical | 0 |
| `node --import tsx scripts/test-token-scanner-chain-strict.mjs` | 1 | 1 | Legacy pair.chainId source assertion | Identical | 0 |
| Touched-source ESLint | 0 | 0 | 0 errors; 48 existing warnings | 0 errors; 47 warnings; no new diagnostics | 0 |

Full suite, identical invocation on each tree:

```sh
node --import tsx --test --test-concurrency=4 $(rg --files tests lib src workers app -g '*.test.ts' -g '*.test.tsx' -g '*.test.js' -g '*.test.mjs' | sort)
```

Baseline: 3,911 tests; 3,873 pass, 35 fail, 3 skip.
Working tree: 3,926 tests; 3,888 pass, 35 fail, 3 skip.
Difference: 15 new passing wallet-detail tests; zero new or removed failures.
The earlier exploratory concurrent-build run's time-sensitive walletPersonality assertion did not recur in either matched final run; that file was not changed.

Six identical typecheck failures (generated Next route validators):
- app/api/fomo/leaderboard/route.ts: authorizeFomoLeaderboardRequest
- app/api/paypal/create-subscription/route.ts: handleCreateSubscription
- app/api/paypal/webhook/route.ts: planFromCustomId
- app/api/radar/route.ts: __resetRadarResilienceStateForTest
- app/api/wallet-scan/worker/route.ts: isAuthorizedWalletScanWorkerRequest
- app/terminal/wallet-scanner/page.tsx: deriveWalletScanStageState

Required targeted recheck:

```sh
node --import tsx --test tests/wallet-detail-enrichment.test.ts tests/holder-integrity-cross-chain.test.ts lib/devControlCustodyPolicy.test.ts
```

48 tests passed; 0 failed. Shared evidence script: 52 checks passed; deployer intel: 29; cluster diagnosis: 76; chain strictness: 32; Robinhood consistency passed. npm test: 20 passed in the implementation pass.

ESLint inspected all 13 touched TS/TSX/MJS source/test files. New modules and the new regression file have no warnings or errors. Existing React warnings in the scanner and unused variables in existing routes were compared with baseline and left untouched. `git diff --check` passed. Unrelated baseline failures were not modified.

### Identical broader failure set

- app/api/_shared/eventsCache.test.ts — omitting the cache parameter entirely preserves the original behavior (a fresh, independent fetch every time)
- app/api/wallet-scan/walletScanPartialSnapshot.test.ts — HARD ASSERTION (required regression): a partial snapshot reaches the poll response while the job is still running
- app/api/wallet-scan/walletScanPartialSnapshot.test.ts — HARD ASSERTION (required regression): the final result still overwrites the partial result — publishFinal replaces the whole job record
- app/api/wallet-scan/walletScanPartialSnapshot.test.ts — progress and partial can coexist on the same running job — both surfaced together
- app/api/wallet-scan/walletScanPublishPollKeys.test.ts — HARD ASSERTION: a partial/bounded-sample result (integrityTier: "partial") is returned with realizedPnlUsd intact — the route never nulls it out because the tier is not "full"
- app/api/wallet-scan/walletScanPublishPollKeys.test.ts — a "blocked" integrityTier result with a genuinely null realizedPnlUsd still passes it through as null, never coerced to a fabricated 0
- app/api/wallet-scan/walletScanPublishPollKeys.test.ts — a failed result write leaves the job key untouched — never marked done with a missing result
- app/api/wallet-scan/walletScanPublishPollKeys.test.ts — poll returns the full result when both final keys exist
- app/api/wallet-scan/walletScanPublishPollKeys.test.ts — poll surfaces the safe stage error code for a failed job
- app/api/wallet-scan/walletScanPublishPollKeys.test.ts — publish → poll returns the full successful result
- app/api/wallet-scan/walletScanPublishPollKeys.test.ts — publish → poll stays running when the result key is missing
- app/api/wallet-scan/walletScanQueueUnavailable.test.ts — poll route returns status-unavailable when KV cannot read job keys
- app/api/wallet-scan/walletScanQueueUnavailable.test.ts — worker queue claim unavailable returns an error
- app/api/wallet-scan/walletScanStageProgress.test.ts — HARD ASSERTION (required regression): a stage update reaches the poll response while the job is still running
- app/api/wallet-scan/walletScanStageProgress.test.ts — HARD ASSERTION (required regression): progress never leaks into the response once the scan is done — publishFinal overwrites the whole record
- app/api/wallet-scan/walletScanStageProgress.test.ts — a later stage update overwrites the earlier one — the poll route always shows the MOST RECENT real checkpoint
- app/api/wallet-scan/walletScanStageProgress.test.ts — a queued job (not yet running) can also carry a real stage update
- app/frontend/components/WalletScannerResultsV3.structure.test.ts — WalletScannerTabsV3 passes pricedHoldings/chainValueUsd straight through to HoldingsViewV2 — the same canonical selectHoldingsV2() source the old layout uses
- src/modules/fifoEngine/computePnl.aggregateArithmeticInvariant.test.ts — cent-level and full-precision invariants hold across 5 reconciled positions with varied priced/unpriced lot mixes (production-shaped)
- src/modules/fifoEngine/computePnl.aggregateArithmeticInvariant.test.ts — keeps missing-evidence guards while reconciling a known smaller balance
- src/modules/fifoEngine/computePnl.classificationAndPricing.test.ts — 5. an open quantity greater than a known positive balance is capped to that balance for unrealized, never excluded (Wallet PnL Item 3)
- src/modules/fifoEngine/computePnl.reconciliationDiagnostics.test.ts — 6. known smaller balances reconcile every priced position instead of excluding it
- src/modules/fifoEngine/computePnl.reconciliationDiagnostics.test.ts — reports "partial" when some positions reconcile and some do not, and "ok" when all reconcile
- src/pipeline/priceLotsForWallet.alchemyApply.test.ts — a temporally-rejected (stale) price never applies, even with the flag enabled
- src/pipeline/priceLotsForWallet.ethNativeCoingeckoReservation.test.ts — fullyPricedLots increases even though an ordinary CoinGecko call would have 429'd in this scan, and FIFO stays byte-identical
- src/pipeline/priceLotsForWallet.ethNativeDateCoalescing.test.ts — two closed lots quoted in ETH on the SAME calendar date share one real request, fullyPricedLots increases, FIFO stays byte-identical
- src/pipeline/priceLotsForWallet.ethNativeHistorical.test.ts — an Ethereum native-ETH-funded closed lot becomes fully priced using the fixed routing, cap stays 2, FIFO byte-identical
- src/pipeline/priceLotsForWallet.nativeCapPriority.test.ts — 42 native requirements (one per distinct token, all tied at rank 0) plus unranked ETH decoys: only the per-token cap (2) survive, and they are the top-ranked ones
- src/pipeline/priceLotsForWallet.nativeCompletionPriority.test.ts — completion-aware ranking increases fullyPricedLots where amount-only ranking would not
- src/pipeline/priceLotsForWallet.nativeEntryIdentity.test.ts — the target entry is capped while the same-tx native quote entry survives and is priced
- src/pipeline/priceLotsForWallet.nativePricingRoute.test.ts — completion-aware ranking fully completes one lot rather than half-completing two, given the unchanged 2-slot cap
- src/pipeline/priceLotsForWallet.nativeQuotePriority.test.ts — 5. coverage improves: a native-ETH-quoted closed lot that was unpriced becomes fully priced
- src/pipeline/priceLotsForWallet.nativeRankDirection.test.ts — 40 distractors + 2 completion candidates: completion candidates receive the two smallest ranks and both survive the cap
- src/pipeline/scanPerformance.staticCheck.test.ts — recoveryPolicy (a bounded, deterministic recomputation over a fixed past window) uses the 300s repeat-scan constant
- src/pipeline/walletScannerPublicUiLeak.test.ts — public PnL card hides raw debug behind Technical details and never names server audits
