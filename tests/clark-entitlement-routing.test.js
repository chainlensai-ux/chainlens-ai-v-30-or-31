import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))
const routeSrc = readFileSync(resolve(__dir, '../app/api/clark/route.ts'), 'utf8')
const basicIntentSrc = readFileSync(resolve(__dir, '../lib/server/clarkBasicIntent.ts'), 'utf8')
const walletRunnerSrc = readFileSync(resolve(__dir, '../lib/server/walletScannerRunner.ts'), 'utf8')

describe('Clark entitlement routing — Elite server-auth guarantees', () => {
  it('/api/clark resolves the Supabase Bearer token server-side before body-driven routing', () => {
    const tokenPos = routeSrc.indexOf("const token = auth.startsWith('Bearer ')")
    const planPos = routeSrc.indexOf('getCurrentUserPlanFromBearerToken(token)')
    const bodyPos = routeSrc.indexOf('body = (await req.json()) as ClarkRequestBody')
    assert.ok(tokenPos >= 0, 'route must read the Authorization Bearer token')
    assert.ok(planPos > tokenPos, 'route must resolve the plan from the bearer token')
    assert.ok(bodyPos > planPos, 'server-side bearer plan resolution must happen before request-body routing')
  })

  it('Clark uses the server-resolved plan instead of trusting a client body plan', () => {
    assert.ok(routeSrc.includes('const effectivePlan'), 'route must derive an effective plan server-side')
    assert.ok(routeSrc.includes('clarkInternalCtx = { authToken: token || undefined, verifiedPlan: effectivePlan'), 'internal Clark context must use the server-resolved effective plan')
    assert.ok(!/body\.(?:plan|userPlan|verifiedPlan)\b/.test(routeSrc), 'route must not read plan/userPlan/verifiedPlan from the client body')
  })

  it('basic Clark answers are answered directly with zero provider calls and debug metadata', () => {
    assert.ok(basicIntentSrc.includes("'greeting'") && basicIntentSrc.includes("'basic_question'"), 'basic intent classifier must include direct-answer intents')
    assert.ok(routeSrc.includes('providerCallsAdded: 0'), 'basic/direct responses must report zero provider calls')
    assert.ok(routeSrc.includes('Answered ${basicIntent} directly with no provider calls.'), 'basic answers must short-circuit instead of routing to providers')
  })

  it('Elite/pro wallet and token routes are unlocked only through the server-resolved verified plan', () => {
    assert.ok(routeSrc.includes("if (p === 'elite' || p === 'pro') return true"), 'planAllows must unlock paid routes for Elite/pro')
    assert.ok(routeSrc.includes("planAllows(verifiedPlan, 'wallet_scan')"), 'wallet routing must check the verified plan')
    assert.ok(routeSrc.includes("planAllows(verifiedPlan, 'token_full_report')"), 'token routing must check the verified plan')
    assert.ok(routeSrc.includes('runWalletScanner'), 'Clark wallet routing must call the wallet scanner runner')
  })

  it('Elite does not unlock admin-only full_recovery or smart_recovery through Clark wallet routing', () => {
    assert.ok(walletRunnerSrc.includes("deepScan?: boolean"), 'Clark wallet runner exposes normal/deep scans, not admin recovery modes')
    assert.ok(!/walletScanMode\s*:\s*['\"](?:full_recovery|smart_recovery)['\"]/.test(routeSrc), 'Clark route must not send admin recovery modes to wallet scanning')
    assert.ok(!/scanMode\s*:\s*['\"](?:full_recovery|smart_recovery)['\"]/.test(routeSrc), 'Clark route must not send admin recovery scanMode values')
  })

  it('routing debug exposes resolved intent, routeUsed, providerCallsAdded, plan aliases, and blockedReason', () => {
    for (const field of ['intent:', 'routeUsed:', 'providerCallsAdded:', 'userPlan:', 'plan:', 'blockedReason:']) {
      assert.ok(routeSrc.includes(field) || basicIntentSrc.includes(field), `debug output must include ${field}`)
    }
    assert.ok(routeSrc.includes('plan_locked:'), 'blocked entitlement responses must include a blockedReason')
  })
})
