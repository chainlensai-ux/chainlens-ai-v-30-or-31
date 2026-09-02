import assert from 'node:assert/strict'
import fs from 'node:fs'

const pricing = fs.readFileSync(new URL('../app/pricing/page.tsx', import.meta.url), 'utf8')
const home = fs.readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8')
const navbar = fs.readFileSync(new URL('../components/Navbar.tsx', import.meta.url), 'utf8')
const clarkCfg = fs.readFileSync(new URL('../app/terminal/clark-ai/clarkAiPageConfig.ts', import.meta.url), 'utf8')
const clarkRoute = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
const clarkChat = fs.readFileSync(new URL('../components/ClarkChat.tsx', import.meta.url), 'utf8')
const planFeatures = fs.readFileSync(new URL('../lib/planFeatures.ts', import.meta.url), 'utf8')
const faq = fs.readFileSync(new URL('../components/FAQAccordion.tsx', import.meta.url), 'utf8')
const tokenGate = fs.readFileSync(new URL('../lib/server/tokenPublicResponse.ts', import.meta.url), 'utf8')
const tokenPage = fs.readFileSync(new URL('../app/terminal/token-scanner/page.tsx', import.meta.url), 'utf8')

const { pricingPlans, CLARK_DAILY_LIMITS, SCAN_DAILY_LIMITS, clarkPlanAllows, canAccessFeature, PLAN_TOOL_NAV, planFaqWhatIsIncluded, planFaqClarkLimits } = await import('../lib/pricingPlans.ts')

assert.equal(CLARK_DAILY_LIMITS.free, 3)
assert.equal(CLARK_DAILY_LIMITS.pro, 50)
assert.equal(CLARK_DAILY_LIMITS.elite, 300)
assert.equal(SCAN_DAILY_LIMITS.free, 3)

assert.ok(clarkCfg.includes("from '@/lib/pricingPlans'") || clarkCfg.includes('from "@/lib/pricingPlans"'))
assert.ok(clarkRoute.includes('CLARK_DAILY_BY_PLAN'))
assert.ok(clarkChat.includes('CLARK_DAILY_LIMITS'))
assert.ok(planFeatures.includes("from './pricingPlans'"))

const free = pricingPlans.find((p) => p.id === 'free')
const pro = pricingPlans.find((p) => p.id === 'pro')
const elite = pricingPlans.find((p) => p.id === 'elite')
assert.ok(free && pro && elite)
assert.ok(free.features.some((f) => /3 full scans per day/i.test(f)))
assert.ok(free.features.some((f) => /Clark AI — 3 prompts per day/i.test(f)))
assert.ok(free.features.some((f) => /Watchlist/i.test(f)))
assert.ok(free.features.some((f) => /Basic Wallet Scanner/i.test(f)))
assert.ok(free.features.some((f) => /Portfolio Intelligence/i.test(f)))
assert.ok(free.features.some((f) => /Token Scanner — market, holders, LP Safety, Risk Engine, and dev checks/i.test(f)))
assert.ok(pro.features.some((f) => /Clark AI — 50 prompts per day/i.test(f)))
assert.ok(elite.features.some((f) => /Clark AI — 300 prompts per day/i.test(f)))

const pricingCopy = [pricing, home.slice(Math.max(0, home.indexOf('Cards — wrap')), Math.max(0, home.indexOf('Cards — wrap')) + 12000), faq]
for (const src of pricingCopy) {
  assert.doesNotMatch(src, /Whale Alerts/)
  assert.doesNotMatch(src, /Pump Alerts/)
  assert.doesNotMatch(src, /whale-alert/i)
  assert.doesNotMatch(src, /Dev Wallet Detector/)
}
for (const plan of pricingPlans) {
  for (const f of plan.features) {
    assert.doesNotMatch(f, /Whale/i)
    assert.doesNotMatch(f, /Pump Alert/i)
    assert.doesNotMatch(f, /Dev Wallet Detector/i)
  }
}
for (const col of PLAN_TOOL_NAV) {
  for (const t of col.tools) {
    assert.doesNotMatch(t.name, /Whale|Pump Alert|Dev Wallet Detector|Liquidity Safety/)
  }
}

