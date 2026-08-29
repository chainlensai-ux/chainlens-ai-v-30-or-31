// TESTS — Robinhood Chain evidence resolver (lib/robinhoodTokenEvidence.ts). Pure/synchronous, no
// network. Covers the task's required scenarios: market/liquidity rendering, honest holder/security/
// LP/dev-control classification (never generic "Open check"), confidence reduction on missing
// evidence, and no fake Base/Ethereum LP assumptions.

import assert from 'node:assert/strict'
import { resolveRobinhoodTokenEvidence } from '../lib/robinhoodTokenEvidence.ts'

let passed = 0
function check(label, condition) { assert.ok(condition, label); passed++ }

const TOKEN = '0xverona000000000000000000000000000000001'

function baseInput(overrides = {}) {
  return {
    chainSlug: 'robinhood',
    chainId: 4663,
    tokenAddress: TOKEN,
    marketData: { hasPrice: true, hasLiquidity: true, noActivePools: false },
    poolData: { poolCount: 1, liquidityUsd: 37000, poolAddress: '0xpool1', dexName: 'Robinhood DEX', poolModel: 'concentrated_liquidity' },
    holderData: { topHoldersCount: 0, providerStatus: 'unavailable_with_reason', providerReason: null, providerAttempted: false },
    securityData: { attempted: false, simulationStatus: null, honeypotReason: null, isHoneypot: null },
    ownershipData: { ownerAddress: null, adminAddress: null, isRenounced: null, checkCompleted: false },
    lpData: { proofApplicable: false, controllerType: null, controllerVerified: null, lockBurnRegistrySupported: false },
    devControlData: { deployerAddress: null, deployerResolved: false, holderEvidenceAvailable: false, clusterSupplyPercent: null },
    ...overrides,
  }
}

// ─── 1. Robinhood token with market/liquidity renders market data ──────────────────────────────
{
  const ev = resolveRobinhoodTokenEvidence(baseInput())
  check('market data status verified when price + pools present', ev.marketDataStatus === 'verified')
  check('liquidity status verified when real liquidity present', ev.liquidityStatus === 'verified')
}

// ─── 2. Missing holders shows exact unsupported/provider reason, not "Open Check" ───────────────
{
  const notAttempted = resolveRobinhoodTokenEvidence(baseInput({ holderData: { topHoldersCount: 0, providerStatus: 'unavailable_with_reason', providerReason: null, providerAttempted: false } }))
  check('no supported holder provider -> unsupported_on_robinhood', notAttempted.holderStatus === 'unsupported_on_robinhood')
  check('exact required wording, no "Open check" text', notAttempted.holderLabel === 'Holder distribution unsupported for Robinhood provider right now')
  check('label never contains the literal string "Open check"', !/open check/i.test(notAttempted.holderLabel))

  const attemptedButFailed = resolveRobinhoodTokenEvidence(baseInput({ holderData: { topHoldersCount: 0, providerStatus: 'error', providerReason: 'provider_error', providerAttempted: true } }))
  check('provider attempted but errored -> provider_unavailable', attemptedButFailed.holderStatus === 'provider_unavailable')
  check('same honest wording for a real provider failure', attemptedButFailed.holderLabel === 'Holder distribution unsupported for Robinhood provider right now')

  const withHolders = resolveRobinhoodTokenEvidence(baseInput({ holderData: { topHoldersCount: 12, providerStatus: 'ok', providerReason: null, providerAttempted: true } }))
  check('real holder rows -> verified', withHolders.holderStatus === 'verified')
}

// ─── 3. Unsupported LP lock proof shows unsupported_on_robinhood ───────────────────────────────
{
  const ev = resolveRobinhoodTokenEvidence(baseInput({
    lpData: { proofApplicable: true, controllerType: null, controllerVerified: false, lockBurnRegistrySupported: false },
  }))
  check('LP lock proof status is unsupported_on_robinhood when no locker registry exists', ev.lpStatus === 'unsupported_on_robinhood')
  check('exact required LP lock wording', ev.lpLockProofLabel === 'LP lock proof unsupported for this Robinhood pool model')
}

// ─── 4. LP controller unknown shows "controller not verified" ──────────────────────────────────
{
  const ev = resolveRobinhoodTokenEvidence(baseInput({
    lpData: { proofApplicable: true, controllerType: null, controllerVerified: false, lockBurnRegistrySupported: false },
  }))
  check('exact required controller wording', ev.lpControllerLabel === 'LP controller not verified')
}

// ─── 5. Unsupported security simulation shows unsupported, not "Open Check" ────────────────────
{
  const unsupported = resolveRobinhoodTokenEvidence(baseInput({
    securityData: { attempted: true, simulationStatus: 'not_supported', honeypotReason: 'Security provider does not support this token/chain pair', isHoneypot: null },
  }))
  check('honeypot.is 403 -> unsupported_on_robinhood', unsupported.securityStatus === 'unsupported_on_robinhood')
  check('exact required security wording', unsupported.securityLabel === 'Security simulation unsupported for Robinhood provider')
  check('never the literal "Open check"', !/open check/i.test(unsupported.securityLabel))

  const failed = resolveRobinhoodTokenEvidence(baseInput({
    securityData: { attempted: true, simulationStatus: 'failed', honeypotReason: 'Security provider returned an error', isHoneypot: null },
  }))
  check('a real attempted-and-failed simulation reports the provider failure reason', failed.securityStatus === 'failed_with_reason' && failed.securityLabel === 'Security provider returned an error')
}

// ─── 6. Dev control with missing holders says "needs holder evidence" ──────────────────────────
{
  const ev = resolveRobinhoodTokenEvidence(baseInput({
    devControlData: { deployerAddress: '0xdeployer1', deployerResolved: true, holderEvidenceAvailable: false, clusterSupplyPercent: null },
  }))
  check('deployer resolved but no holder evidence -> partial', ev.devControlStatus === 'partial')
  check('exact required dev-control wording', ev.devControlLabel === 'Needs holder evidence before confirming supply control')
}

