import assert from 'node:assert/strict'
import fs from 'node:fs'

const pricing = fs.readFileSync(new URL('../app/pricing/page.tsx', import.meta.url), 'utf8')
const home = fs.readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8')
const navbar = fs.readFileSync(new URL('../components/Navbar.tsx', import.meta.url), 'utf8')
const clarkCfg = fs.readFileSync(new URL('../app/terminal/clark-ai/clarkAiPageConfig.ts', import.meta.url), 'utf8')
const clarkRoute = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
const planFeatures = fs.readFileSync(new URL('../lib/planFeatures.ts', import.meta.url), 'utf8')

assert.match(clarkCfg, /CLARK_DAILY_LIMITS: Record<string, number> = \{ free: 5, pro: 50, elite: 300 \}/)
assert.match(clarkRoute, /CLARK_DAILY_BY_PLAN: Record<string, number> = \{ free: 5, pro: 50, elite: 300, unauth: 3 \}/)

for (const src of [pricing, home, navbar]) {
  assert.match(src, /5 prompts/)
  assert.match(src, /50 prompts/)
  assert.match(src, /300 prompts/)
  assert.doesNotMatch(src, /unlimited prompts/i)
  assert.doesNotMatch(src, /Unlimited Clark/i)
  assert.doesNotMatch(src, /Priority CORTEX/)
  assert.doesNotMatch(src, /Early access to new/)
  assert.doesNotMatch(src, /Auto Verdicts/)
  assert.doesNotMatch(src, /Best plan for daily Base researchers/)
}

assert.match(pricing, /Token Scanner — basic market data and liquidity depth/)
assert.match(pricing, /Token Scanner — full token, liquidity, LP, holder, security, tax, and dev-risk analysis/)
assert.match(pricing, /Liquidity Safety/)
assert.match(pricing, /Dev Wallet Detector/)
assert.match(pricing, /Faster whale-alert sync than Pro/)
assert.match(pricing, /No Portfolio/)
assert.match(planFeatures, /'token-scanner-basic':\s+\['free', 'pro', 'elite'\]/)
assert.match(planFeatures, /'wallet-scanner':\s+\['pro', 'elite'\]/)
assert.match(planFeatures, /'liquidity-safety':\s+\['pro', 'elite'\]/)

console.log('test-pricing-plan-offerings.mjs: all assertions passed')
