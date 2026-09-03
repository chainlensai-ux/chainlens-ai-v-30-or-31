// "What's pumping on Base?" was being misrouted: the single-symbol market-intent gate (added for
// "What is ETH price?"-style questions) matched the bare word "pumping", extracted the literal
// word "BASE" as a candidate ticker (since chain names aren't in MARKET_SYMBOL_STOPWORDS), and
// asked the user to disambiguate between real tokens named "BASE" — instead of falling through to
// isBaseMomentumPrompt's existing handler, which returns a real list of pumping Base tokens via
// getBaseMarketUniverse. Fix: the single-symbol gate now defers to isBaseMomentumPrompt.
import fs from 'node:fs'

let passed = 0
let failed = 0
function check(label, cond) {
  if (cond) { passed++ } else { failed++; console.error(`FAIL: ${label}`) }
}

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const routeSrc = read('../app/api/clark/route.ts')

console.log('\nSection 1: the single-symbol market-intent gate defers to isBaseMomentumPrompt')
{
  check(
    'gate condition excludes Base-momentum-style prompts before extracting a bare symbol',
    /if \(marketIntent && !hijacksBroaderReport && !isBaseMomentumPrompt\(prompt\)\) \{/.test(routeSrc)
  )
}

console.log('\nSection 2: isBaseMomentumPrompt still runs later and returns a real token list, not a fabricated one')
{
  check('isBaseMomentumPrompt handler still present', /if \(isBaseMomentumPrompt\(prompt\)\) \{/.test(routeSrc))
  check('handler sources rows from the real Base market universe (getBaseMarketUniverse), not fabricated data',
    /getBaseMarketUniverse\(\{ origin, mode: "pumping"/.test(routeSrc))
  check('handler returns intent "market" with marketContext.items (a real list of tokens)',
    /intent: "market",\s*\n\s*toolsUsed: \["base_market_feed"\],\s*\n\s*analysis: formatBaseMarketReply/.test(routeSrc))
}

console.log('\nSection 3: isBaseMomentumPrompt regex still matches the exact reported phrasing')
{
  const fnMatch = routeSrc.match(/function isBaseMomentumPrompt\(prompt: string\): boolean \{[\s\S]*?\n\}/)
  check('isBaseMomentumPrompt function found', Boolean(fnMatch))
  if (fnMatch) {
    check('regex source literally includes "what\'s pumping on base"', fnMatch[0].includes("what's pumping on base"))
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
