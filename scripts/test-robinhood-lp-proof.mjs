// Robinhood Token Scanner LP + holder proof.
// Pure classification + mocked Blockscout + source contracts. No live network.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const tsx = require('tsx/cjs/api')
const here = fileURLToPath(new URL('.', import.meta.url))

process.env.ENABLE_ROBINHOOD_CHAIN = 'true'
process.env.BLOCKSCOUT_API_KEY = 'test-blockscout-key'

const {
  classifyRobinhoodLpHolders,
  buildRobinhoodLpCopy,
  selectedRobinhoodPoolChainOk,
  emptyRobinhoodLpProofAudit,
  buildRobinhoodLpSafetyBuckets,
  usesErc20LpLockBurnWording,
  ROBINHOOD_HOLDER_UNAVAILABLE_LABEL,
  ROBINHOOD_SECURITY_UNSUPPORTED_LABEL,
  ROBINHOOD_CONCENTRATED_MODEL_LABEL,
  ROBINHOOD_CONCENTRATED_LOCK_LABEL,
} = await import('../lib/robinhoodLpProofShared.ts')

const { resolveRobinhoodLpProof } = await import('../lib/server/robinhoodLpProof.ts')
const { honeypotSimulationUnsupportedReason } = await import('../lib/server/honeypotSecurity.ts')
const {
  buildTokenScanCacheKey,
  isCacheHitValid,
} = await import('../lib/tokenScannerChainStrictness.ts')

const pageSrc = readFileSync(new URL('../app/terminal/token-scanner/page.tsx', import.meta.url), 'utf8')
const routeSrc = readFileSync(new URL('../app/api/token/route.ts', import.meta.url), 'utf8')
const honeypotSrc = readFileSync(new URL('../lib/server/honeypotSecurity.ts', import.meta.url), 'utf8')
const lockIntelSrc = readFileSync(new URL('../lib/server/lpLockBurnIntel.ts', import.meta.url), 'utf8')

let passed = 0
function check(label, condition) {
  assert.ok(condition, label)
  passed += 1
}

const DEAD = '0x000000000000000000000000000000000000dead'
const ZERO = '0x0000000000000000000000000000000000000000'
const WALLET = '0x1111111111111111111111111111111111111111'
const CONTRACT = '0x2222222222222222222222222222222222222222'
const TOKEN = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const POOL = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

// ── 1. ERC-20 LP with holder rows verifies burn / controller ─────────────────
{
  const burned = classifyRobinhoodLpHolders({
    concentrated: false,
    holderFetchAttempted: true,
    totalSupplyRaw: '1000',
    holderRows: [{ address: DEAD, balanceRaw: '1000', pct: 100, isContract: false }],
  })
  check('99%+ burn classifies verified_burned', burned.classification === 'verified_burned')
  check('verified_burned does not claim a locker', burned.lockerDetected === false)

  const wallet = classifyRobinhoodLpHolders({
    concentrated: false,
    holderFetchAttempted: true,
    totalSupplyRaw: '1000',
    holderRows: [{ address: WALLET, balanceRaw: '900', pct: 90, isContract: false }],
  })
  check('80%+ EOA classifies wallet_controlled', wallet.classification === 'wallet_controlled')
  check('wallet controller address is the EOA', wallet.controllerAddress === WALLET)

  const contract = classifyRobinhoodLpHolders({
    concentrated: false,
    holderFetchAttempted: true,
    totalSupplyRaw: '1000',
    holderRows: [{ address: CONTRACT, balanceRaw: '900', pct: 90, isContract: true }],
  })
  check('80%+ unverified contract is not verified_locked', contract.classification === 'contract_controlled_unverified')
  check('no locker invented for unknown contract', contract.lockerDetected === false)
}

// ── 2. Pool found, holder rows missing → unavailable_with_reason, not Open Check
{
  const missing = classifyRobinhoodLpHolders({
    concentrated: false,
    holderFetchAttempted: true,
    totalSupplyRaw: '1000',
    holderRows: [],
  })
  check('empty holder rows are unavailable_with_reason', missing.classification === 'unavailable_with_reason')
  check('missing rows are not treated as 0% burn', missing.burnSharePct == null)
  check('reason names missing holder rows', /holder rows/i.test(missing.reason))
  const copy = buildRobinhoodLpCopy({ concentrated: false, classification: missing.classification, reason: missing.reason })
  check('copy never says Open Check', !/open check/i.test(`${copy.lockLabel} ${copy.controllerLabel} ${copy.lockWhy}`))
  check('lock copy says not confirmed', /lp lock not confirmed/i.test(copy.lockLabel))
}

