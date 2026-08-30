import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  classifyClarkPrompt,
  applyClarkLiquidityIntentLock,
  isForcedLiquidityCheckPrompt,
  isLiquidityCheckIntent,
  CLARK_LIQUIDITY_BLOCKED_FALLBACKS,
} from '../lib/server/clarkRouting.ts'
import {
  formatClarkLiquidityCheck,
  mapEvmLiquiditySafetyPayload,
} from '../lib/server/clarkLiquidityCheck.ts'

const ADDR = '0x1234567890123456789012345678901234567890'
const AERO = '0x940181a94A35A4569E4529A3CDfB74e38FD98631'

function lock(prompt, detected = 'token_scan') {
  return applyClarkLiquidityIntentLock({ intent: detected, address: null, symbol: 'HOUSE' }, prompt)
}

{
  const r = classifyClarkPrompt('liquidity check HOUSE')
  assert.equal(r.intent, 'liquidity_scan')
  assert.equal(r.symbol, 'HOUSE')
  assert.ok(isForcedLiquidityCheckPrompt('liquidity check HOUSE'))
  assert.ok(isLiquidityCheckIntent('liquidity check HOUSE'))
}

{
  const r = classifyClarkPrompt('LP check AERO')
  assert.equal(r.intent, 'liquidity_scan')
  assert.equal(r.symbol, 'AERO')
}

{
  const r = classifyClarkPrompt('is LP locked?')
  assert.equal(r.intent, 'liquidity_scan', 'is LP locked must lock to liquidity_scan, never token_safety/token_scan')
}

{
  const r = classifyClarkPrompt('liquidity check')
  assert.equal(r.intent, 'liquidity_scan', 'bare liquidity check must not fall through TOKEN_SCAN_RE "check" into token_scan')
}

{
  const locked = lock('liquidity check HOUSE', 'token_scan')
  assert.equal(locked.routed.intent, 'liquidity_scan')
  assert.equal(locked.audit.detectedIntent, 'token_scan')
  assert.equal(locked.audit.forcedIntent, 'liquidity_scan')
  assert.equal(locked.audit.fallbackPrevented, true)
  assert.equal(locked.audit.responseTemplate, 'LIQUIDITY CHECK')
  assert.ok(CLARK_LIQUIDITY_BLOCKED_FALLBACKS.includes('token_scan'))
  assert.ok(locked.audit.blockedFallbackIntents.includes('token_safety'))
  assert.ok(locked.audit.blockedFallbackIntents.includes('risk_explanation'))
  assert.ok(locked.audit.blockedFallbackIntents.includes('token_full_report'))
}

{
  const locked = lock('liquidity check HOUSE', 'token_full_report')
  assert.equal(locked.routed.intent, 'liquidity_scan')
  assert.equal(locked.audit.fallbackPrevented, true)
}

{
  const unlocked = applyClarkLiquidityIntentLock({ intent: 'token_scan', address: ADDR, symbol: 'BRETT' }, 'scan BRETT')
  assert.equal(unlocked.routed.intent, 'token_scan', 'ordinary token scans must not be stolen by the LP lock')
  assert.equal(unlocked.audit.fallbackPrevented, false)
}

{
  const mapped = mapEvmLiquiditySafetyPayload({
    symbol: 'HOUSE',
    lp_total_liquidity_usd: 80_000,
    lpLockStatus: 'unverified',
    lpController: 'not verified',
    lpMeta: { primaryPoolDex: 'Aerodrome', primaryPoolAddress: AERO },
  }, { chainSlug: 'base', tokenAddressOrMint: AERO, symbol: 'HOUSE' })
  const out = formatClarkLiquidityCheck(mapped)
  assert.ok(out.startsWith('LIQUIDITY CHECK — HOUSE'))
  assert.ok(!out.startsWith('TOKEN READ'))
  assert.ok(!/proxy status/i.test(out))
  assert.ok(!/market cap/i.test(out))
  assert.ok(!/honeypot/i.test(out))
  assert.ok(out.includes('Pool address:'))
  assert.ok(out.includes('LP lock/burn:'))
  assert.ok(out.includes('Controller:'))
  assert.ok(out.includes('Missing LP evidence:'))
  assert.ok(out.includes('Verdict:'))
  assert.ok(out.includes('Liquidity partial') || out.includes('Liquidity verified') || out.includes('Liquidity risky') || out.includes('Liquidity unavailable') || out.includes('unsupported'))
}

{
  const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
  assert.ok(routeSrc.includes('applyClarkLiquidityIntentLock(routed, prompt)'), 'route must apply the liquidity intent lock')
  assert.ok(routeSrc.includes('!isForcedLiquidityCheckPrompt(prompt) && isTokenFollowupPrompt(prompt)'), 'token follow-up TOKEN READ path must not hijack LP prompts')
  assert.ok(routeSrc.includes('forcedTokenScan?.address && !isForcedLiquidityCheckPrompt(prompt)'), 'forcedTokenScan must not override a liquidity lock')
  assert.ok(routeSrc.includes('clarkIntentLockAudit'), 'route must emit clarkIntentLockAudit')
  assert.ok(routeSrc.includes('isLiquidityFallback'), 'timeout fallback must treat liquidity as LP-only, not TOKEN READ')
  const tokenScanIdx = routeSrc.indexOf('if (routed.intent === "token_scan")')
  const liqIdx = routeSrc.indexOf('if (routed.intent === "liquidity_scan")')
  assert.ok(liqIdx > -1 && tokenScanIdx > -1 && liqIdx < tokenScanIdx, 'liquidity_scan must run before token_scan so TOKEN READ cannot claim an LP prompt')
}

console.log('test-clark-intent-lock.mjs: all assertions passed')
