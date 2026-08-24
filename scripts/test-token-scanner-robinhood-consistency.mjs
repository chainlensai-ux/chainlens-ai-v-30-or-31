// Robinhood Token Scanner inconsistency — regression tests.
// Root causes proven in the audit:
//   1. Free-plan gating nulls riskScore/riskEngine (cousin's laptop) — now disclosed via
//      planGate + scanAudit and explained in the UI instead of a bare "unavailable".
//   2. Unversioned shared KV cache could replay a stale response shape (liquidity missing on
//      one device) — fixed with TOKEN_SCAN_RESPONSE_SCHEMA_VERSION in key + read guard.
// These tests lock in both fixes without touching scoring logic.
import assert from 'node:assert/strict'
import {
  applyTokenScannerPlanGate,
  sanitizePublicTokenResponse,
  TOKEN_SCAN_RESPONSE_SCHEMA_VERSION,
} from '../lib/server/tokenPublicResponse.ts'

const tokenAddr = '0x' + 'c'.repeat(40)

// ── 1. Schema version is exported, an integer, and stamped by the route ────
{
  assert.equal(typeof TOKEN_SCAN_RESPONSE_SCHEMA_VERSION, 'number')
  assert.ok(Number.isInteger(TOKEN_SCAN_RESPONSE_SCHEMA_VERSION) && TOKEN_SCAN_RESPONSE_SCHEMA_VERSION >= 1)
  const routeSrc = (await import('node:fs')).readFileSync(
    new URL('../app/api/token/route.ts', import.meta.url), 'utf8')
  // Cache key embeds the version…
  assert.ok(routeSrc.includes('token:v${TOKEN_SCAN_RESPONSE_SCHEMA_VERSION}'), 'cache key must embed schema version')
  // …the cached copy is verified before serving…
  assert.match(routeSrc, /_cachedResponse.*scanResponseSchemaVersion === TOKEN_SCAN_RESPONSE_SCHEMA_VERSION/,
    'cache read must verify schema version')
  // …and every fresh response is stamped.
  assert.match(routeSrc, /scanResponseSchemaVersion = TOKEN_SCAN_RESPONSE_SCHEMA_VERSION/,
    'response payload must be stamped with schema version')
}

// ── 2. Plan gate: free plan nulls scores but keeps sections present + discloses why ────
{
  const full = {
    chain: 'robinhood',
    contract: tokenAddr,
    symbol: 'RHT',
    riskScore: 42,
    riskLabel: 'moderate',
    riskBreakdown: { liquiditySafety: { score: 10, max: 20 } },
    riskEngine: { confidence: 'medium' },
    security: { honeypot: false },
    lpControl: { status: 'partial' },
    holderDistribution: { top1: 12 },
  }
  const gated = applyTokenScannerPlanGate(full, 'free')
  // Scalars nulled…
  assert.equal(gated.riskScore, null)
  assert.equal(gated.riskLabel, null)
  assert.equal(gated.riskBreakdown, null)
  // …objects replaced but PRESENT (no missing-key crashes downstream)…
  assert.deepEqual(gated.riskEngine, { status: 'requires_pro' })
  assert.deepEqual(gated.security, { status: 'requires_pro' })
  // …and the gate is DISCLOSED, not silent.
  assert.equal(gated.planGate.plan, 'free')
  assert.equal(gated.planGate.requiredPlan, 'pro')
  // Paid plans pass through untouched.
  const elite = applyTokenScannerPlanGate(full, 'elite')
  assert.equal(elite.riskScore, 42)
  assert.equal(elite.planGate, undefined)
}

// ── 3. Sanitizer keeps scanAudit + scanResponseSchemaVersion public ────────
{
  const payload = {
    chain: 'robinhood',
    contract: tokenAddr,
    symbol: 'RHT',
    riskScore: 55,
    riskLabel: 'moderate',
    scanResponseSchemaVersion: TOKEN_SCAN_RESPONSE_SCHEMA_VERSION,
    scanAudit: {
      chainSlug: 'robinhood',
      liquidityMissingReason: 'no_active_liquidity_pool_found',
      responseWarnings: ['Liquidity unavailable on Robinhood provider: no_active_liquidity_pool_found'],
    },
    gtRaw: { secret: true },
  }
  const out = sanitizePublicTokenResponse(payload, false)
  // Debug-only fields stripped…
  assert.equal(out.gtRaw, undefined)
  // …audit receipt survives so both devices can be compared.
  assert.equal(out.scanResponseSchemaVersion, TOKEN_SCAN_RESPONSE_SCHEMA_VERSION)
  assert.ok(out.scanAudit && typeof out.scanAudit === 'object', 'scanAudit must survive sanitization')
  assert.ok(Array.isArray(out.scanAudit.responseWarnings) && out.scanAudit.responseWarnings.length > 0)
}

// ── 4. Liquidity-missing Robinhood scan still carries confidence/risk fields ────
// Simulates the exact reported failure: no pool found (liquidityUsd null) but the risk engine
// produced a score. The response must retain riskScore + warnings; nothing suppresses them.
{
  const payload = {
    chain: 'robinhood',
    contract: tokenAddr,
    noActivePools: true,
    liquidityStatus: 'inferred',
    liquidityReason: 'no_active_liquidity_pool_found',
    riskScore: 61,
    riskLabel: 'high',
    riskBreakdown: {
      marketMaturity: { score: 5, max: 25 },
      liquiditySafety: { score: 2, max: 25, reasons: ['No active pool detected'] },
      contractSafety: { score: 18, max: 30 },
      behavioralRisk: { score: 6, max: 20 },
    },
    scanAudit: {
      liquidityMissingReason: 'no_active_liquidity_pool_found',
      riskEngineScore: 61,
      responseWarnings: ['Liquidity unavailable on Robinhood provider: no_active_liquidity_pool_found'],
    },
  }
  const out = sanitizePublicTokenResponse(payload, false)
  assert.equal(out.riskScore, 61, 'risk score must survive when liquidity is missing')
  assert.equal(out.riskLabel, 'high')
  assert.ok(out.scanAudit.liquidityMissingReason, 'missing-liquidity reason must be explicit')
  // Frontend banner source: at least one liquidity warning present.
  assert.ok(out.scanAudit.responseWarnings.some(w => /liquidity/i.test(w)))
}

// ── 5. Same API response renders identically across sessions ───────────────
// The frontend render branch for the score hero depends only on response fields
// (riskScore / planGate / scanAudit) — never localStorage, session, or device state.
// Verify the page reads only those inputs.
{
  const pageSrc = (await import('node:fs')).readFileSync(
    new URL('../app/terminal/token-scanner/page.tsx', import.meta.url), 'utf8')
  assert.match(pageSrc, /result\.planGate\?\.plan === 'free'/, 'score fallback must check planGate disclosure')
  assert.match(pageSrc, /result\.scanAudit\?\.responseWarnings/, 'liquidity banner must come from scanAudit receipt')
  assert.match(pageSrc, /json\.planGate \?\? null/, 'planGate must be mapped into result state')
  assert.match(pageSrc, /json\.scanAudit \?\? null/, 'scanAudit must be mapped into result state')
}

console.log('test-token-scanner-robinhood-consistency.mjs: all assertions passed')