{
  const proof = await resolveRobinhoodLpProof({
    tokenAddress: TOKEN,
    poolAddress: POOL,
    pairAddress: POOL,
    lpTokenAddress: POOL,
    dex: 'Robinhood DEX',
    poolType: 'v2',
    liquidityUsd: 42_000,
    createdAt: null,
    poolChainHint: 4663,
    concentrated: false,
    skipNetwork: true,
    existingHolderRows: [],
  })
  check('orchestrator with no rows is unavailable_with_reason', proof.classification === 'unavailable_with_reason')
  check('audit status matches', proof.proofAudit.status === 'unavailable_with_reason')
  check('audit is not Open Check', proof.proofAudit.status !== 'open_check')
  check('selected pool chain ok for 4663', proof.proofAudit.selectedPoolChainOk === true)
  check('resolution audit stores pool address', proof.resolutionAudit.poolAddress === POOL)
}

// ── 3. Concentrated pool does not show ERC-20 LP lock/burn wording ───────────
{
  const conc = classifyRobinhoodLpHolders({
    concentrated: true,
    holderFetchAttempted: true,
    totalSupplyRaw: '1000',
    holderRows: [{ address: DEAD, balanceRaw: '1000', pct: 100, isContract: false }],
  })
  check('concentrated ignores ERC-20 burn rows', conc.classification === 'unavailable_with_reason')
  const copy = buildRobinhoodLpCopy({
    concentrated: true,
    classification: conc.classification,
    reason: conc.reason,
    positionOwnerProof: 'unavailable',
  })
  check('concentrated model label', copy.concentratedNote === ROBINHOOD_CONCENTRATED_MODEL_LABEL)
  check('concentrated lock label', copy.lockLabel === ROBINHOOD_CONCENTRATED_LOCK_LABEL)
  check('position owner proof unavailable', copy.controllerLabel === 'Position owner proof: unavailable')
  check('no ERC-20 lock/burn wording on concentrated copy', usesErc20LpLockBurnWording(copy) === false)
  check('no Unicrypt/PinkLock wording', !/unicrypt|pinklock|pink lock/i.test(`${copy.lockLabel} ${copy.lockWhy}`))
}

