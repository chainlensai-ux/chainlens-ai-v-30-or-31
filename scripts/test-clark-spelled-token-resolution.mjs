// Spelled-token liquidity/name resolution — reported: "Liquidity check AERO" with no session
// memory returned the generic "Which token or wallet do you mean? Paste an address..." instead of
// resolving AERO, and a bare follow-up name like "aerodrome finance" (no liquidity/lp keyword, no
// verb) also fell through to a generic reply instead of being looked up by name.
//
// Root causes fixed:
// 1. classifyClarkPrompt correctly extracted routed.symbol="AERO" for "Liquidity check AERO", but
//    app/api/clark/route.ts's liquidity_scan handler called the PURE, address/memory-only
//    resolveClarkMemoryContext() and returned its clarification message immediately whenever
//    !routed.address — without checking whether routed.symbol was already extracted, so the real
//    resolver (resolveTokenSymbolToAddress, which calls /api/resolve's alias map + live search) was
//    never reached. Fixed with a `!routed.symbol` guard on that early return (and on the adjacent
//    memory-reuse branch, which would otherwise silently override a freshly spelled symbol with a
//    stale remembered address).
// 2. classifyClarkPrompt had no fallback for a bare multi-word NAME with no verb/liquidity keyword
//    ("aerodrome finance") — it fell all the way through to intent "none". Added a bare-name
//    fallback that classifies a short, plausible, non-question phrase as token_scan with the full
//    phrase as symbol, since resolveTokenSymbolToAddress/api/resolve already match by NAME.
// 3. /api/resolve's fetchDexScreener/fetchGeckoTerminal unconditionally required
//    /^0x[a-fA-F0-9]{40}$/ on every candidate address, silently discarding every Solana (base58)
//    result — meaning no Solana token could ever resolve by symbol or name. Fixed to accept a
//    structurally valid Solana mint too, without lowercasing it (base58 is case-sensitive).
const { classifyClarkPrompt } = await import('../lib/server/clarkRouting.ts')

let passed = 0
let failed = 0
function check(label, cond) {
  if (cond) { passed++ } else { failed++; console.error(`  ❌ FAIL: ${label}`) }
}

console.log('Section A: "Liquidity check AERO" extracts symbol + liquidity_scan intent (first-time, no memory)')
{
  const r = classifyClarkPrompt('Liquidity check AERO')
  check('intent is liquidity_scan', r.intent === 'liquidity_scan')
  check('symbol is AERO', r.symbol === 'AERO')
  check('address is null (nothing pasted)', r.address === null)
}

console.log('\nSection B: bare multi-word token NAME with no verb/liquidity keyword resolves to token_scan')
{
  const r = classifyClarkPrompt('aerodrome finance')
  check('intent is token_scan (not "none")', r.intent === 'token_scan')
  check('symbol carries the full name for /api/resolve name-matching', r.symbol === 'aerodrome finance')
}
{
  const r = classifyClarkPrompt('pepe coin')
  check('another bare name also resolves to token_scan', r.intent === 'token_scan')
  check('symbol is the full phrase', r.symbol === 'pepe coin')
}

console.log('\nSection C: bare-name fallback does not hijack real conversation')
for (const greeting of ['hello', 'thanks', 'what is fdv', 'what does fdv mean']) {
  const r = classifyClarkPrompt(greeting)
  check(`"${greeting}" does not become token_scan`, r.intent !== 'token_scan')
}
{
  // A question about a concept must stay educational, not become a token name lookup.
  const r = classifyClarkPrompt('what is a lowcap')
  check('"what is a lowcap" is not hijacked into token_scan', r.intent !== 'token_scan')
}

console.log('\nSection D: route.ts guards routed.symbol before short-circuiting to generic clarification')
{
  const fs = await import('node:fs')
  const src = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
  check(
    'liquidity_scan clarification early-return is guarded by !routed.symbol',
    /!routed\.symbol\s*&&\s*memResolution\.needsClarification\s*&&\s*memResolution\.clarificationQuestion/.test(src)
  )
  check(
    'reuseAddress no longer overrides a freshly spelled symbol with stale memory',
    /const reuseAddress = routed\.symbol \? null : \(memResolution\.resolvedToken/.test(src)
  )
}

console.log('\nSection E: /api/resolve accepts Solana (base58) candidates instead of silently dropping them')
{
  const fs = await import('node:fs')
  const src = fs.readFileSync(new URL('../app/api/resolve/route.ts', import.meta.url), 'utf8')
  check('imports isValidSolanaMintAddress', /isValidSolanaMintAddress/.test(src))
  check('dexscreener/geckoterminal filters use isResolvableContractAddress, not a bare EVM regex', (src.match(/isResolvableContractAddress\(/g) ?? []).length >= 2)
  check('candidate addresses are not force-lowercased (would corrupt base58)', !/addr = \(bt\?\.address as string \| undefined\)\?\.toLowerCase\(\)/.test(src))
  check('direct Solana mint query resolves immediately', /isValidSolanaMintAddress\(rawQuery\)/.test(src))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
