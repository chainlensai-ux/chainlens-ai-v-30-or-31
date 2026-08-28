import assert from 'node:assert/strict'
import fs from 'node:fs'

// ALWAYS-SAME-DEPLOYER FIX, DISCLOSED.
//
// Live report: "for every fcking token i say check deployer its this same blue bull" — on the
// Dashboard's Clark widget (components/ClarkRadar.tsx), a bare "check deployer"/"who deployed
// this" always answered from one old, unrelated token no matter what the user had actually just
// scanned in Token Scanner.
//
// Root cause: THIS_DEV_RE's target resolution (app/api/clark/route.ts) only ever checked
// sessionMem.lastToken (server-side memory, wiped on any serverless cold start) and
// clientContext.lastToken (only ever written when Clark itself last ran a token_scan/token_safety
// intent) — never appContext.tokenSummary/currentTokenAddress, the mechanism the full
// /terminal/clark-ai page already uses to learn about a token scanned directly through Token
// Scanner's own UI with no Clark chat turn at all. Compounding it, the Dashboard widget never sent
// appContext.tokenSummary in the first place, unlike the full Clark AI page.

const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
const routeCode = routeSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
const radarSrc = fs.readFileSync(new URL('../components/ClarkRadar.tsx', import.meta.url), 'utf8')

// THIS_DEV_RE's target resolution must fall back through appContext, same ordering already
// established elsewhere in this file ("session memory > appContext.tokenSummary").
assert.match(
  routeCode,
  /const target = sessionMem\.lastToken\?\.address\s*\n\s*\?\? body\.clientContext\?\.lastToken\?\.address\s*\n\s*\?\? body\.appContext\?\.tokenSummary\?\.address\s*\n\s*\?\? body\.appContext\?\.currentTokenAddress\s*\n\s*\?\? null;/,
  'THIS_DEV_RE\'s address-less deployer branch must fall back to appContext.tokenSummary/currentTokenAddress, not just server/client memory'
)

// The Dashboard widget must send the same Token-Scanner-scanned token summary the full Clark AI
// page already reads from localStorage, as appContext — the exact field name the server checks.
assert.match(radarSrc, /localStorage\.getItem\('chainlens:clark:lastTokenSummary'\)/, 'ClarkRadar must read Token Scanner\'s last-scan summary out of localStorage')
assert.match(radarSrc, /appContext:\s*\{\s*tokenSummary,\s*currentTokenAddress:/, 'ClarkRadar must forward the token summary as appContext.tokenSummary/currentTokenAddress on every Clark request')

console.log('test-clark-deployer-context-fallback.mjs: all assertions passed')
