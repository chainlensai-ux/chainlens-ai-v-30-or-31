// LP SAFETY OPEN-CHECK FIX, DISCLOSED — locks in computeDisplayLpModel's (already-correct)
// classification for the two cases the bug report names explicitly ("Uniswap V2 pool never ends
// as Model Open Check", "Uniswap V3 pool shows concentrated not_applicable"), plus the genuine
// no-pool and genuinely-unclassifiable-model cases. This function itself was not the root cause
// of the reported bug (see app/api/token/route.ts's proofStatus mapping and
// app/api/token/lpSafetyOpenCheckFix.staticCheck.test.ts for the actual fix) — this test exists so
// a future change to this shared classifier can't silently regress those two required behaviors.
//
// Run directly with:
//   npx tsx --test lib/server/lpIntelligence.computeDisplayLpModel.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computeDisplayLpModel } from './lpIntelligence'

describe('computeDisplayLpModel', () => {
  it('a Uniswap V2 pool with proof present never resolves to "open_check" — it is a real erc20_lp_token model', () => {
    const result = computeDisplayLpModel({
      noActivePools: false,
      proofPresent: true,
      primaryPoolType: 'v2',
      primaryDexId: 'uniswap_v2',
    })
    assert.equal(result.displayLpModel, 'erc20_lp_token')
    assert.equal(result.lockBurnApplicable, true)
    assert.equal(result.proofApplicability, 'applicable')
  })

  it('a Uniswap V3 pool is concentrated_liquidity with proofApplicability "not_applicable" — never "failed V2 proof"', () => {
    const result = computeDisplayLpModel({
      noActivePools: false,
      proofPresent: true,
      primaryPoolType: 'v3',
      primaryDexId: 'uniswap_v3',
    })
    assert.equal(result.displayLpModel, 'concentrated_liquidity')
    assert.equal(result.lockBurnApplicable, false)
    assert.equal(result.proofApplicability, 'not_applicable')
    assert.match(result.lockBurnReason, /does not apply/i)
  })

  it('no pool at all resolves to "no_pool", never "open_check"', () => {
    const result = computeDisplayLpModel({ noActivePools: true, proofPresent: false, primaryPoolType: 'unknown' })
    assert.equal(result.displayLpModel, 'no_pool')
  })

  it('a real pool with a genuinely unclassified model still carries a concrete lockBurnReason — never a bare/empty reason', () => {
    const result = computeDisplayLpModel({ noActivePools: false, proofPresent: true, primaryPoolType: 'unknown' })
    assert.equal(result.displayLpModel, 'open_check')
    assert.ok(result.lockBurnReason && result.lockBurnReason.length > 0, 'lockBurnReason must never be empty for this case — route.ts/UI depend on it to build the final "Unavailable: <reason>" label')
  })

  it('modelProofStandardLockApplies rescues a real ERC-20 model from the generic "open_check" bucket', () => {
    const result = computeDisplayLpModel({
      noActivePools: false,
      proofPresent: true,
      primaryPoolType: 'unknown',
      modelProofStandardLockApplies: true,
    })
    assert.equal(result.displayLpModel, 'erc20_lp_token')
    assert.equal(result.lockBurnApplicable, true)
  })
})
