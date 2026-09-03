import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const pricing = readFileSync(new URL('../app/pricing/page.tsx', import.meta.url), 'utf8')
const homepage = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8')
const planConfig = readFileSync(new URL('../lib/pricingPlans.ts', import.meta.url), 'utf8')

// CARD/PAYPAL, DISCLOSED (checkout audit, updated per explicit instruction to use PayPal's own card
// option): Card and PayPal intentionally hit the same real PayPal Subscriptions endpoint — PayPal's
// hosted checkout page can present a real card-entry form to a guest payer instead of forcing login,
// but only once Guest Checkout is enabled on the live PayPal Business account (an account-level
// setting this code cannot control — see CARD_CHECKOUT_AVAILABLE's own comment in
// lib/pricingPlans.ts). This file previously asserted an intermediate design (Card pointed at its
// own always-503 route) that was reverted per that explicit instruction.
assert.match(planConfig, /export const pricingPlans: PricingPlan\[\] = \[/)
for (const field of ['id', 'name', 'priceMonthly', 'cryptoCheckoutUrl', 'paypalCheckoutUrl', 'cardCheckoutUrl', 'features', 'limits']) {
  assert.match(planConfig, new RegExp(`\\b${field}:`), `pricingPlans must include ${field}`)
}
assert.match(planConfig, /cryptoCheckoutUrl: '\/api\/checkout\/crypto'/)
assert.match(planConfig, /paypalCheckoutUrl: '\/api\/paypal\/create-subscription'/, 'PayPal must use the real PayPal Subscriptions endpoint')
assert.match(planConfig, /cardCheckoutUrl: '\/api\/paypal\/create-subscription'/, 'Card must run the same real PayPal Subscriptions flow, per explicit instruction')
assert.match(planConfig, /export const CARD_CHECKOUT_AVAILABLE = true/, 'Card routing must be marked available now that it runs the real PayPal flow')
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

console.log('\nSection: three real payment options — PayPal, Crypto, and Card (via PayPal checkout)')
assert.match(pricing, /'Opening checkout…' : 'PayPal'/, 'PayPal option must read PayPal')
assert.match(pricing, /Pay monthly with PayPal/)
assert.match(pricing, /'Opening checkout…' : 'Crypto'/, 'crypto option must read Crypto')
assert.match(pricing, /Pay with USDC\/ETH on Base/)
assert.match(pricing, /'Opening checkout…' : 'Card'/, 'Card option must read Card and be a real, clickable option')
assert.match(pricing, /Pay by card via PayPal checkout/, 'Card copy must honestly say it runs through PayPal checkout')
assert.doesNotMatch(pricing, /Secure card checkout/, 'must not claim Card is an independent secure checkout provider')
assert.doesNotMatch(pricing, /Card checkout coming soon/, 'Card must not be shown as unavailable now that it is wired to the real flow')

console.log('\nSection: checkout routing — all three options can fire a real checkout request')
assert.match(pricing, /startCheckout\(selectedPlanId, 'paypal'\)/)
assert.match(pricing, /startCheckout\(selectedPlanId, 'crypto'\)/)
assert.match(pricing, /startCheckout\(selectedPlanId, 'card'\)/, 'the Card button must be wired to fire a real checkout request')
assert.match(pricing, /if \(paymentMethod === 'card' && !CARD_CHECKOUT_AVAILABLE\) return/, 'startCheckout keeps a defense-in-depth guard in case CARD_CHECKOUT_AVAILABLE is ever flipped back off')
assert.match(pricing, /disabled=\{checkoutLoading !== null \|\| !CARD_CHECKOUT_AVAILABLE\}/, 'Card is only disabled by the shared availability flag, never hardcoded')
assert.match(pricing, /paymentMethod === 'crypto' \? plan\?\.cryptoCheckoutUrl\s*\n\s*: paymentMethod === 'paypal' \? plan\?\.paypalCheckoutUrl\s*\n\s*: plan\?\.cardCheckoutUrl/)
assert.match(pricing, /method: paymentMethod/, 'an audit-only method field must be sent so the server can tell Card and PayPal clicks apart')
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
