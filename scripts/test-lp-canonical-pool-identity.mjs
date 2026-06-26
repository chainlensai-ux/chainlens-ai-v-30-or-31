import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  buildCanonicalPoolIdentity,
  mergeCanonicalPoolIdentity,
  reconcileCanonicalPoolIdentity,
  getCachedCanonicalPoolIdentity,
} from '../lib/server/lpProof.ts'

const AORA_POOL = '0x0aed2bd5abdffcde57c0bcf30e75cd594b8876a9'

// ── A. Same-pool fallback regression: a richer primary-market read classified this pool
// concentrated; a later scan only has generic fallback market data ("Aerodrome", no marker).
// The canonical identity must not be downgraded to constant_product. ─────────────────────────
{
  const primaryRead = buildCanonicalPoolIdentity({
    poolAddress: AORA_POOL,
    poolId: null,
    pair: 'AORA / WETH',
    dexId: 'aerodrome-slipstream-3',
    dexName: 'Aerodrome Slipstream-3',
    source: 'primary_market',
  })
  assert.equal(primaryRead.model, 'concentrated')
  assert.equal(primaryRead.standardLockBurnApplies, false)
  assert.equal(primaryRead.requiresPositionProof, true)
  reconcileCanonicalPoolIdentity(primaryRead)

  const fallbackRead = buildCanonicalPoolIdentity({
    poolAddress: AORA_POOL,
    poolId: null,
    pair: 'AORA / WETH',
    dexId: 'aerodrome',
    dexName: 'Aerodrome',
    source: 'fallback_market',
  })
  // In isolation (no prior cache) a bare "aerodrome" fallback read is "unknown", never CPMM.
  assert.equal(fallbackRead.model, 'unknown', 'bare fallback Aerodrome read alone is unknown, not constant_product')

  const merged = reconcileCanonicalPoolIdentity(fallbackRead)
  assert.equal(merged.model, 'concentrated', 'canonical model stays concentrated after a weaker fallback read for the same address')
  assert.equal(merged.standardLockBurnApplies, false, 'standard ERC-20 lock/burn proof never re-applies to a known concentrated pool')
  assert.equal(merged.requiresPositionProof, true)
  assert.ok(merged.evidence.some((e) => e.includes('weaker_read_ignored')), 'merge records that a weaker read was observed and ignored')

  const cached = getCachedCanonicalPoolIdentity(AORA_POOL)
  assert.equal(cached?.model, 'concentrated', 'cache retains the stronger classification for this address')
}

// ── B. Generic fallback Aerodrome with no prior history and no RPC confirmation ────────────
{
  const freshPool = '0x' + 'f'.repeat(40)
  const read = buildCanonicalPoolIdentity({
    poolAddress: freshPool,
    poolId: null,
    pair: 'FOO / WETH',
    dexId: 'aerodrome',
    dexName: 'Aerodrome',
    source: 'fallback_market',
  })
  assert.equal(read.model, 'unknown', 'generic Aerodrome fallback alone never becomes constant_product')
  assert.equal(read.canApplyErc20LpProof, false)
  assert.equal(read.standardLockBurnApplies, false)
  assert.ok(/requires verification/.test(read.reason))

  // RPC confirmation of a real V2 interface is real evidence — now it may become constant_product.
  const confirmedRead = buildCanonicalPoolIdentity({
    poolAddress: freshPool,
    poolId: null,
    pair: 'FOO / WETH',
    dexId: 'aerodrome',
    dexName: 'Aerodrome',
    source: 'rpc_probe',
    rpcConfirmedModel: 'v2',
  })
  assert.equal(confirmedRead.model, 'constant_product')
  assert.equal(confirmedRead.standardLockBurnApplies, true)
}

// ── mergeCanonicalPoolIdentity: pure ranking behavior ───────────────────────────────────────
{
  const unknown = buildCanonicalPoolIdentity({ poolAddress: '0xabc', poolId: null, pair: null, dexId: null, dexName: null, source: 'fallback_market' })
  const concentrated = buildCanonicalPoolIdentity({ poolAddress: '0xabc', poolId: null, pair: null, dexId: 'uniswap-v3', dexName: 'Uniswap V3', source: 'primary_market' })
  assert.equal(mergeCanonicalPoolIdentity(null, unknown).model, 'unknown')
  assert.equal(mergeCanonicalPoolIdentity(unknown, concentrated).model, 'concentrated', 'unknown never outranks a known model')
  assert.equal(mergeCanonicalPoolIdentity(concentrated, unknown).model, 'concentrated', 'a generic read never downgrades a previously concentrated identity')
}

// ── C/D/E: response-shape regressions in route.ts (static source checks, no live API call) ──
{
  const route = readFileSync(new URL('../app/api/token/route.ts', import.meta.url), 'utf8')
  assert.ok(route.includes('reconcileCanonicalPoolIdentity'), 'route reconciles canonical pool identity')
  assert.ok(route.includes('_hasFallbackPoolEvidence'), 'sections.liquidity inherits fallback pool evidence instead of collapsing to no-pool')
  assert.ok(route.includes("'liquidity_from_fallback_market_read'"), 'fallback liquidity section reports the fallback-read reason')
  assert.ok(route.includes('noActivePools = normalizedPools.length === 0 && !_fallbackLiquidityDetected'), 'noActivePools (which gates the "zero liquidity" UI copy) already accounts for fallback liquidity evidence')
}

console.log('test-lp-canonical-pool-identity.mjs: all assertions passed')
