import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const pricing = readFileSync(new URL('../app/pricing/page.tsx', import.meta.url), 'utf8')
const homepage = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8')
const planConfig = readFileSync(new URL('../lib/pricingPlans.ts', import.meta.url), 'utf8')

// CARD/PAYPAL FIX, DISCLOSED (checkout audit): cardCheckoutUrl and paypalCheckoutUrl are now
// genuinely distinct endpoints — previously both fields pointed at the same PayPal Subscriptions
// route, which is why clicking "Card" silently ran the PayPal flow and redirected to PayPal's
// hosted login page. This file's old assertions locked in that exact bug (asserting
// cardCheckoutUrl === '/api/paypal/create-subscription' and a "Card" option labelled "Secure card
// checkout") and are rewritten below to assert the fix instead.
assert.match(planConfig, /export const pricingPlans: PricingPlan\[\] = \[/)
for (const field of ['id', 'name', 'priceMonthly', 'cryptoCheckoutUrl', 'paypalCheckoutUrl', 'cardCheckoutUrl', 'features', 'limits']) {
  assert.match(planConfig, new RegExp(`\\b${field}:`), `pricingPlans must include ${field}`)
}
assert.match(planConfig, /cryptoCheckoutUrl: '\/api\/checkout\/crypto'/)
assert.match(planConfig, /paypalCheckoutUrl: '\/api\/paypal\/create-subscription'/, 'PayPal must use the real PayPal Subscriptions endpoint')
assert.match(planConfig, /cardCheckoutUrl: '\/api\/checkout\/card'/, 'Card must use its own distinct endpoint, never the PayPal one')
assert.doesNotMatch(planConfig, /cardCheckoutUrl: '\/api\/paypal\/create-subscription'/, 'Card must never alias the PayPal endpoint again')
assert.match(planConfig, /export const CARD_CHECKOUT_AVAILABLE = false/, 'Card must not claim to be available until a real provider is wired')
assert.match(pricing, /import \{ pricingPlans, PRICING_PROOF, CARD_CHECKOUT_AVAILABLE \} from '@\/lib\/pricingPlans'/)

assert.match(pricing, /async function handleFreeCta\(\)/)
assert.match(pricing, /if \(!session\?\.access_token\) \{[\s\S]*redirectToAuth\('\/terminal\/token-scanner'\)/)
assert.match(pricing, /window\.location\.href = '\/terminal\/token-scanner'/)

assert.match(pricing, /onClick=\{\(\) => openPaymentModal\(plan\.id as PaidPlanId\)\}/)
assert.match(pricing, /Upgrade to \{plan\.name\}/, 'pricing card CTA must read "Upgrade to Pro"/"Upgrade to Elite"')
assert.match(pricing, /if \(userPlan === planId\) return/)
assert.match(pricing, /✓ Current Plan/)
assert.doesNotMatch(pricing, /cta-split-row/)

assert.match(pricing, /role='dialog'/)
assert.match(pricing, /aria-modal='true'/)
assert.match(pricing, /event\.key === 'Escape'/)
assert.match(pricing, /event\.target === event\.currentTarget/)
assert.match(pricing, /Choose payment method/, 'modal title must read Choose payment method')
assert.match(pricing, /Select how you want to complete checkout\./, 'modal subtitle must read Select how you want to complete checkout.')
assert.doesNotMatch(pricing, /Upgrade to \{selectedPlan\.name\}/, 'the modal title itself must not restate the plan choice')

console.log('\nSection: three genuinely distinct payment options — PayPal, Crypto, Card (disabled)')
assert.match(pricing, /'Opening checkout…' : 'PayPal'/, 'PayPal option must read PayPal, not Card')
assert.match(pricing, /Pay monthly with PayPal/)
assert.match(pricing, /'Opening checkout…' : 'Crypto'/, 'crypto option must read Crypto')
assert.match(pricing, /Pay with USDC\/ETH on Base/)
assert.match(pricing, />Card<\/span>/, 'a disabled Card option must still be visible, not hidden')
assert.match(pricing, /Card checkout coming soon/, 'Card must show a clear "coming soon" reason, never pretend to work')
assert.doesNotMatch(pricing, /Secure card checkout/, 'must not claim Card is a working secure checkout')

console.log('\nSection: checkout routing — PayPal and Crypto are real, Card never fires a request')
assert.match(pricing, /startCheckout\(selectedPlanId, 'paypal'\)/)
assert.match(pricing, /startCheckout\(selectedPlanId, 'crypto'\)/)
assert.doesNotMatch(pricing, /startCheckout\(selectedPlanId, 'card'\)/, 'the disabled Card button must not even wire an onClick that fires a checkout request')
assert.match(pricing, /if \(paymentMethod === 'card' && !CARD_CHECKOUT_AVAILABLE\) return/, 'startCheckout must refuse to run for card while unavailable — defense in depth')
assert.match(pricing, /paymentMethod === 'crypto' \? plan\?\.cryptoCheckoutUrl\s*\n\s*: paymentMethod === 'paypal' \? plan\?\.paypalCheckoutUrl\s*\n\s*: plan\?\.cardCheckoutUrl/)
assert.match(pricing, /parsedRedirect\.protocol !== 'https:'/)
assert.match(pricing, /Your plan activates only after the payment provider confirms the subscription\./)

assert.doesNotMatch(homepage, /cta: 'Pay with Crypto'/)
assert.match(homepage, /cta: 'Get Started'/)
assert.match(homepage, /cta: 'Upgrade to Pro'/)
assert.match(homepage, /cta: 'Upgrade to Elite'/)

assert.match(pricing, /useState<UserPlan \| null>\(\(\) => peekCachedPlan\(\)/)
assert.match(pricing, /useState\(\(\) => peekCachedPlan\(\) != null\)/)
assert.doesNotMatch(pricing, /!planReady \? \(/)
assert.match(pricing, /width:min\(620px,100%\)/)
assert.match(pricing, /min-width:0/)
assert.match(pricing, /grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/, 'modal must lay out three payment options')

console.log('test-pricing-checkout-flow.mjs: all assertions passed')