// ── 4. Unsupported honeypot/security is neutral unsupported, not red error ───
{
  check('4663 is unsupported', honeypotSimulationUnsupportedReason(4663) === ROBINHOOD_SECURITY_UNSUPPORTED_LABEL)
  check('robinhood slug is unsupported', honeypotSimulationUnsupportedReason('robinhood') === ROBINHOOD_SECURITY_UNSUPPORTED_LABEL)
  check('base is not skipped', honeypotSimulationUnsupportedReason(8453) == null)
  check('eth is not skipped', honeypotSimulationUnsupportedReason(1) == null)
  check('honeypot early-skip lives in fetchHoneypotSecurity', /honeypotSimulationUnsupportedReason\(chainIdOrNetwork\)/.test(honeypotSrc))
  check('GoPlus fallback skipped for robinhood', /chain !== 'robinhood'/.test(routeSrc))
  check('page paints unsupported security as neutral, not red', /unsupported\/i\.test\(value\)\?'#7dd3fc'/.test(pageSrc) || /unsupported/i.test(pageSrc) && /#7dd3fc/.test(pageSrc))
}

// ── 5. Base/ETH LP cache cannot populate Robinhood LP proof ──────────────────
{
  const addr = TOKEN
  const baseKey = buildTokenScanCacheKey('base', 8453, addr)
  const rhKey = buildTokenScanCacheKey('robinhood', 4663, addr)
  check('cache keys differ by chain', baseKey !== rhKey)
  check('base cache is not a robinhood hit', isCacheHitValid(
    { chainSlug: 'base', chainId: 8453, tokenAddress: addr },
    { chainSlug: 'robinhood', chainId: 4663, tokenAddress: addr },
  ) === false)
  check('eth cache is not a robinhood hit', isCacheHitValid(
    { chainSlug: 'eth', chainId: 1, tokenAddress: addr },
    { chainSlug: 'robinhood', chainId: 4663, tokenAddress: addr },
  ) === false)
  check('8453 pool is rejected', selectedRobinhoodPoolChainOk(8453) === false)
  check('eth pool is rejected', selectedRobinhoodPoolChainOk(1) === false)
  check('base slug is rejected', selectedRobinhoodPoolChainOk('base') === false)
  check('4663 is accepted', selectedRobinhoodPoolChainOk(4663) === true)
  check('robinhood slug is accepted', selectedRobinhoodPoolChainOk('robinhood') === true)

  const leaked = await resolveRobinhoodLpProof({
    tokenAddress: TOKEN,
    poolAddress: POOL,
    pairAddress: POOL,
    lpTokenAddress: POOL,
    dex: 'uniswap',
    poolType: 'v2',
    liquidityUsd: 1_000_000,
    createdAt: null,
    poolChainHint: 8453,
    concentrated: false,
    skipNetwork: true,
    existingHolderRows: [{ address: DEAD, balanceRaw: '1000', pct: 100, isContract: false }],
  })
  check('wrong-chain pool does not classify from leaked holder rows', leaked.classification === 'unavailable_with_reason')
  check('wrong-chain overlay is refused', leaked.lpControlOverlay == null)
  check('wrong-chain reason names 4663', /4663/.test(leaked.proofAudit.reason))
  check('route never imports Base locker registry for robinhood overlay', /lockersByChain/.test(lockIntelSrc) && !/robinhood:\s*\[/.test(lockIntelSrc))
  check('route skips PinkLock on robinhood', /chain === 'robinhood'/.test(routeSrc) && /do not call PinkLock/i.test(routeSrc))
}

// ── 6. UI renders verified / partial / missing / unsupported ─────────────────
{
  check('page has Verified evidence bucket', /Verified evidence/.test(pageSrc))
  check('page has Partial evidence bucket', /Partial evidence/.test(pageSrc))
  check('page has Missing evidence bucket', /Missing evidence/.test(pageSrc))
  check('page has Unsupported on Robinhood bucket', /Unsupported on Robinhood/.test(pageSrc))
  check('page uses robinhoodLpProofAudit', /robinhoodLpProofAudit/.test(pageSrc))
  check('route attaches robinhoodLpProofAudit', /robinhoodLpProofAudit = _robinhoodLpProofResult\.proofAudit/.test(routeSrc))
  check('route attaches robinhoodLpResolutionAudit', /robinhoodLpResolutionAudit = _robinhoodLpProofResult\.resolutionAudit/.test(routeSrc))
  check('holder fallback uses required copy', pageSrc.includes('ROBINHOOD_HOLDER_UNAVAILABLE_LABEL') || pageSrc.includes(ROBINHOOD_HOLDER_UNAVAILABLE_LABEL))
  check('security unsupported copy is present', pageSrc.includes(ROBINHOOD_SECURITY_UNSUPPORTED_LABEL) || pageSrc.includes('ROBINHOOD_SECURITY_UNSUPPORTED_LABEL'))

  const audit = {
    ...emptyRobinhoodLpProofAudit(TOKEN),
    selectedPoolChainOk: true,
    selectedPoolAddress: POOL,
    poolType: 'v2',
    lpTokenAddress: POOL,
    lpTokenResolved: true,
    holderRowsAttempted: true,
    holderRowsReturned: 2,
    blockscoutUsed: true,
    totalSupplyRead: true,
    burnAddressSharePct: 100,
    status: 'verified_burned',
    reason: 'On-chain LP holder rows show 100.00% of LP supply at burn/dead addresses.',
  }
  const copy = buildRobinhoodLpCopy({ concentrated: false, classification: 'verified_burned', reason: audit.reason })
  const buckets = buildRobinhoodLpSafetyBuckets({
    audit,
    copy,
    liquidityUsd: 50_000,
    tokenHolderRowsReturned: 8,
    securityUnsupported: true,
    securityErrored: false,
    concentrated: false,
  })
  check('verified bucket includes burn proof', buckets.verified.some((l) => /burn/i.test(l)))
  check('verified bucket includes liquidity', buckets.verified.some((l) => /liquidity/i.test(l)))
  check('unsupported bucket includes security', buckets.unsupported.includes(ROBINHOOD_SECURITY_UNSUPPORTED_LABEL))
  check('missing bucket empty when holders present', !buckets.missing.includes(ROBINHOOD_HOLDER_UNAVAILABLE_LABEL))
}

// ── 7. Blockscout holder parser (mocked fetch) ───────────────────────────────
{
  const proof = await resolveRobinhoodLpProof({
    tokenAddress: TOKEN,
    poolAddress: POOL,
    pairAddress: POOL,
    lpTokenAddress: POOL,
    dex: 'uniswap',
    poolType: 'v2',
    liquidityUsd: 12_000,
    createdAt: null,
    poolChainHint: 4663,
    concentrated: false,
    existingTotalSupplyRaw: '1000',
    existingHolderRows: [{ address: WALLET, balanceRaw: '900', pct: 90, isContract: false }],
    fetchImpl: async () => { throw new Error('Blockscout must be skipped when primary LP proof is complete') },
  })
  check('complete primary LP holders skip Blockscout', proof.blockscoutFallbackDecisionAudit.finalStatus === 'skipped_primary_succeeded')
  check('complete primary LP holder proof resolves controller without explorer', proof.classification === 'wallet_controlled' && proof.proofAudit.blockscoutUsed === false)
}

{
  const previousRpc = process.env.ALCHEMY_ROBINHOOD_RPC_URL
  delete process.env.ALCHEMY_ROBINHOOD_RPC_URL
  const fetchImpl = async (url) => {
    const value = String(url)
    if (value.includes('/holders')) return { ok: true, status: 200, json: async () => ({ items: [{ address: { hash: CONTRACT, is_contract: true }, value: '900', percentage: 90 }] }) }
    if (value.includes('/api/v2/tokens/') && !value.includes('/transfers')) return { ok: true, status: 200, json: async () => ({ total_supply: '1000', type: 'ERC-20' }) }
    return { ok: true, status: 200, json: async () => ({ items: [] }) }
  }
  const proof = await resolveRobinhoodLpProof({
    tokenAddress: TOKEN,
    poolAddress: POOL,
    pairAddress: POOL,
    lpTokenAddress: POOL,
    dex: 'uniswap',
    poolType: 'v2',
    liquidityUsd: 12_000,
    createdAt: null,
    poolChainHint: 4663,
    concentrated: false,
    existingTotalSupplyRaw: '1000',
    existingHolderRows: [{ address: CONTRACT, balanceRaw: '900', pct: 90, isContract: null }],
    fetchImpl,
  })
  check('unresolved primary LP controller triggers Blockscout', proof.blockscoutFallbackDecisionAudit.primaryMissingFields.includes('lp_controller') && proof.blockscoutFallbackDecisionAudit.blockscoutAttempted)
  check('Blockscout controller metadata completes contract classification', proof.classification === 'contract_controlled_unverified')
  if (previousRpc == null) delete process.env.ALCHEMY_ROBINHOOD_RPC_URL
  else process.env.ALCHEMY_ROBINHOOD_RPC_URL = previousRpc
}

{
  const fetchImpl = async (url) => {
    if (String(url).includes('/holders')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            { address: { hash: DEAD, is_contract: false }, value: '990' },
            { address: { hash: WALLET, is_contract: false }, value: '10' },
          ],
        }),
      }
    }
    if (String(url).includes('/api/v2/tokens/') && !String(url).includes('/holders') && !String(url).includes('/transfers')) {
      return { ok: true, status: 200, json: async () => ({ total_supply: '1000', type: 'ERC-20' }) }
    }
    return { ok: true, status: 200, json: async () => ({ items: [] }) }
  }
  const proof = await resolveRobinhoodLpProof({
    tokenAddress: TOKEN,
    poolAddress: POOL,
    pairAddress: POOL,
    lpTokenAddress: POOL,
    dex: 'uniswap',
    poolType: 'v2',
    liquidityUsd: 12_000,
    createdAt: '2026-01-01',
    poolChainHint: 'robinhood',
    concentrated: false,
    fetchImpl,
  })
  check('mocked Blockscout burn classifies verified_burned', proof.classification === 'verified_burned')
  check('blockscoutUsed is true', proof.proofAudit.blockscoutUsed === true)
  check('holder rows returned', proof.proofAudit.holderRowsReturned === 2)
  check('totalSupply read', proof.proofAudit.totalSupplyRead === true)
  check('overlay status is burned', proof.lpControlOverlay?.status === 'burned')
  check('LP decision audit proves fallback ran and returned rows', proof.blockscoutFallbackDecisionAudit.blockscoutAttempted === true && proof.blockscoutFallbackDecisionAudit.finalStatus === 'fallback_succeeded')
}

{
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ items: [], total_supply: '0' }) })
  const proof = await resolveRobinhoodLpProof({
    tokenAddress: TOKEN,
    poolAddress: POOL,
    pairAddress: POOL,
    lpTokenAddress: POOL,
    dex: 'uniswap',
    poolType: 'v2',
    liquidityUsd: 12_000,
    createdAt: null,
    poolChainHint: 'robinhood',
    concentrated: false,
    fetchImpl,
  })
  check('empty Blockscout is unavailable, not Open Check', proof.classification === 'unavailable_with_reason')
  check('empty Blockscout overlay is partial with reason', proof.lpControlOverlay?.status === 'partial')
  check('empty Blockscout has an exact decision status', proof.blockscoutFallbackDecisionAudit.finalStatus === 'fallback_returned_no_rows' && /no_holder_rows/i.test(proof.blockscoutFallbackDecisionAudit.blockscoutFailureReason ?? ''))
}

console.log(`ok - ${passed} robinhood LP proof checks passed`)
void tsx
void here
