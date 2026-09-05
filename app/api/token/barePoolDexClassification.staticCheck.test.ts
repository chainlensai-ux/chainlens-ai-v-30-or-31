// BARE-UNISWAP-POOL-MODEL FIX, DISCLOSED: reported live — "LP Safety finds a Uniswap pool but
// still shows LP Status: Partial Proof / Primary Liquidity Model: Model Open Check / Lock/Burn
// Proof: Open Check / Exit Risk: Open Check" on Base/Ethereum/BNB scans.
//
// Root cause traced to an inconsistency between the two pool-model classifiers this codebase
// keeps in sync everywhere else:
//   - lib/server/lpProof.ts's classifyPoolModel() matches ANY dex id containing "uniswap"
//     (no version requirement) as a constant-product V2 LP token.
//   - app/api/token/route.ts's local detectPoolType() only defaulted UNVERSIONED
//     "sushiswap"/"pancakeswap" dex ids to "v2" — a bare "uniswap" dex id (no "_v2"/"-v2"
//     suffix, which GeckoTerminal/DexScreener do return for some V2 pools) fell through every
//     branch to "unknown".
//
// That mismatch left lpPoolType/verifyPoolType stuck at "unknown" for a real, found Uniswap V2
// pool. computeDisplayLpModel's final "modelProofStandardLockApplies" safety net can still
// rescue displayLpModel in some paths, but proofApplicability/lockBurnApplicable and the RPC
// reclassification gate (poolType === 'unknown') all key off detectPoolType's stricter
// classification first — leaving a real ERC-20 LP pool displayed as an unresolved "Open Check"
// unless RPC classification also happened to succeed (network/env dependent, not guaranteed).
//
// Fixed by making detectPoolType treat a bare "uniswap" dex id the same as bare
// "sushiswap"/"pancakeswap": default to "v2". Uses the same "read the real source, assert on it
// directly" convention as robinhoodLpRpcClassification.staticCheck.test.ts (this function is not
// exported and app/api/token/route.ts is too large/provider-dependent for a fixture test).
//
// Run directly with:
//   npx tsx --test app/api/token/barePoolDexClassification.staticCheck.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { classifyPoolModel } from '../../../lib/server/lpProof'

const src = readFileSync(fileURLToPath(new URL('./route.ts', import.meta.url)), 'utf8')

describe('detectPoolType treats a bare (unversioned) "uniswap" dex id as v2, matching classifyPoolModel', () => {
  it('classifyPoolModel (the shared classifier) already treats bare "uniswap" as a V2 ERC-20 LP token — confirms the target behavior', () => {
    const cls = classifyPoolModel('uniswap')
    assert.equal(cls.poolModel, 'constant_product')
    assert.equal(cls.standardLockApplies, true)
    assert.equal(cls.proofApplicability, 'applicable')
  })

  it('the idSignals fast-path unversioned default now includes bare "uniswap", not just sushiswap/pancakeswap', () => {
    assert.match(
      src,
      /if \(\/\^sushiswap\|\^pancakeswap\|\^uniswap\$\/\.test\(s\)\) return "v2"/,
      'detectPoolType\'s unversioned-default fast path must also match a bare "uniswap" dex id (was sushiswap/pancakeswap only)',
    )
  })

  it('the bare-uniswap fast-path check comes after the versioned uniswap v2/v3/v4 checks (so a real "uniswap_v3" id is never misclassified as v2)', () => {
    const v4Index = src.indexOf('if (/uniswap[_-]?v4|uniswapv4/.test(s)) return "concentrated"')
    const v3Index = src.indexOf('if (/uniswap[_-]?v3|uniswapv3|pancakeswap[_-]?v3|pancakeswapv3|sushiswap[_-]?v3|sushiswapv3|\\balgebra\\b/.test(s)) return "v3"')
    const v2Index = src.indexOf('if (/uniswap[_-]?v2|uniswapv2|pancakeswap[_-]?v2|pancakeswapv2|sushiswap[_-]?v2|sushiswapv2|^baseswap|^alienbase|^swapbased|^shibaswap/.test(s)) return "v2"')
    const bareIndex = src.indexOf('if (/^sushiswap|^pancakeswap|^uniswap$/.test(s)) return "v2"')
    assert.ok(v4Index !== -1 && v3Index !== -1 && v2Index !== -1 && bareIndex !== -1, 'all four checks must be present')
    assert.ok(v4Index < bareIndex && v3Index < bareIndex && v2Index < bareIndex, 'the versioned checks must run before the bare-uniswap fallback, so a real versioned dex id is never shadowed by the unversioned default')
  })

  it('the text-based has() fallback also recognizes a bare "uniswap" anywhere in pool metadata text, defaulting to v2', () => {
    assert.match(
      src,
      /if \(has\(\/\\buniswap\\b\/\)\) return "v2";\n\s*return "unknown";/,
      'the has()-based fallback must catch a bare "uniswap" mention (with no version marker matched by the earlier v3/v2 checks) and default to v2, right before the final "unknown" return',
    )
  })
})

console.log('barePoolDexClassification.staticCheck.test.ts: source assertions passed')
