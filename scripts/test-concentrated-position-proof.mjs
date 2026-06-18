import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { attemptConcentratedPositionProof } from '../lib/server/lpProof.ts'
import { buildLpControllerIntel } from '../lib/server/lpControllerIntel.ts'

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
    assert.equal(r.poolAddress, null, 'V4 pool IDs are not exposed as EVM pool contracts')
    assert.equal(r.poolId, poolId)
    assert.equal(r.poolIdentity, poolId)
    assert.equal(r.poolIdentityType, 'pool_id')
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
    assert.equal(r.poolIdentity, poolAddr)
    assert.equal(r.poolIdentityType, 'contract')
  }

  // ── Aerodrome Slipstream (concentrated) dex hint classification ────────────
  {
    const r = await attemptConcentratedPositionProof('base', null, '0x' + 'b'.repeat(64), 'pool_id', 'aerodrome-slipstream')
    assert.equal(r.poolModel, 'slipstream')
    assert.equal(r.status, 'not_supported')
  }


  // ── Controller intel labels reflect attempted concentrated proof results ──
  {
    const intel = buildLpControllerIntel({
      lpControl: { status: 'concentrated_liquidity', proofApplicability: 'not_applicable' },
      selectedPool: { model: 'concentrated', dex: 'Uniswap V4' },
      concentratedPositionProof: {
        status: 'not_supported',
        topPositionOwner: null,
        topPositionOwnerType: null,
        controllerRisk: 'unknown',
        reason: 'Uniswap V4 position lookup not available in current provider path.',
        poolModel: 'uniswap_v4',
        poolId: '0xdc55f2e5718fe52ebfcfde3a97d14d7d963c3c3a5000798596b7f1027ec84a9d',
        poolIdentity: '0xdc55f2e5718fe52ebfcfde3a97d14d7d963c3c3a5000798596b7f1027ec84a9d',
        poolIdentityType: 'pool_id',
      },
    })
    assert.equal(intel.controllerLabel, 'Position proof attempted — not supported')
    assert.equal(intel.controlProofLabel, 'Not Supported — current provider path cannot resolve Uniswap V4 position ownership.')
    assert.notEqual(intel.controllerLabel, 'Position verification required')
    assert.ok(intel.evidenceGaps.includes('Position manager not resolved'))
    assert.ok(intel.evidenceGaps.includes('Top position owner not resolved'))
    assert.ok(intel.evidenceGaps.includes('Position count unavailable'))
    assert.equal(intel.controller, null, 'no fake verified position owner/controller')
    // V4 pool ID must never be exposed as poolAddress — only poolId/poolIdentity.
    assert.equal(intel.poolAddress, null, 'V4 pool ID is not a contract address')
    assert.equal(intel.poolIdentityType, 'pool_id')
    assert.notEqual(intel.controlProofLabel.includes('Uniswap V3'), true, 'V4 proof never mislabels as V3')
  }

  // ── lpExitRiskReason names the real concentrated-pool protocol, never a generic V3/Slipstream guess ──
  {
    const { computeLpExitRisk } = await import('../lib/server/lpProof.ts')
    const result = computeLpExitRisk({
      proofApplicability: 'not_applicable',
      lpLockStatus: 'unknown',
      lpController: 'unknown',
      liquidityUsd: 138929,
      poolModel: 'concentrated',
      hasPool: true,
      concentratedPoolModel: 'uniswap_v4',
      positionOwnershipUnresolved: true,
    })
    assert.ok(result.lpExitRiskReason.includes('Uniswap V4 concentrated-liquidity pool'), 'names Uniswap V4, not generic V3/Slipstream')
    assert.ok(!result.lpExitRiskReason.includes('V3/Slipstream'), 'never uses the generic V3/Slipstream guess when the model is known')
    assert.ok(result.lpExitRiskReason.includes('unresolved position ownership'), 'flags unresolved position ownership')
  }

  // ── Static regressions: public/UI wording avoids raw keys and V4/V2 contradictions ──
  {
    const route = readFileSync(new URL('../app/api/token/route.ts', import.meta.url), 'utf8')
    const ui = readFileSync(new URL('../app/terminal/token-scanner/page.tsx', import.meta.url), 'utf8')
    assert.ok(route.includes('On Ethereum: this token’s primary pool is concentrated liquidity'))
    assert.ok(!route.includes('On Ethereum: standard v2 LP patterns apply. Renounce events') || route.includes('_selectedPoolIsConcentratedForCtx'))
    assert.ok(ui.includes('Uniswap V4 Concentrated'))
    assert.ok(!ui.includes("/uniswap/i.test(dex)) return 'V3 Concentrated Liquidity'"))
    for (const raw of ['positionManager', 'topPositionOwner', 'positionCount']) {
      assert.ok(route.includes('humanizeConcentratedMissingEvidence'), `route humanizes ${raw}`)
    }
    assert.ok(!ui.includes("Position verification required' : cleanStatusLabel(ci?.status)"), 'UI no longer renders only required for protocol controller')
    assert.ok(route.includes('Uniswap V4 Concentrated Liquidity'), 'riskEngine labels V4 concentrated pools correctly')
    assert.ok(!route.includes('return "v3"  // treat V4 as concentrated'), 'detectPoolType no longer mislabels V4 as v3')
    assert.ok(ui.includes('current provider path cannot resolve'), 'UI control-proof wording matches the poolModel-aware not_supported text')
    assert.ok(ui.includes('Position proof attempted — not supported'), 'UI never shows raw snake_case not_supported text')
  }

  console.log('test-concentrated-position-proof.mjs: all assertions passed')
}

main()
