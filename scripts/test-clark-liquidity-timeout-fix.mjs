// "Liquidity check AERO" (and any other token symbol/CA) reliability fix — same root-cause
// family as the /holders fix in scripts/test-clark-holders-timeout-fix.mjs: Clark's internal
// calls to /api/liquidity-safety (625 lines, multi-provider, comparable cost to Token Core) and
// /api/resolve (the real DexScreener/GeckoTerminal symbol search "Liquidity check AERO" depends
// on) were both still on callInternalApi's 9s default, and neither route had an explicit
// maxDuration override in vercel.json — the same missing-budget pattern that made /holders
// reliably report "timed out" on a scan that was still correctly in flight.
import fs from 'node:fs'

let passed = 0
let failed = 0
function check(label, cond) {
  if (cond) { passed++ } else { failed++; console.error(`FAIL: ${label}`) }
}

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const routeSrc = read('../app/api/clark/route.ts')
const vercelJson = JSON.parse(read('../vercel.json'))

console.log('\nSection 1: Clark now gives /api/liquidity-safety and /api/resolve real, adequate timeouts')
{
  const liqMatch = routeSrc.match(/const CLARK_LIQUIDITY_SOURCE_TIMEOUT_MS = (\d+);/)
  const resolveMatch = routeSrc.match(/const CLARK_RESOLVE_SOURCE_TIMEOUT_MS = (\d+);/)
  check('CLARK_LIQUIDITY_SOURCE_TIMEOUT_MS constant exists', Boolean(liqMatch))
  check('CLARK_RESOLVE_SOURCE_TIMEOUT_MS constant exists', Boolean(resolveMatch))
  const liqTimeoutMs = liqMatch ? Number(liqMatch[1]) : 0
  const resolveTimeoutMs = resolveMatch ? Number(resolveMatch[1]) : 0
  check('liquidity-safety timeout now well exceeds the old 9s default (real 625-line multi-provider route)', liqTimeoutMs >= 15000)
  check('resolve timeout now exceeds the old 9s default (real DexScreener/GeckoTerminal search)', resolveTimeoutMs >= 10000)
}

console.log('\nSection 2: every /api/liquidity-safety call site in Clark uses the fixed timeout (no call site left on the old 9s default)')
{
  const liquidityCallSites = [...routeSrc.matchAll(/callInternalApi\([^)]*"\/api\/liquidity-safety"[^)]*\)/g)].map((m) => m[0])
  check('at least 4 /api/liquidity-safety call sites found (liquidity_analyze tool, THIS_LIQ follow-up, liquidity_scan primary, lp-lock-check follow-up)', liquidityCallSites.length >= 4)
  for (const site of liquidityCallSites) {
    check(`call site uses CLARK_LIQUIDITY_SOURCE_TIMEOUT_MS: ${site.slice(0, 60)}...`, site.includes('CLARK_LIQUIDITY_SOURCE_TIMEOUT_MS'))
  }
}

console.log('\nSection 3: the one /api/resolve call site (symbol resolution for AERO and every other bare symbol) uses the fixed timeout')
{
  check('resolveTokenSymbolToAddress calls /api/resolve with CLARK_RESOLVE_SOURCE_TIMEOUT_MS', /callInternalApi\(origin, "\/api\/resolve", \{ query: sym, chain: prefer \}, authHeader \?\? undefined, verifiedPlan, CLARK_RESOLVE_SOURCE_TIMEOUT_MS\)/.test(routeSrc))
}

console.log('\nSection 4: Solana liquidity checks (any Solana CA, not just EVM) get the same real budget as Token Core')
{
  const solanaLiquiditySites = [...routeSrc.matchAll(/fetchSolanaLiquidity: async \(mint\) => \{\s*\n\s*const tokRes = await callInternalApi\(origin, "\/api\/token", \{ contract: mint, chain: "solana" \}, authHeader \?\? undefined, verifiedPlan(, TOKEN_CORE_TIMEOUT_MS)?\)/g)]
  check('at least 2 fetchSolanaLiquidity call sites found (liquidity_scan primary + lp-lock-check follow-up)', solanaLiquiditySites.length >= 2)
  for (const m of solanaLiquiditySites) {
    check('fetchSolanaLiquidity uses TOKEN_CORE_TIMEOUT_MS, not the 9s default', Boolean(m[1]))
  }
}

console.log('\nSection 5: the underlying routes are provisioned with real platform-level duration budgets')
{
  const liqMax = vercelJson.functions?.['app/api/liquidity-safety/route.ts']?.maxDuration
  const resolveMax = vercelJson.functions?.['app/api/resolve/route.ts']?.maxDuration
  check('app/api/liquidity-safety/route.ts has an explicit maxDuration (previously unconfigured)', typeof liqMax === 'number' && liqMax >= 30)
  check('app/api/resolve/route.ts has an explicit maxDuration (previously unconfigured)', typeof resolveMax === 'number' && resolveMax >= 15)

  const liqTimeoutMs = Number(routeSrc.match(/const CLARK_LIQUIDITY_SOURCE_TIMEOUT_MS = (\d+);/)?.[1] ?? 0)
  const resolveTimeoutMs = Number(routeSrc.match(/const CLARK_RESOLVE_SOURCE_TIMEOUT_MS = (\d+);/)?.[1] ?? 0)
  check('Clark internal liquidity timeout never exceeds the route\'s own platform budget (no self-defeating config)', liqTimeoutMs <= liqMax * 1000)
  check('Clark internal resolve timeout never exceeds the route\'s own platform budget (no self-defeating config)', resolveTimeoutMs <= resolveMax * 1000)

  const clarkMax = vercelJson.functions?.['app/api/clark/route.ts']?.maxDuration
  check('the Clark route itself still has enough platform duration to cover a full resolve + liquidity-safety round trip', typeof clarkMax === 'number' && clarkMax * 1000 >= liqTimeoutMs + resolveTimeoutMs)
}

console.log('\nSection 6: "Liquidity check AERO" and any other symbol/CA go through the same honest, non-fabricating resolution path')
{
  check('a bare EVM address is resolved directly, never round-tripped through /api/resolve unnecessarily', /if \(\/\^0x\[a-fA-F0-9\]\{40\}\$\/\.test\(sym\.trim\(\)\)\) return \{ address: sym\.trim\(\)/.test(routeSrc))
  check('a Solana mint is resolved directly too', /if \(isValidSolanaMintAddress\(sym\.trim\(\)\)\) return \{ address: sym\.trim\(\), name: sym, symbol: sym, status: "resolved", confidence: "high", chain: "solana"/.test(routeSrc))
  check('an ambiguous symbol (matches on more than one chain) asks the user instead of guessing', /return \{ address: "", name: sym, symbol: sym\.toUpperCase\(\), status: "ambiguous", matches: uniqueExact, matchesCount: uniqueExact\.length \}/.test(routeSrc))
  check('a timed-out resolve is reported honestly as timed_out, never silently treated as not_found', /status: "timed_out", matchesCount: 0/.test(routeSrc))
  check('liquidity_scan honestly rejects a chain Liquidity Safety does not cover instead of silently defaulting', /Liquidity Safety doesn't have full \$\{chainDisplayLabel\(chainForClarkTools\)\} support yet — it currently covers Base, Ethereum, Robinhood, and Solana\./.test(routeSrc))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