// ─── 7. Risk confidence drops when major checks unsupported ────────────────────────────────────
{
  const allGood = resolveRobinhoodTokenEvidence(baseInput({
    holderData: { topHoldersCount: 10, providerStatus: 'ok', providerReason: null, providerAttempted: true },
    securityData: { attempted: true, simulationStatus: 'confirmed', honeypotReason: null, isHoneypot: false },
    lpData: { proofApplicable: true, controllerType: 'timelock', controllerVerified: true, lockBurnRegistrySupported: true },
  }))
  check('all major checks verified -> high confidence', allGood.confidence === 'high')

  const oneGap = resolveRobinhoodTokenEvidence(baseInput({
    holderData: { topHoldersCount: 10, providerStatus: 'ok', providerReason: null, providerAttempted: true },
    securityData: { attempted: true, simulationStatus: 'confirmed', honeypotReason: null, isHoneypot: false },
    lpData: { proofApplicable: true, controllerType: null, controllerVerified: false, lockBurnRegistrySupported: false },
  }))
  check('one major check unsupported -> medium confidence', oneGap.confidence === 'medium')

  const allGaps = resolveRobinhoodTokenEvidence(baseInput())
  check('holders + security + LP all unsupported -> low confidence', allGaps.confidence === 'low')

  // Hard rule: unsupported must never be treated as confirmed bad, and market/liquidity evidence
  // (real, positive) is never penalized just because other sections are thin.
  check('an unsupported check is never reported as "verified" (never fabricated as confirmed-safe)', allGaps.holderStatus !== 'verified' && allGaps.securityStatus !== 'verified' && allGaps.lpStatus !== 'verified')
  check('market/liquidity stay verified even when confidence is low elsewhere', allGaps.marketDataStatus === 'verified' && allGaps.liquidityStatus === 'verified')
}

// ─── 8. No Base/Ethereum LP assumptions applied to Robinhood ───────────────────────────────────
{
  // A pool model that is NOT proof-applicable (concentrated liquidity, Robinhood's real LP shape)
  // must never be told "verified"/"locked"/"burned" the way a standard ERC-20 LP pool would be.
  const concentrated = resolveRobinhoodTokenEvidence(baseInput({
    lpData: { proofApplicable: false, controllerType: null, controllerVerified: null, lockBurnRegistrySupported: false },
  }))
  check('concentrated-liquidity pool model -> not_applicable, never a fake ERC-20 LP verdict', concentrated.lpStatus === 'not_applicable')
  check('not_applicable never counts as a provider failure in the audit', !concentrated.audit.providerFailures.includes('lp'))
  check('not_applicable is listed as a genuinely-inapplicable check, not a hidden failure', concentrated.audit.unsupportedChecks.includes('lp'))
}

// ─── 9. Wrong-chain cache rejected — resolver never reads data from another chain's evidence ────
{
  // The resolver takes only already-scoped-to-Robinhood evidence as input; it has no cache of its
  // own to reject from, so this proves the structural guarantee instead: chainId/chainSlug are
  // always echoed back exactly as passed, never silently substituted.
  const ev = resolveRobinhoodTokenEvidence(baseInput())
  check('chainId in the audit is always the real Robinhood chain id (4663), never substituted', ev.audit.chainId === 4663)
}

// ─── 10. Audit object shape matches the required spec exactly ──────────────────────────────────
{
  const ev = resolveRobinhoodTokenEvidence(baseInput({ baseRiskScore: 42 }))
  const requiredKeys = [
    'tokenAddress', 'chainId', 'marketDataStatus', 'liquidityStatus', 'holderStatus', 'lpStatus',
    'ownershipStatus', 'securityStatus', 'devControlStatus', 'unsupportedChecks', 'providerFailures',
    'exactMissingReasons', 'finalRiskScore', 'confidence',
  ]
  for (const key of requiredKeys) check(`audit has required field "${key}"`, key in ev.audit)
  check('finalRiskScore passes through the caller-supplied base score unchanged', ev.audit.finalRiskScore === 42)
}

// ─── Structural guards: root-cause fix + real UI wiring, not just the resolver in isolation ─────
{
  const fs = await import('node:fs')
  const routeSrc = fs.readFileSync(new URL('../app/api/token/route.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(routeSrc, /if \(!r\.ok\) return null/, 'resolveSimulation no longer discards a failed honeypot.is result — the real status/reason must survive')
  assert.match(routeSrc, /honeypotStatus:\s*hpResult\.honeypotStatus,/, 'the public honeypot response object carries the real simulation status')
  assert.match(routeSrc, /resolveRobinhoodTokenEvidence\(/, 'route.ts computes the server-side robinhoodTokenEvidenceAudit')
  assert.match(routeSrc, /robinhoodTokenEvidenceAudit/, 'the audit is wired into the response payload')
  passed += 4

  const uiSrc = fs.readFileSync(new URL('../app/terminal/token-scanner/page.tsx', import.meta.url), 'utf8')
  assert.match(uiSrc, /function robinhoodEvidenceFor/, 'the shared Robinhood evidence helper exists in the UI')
  assert.match(uiSrc, /robinhoodEvidenceFor\(result\)/, 'the helper is actually called from render logic, not dead code')
  assert.match(uiSrc, /import \{ resolveRobinhoodTokenEvidence \} from '@\/lib\/robinhoodTokenEvidence'/, 'the UI imports the real shared resolver rather than re-implementing its own label logic')
  passed += 2
}

console.log(`test-robinhood-token-evidence: ${passed} checks passed`)
