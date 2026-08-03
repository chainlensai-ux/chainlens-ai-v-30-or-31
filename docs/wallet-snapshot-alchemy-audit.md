# `lib/server/walletSnapshot.ts` — direct Alchemy call audit

Scope: only direct Alchemy calls inside `lib/server/walletSnapshot.ts` (the dev-wallet /
token-intelligence surface — `app/api/dev-wallet`, `app/api/wallet-scanner`, `app/api/wallet-profile`
all route through it). This is **not** the PnL wallet-scan pipeline (`src/pipeline/**`,
`src/modules/providerFetchWindow/**`), and nothing in that pipeline, FIFO, receipts, or historical
pricing was touched.

## Choke point

The file's own header already states it, and reading confirms it: **`alchemyRpc(url, method,
params)` is the only function in this file that makes a real Alchemy network call.** All 12 call
sites route through it — no other `fetch()` in the file bypasses it. This is the single, provably
correct enforcement point.

## Call inventory

| Caller | Endpoint | Chains | Pagination | Max calls (structural) | Est. CU | Request cache/singleflight | Duplicates? | Consumer |
|---|---|---|---|---|---|---|---|---|
| `getSharedTxReceipt` (via `enrichSwapCandidatesFromReceipts`) | `eth_getTransactionReceipt` | base+eth | none (1 tx/call) | bounded by candidate count | 15 | yes — 15 min TTL cache + in-flight map (pre-existing) | no | dev-wallet swap reconstruction |
| `getSharedTxByHash` | `eth_getTransactionByHash` | base+eth | none | bounded | 17 | yes — same shared cache | no | dev-wallet swap reconstruction |
| `getFirstTxOnChain` | `alchemy_getAssetTransfers` (maxCount=1) | base+eth | none | 2/chain, called once/chain | 150×2 | 24h TTL cache (pre-existing), **no singleflight** | no (called once per URL per request) | wallet age / first-activity |
| `fetchAlchemyPnlEvents` | `alchemy_getAssetTransfers` (maxCount=0x7d) | base | none | 2/call | 150×2 | **none** | **YES — proven** (see below) | dev-wallet PnL/swap events |
| `fetchAlchemyBaseTransfersPaginated` | `alchemy_getAssetTransfers` (pageKey) | base | yes, `maxPages` capped ≤5 (pre-existing) | ≤5/direction | 150×≤10 | none | no (distinct pageKeys) | recovery-tier ("Phase 20") supplement |
| `fetchAlchemyBasePriorBuysForToken` | `alchemy_getAssetTransfers` (contract-scoped) | base | none | 1/target token, capped by `maxPagesTotal=4` (pre-existing) | 150 | none | no (per-target, disjoint targets by construction) | unmatched-sell backfill |
| `fetchWalletBehavior` | `alchemy_getAssetTransfers` (maxCount=0x32) | base | none | 2/call, called once | 150×2 | none | no | wallet behavior summary |
| `alchemyRpc` (nonce probe) | `eth_getTransactionCount` | base | none | 1/call, called once | ~50 (unlisted, default) | none | no | address activity check |

## Proven findings

**1. A real, reachable duplicate call.** `fetchAlchemyPnlEvents(address, baseUrl)` is invoked from
two structurally independent branches with byte-identical arguments:
- line ~13246, gated on `_shouldFetchGrBase && grEvents.length < 5` (thin GoldRush result)
- line ~14268, gated on `walletSwapSummary.swapCandidateEvents === 0 && scanMode === 'full_recovery'
  && requestedChain !== 'eth'`

These conditions are not mutually exclusive — a wallet with a thin GoldRush result *and* zero swap
candidates *and* `full_recovery` mode triggers both, firing 4 identical `alchemy_getAssetTransfers`
calls (2×2) for data already fetched once. **Fixed** by settled-result reuse at the `alchemyRpc`
choke point — no per-call-site change needed.

**2. A real, computed, unenforced budget.** `lib/server/walletProviders/budget.ts`'s
`canUseWalletProviderCall` (credit target / hard cap / mode gating) is real and well-built, and
`_trackGatewayProviderCall` computes its `allowed` decision at every one of this file's ~40 provider
call sites — but **that decision's return value is never checked before the real call proceeds.** It
observes and records into an audit log; it does not gate. Confirmed by reading every one of the 12
Alchemy call sites: none checks `_trackGatewayProviderCall`'s return value or short-circuits on
`allowed: false`. Also, two Alchemy call sites (`getSharedTxReceipt`, `getFirstTxOnChain`) are
module-level helpers entirely outside that system's closure and have zero budget of any kind today.

**3. No hard cap of any kind on `alchemy_getAssetTransfers` fan-out.** The file's own diagnostics
(`ALCHEMY_NON_RECEIPT_CALL_BASELINE=8`, `ALCHEMY_RECEIPT_CALL_CAP=36`) are advisory — they push a
warning *string* after the fact, never refuse a call.

## Fix

Added `lib/server/walletSnapshotAlchemyBudget.ts` — one request-scoped budget wired at the
`alchemyRpc` choke point:
- hard call cap (90) and CU cap (5,000, Alchemy's own published per-method costs), sized above this
  file's own pre-existing expected baseline (44) with headroom for the genuinely-bounded pagination
  paths, but tight enough to actually bind on a runaway loop
- settled-result reuse (fixes finding 1) + in-flight singleflight, keyed on `(url, method, params)`
- fail-closed to `null` on exhaustion — the exact value `alchemyRpc` already returns for "no
  result", so every one of the 12 existing callers' established try/catch and `?? []` handling is
  unchanged
- no retries: one attempt per distinct request; a thrown error propagates and is never memoized
  (consistent with this codebase's existing negative-cache convention)
- reset wired to `fetchWalletSnapshot`'s own entry point (the one exported function every request
  goes through)
- diagnostics exposed additively at `_apiAudit.alchemy.budget` in the existing response shape —
  every existing field, and every existing consumer of the snapshot response, is unchanged

## Deliberately not touched

- The existing `_trackGatewayProviderCall`/`canUseWalletProviderCall` advisory system — out of
  surgical scope; wiring it to actually gate would touch ~40 call sites across every provider
  (Moralis/GoldRush/Zerion too), not just the Alchemy calls this task scopes.
- `runTargetedUnmatchedSellBackfill`'s two call sites (Phase 5D / Phase 5D-Supplemental) — already
  deliberately non-duplicative by construction (`_newKeys = _finalKeys.filter(k =>
  !_phase5dTargetedKeys.has(k))`), no fix needed.
- `getFirstTxOnChain`'s missing singleflight — called exactly once per URL per request in the real
  code path; no proven concurrent-duplicate risk to justify the added complexity.
