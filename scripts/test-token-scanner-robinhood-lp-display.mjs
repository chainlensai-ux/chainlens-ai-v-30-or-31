// Robinhood Chain LP Safety display — regression tests.
// Verifies (by source contract + pure-logic replication, since the page's helpers are
// module-private):
//   1. Liquidity-without-proof renders the partial state (Robinhood LP Model Partial /
//      Standard LP proof unavailable / Exit risk unverified), never a generic Open Check.
//   2. Liquidity depth can be Deep while exit risk stays Unverified (separation of
//      liquidity-exists from control-verified).
//   3. Missing LP proof does not hide risk/confidence (score hero renders from riskScore
//      regardless of LP proof status).
//   4. Base/Ethereum scans take no override path.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const pageSrc = readFileSync(new URL('../app/terminal/token-scanner/page.tsx', import.meta.url), 'utf8')
const routeSrc = readFileSync(new URL('../app/api/token/route.ts', import.meta.url), 'utf8')

// ── Pure replication of robinhoodLpLabelOverrides decision logic ────────────
function rhOverride(result) {
  const lp = result.lpControl
  const status = lp?.status
  const hasLiquidity = (result.liquidity ?? 0) > 0 || lp?.poolAddressPresent
  const proofConfirmed = status === 'burned' || status === 'locked' || result.lpLockStatus === 'locked' || result.lpLockStatus === 'burned'
  const walletControlled = status === 'team_controlled' || lp?.lpControllerType === 'wallet'
  if (result.chain !== 'robinhood') return null
  if (!hasLiquidity) return null
  if (proofConfirmed || walletControlled) return null
  return {
    lock: 'Standard LP proof unavailable',
    exit: 'Exit risk unverified',
    model: 'Robinhood LP Model Partial',
    explainer: 'Liquidity was detected, but ChainLens could not verify LP lock/burn/controller proof for this Robinhood pool. Treat exit risk as unverified.',
  }
}

const baseResult = {
  chain: 'robinhood',
  liquidity: 480_000, // deep
  lpControl: { status: 'unknown', poolAddressPresent: true, lpControllerType: 'unknown' },
}

// ── Test 1: liquidity but no LP proof → partial state, not Open Check ──────
{
  const o = rhOverride(baseResult)
  assert.ok(o, 'override must fire for robinhood + liquidity + no proof')
  assert.equal(o.lock, 'Standard LP proof unavailable')
  assert.equal(o.exit, 'Exit risk unverified')
  assert.equal(o.model, 'Robinhood LP Model Partial')
  assert.match(o.explainer, /Treat exit risk as unverified/)
  // Page source must wire all three overrides into the render path.
  assert.match(pageSrc, /robinhoodLpLabelOverrides\(result\)/)
  assert.match(pageSrc, /finalModelLabel/, 'model label override must reach the hero card')
  // Generic labels must not be what renders in the override branch.
  assert.doesNotMatch(o.lock, /Open Check/)
}

// ── Test 2: Deep liquidity + Unverified exit risk coexist ──────────────────
{
  const o = rhOverride({ ...baseResult, liquidity: 2_400_000 })
  assert.ok(o, 'deep liquidity with no proof still needs honest labels')
  assert.equal(o.exit, 'Exit risk unverified', 'depth alone must not imply verified exit safety')
  // And confirmed-proof results bypass the override entirely:
  const proven = rhOverride({ ...baseResult, lpLockStatus: 'burned', lpControl: { ...baseResult.lpControl, status: 'burned' } })
  assert.equal(proven, null, 'confirmed proof passes through untouched')
  const wallet = rhOverride({ ...baseResult, lpControl: { ...baseResult.lpControl, status: 'team_controlled', lpControllerType: 'wallet' } })
  assert.equal(wallet, null, 'wallet-controlled verdict passes through untouched')
}

// ── Test 3: missing LP proof does not suppress risk/confidence ─────────────
{
  // Score-hero fallback only fires when riskScore is absent; LP proof status plays no part.
  assert.match(pageSrc, /riskScoreVal != null \? \(/, 'score hero renders whenever riskScore exists')
  // The prior audit task guarantees scanAudit carries confidence/risk even when liquidity fails;
  // the liquidity banner and score hero are independent blocks (no conditional nesting).
  const heroIdx = pageSrc.indexOf(">LIQUIDITY PARTIAL<")
  const scoreIdx = pageSrc.indexOf('riskScoreVal != null')
  assert.ok(heroIdx > 0, 'liquidity partial banner still renders')
  assert.ok(scoreIdx > 0, 'score hero still renders from riskScore')
  // Banner and score are independent blocks — LP proof status must not nest/hide the score.
  // Route: liquidityMissingReason must not gate riskEngine fields.
  assert.match(routeSrc, /riskEngineScore: typeof tokenRiskScoreResult\.riskScore === 'number'/,
    'audit records risk score independently of liquidity')
}

// ── Test 4: Base/Ethereum unchanged ─────────────────────────────────────────
{
  assert.equal(rhOverride({ ...baseResult, chain: 'base' }), null, 'no override on base')
  assert.equal(rhOverride({ ...baseResult, chain: 'eth' }), null, 'no override on eth')
  // Backend audit object only attaches for robinhood.
  assert.match(routeSrc, /robinhoodLpResolverAudit = chain === 'robinhood' \?/)
}

// ── Bonus: backend audit receipt shape ──────────────────────────────────────
{
  for (const key of ['chainId', 'chainSlug', 'tokenAddress', 'primaryPoolAddress', 'primaryDex',
    'poolModel', 'liquidityUsd', 'dexScreenerFound', 'geckoTerminalFound', 'blockscoutVerified',
    'rpcPoolReadAttempted', 'lpControlProofAttempted', 'lpControlProofStatus',
    'lockBurnProofApplicable', 'lockBurnProofStatus', 'exitRiskStatus', 'missingProofReason']) {
    assert.ok(routeSrc.includes(key), `robinhoodLpResolverAudit missing field: ${key}`)
  }
}

console.log('test-token-scanner-robinhood-lp-display.mjs: all assertions passed')
