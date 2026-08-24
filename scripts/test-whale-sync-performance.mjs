// Whale Alerts sync performance — regression tests.
// The sync route is a tightly-integrated Next.js handler, so these tests verify the
// performance contract by source inspection (structure invariants that must hold) plus
// pure-logic replication of the checkpoint decision. Together they cover:
//   1. Repeat sync skips classification for wallets with no new activity (checkpoint).
//   2. New tx after checkpoint is always classified (no alert missed).
//   3. Checkpoint bypassed when missing/stale or in full mode (cold sync unchanged).
//   4. Duplicate provider calls are singleflighted (pre-existing, locked here).
//   5. DB writes remain one batched upsert with deterministic dedupe keys.
//   6. Provider 429 reduces adaptive concurrency instead of failing the sync.
//   7. whaleSyncPerformanceAudit object present with required fields.
//   8. UI refreshes feed after each productive batch (early streaming).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../app/api/whale-alerts/sync/route.ts', import.meta.url), 'utf8')
const pageSrc = readFileSync(new URL('../app/terminal/whale-alerts/page.tsx', import.meta.url), 'utf8')

// ── Pure replication of the checkpoint decision ─────────────────────────────
function checkpointFilter(txTimestamps, checkpointMs, windowMs, now = Date.now()) {
  const valid = checkpointMs != null && Number.isFinite(checkpointMs) && checkpointMs > now - windowMs
  if (!valid) return { skipped: false, fresh: txTimestamps }
  const cp = checkpointMs
  const fresh = txTimestamps.filter(t => t > cp)
  return { skipped: fresh.length === 0, fresh }
}

const HOUR = 3_600_000
const now = Date.now()

// Test: wallet with no new activity since checkpoint is skipped entirely
{
  const r = checkpointFilter([now - 5 * HOUR, now - 4 * HOUR], now - 2 * HOUR, 24 * HOUR, now)
  assert.equal(r.skipped, true)
  assert.deepEqual(r.fresh, [])
}
// Test: NEW tx after checkpoint is kept — never dropped
{
  const r = checkpointFilter([now - 5 * HOUR, now - 1 * HOUR], now - 2 * HOUR, 24 * HOUR, now)
  assert.equal(r.skipped, false)
  assert.deepEqual(r.fresh, [now - 1 * HOUR])
}
// Test: stale checkpoint (older than window) is bypassed → full classification
{
  const r = checkpointFilter([now - 20 * HOUR], now - 30 * HOUR, 24 * HOUR, now)
  assert.equal(r.skipped, false)
  assert.equal(r.fresh.length, 1)
}
// Test: missing checkpoint (cold instance) → full classification
{
  const r = checkpointFilter([now - 20 * HOUR], null, 24 * HOUR, now)
  assert.equal(r.skipped, false)
}

// ── Source contract: incremental layer exists and is safe ────────────────────
{
  // Full mode bypasses checkpoints entirely.
  assert.match(src, /mode === 'full' \? null : /, 'full sync must bypass checkpoints')
  // Checkpoints only advance after successful processing, only monotonic.
  assert.match(src, /if \(newest > prev\) walletLastSeenActivityMs\.set/, 'checkpoint updates must be monotonic')
  // Wallets WITH alerts this round keep their old checkpoint (re-confirm recent activity).
  assert.match(src, /hasAlertsThisRound\)\s*continue/, 'alert-producing wallets keep old checkpoint')
}

// ── Singleflight + cache (pre-existing behavior, locked) ─────────────────────
{
  assert.match(src, /walletTransactionInFlight\.get\(cacheKey\)/)
  assert.match(src, /providerCallsSavedByDedupe \+= 1/)
  assert.match(src, /walletTransactionCacheKey\(address\)/)
  // Cache key is chain-scoped:
  assert.match(src, /PROVIDER_CHAIN}:\$\{address\.toLowerCase\(\)\}/)
}

// ── Adaptive concurrency on 429 ──────────────────────────────────────────────
{
  assert.match(src, /adaptiveConcurrency = Math\.max\(2, adaptiveConcurrency - 2\)/,
    '429 must step concurrency down')
  assert.match(src, /adaptiveConcurrency = Math\.min\(CONCURRENCY, adaptiveConcurrency \+ 1\)/,
    'clean batch lets concurrency recover')
  assert.match(src, /Math\.max\(2, Math\.min\(CONCURRENCY, adaptiveConcurrency\)\)/,
    'chunking uses the adaptive cap')
}

// ── Batched DB writes + deterministic dedupe keys ────────────────────────────
{
  // Exactly ONE upsert call for all filtered alerts of the batch:
  assert.equal((src.match(/\.upsert\(allFilteredAlerts/g) ?? []).length, 1)
  assert.match(src, /onConflict: 'tx_hash,wallet_address,token_address,alert_type'/,
    'deterministic dedupe keys')
  assert.match(src, /ignoreDuplicates: true/)
}

// ── whaleSyncPerformanceAudit contract ──────────────────────────────────────
{
  const fields = ['syncId', 'trackedWalletCount', 'chainsScanned', 'totalDurationMs',
    'timeToFirstAlertMs', 'walletsProcessed', 'walletsSkippedByCache',
    'walletsWithNewActivity', 'providerCallsTotal', 'providerCallsByProvider',
    'providerCallsByChain', 'tokenEnrichmentMs', 'priceLookupMs', 'alertClassificationMs',
    'dbWriteBatches', 'duplicateAlertsRemoved', 'cacheHitRate', 'rateLimitEvents',
    'failedWallets', 'partialFailures', 'bottleneckStage']
  for (const f of fields) {
    assert.ok(new RegExp(`\\b${f}[,:}]`).test(src), `audit missing field: ${f}`)
  }
  // Audit present on EVERY response (not debug-gated):
  assert.match(src, /response\.whaleSyncPerformanceAudit = \{/)
}

// ── UI early streaming ──────────────────────────────────────────────────────
{
  assert.match(pageSrc, /EARLY STREAMING[\s\S]*?loadAlerts\(\{ enrich: false \}\)/,
    'feed must refresh after each productive batch during full sync')
  // Feed loads cached alerts immediately on mount (existing behavior):
  assert.match(pageSrc, /useEffect\(\(\) => \{ void loadAlerts\(\) \}/)
}

console.log('test-whale-sync-performance.mjs: all assertions passed')
