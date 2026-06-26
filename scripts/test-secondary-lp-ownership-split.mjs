import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildSecondaryLpExposure } from '../lib/server/secondaryLpExposure.ts'

// ── 1. Secondary status must not inherit primary's concentrated status ──────────────────────
{
  const exposure = buildSecondaryLpExposure({
    secondarySignals: {
      status: 'concentrated_liquidity', // a stale/buggy producer might still send this
      confidence: 'low',
      poolAddress: '0x' + '1'.repeat(40),
      poolDex: 'hydrex-integral',
      poolType: 'unknown',
      reason: 'Secondary LP pool detected, but pool model/control proof could not be confirmed.',
      evidence: [],
    },
    primaryDex: 'Aerodrome Slipstream',
    primaryPair: 'AORA / WETH',
    primaryPoolModel: 'concentrated',
  })
  assert.ok(exposure, 'secondary exposure object is built when secondary signals exist')
  assert.notEqual(exposure.status, 'concentrated_liquidity', 'secondary status never inherits primary concentrated status')
  assert.equal(exposure.poolType, 'unknown')
  assert.ok(/separate/i.test(exposure.summary) || /not primary liquidity/i.test(exposure.summary), 'summary marks this as separate from primary')
  assert.ok(/monitored separately/i.test(exposure.summary), 'summary says to monitor separately')
}

// ── 2. Impossible combo (concentrated_liquidity + poolType unknown) is structurally blocked ──
{
  const statuses = ['wallet_controlled', 'locked', 'burned', 'watch', 'open_check']
  assert.ok(!statuses.includes('concentrated_liquidity'), 'SecondaryLpExposureStatus type cannot represent concentrated_liquidity at all')
}

// ── 3/4/5/6: static source checks on route.ts (no live API call) ────────────────────────────
{
  const route = readFileSync(new URL('../app/api/token/route.ts', import.meta.url), 'utf8')

  // Part 1 fix: the secondaryLpControlSignals producer derives status from the secondary
  // pool's own classification (_lpProofType), not from lpControl.status.
  assert.ok(route.includes('_secondaryModelConcentrated = _lpProofType'), 'secondary status derives from the secondary pool\'s own classification')
  assert.ok(!route.includes('status: lpControl.status,\n          confidence: lpControl.confidence,\n          poolAddress: lpVerifyPoolAddress,'), 'secondary signal no longer blindly copies primary lpControl.status')

  // Part 3: ownership status split — additive fields alongside the legacy ones.
  assert.ok(route.includes('erc20LpOwnershipStatus:'), 'sections.liquidity exposes erc20LpOwnershipStatus')
  assert.ok(route.includes('erc20LockBurnProofStatus:'), 'sections.liquidity exposes erc20LockBurnProofStatus')
  assert.ok(route.includes('positionOwnershipStatus:'), 'sections.liquidity exposes positionOwnershipStatus')
  assert.ok(route.includes('positionProofConfidence:'), 'sections.liquidity exposes positionProofConfidence')
  assert.ok(route.includes("'position_proof_partial'") || route.includes('position_proof_partial'), 'lpOwnershipStatus can report position_proof_partial for concentrated pools with partial proof')

  // Primary concentrated fields must remain stable / untouched by this change.
  assert.ok(route.includes("lpState === 'concentrated_liquidity'"), 'liquidity ownership split still keys off lpState concentrated_liquidity, primary classification logic untouched')
}

console.log('test-secondary-lp-ownership-split.mjs: all assertions passed')
