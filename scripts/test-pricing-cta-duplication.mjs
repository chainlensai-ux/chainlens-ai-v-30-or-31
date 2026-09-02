// Pricing card CTA duplication — regression tests.
//
// Diagnosis: app/pricing/page.tsx's own card CTAs and payment-method modal were already fixed to
// "Choose payment method" / Crypto / Card in an earlier pass, but app/page.tsx (the homepage) has
// a SECOND, independent pricing-card implementation — same shared pricingPlans config for
// copy/prices, but its own hardcoded per-plan `cta` label, which still read "Pay with Crypto" for
// Pro and Elite. The CTA has always just linked to /pricing (never triggered checkout directly),
// so this was a stale/duplicated label, not a behavior bug. app/pricing/page.tsx itself also had
// two smaller "Pay with crypto" strings outside the modal (a hero trust-chip, and a disclosure
// paragraph) that duplicated the banned phrase and named a specific payment method outside the
// modal, contrary to "payment method text belongs only inside modal".
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const homeSrc = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8')
const pricingSrc = readFileSync(new URL('../app/pricing/page.tsx', import.meta.url), 'utf8')

let passed = 0
let failed = 0
function check(label, cond) {
  if (cond) { passed++ }
  else { failed++; console.error(`  ❌ FAIL: ${label}`) }
}

console.log('Section A: homepage pricing cards choose the plan, not the payment method')
check('homepage Pro CTA reads "Upgrade to Pro"', homeSrc.includes("cta: 'Upgrade to Pro'"))
check('homepage Elite CTA reads "Upgrade to Elite"', homeSrc.includes("cta: 'Upgrade to Elite'"))
check('homepage Free CTA reads "Get Started"', homeSrc.includes("cta: 'Get Started'"))
check('homepage CTA still links to /pricing (unchanged behavior — copy-only fix)', /<Link href="\/pricing" className=\{`cta-\$\{plan\.ctaStyle\}`\}/.test(homeSrc))

console.log('\nSection B: /pricing page cards choose the plan, not the payment method')
check('/pricing Pro/Elite CTA reads "Upgrade to {plan.name}"', pricingSrc.includes('Upgrade to {plan.name}'))
check('/pricing Free CTA reads "Get Started"', /Get Started/.test(pricingSrc))
check('/pricing shows "✓ Current Plan" when already on that plan', pricingSrc.includes('✓ Current Plan'))

console.log('\nSection C: payment method text lives only inside the modal (Crypto / Card)')
check('the modal title reads "Choose payment method"', pricingSrc.includes('Choose payment method'))
check('the modal subtitle reads "Select how you want to complete checkout."', pricingSrc.includes('Select how you want to complete checkout.'))
check('the crypto option reads "Crypto"', /'Opening checkout…' : 'Crypto'/.test(pricingSrc))
check('the card option reads "Card"', /'Opening checkout…' : 'Card'/.test(pricingSrc))

console.log('\nSection D: no live "Pay with Crypto" / "PAY WITH CRYPTO" / "pay with crypto" text renders anywhere')
// Matches the exact single-quoted string-literal shape source code would use for a rendered
// value (`'Pay with Crypto'` / `'Pay with crypto'` / `'PAY WITH CRYPTO'`) — deliberately does not
// flag a double-quoted mention inside an explanatory disclosure comment, which is source
// documentation, not rendered UI text.
const bannedLiteral = /'Pay with [Cc]rypto'|'PAY WITH CRYPTO'/
check('app/page.tsx renders no "Pay with Crypto" string literal', !bannedLiteral.test(homeSrc))
check('app/pricing/page.tsx renders no "Pay with Crypto" string literal', !bannedLiteral.test(pricingSrc))
// The two known-fixed spots specifically: the hero trust-chip and the payment-method disclosure.
check('the hero trust-chip no longer names a specific payment method', pricingSrc.includes("'Secure checkout'") && !pricingSrc.includes("'Pay with crypto'"))
check('the payment-method disclosure paragraph is neutral, not "Pay with crypto."', pricingSrc.includes('Choose crypto or card at checkout.'))

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
