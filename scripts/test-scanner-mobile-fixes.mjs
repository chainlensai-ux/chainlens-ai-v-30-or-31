// Fixes for: (1) Solana Token Scanner scans failing with "unauthorized", (2) pricing page mobile
// scroll getting stuck before reaching the plan buttons, (3) Pump Alerts' Clark-preview text being
// clipped/invisible on mobile (a hover-only reveal with no touch equivalent).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

let passed = 0
function check(label, cond) { assert.ok(cond, label); passed++ }

const tokenScannerSrc = readFileSync(new URL('../app/terminal/token-scanner/page.tsx', import.meta.url), 'utf8')
const pricingSrc = readFileSync(new URL('../app/pricing/page.tsx', import.meta.url), 'utf8')
const pumpAlertsSrc = readFileSync(new URL('../app/terminal/pump-alerts/page.tsx', import.meta.url), 'utf8')

console.log('\nSection 1: Solana Token Scanner scan/deep-check calls attach the session auth token (/api/token requires one)')
{
  const solanaScanBlock = tokenScannerSrc.slice(
    tokenScannerSrc.indexOf("if (effectiveChain === 'solana') {"),
    tokenScannerSrc.indexOf("if (effectiveChain === 'solana') {") + 1500,
  )
  check('main Solana scan path reads the Supabase session before calling /api/token', /supabase\.auth\.getSession\(\)/.test(solanaScanBlock))
  check('main Solana scan path sends an Authorization header when a token exists', /Authorization: `Bearer \$\{_tok\}`/.test(solanaScanBlock))

  const deepCreatorBlock = tokenScannerSrc.slice(
    tokenScannerSrc.indexOf('async function runSolanaDeepCreatorCheck'),
    tokenScannerSrc.indexOf('async function runSolanaDeepCreatorCheck') + 1500,
  )
  check('Solana Deep Creator Check attaches the auth token too', /Authorization: `Bearer \$\{_tok\}`/.test(deepCreatorBlock))

  const deepClusterBlock = tokenScannerSrc.slice(
    tokenScannerSrc.indexOf('async function runSolanaDeepClusterCheck'),
    tokenScannerSrc.indexOf('async function runSolanaDeepClusterCheck') + 1500,
  )
  check('Solana Deep Cluster Check attaches the auth token too', /Authorization: `Bearer \$\{_tok\}`/.test(deepClusterBlock))
}

console.log('\nSection 2: pricing page no longer runs its own nested scroll container fighting the page scroll')
{
  check('root wrapper no longer sets its own overflowY (was competing with the document\'s own scroll on mobile)', !/minHeight: '100vh'[\s\S]{0,40}overflowY: 'auto'/.test(pricingSrc))
  check('root wrapper uses 100dvh so min-height tracks the real visible viewport, not the address-bar-inclusive one', /minHeight: '100dvh'/.test(pricingSrc))
  check('overflowX stays clipped (still needed for the decorative background arcs/blobs)', /overflowX: 'hidden'/.test(pricingSrc))
}

console.log('\nSection 3: Pump Alerts\' Clark-preview block is no longer hover-only on touch devices')
{
  check('a coarse-pointer (touch) override exists for .pump-clark-preview', /@media \(pointer: coarse\)[\s\S]{0,20}\.pump-clark-preview/.test(pumpAlertsSrc))
  check('touch devices always show the full block (no hover-gated max-height/opacity/overflow clipping)', /\.pump-clark-preview \{ max-height: none !important; opacity: 1 !important; overflow: visible !important;/.test(pumpAlertsSrc))
  check('the original desktop hover-reveal styling is untouched (still a real interaction on mouse devices)', /\.pump-clark-preview \{ max-height: 0; opacity: 0; overflow: hidden;/.test(pumpAlertsSrc))
}

console.log(`\n${passed} assertions passed`)