assert.match(pricing, /pricingPlans\.map/)
assert.match(pricing, /PRICING_PROOF\.map/)
assert.doesNotMatch(pricing, /No Wallet Scanner/)
assert.doesNotMatch(pricing, /No Portfolio/)
assert.doesNotMatch(pricing, /Upgrade to continue/)
assert.doesNotMatch(pricing, /Loading plan/)
assert.match(pricing, /overflowX: 'hidden'/)
assert.match(pricing, /auto-fit,minmax\(280px,1fr\)/)
assert.doesNotMatch(pricing, /repeat\(3,minmax\(0,1fr\)\)/)
assert.match(pricing, /useState<UserPlan \| null>\(\(\) => peekCachedPlan\(\)\)/)
assert.match(pricing, /useState\(\(\) => peekCachedPlan\(\) != null\)/)
assert.doesNotMatch(pricing, /!planReady \? \(/)

const lpStandalone = /^\s*['"]?Liquidity Safety['"]?\s*$/m
assert.doesNotMatch(pricing, lpStandalone)
assert.ok(free.features.filter((f) => f === 'Liquidity Safety' || f === 'LP Safety').length === 0, 'LP Safety must not be a standalone Free feature')
assert.ok(free.features.some((f) => /Token Scanner/.test(f) && /LP Safety/.test(f)))

assert.equal(canAccessFeature('free', 'watchlist'), true)
assert.equal(canAccessFeature('free', 'wallet-scanner'), true)
assert.equal(canAccessFeature('free', 'portfolio'), true)
assert.equal(canAccessFeature('free', 'token-scanner-full'), true)
assert.equal(canAccessFeature('free', 'base-radar'), false)
assert.equal(clarkPlanAllows('free', 'token_full_report'), true)
assert.equal(clarkPlanAllows('free', 'wallet_scan'), true)
assert.equal(clarkPlanAllows('free', 'liquidity_check'), true)
assert.equal(clarkPlanAllows('free', 'dev_wallet'), true)
assert.equal(clarkPlanAllows('free', 'whale_alerts'), false)
assert.equal(clarkPlanAllows('free', 'base_radar_full'), false)

assert.doesNotMatch(clarkRoute, /Upgrade to Pro to run wallet\/dev\/liquidity reports/)
assert.match(clarkRoute, /clarkPlanAllows/)
assert.doesNotMatch(tokenGate, /requires_pro/)
assert.doesNotMatch(tokenPage, /Risk Score requires Pro/)
assert.doesNotMatch(tokenPage, /Upgrade to continue/)
assert.doesNotMatch(pricing, /Upgrade to continue/)
assert.doesNotMatch(navbar, /Upgrade to continue/)

assert.match(navbar, /PLAN_TOOL_NAV as TIER_COLUMNS/)
assert.match(navbar, /planLoading && !plan \? 'CHECKING PLAN/)
assert.doesNotMatch(navbar, /Loading plan/)
assert.match(faq, /planFaqWhatIsIncluded/)
assert.match(faq, /planFaqClarkLimits/)
assert.match(planFaqWhatIsIncluded(), /Clark AI at 3 prompts per day/)
assert.match(planFaqWhatIsIncluded(), /Clark AI at 50 prompts per day/)
assert.match(planFaqWhatIsIncluded(), /Clark AI at 300 prompts per day/)
assert.match(planFaqClarkLimits(), /Free gets 3/)
assert.match(planFaqClarkLimits(), /Pro gets 50/)
assert.match(planFaqClarkLimits(), /Elite gets 300/)
assert.doesNotMatch(faq, /GhostTrade/)
assert.doesNotMatch(faq, /DipRadar/)
assert.doesNotMatch(faq, /ProofVault/)

const about = fs.readFileSync(new URL('../app/about/page.tsx', import.meta.url), 'utf8')
assert.doesNotMatch(about, /Smart money tracking/)
assert.doesNotMatch(about, /Smart money pattern detection/)

const { consumeDailyScan, __resetScanQuotaForTest } = await import('../lib/scanQuota.ts')
__resetScanQuotaForTest()
assert.equal(consumeDailyScan('free', 't1').allowed, true)
assert.equal(consumeDailyScan('free', 't1').allowed, true)
const third = consumeDailyScan('free', 't1')
assert.equal(third.allowed, true)
assert.equal(third.remaining, 0)
assert.equal(consumeDailyScan('free', 't1').allowed, false)
assert.equal(consumeDailyScan('pro', 't1').allowed, true)

console.log('test-pricing-plan-offerings.mjs: all assertions passed')
