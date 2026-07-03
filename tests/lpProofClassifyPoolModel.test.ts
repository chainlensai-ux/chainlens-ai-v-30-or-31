// Regression test for lib/server/lpProof.ts's classifyPoolModel() concentrated-liquidity marker
// regex. Bug: the previous pattern matched "-cl" as an unanchored substring, so real V2 pools
// whose dex id happened to contain "-cl" mid-word (e.g. "aerodrome-classic") were misclassified as
// concentrated-liquidity and had LP lock/burn proof incorrectly marked "not_applicable".
// Run directly with: npx tsx --test tests/lpProofClassifyPoolModel.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyPoolModel } from '../lib/server/lpProof'

describe('classifyPoolModel — concentrated-liquidity marker regex', () => {
  it('does not misclassify V2 pool ids that merely contain "-cl" as a substring', () => {
    for (const id of ['aerodrome-classic', 'uniswap-client-pool', 'some-clone-dex', 'pancake-cleanpool']) {
      const result = classifyPoolModel(id)
      assert.notEqual(result.poolModel, 'concentrated', `expected ${id} to not be classified concentrated`)
      assert.notEqual(result.proofApplicability, 'not_applicable', `expected ${id} LP proof to remain applicable`)
    }
  })

  it('still correctly classifies real concentrated-liquidity markers', () => {
    assert.equal(classifyPoolModel('aerodrome-cl-100').poolModel, 'concentrated')
    assert.equal(classifyPoolModel('aerodrome-cl').poolModel, 'concentrated')
    assert.equal(classifyPoolModel('uniswap-v3').poolModel, 'concentrated')
    assert.equal(classifyPoolModel('uniswap-v3-pool').poolModel, 'concentrated')
    assert.equal(classifyPoolModel('pancakeswap-v4').poolModel, 'concentrated')
    assert.equal(classifyPoolModel('aerodrome-slipstream').poolModel, 'concentrated')
  })

  it('correctly classifies a genuine Aerodrome V2 pool as LP-proof applicable', () => {
    const result = classifyPoolModel('aerodrome-v2')
    assert.equal(result.poolModel, 'aerodrome_v2')
    assert.equal(result.proofApplicability, 'applicable')
  })

  it('handles null/undefined/empty dexId without throwing', () => {
    assert.equal(classifyPoolModel(null).poolModel, 'unknown')
    assert.equal(classifyPoolModel(undefined).poolModel, 'unknown')
    assert.equal(classifyPoolModel('').poolModel, 'unknown')
  })
})
