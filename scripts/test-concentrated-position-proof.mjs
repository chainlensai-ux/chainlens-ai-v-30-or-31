import assert from 'node:assert/strict'
import { attemptConcentratedPositionProof } from '../lib/server/lpProof.ts'

const VALID_STATUSES = new Set(['verified', 'partial', 'not_found', 'not_supported', 'failed', 'open_check'])

async function main() {
  // ── No pool address or pool ID at all → open_check, never fakes a pool ──────
  {
    const r = await attemptConcentratedPositionProof('eth', null, null, 'unknown', null)
    assert.equal(r.status, 'open_check')
    assert.equal(r.topPositionOwner, null, 'no fake position owner without a pool')
    assert.ok(VALID_STATUSES.has(r.status))
  }

  // ── Uniswap V4 (32-byte pool ID, no contract address) → real attempt, honest not_supported ──
  {
    const poolId = '0xdc55f2e5718fe52ebfcfde3a97d14d7d963c3c3a5000798596b7f1027ec84a9d'
    const r = await attemptConcentratedPositionProof('eth', null, poolId, 'pool_id', 'uniswap_v4')
    assert.equal(r.status, 'not_supported', 'V4 pool-id-only pool reports not_supported, not a fake result')
    assert.equal(r.poolModel, 'uniswap_v4')
    assert.equal(r.topPositionOwner, null, 'never fakes a position owner when unsupported')
    assert.equal(r.lockedOrManagedPositionFound, null, 'never fakes locked/managed-position evidence')
    assert.ok(r.reason.toLowerCase().includes('not available'), 'reason explains provider-path limitation')
    assert.ok(Array.isArray(r.missingEvidence) && r.missingEvidence.length > 0)
    assert.notEqual(r.status, 'verified', 'never claims verified ownership for V4')
  }

  // ── Uniswap V4 dex hint inferred even without explicit "v4" in dexId, from pool-id shape ──
  {
    const poolId = '0x' + 'a'.repeat(64)
    const r = await attemptConcentratedPositionProof('base', null, poolId, 'pool_id', null)
    assert.equal(r.poolModel, 'uniswap_v4')
    assert.equal(r.status, 'not_supported')
  }

  // ── V3-style pool with a real contract address → attempts a live RPC probe, never fakes "verified" ──
  {
    const poolAddr = '0x1234567890123456789012345678901234567890'
    const r = await attemptConcentratedPositionProof('eth', poolAddr, null, 'contract', 'uniswap_v3')
    assert.equal(r.poolModel, 'uniswap_v3')
    assert.ok(VALID_STATUSES.has(r.status))
    assert.notEqual(r.status, 'verified', 'no network/RPC available in test env — must never fabricate verified')
    assert.equal(r.topPositionOwner, null, 'no position owner fabricated without resolved RPC evidence')
    assert.equal(r.poolAddress, poolAddr)
  }

  // ── Aerodrome Slipstream (concentrated) dex hint classification ────────────
  {
    const r = await attemptConcentratedPositionProof('base', null, '0x' + 'b'.repeat(64), 'pool_id', 'aerodrome-slipstream')
    assert.equal(r.poolModel, 'slipstream')
    assert.equal(r.status, 'not_supported')
  }

  console.log('test-concentrated-position-proof.mjs: all assertions passed')
}

main()
