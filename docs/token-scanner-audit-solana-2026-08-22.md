# Token Scanner Audit — Solana Chain — August 22, 2026

## Scope

Companion to `docs/token-scanner-audit-2026-05-18.md` (Base-chain scanner), covering the Solana Beta
path only:

- Orchestrator: `lib/server/solanaTokenScannerBeta.ts` (facade) → `lib/server/solana/providerMerge.ts`
- Analyzers: `lib/server/solana/*.ts` (18 modules)
- Providers: `lib/server/solanaProviders.ts`, `lib/server/solanaChainConfig.ts`
- API: `app/api/token/route.ts` (solana branch), `app/api/token/chain-status/route.ts`,
  `app/api/solana-wallet-detail/route.ts`
- Client scoring: `lib/solanaConfidenceScore.ts`, `lib/solanaCortexRisk.ts`, `lib/solanaAddress.ts`
- UI: `app/terminal/token-scanner/page.tsx` (Solana-only render branch)
- Tests: `scripts/test-solana-*.mjs`

## Executive Summary

Unlike the Base scanner, the Solana path is unusually well self-documented (every module carries an
explicit "honesty contract" disclosing what it does/does not fabricate) and has no dead terminal
command wiring. The risks here are different in character: **three independent, disagreeing risk-
scoring systems shown for the same token**, **zero caching** on an 8+ sequential-RPC-call pipeline,
**no rate limiting** on the per-click wallet-detail endpoint, and a **developer-score model that
structurally penalizes every scan that didn't opt into Deep Cluster Check**. Token-2022 extension
parsing is honest but shallow (trusts RPC's own decoder, doesn't cross-check separately).

## Detailed Findings

### 1) Three parallel, independently-tuned risk verdicts for one token (Medium-High)

- Server: `lib/server/solana/riskEngine.ts` `scoreSolanaBeta()` → `OPEN_CHECK|CAUTION|HIGH_RISK`.
- Client #1: `lib/solanaConfidenceScore.ts` `computeSolanaConfidenceScore()` → 0-100 score,
  `Open Check|Caution|High Risk` (different thresholds: 60/35).
- Client #2: `lib/solanaCortexRisk.ts` `computeSolanaCortexRisk()` → 0-100+ score (max varies per
  scan, 100 nominal), 5-tier `LOW RISK|WATCH|MEDIUM RISK|HIGH RISK|EXTREME RISK`.
- All three read the *same* `SolanaBetaScanResult` fields but use different bucket boundaries, and
  Cortex additionally applies a hard "authority override" that can jump the verdict two tiers
  (`solanaCortexRisk.ts:265-272`) that Confidence Score has no equivalent of. A token could plausibly
  read "Caution" from one panel and "HIGH RISK" from another simultaneously on the same page.

Recommendation: pick one canonical verdict model (or clearly label each as a distinct, independently
named "lens" with no shared vocabulary like "Caution"/"High Risk" reused across two of them).

### 2) No caching anywhere on the Solana pipeline (Medium)

- `grep` across `lib/server/solana/*` and `solanaProviders.ts` finds zero references to `kv.ts` or
  any cache layer, unlike Base (`baseMarketUniverse.ts`, `baseRadarHolderConcentration.ts`,
  `baseRadarOwnership.ts` all use caching).
- `runSolanaProviderMerge` (`lib/server/solana/providerMerge.ts:49-286`) fires ~8 sequential network
  calls (mint RPC ×2, holders RPC + Helius, DexScreener, Jupiter ×2, Helius activity, GeckoTerminal,
  pool RPC) on **every** scan of the same mint, back to back rather than in parallel — no
  `Promise.all` batching for the independent calls (mint/market/metadata/creator could run
  concurrently; instead lines 67-122 await them one after another).

Recommendation: add a short-TTL cache keyed by mint address (mirroring the Base pattern), and
parallelize the provider calls that have no data dependency on each other to cut wall-clock latency.

### 3) `developerScoreAnalyzer.ts` penalizes scans that never ran Deep Cluster Check (Medium)

