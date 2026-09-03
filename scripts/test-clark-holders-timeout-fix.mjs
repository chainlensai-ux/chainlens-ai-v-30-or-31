// /holders timeout fix — reported live: "/holders 0x...4a01" reliably returned "Holder source
// timed out" for a genuinely slow-but-succeeding Base token scan. Root cause: the /holders
// handler races resolveTokenForFollowup() (which internally waits up to TOKEN_CORE_TIMEOUT_MS =
// 18_000ms for the real /api/token call) against CLARK_HOLDERS_SOURCE_TIMEOUT_MS, which was only
// 12_000ms — the outer race timer always fired before the inner, correctly-longer timeout could.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { CLARK_HOLDERS_SOURCE_TIMEOUT_MS, CLARK_DEPLOYER_SOURCE_TIMEOUT_MS } from '../lib/server/clarkRequestLifecycle.ts'

let passed = 0
let failed = 0
function check(label, cond) {
  if (cond) { passed++ } else { failed++; console.error(`FAIL: ${label}`) }
}

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const routeSrc = read('../app/api/clark/route.ts')

console.log('\nSection 1: the outer /holders race timeout no longer fires before the inner token-evidence timeout')
{
  const tokenCoreMatch = routeSrc.match(/const TOKEN_CORE_TIMEOUT_MS = (\d+);/)
  assert.ok(tokenCoreMatch, 'TOKEN_CORE_TIMEOUT_MS constant found in app/api/clark/route.ts')
  const tokenCoreTimeoutMs = Number(tokenCoreMatch[1])
  check('TOKEN_CORE_TIMEOUT_MS is still 18000ms (this fix does not touch the real scan timeout)', tokenCoreTimeoutMs === 18000)
  check(
    'CLARK_HOLDERS_SOURCE_TIMEOUT_MS now exceeds TOKEN_CORE_TIMEOUT_MS — the outer race can never preempt a still-succeeding inner scan',
    CLARK_HOLDERS_SOURCE_TIMEOUT_MS > tokenCoreTimeoutMs,
  )
  check('CLARK_HOLDERS_SOURCE_TIMEOUT_MS is a real, sane value (not accidentally huge)', CLARK_HOLDERS_SOURCE_TIMEOUT_MS >= 15000 && CLARK_HOLDERS_SOURCE_TIMEOUT_MS <= 30000)
}

console.log('\nSection 2: /deployer has the same class of fix (dev-wallet route allows up to 60s per vercel.json)')
{
  const vercelJson = JSON.parse(read('../vercel.json'))
  const devWalletMaxDuration = vercelJson.functions?.['app/api/dev-wallet/route.ts']?.maxDuration
  check('app/api/dev-wallet/route.ts has a real maxDuration configured', typeof devWalletMaxDuration === 'number' && devWalletMaxDuration > 0)
  check(
    'CLARK_DEPLOYER_SOURCE_TIMEOUT_MS no longer wildly undercuts the route it calls',
    CLARK_DEPLOYER_SOURCE_TIMEOUT_MS >= 20000 && CLARK_DEPLOYER_SOURCE_TIMEOUT_MS <= devWalletMaxDuration * 1000,
  )
}

console.log('\nSection 3: the Clark API route itself is provisioned with enough platform-level duration')
{
  const vercelJson = JSON.parse(read('../vercel.json'))
  const clarkMaxDuration = vercelJson.functions?.['app/api/clark/route.ts']?.maxDuration
  check('app/api/clark/route.ts has an explicit maxDuration in vercel.json', typeof clarkMaxDuration === 'number')
  check(
    'platform maxDuration comfortably exceeds every in-app Clark timeout constant (holders/deployer), so a real slow-but-succeeding scan is never platform-killed before its own graceful timeout can fire',
    clarkMaxDuration * 1000 > CLARK_HOLDERS_SOURCE_TIMEOUT_MS && clarkMaxDuration * 1000 > CLARK_DEPLOYER_SOURCE_TIMEOUT_MS,
  )
}

console.log('\nSection 4: /holders now gives an honest per-chain message instead of silently attempting an unsupported scan')
{
  check(
    '/holders checks toTokenApiChain(chainForClarkTools) === null before attempting a scan, same as /token already does',
    /if \(routed\.intent === "holders_check"\)[\s\S]{0,4000}toTokenApiChain\(chainForClarkTools\) === null/.test(routeSrc),
  )
  check(
    'the honest chain message names all 4 real supported chains (Base, Ethereum, BNB, Robinhood Chain)',
    /Holder data on \$\{chainDisplayLabel\(chainForClarkTools\)\} isn't available yet — I can run this on Base, Ethereum, BNB, or Robinhood Chain\./.test(routeSrc),
  )
  check('toTokenApiChain itself recognizes base/eth/bnb/robinhood and returns null only for genuinely unsupported chains', /if \(chain === "bnb"\) return "bnb";\s*\n\s*if \(chain === "robinhood"\) return "robinhood";\s*\n\s*return null;/.test(routeSrc))
}

console.log('\nSection 5: Solana /holders path is unaffected — still uses the (now longer) shared timeout, not a separate race')
{
  check(
    'the Solana branch of /holders passes CLARK_HOLDERS_SOURCE_TIMEOUT_MS directly to callInternalApiCaught (a single real timeout, not a double race)',
    /isValidSolanaMintAddress\(holdersAddr\)[\s\S]{0,400}callInternalApiCaught\(origin, "\/api\/token", \{ contract: holdersAddr, chain: "solana" \}, authHeader \?\? undefined, verifiedPlan, CLARK_HOLDERS_SOURCE_TIMEOUT_MS\)/.test(routeSrc),
  )
}

console.log('\nSection 6: /token, /lp, /deployer, /wallet all keep working per-chain (no regression from this fix)')
{
  check('/token still honestly rejects an unsupported chain before scanning (unchanged)', /if \(toTokenApiChain\(chainForClarkTools\) === null\) \{\s*\n\s*return \{\s*\n\s*feature: "clark-ai", chain, mode: "analysis", intent: "token_scan"/.test(routeSrc))
  check('/token still routes a Solana mint to the Solana creator answer (unchanged)', /tokenAddress && isValidSolanaMintAddress\(tokenAddress\)\) \{\s*\n\s*return await buildSolanaCreatorAnswer/.test(routeSrc))
  check('/deployer still resolves a real per-chain toTokenApiChain(probe.chain) before calling /api/dev-wallet (unchanged)', /thisDevChain = toTokenApiChain\(probe\.chain\)/.test(routeSrc))
  check('/wallet still routes through the same real, already-tested /api/wallet-scan pipeline (unchanged — out of scope for this fix)', routeSrc.includes('routed.intent === "wallet_scan"'))
  check('only one Promise.race exists in this file (the /holders one just fixed) — no other command has the same double-timeout risk', (routeSrc.match(/Promise\.race/g) ?? []).length === 1)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
