import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const pricing = readFileSync(new URL('../app/pricing/page.tsx', import.meta.url), 'utf8')
const planConfig = readFileSync(new URL('../lib/pricingPlans.ts', import.meta.url), 'utf8')

assert.match(planConfig, /export const pricingPlans: PricingPlan\[\] = \[/)
for (const field of ['id', 'name', 'priceMonthly', 'cryptoCheckoutUrl', 'cardCheckoutUrl', 'features', 'limits']) {
  assert.match(planConfig, new RegExp(`\\b${field}:`), `pricingPlans must include ${field}`)
}
assert.match(planConfig, /cryptoCheckoutUrl: '\/api\/checkout\/crypto'/)
assert.match(planConfig, /cardCheckoutUrl: '\/api\/paypal\/create-subscription'/)
assert.match(pricing, /import \{ pricingPlans, PRICING_PROOF \} from '@\/lib\/pricingPlans'/)

assert.match(pricing, /async function handleFreeCta\(\)/)
assert.match(pricing, /if \(!session\?\.access_token\) \{[\s\S]*redirectToAuth\('\/terminal\/token-scanner'\)/)
assert.match(pricing, /window\.location\.href = '\/terminal\/token-scanner'/)

assert.match(pricing, /onClick=\{\(\) => openPaymentModal\(plan\.id as PaidPlanId\)\}/)
assert.match(pricing, /Upgrade to \{plan\.name\}/)
assert.match(pricing, /if \(userPlan === planId\) return/)
assert.match(pricing, /✓ Current Plan/)
assert.doesNotMatch(pricing, /cta-split-row/)

assert.match(pricing, /role='dialog'/)
assert.match(pricing, /aria-modal='true'/)
assert.match(pricing, /event\.key === 'Escape'/)
assert.match(pricing, /event\.target === event\.currentTarget/)
// UPDATED, DISCLOSED (pricing card CTA task): the card CTA now commits to a plan
// ("Upgrade to Pro"/"Upgrade to Elite", checked above) BEFORE this modal ever opens, so the modal
// itself is scoped to choosing a payment method, not restating the plan — title "Choose payment
// method", subtitle "Select how you want to complete checkout.", and the two option buttons read
// "Crypto"/"Card" (their sub-copy, unchanged, already said what each involves).
assert.match(pricing, /Choose payment method/, 'modal title must read Choose payment method')
assert.match(pricing, /Select how you want to complete checkout\./, 'modal subtitle must read Select how you want to complete checkout.')
assert.doesNotMatch(pricing, /Upgrade to \{selectedPlan\.name\}/, 'the modal title itself must not restate the plan choice')
assert.match(pricing, /'Opening checkout…' : 'Crypto'/, 'crypto option must read Crypto, not Pay with crypto')
assert.match(pricing, /USDC \/ ETH on Base/)
assert.match(pricing, /'Opening checkout…' : 'Card'/, 'card option must read Card, not Pay with card')
assert.match(pricing, /Secure card checkout/)

assert.match(pricing, /startCheckout\(selectedPlanId, 'crypto'\)/)
assert.match(pricing, /startCheckout\(selectedPlanId, 'card'\)/)
assert.match(pricing, /paymentMethod === 'crypto' \? plan\?\.cryptoCheckoutUrl : plan\?\.cardCheckoutUrl/)
assert.match(pricing, /parsedRedirect\.protocol !== 'https:'/)
assert.match(pricing, /Your plan activates only after the payment provider confirms the subscription\./)

assert.match(pricing, /useState<UserPlan \| null>\(\(\) => peekCachedPlan\(\)/)
assert.match(pricing, /useState\(\(\) => peekCachedPlan\(\) != null\)/)
assert.doesNotMatch(pricing, /!planReady \? \(/)
assert.match(pricing, /@media\(max-width:560px\)\{\.payment-overlay\{padding:16px\}/)
assert.match(pricing, /width:min\(620px,100%\)/)
assert.match(pricing, /min-width:0/)

console.log('test-pricing-checkout-flow.mjs: all assertions passed')