- `lib/server/solana/developerScoreAnalyzer.ts:60-73`: Cluster/Funding Confidence contributes 0 of
  15 max points whenever `clusterMap` is null (i.e. whenever the user hasn't clicked "Deep Cluster
  Check" — which is opt-in and never run by default per `providerMerge.ts:129`).
- `maxScore` is still computed as the sum of every component's `maxPoints` (line 84), so a normal
  scan's Developer Score denominator always includes the unreachable 15 points, silently capping
  every non-deep-scanned token at `maxScore - 15` effective ceiling with no UI distinction between
  "scored 70/100 because it's risky" vs "scored 70/100 because deep mode wasn't run."

Recommendation: either exclude un-run components from `maxScore`, or expose `scoredComponents` vs
`skippedComponents` distinctly so the UI can show "70/85 (Deep Cluster Check not run)" instead of a
misleadingly-comparable "70/100."

### 4) `holderAnalyzer.ts` — precision loss on large u64 balances (Low)

- `lib/server/solana/holderAnalyzer.ts:55-58`: `Number(r.amount)` converts the raw base-unit balance
  (a u64 string from the RPC) straight to a JS `number`. For high-decimal, high-supply memecoins
  (very common on Solana; e.g. 1e15+ raw units) this silently loses precision beyond 2^53, which
  then propagates into `top1Percent`/`top10Percent`/`top20Percent` and into every consumer
  (`riskEngine.ts`, `patternAnalyzer.ts`, `watchPlanAnalyzer.ts`, `developerScoreAnalyzer.ts`,
  both client scorers). Same issue in `mintAnalyzer.ts:81` (`rawSupply`).

Recommendation: use `BigInt` for raw-amount math and only convert to `number` after the percentage
division (or use a decimal library), same class of fix the Base audit already flagged for EVM balances.

### 5) `/api/solana-wallet-detail` — unauthenticated, unbounded, no rate limit (Medium)

- `app/api/solana-wallet-detail/route.ts:12-31`: only checks `isSolanaChainAvailable()` and address
  shape — no `rateLimit.ts` usage (confirmed via grep; the module exists and is used elsewhere in
  `app/api/token/route.ts` for other purposes but not wired here). Each POST fires 2 fresh RPC calls
  (`getBalance` + `getSignaturesForAddress`) against the configured Alchemy key with no per-IP/session
  throttle, and the Cluster Map UI can fire this on every node click (`app/terminal/token-scanner/page.tsx:2542`).
- A scripted client could cheaply enumerate arbitrary Solana addresses through this endpoint at
  effectively unlimited rate, consuming the shared Alchemy RPC quota.

Recommendation: apply the same rate-limit middleware the rest of the app uses to this route.

### 6) `scoreSolanaBeta` top1 threshold conflates AMM vaults with whales, then still escalates risk (Low)

- `lib/server/solana/riskEngine.ts:39-42`: `top1Percent >= 50` always pushes `CAUTION`, while the
  reason string itself admits "may be an AMM pool vault — not necessarily a single whale." Since
  `holderAnalyzer.ts`'s own header states the top-20 sample routinely *is* an AMM vault, this
  hard-coded 50% threshold will false-positive CAUTION on essentially every token with one dominant
  liquidity pool holding its own LP-side balance — which is most freshly-launched Solana tokens.

Recommendation: exclude the resolved primary pool address (`poolAnalyzer.ts` already identifies it)
from the top-account concentration math before comparing against the 50% threshold, so the signal
reflects actual holder risk rather than routine AMM custody.

### 7) Token-2022 extension parsing trusts RPC's `jsonParsed` output with no independent verification (Low)

- `lib/server/solana/tokenExtensions.ts:51-63` and `mintAnalyzer.ts:86` rely entirely on the RPC
  node's own `extensions` field inside `jsonParsed` — there is no fallback raw-byte parse if a given
  RPC provider's parser is older/incomplete (acknowledged in the module's own header, "if the RPC's
  parser omits a field... that field is null, never guessed" — an honest gap, but it means a
  `transferFeeConfig` or `permanentDelegate` extension could be silently invisible if Alchemy's
  parser lags a newly-added extension type, with **no evidence gap raised** in that case since the
  code can't tell "extension truly absent" from "parser didn't return it."

Recommendation: consider a secondary, even coarse, raw-account-length or discriminator-byte check to
detect "this looks like Token-2022 with unparsed extension data" and surface that as an explicit gap
rather than silent omission.

### 8) `mintAnalyzer.ts`/`holderAnalyzer.ts` — retry-once policy can double real (billed) RPC latency, no circuit breaker (Low)

- `lib/server/solana/rpcClient.ts:50-62`: every `solanaRpc` call gets one retry on 429/5xx/timeout
  with a fixed 350ms backoff. Good for a single hiccup, but `providerMerge.ts` calls `solanaRpc`
  roughly 5+ times sequentially per scan (mint account, supply, largest accounts, pool account, plus
  Helius's own retries-via-pagination). A sustained Alchemy outage or hard rate-limit therefore
  produces `5 × (9s timeout + 350ms + 9s timeout)` ≈ 90+ seconds worst case before the scan resolves
  to a degraded result, with no shared circuit-breaker/budget across the whole request the way
  `alchemyCallBudget.ts` exists for other chains.

Recommendation: reuse the existing `alchemyCallBudget.ts` pattern (or an equivalent per-request
deadline) to fail fast once RPC health is clearly bad, instead of paying the full retry latency on
every subsequent call in the same scan.

### 9) Test coverage — several analyzers with real network/parsing logic have no dedicated script (Medium)

Cross-referencing `scripts/test-solana-*.mjs` imports against `lib/server/solana/*.ts`:

| Module | Covered by a test script? |
|---|---|
| `supplyControlAnalyzer.ts`, `tokenExtensions.ts`, `watchPlanAnalyzer.ts`, `supplyTimelineAnalyzer.ts` | Yes — `test-solana-supply-control.mjs` |
| `creatorConfidenceAnalyzer.ts`, `patternAnalyzer.ts`, `developerScoreAnalyzer.ts` | Yes — `test-solana-developer-score.mjs` |
| `clusterAnalyzer.ts` (+ `fetchHeliusWalletFundingTrace`) | Yes — `test-solana-cluster-map.mjs` |
| `walletDetailAnalyzer.ts` | Yes — `test-solana-wallet-detail.mjs` |
| `riskEngine.ts`, `authorityAnalyzer.ts` | **No dedicated script** — only exercised indirectly if at all |
| `mintAnalyzer.ts` | **No dedicated script** |
| `holderAnalyzer.ts` | **No dedicated script** |
| `marketAnalyzer.ts` (DexScreener parsing, liquidity summing, pair-age math) | **No dedicated script** |
| `poolAnalyzer.ts` (AMM program classification, PumpSwap migration flag) | **No dedicated script** |
| `metadataResolver.ts` | **No dedicated script** |
| `creatorAnalyzer.ts` | **No dedicated script** |
| `deepCreatorAnalyzer.ts` | **No dedicated script** |
| `rpcClient.ts` (retry/transient-error classification) | **No dedicated script** |
| `providerMerge.ts` (the orchestrator itself) | **No dedicated script** — `test-solana-token-scanner.mjs` imports scoring modules, not `providerMerge`/`scanSolanaTokenBeta` directly (confirm before relying on it as an integration test) |

Recommendation: add scripts for `marketAnalyzer.ts` (DexScreener JSON edge cases — malformed pairs,
matched-token-not-found), `poolAnalyzer.ts` (each known program ID + unrecognized-owner path), and
`rpcClient.ts` (transient-vs-permanent error classification), since these three contain the most
non-trivial parsing/branching logic with no test today.

### 10) Chain-status vs actual capability labeling (Low)

- `app/api/token/chain-status/route.ts` only reports `enabled`/`rpcConfigured`/`available` — it does
  not distinguish "Alchemy configured but Helius/Jupiter/GeckoTerminal all off," which is a
  materially different, much lower-evidence experience than a fully-wired scan. The richer
  `solanaTokenScannerConfigAudit()` (`solanaChainConfig.ts:112-141`) exists and reports this detail
  but is never called from `chain-status/route.ts` — only logged server-side from
  `app/api/token/route.ts:3565`.

Recommendation: surface `solanaTokenScannerConfigAudit()`'s provider-level detail (or at least a
"partial provider coverage" flag) through `chain-status` so the UI can warn before a user scans that
optional-provider evidence (holder count, creator signal) won't be available.

## Prioritized Remediation Plan

1. **P0**: Reconcile or clearly separate the three risk-scoring surfaces (Finding 1). — **Open.**
   Deliberately not touched in this pass: collapsing/renaming three live, user-facing verdict
   surfaces is a product decision (which labels survive, how existing users' bookmarked reads are
   affected), not a pure engineering fix, so it's left for a follow-up with product sign-off.
2. **P0**: Add rate limiting to `/api/solana-wallet-detail` (Finding 5). — **Fixed.** Reused the
   existing `lib/server/rateLimit.ts` per-IP token bucket (20 req/min), same pattern already used
   by `app/api/scan-holder/route.ts`.
3. **P1**: Parallelize independent provider calls in `providerMerge.ts` (Finding 2, partial). —
   **Fixed** (parallelization only). Holders/market/creator now run via `Promise.all` (all three
   only depend on step 1's mint identity, not each other); OHLCV candles + pool-program identity
   likewise now run concurrently (both depend only on the resolved pool address). Metadata still
   runs after market since it consumes market's token name/symbol as a fallback. A caching layer
   was **not** added in this pass — worth a follow-up given how cheap the wins were here.
4. **P1**: Fix Developer Score's `maxScore` denominator for un-run components (Finding 3). —
   **Fixed.** Added `scaledMaxScore` (denominator excluding components marked `skipped`, currently
   only Cluster/Funding Confidence when Deep Cluster Check wasn't run) and a `skipped` flag per
   component; the Watch Plan tab UI now shows score against `scaledMaxScore` and visually
   de-emphasizes skipped rows instead of silently including them in a 100-point ceiling.
5. **P1**: Switch raw-balance math to BigInt (Finding 4). — **Fixed** for the holder-concentration
   path: `mintAnalyzer.ts` now also returns `rawSupplyExact` (the untouched RPC string), and
   `holderAnalyzer.ts` sums top-account balances and computes percentages entirely in BigInt,
   falling back to the pre-existing lossy `Number()` path only if `rawSupplyExact` is absent/
   malformed. Added `scripts/test-solana-holder-analyzer.mjs` covering a >2^53 balance case.
6. **P2**: Exclude the primary pool address from top-account concentration before risk scoring
   (Finding 6). — **Open.** `holderAnalyzer.ts`'s `accounts` list doesn't currently carry the raw
   address per row (only rank/amount/percent), so this needs a small type change before the fix;
   deferred rather than done as a rushed follow-on to the BigInt change above.
7. **P2**: Add test scripts for `marketAnalyzer.ts`, `poolAnalyzer.ts`, `rpcClient.ts` (Finding 9).
   — **Open** for those three; `holderAnalyzer.ts` (also flagged as untested) now has
   `scripts/test-solana-holder-analyzer.mjs`.
8. **P2**: Surface provider-level config detail via `chain-status` (Finding 10). — **Fixed.**
   `/api/token/chain-status` now also returns `solana.providers.{alchemy,goldrush,marketFallback,
   helius,jupiter}`, sourced from the existing `solanaTokenScannerConfigAudit()` /
   `isHeliusConfigured()` / `isJupiterConfigured()` helpers that were previously only logged
   server-side.

Remaining open items (1, 6, 7's other three modules) are unchanged from the original audit and are
tracked above for a follow-up pass.

## Suggested Regression Checklist

- Scan a mint with an active mint authority AND active freeze authority — verify all three risk
  surfaces (`betaRisk`, Confidence Score, Cortex Risk) show a consistent severity direction.
- Scan a mint whose primary pool holds >50% of supply as an AMM vault — verify CAUTION isn't
  triggered purely by vault custody.
- Scan a Token-2022 mint with `transferFeeConfig` + `permanentDelegate` — verify Watch Plan and
  Supply Control both surface both extensions with correct bps/delegate values.
- Simulate Alchemy RPC 429s across a scan — verify total latency and that the result degrades to
  evidence gaps rather than hanging near the ~90s worst case.
- Click multiple Cluster Map nodes rapidly — verify `/api/solana-wallet-detail` doesn't silently
  become a way to burn RPC budget without limit.
- Run the same scan with and without Deep Cluster Check — compare Developer Score numerators AND
  denominators, not just the point totals.
