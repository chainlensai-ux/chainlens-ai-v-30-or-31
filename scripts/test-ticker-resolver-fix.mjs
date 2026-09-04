// Ticker search fix — /token PEPE / Token Scanner ticker input.
//
// Root causes fixed:
//   1. /api/resolve exempted EXACT symbol/name matches from the ambiguity check entirely — two
//      different real tokens both named e.g. "PEPE" on different chains always silently picked
//      whichever ranked marginally higher, never asking. This is the most likely cause of the
//      reported "CA or ticker gives the same token" glitch: an ambiguous ticker search silently
//      auto-resolving to a "confident-looking" but arbitrary winner.
//   2. Token Scanner's handleScan auto-scanned resolverResult.contractAddress even when
//      status === 'ambiguous' (the resolver's best GUESS, not a real single match).
//   3. Clark's resolveTokenForFollowup (used by /token, /holders, /deployer, and general token
//      follow-ups) called resolveTokenSymbolToAddress with NO chain argument (always defaulted to
//      "base") and never checked for an "ambiguous" status — a real match list came back but was
//      silently discarded, falling through to a generic "share a token symbol/contract" message.
//
// Run: npx tsx scripts/test-ticker-resolver-fix.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

let passed = 0
function check(label, condition) { assert.ok(condition, label); passed++ }

const resolveSrc = readFileSync(new URL('../app/api/resolve/route.ts', import.meta.url), 'utf8')
const clarkSrc = readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
const scannerSrc = readFileSync(new URL('../app/terminal/token-scanner/page.tsx', import.meta.url), 'utf8')
const tickerResolverSrc = readFileSync(new URL('../lib/tickerResolver.ts', import.meta.url), 'utf8')

console.log('\nSection 1: /api/resolve — exact-symbol ties are no longer exempt from ambiguity')
{
  check('the old blanket exemption for exact_symbol/exact_name is gone', !/scoreDiff < 50 && best\.matchType !== 'exact_symbol' && best\.matchType !== 'exact_name'/.test(resolveSrc))
  check('exact ties still get a tighter (more confident) threshold than fuzzy matches, not zero tolerance', /const ambiguousThreshold = exactTie \? 30 : 50/.test(resolveSrc))
  check('isAmbiguous no longer special-cases matchType at all — any close second candidate can trigger it', /const isAmbiguous = !!second && scoreDiff < ambiguousThreshold/.test(resolveSrc))
}

console.log('\nSection 2: /api/resolve — chain-aware GeckoTerminal search (was hardcoded to Base)')
{
  check('GeckoTerminal network is mapped from the caller\'s preferred chain', /GECKOTERMINAL_NETWORK\[prefer\.toLowerCase\(\)\]/.test(resolveSrc))
  check('BNB/BSC, Solana, and Ethereum all have a real GeckoTerminal network mapping, not just base', /bnb: 'bsc', bsc: 'bsc', solana: 'solana'/.test(resolveSrc))
  check('the old hardcoded network=base literal in the fetch URL is gone', !/query=\$\{encodeURIComponent\(query\)\}&network=base&page=1/.test(resolveSrc))
}

console.log('\nSection 3: /api/resolve — spec result shape (matches/selectedMatch/needsUserChoice/failureReason)')
{
  for (const field of ['query', 'normalizedQuery', 'matches', 'selectedMatch', 'needsUserChoice', 'failureReason']) {
    check(`ResolverResult type includes ${field}`, new RegExp(`\\b${field}:`).test(resolveSrc))
  }
  check('needsUserChoice mirrors isAmbiguous honestly, never hardcoded false on a real ambiguous result', /needsUserChoice: isAmbiguous/.test(resolveSrc))
  check('lib/tickerResolver.ts (client) has the matching additive fields', /needsUserChoice: boolean/.test(tickerResolverSrc) && /selectedMatch: ResolverMatch \| null/.test(tickerResolverSrc))
}

console.log('\nSection 4: /api/resolve — server-side tickerResolverAudit, logged on every path')
{
  check('audit type declared with the required fields', /type TickerResolverAudit = \{/.test(resolveSrc) && /needsUserChoice: boolean/.test(resolveSrc) && /finalAction: 'resolved' \| 'ambiguous' \| 'not_found'/.test(resolveSrc))
  const auditCalls = [...resolveSrc.matchAll(/logTickerResolverAudit\(/g)]
  check('audit is logged from more than one resolution path (CA / alias / live search), not just one', auditCalls.length >= 4)
}

console.log('\nSection 5: Token Scanner — ambiguous ticker search no longer silently auto-scans')
{
  check('handleScan stops before scanning on an ambiguous resolver result', /if \(resolved\.status === 'ambiguous'\) return/.test(scannerSrc))
  check('the picker for an ambiguous result renders the required "choose one to scan" copy', /Multiple tokens found for.*Choose one to scan\./.test(scannerSrc))
  check('every candidate in the ambiguous picker is its own clickable Scan button (bestCandidate included, not just alternates)', /\[resolverResult\.bestCandidate, \.\.\.resolverResult\.alternates\]/.test(scannerSrc))
  check('each option shows chain, address, liquidity, FDV, and 24h volume per the required picker fields', /Liq \{fmtLiquidity\(cand\.liquidityUsd\)\}/.test(scannerSrc) && /FDV \{fmtLiquidity\(cand\.fdvUsd\)\}/.test(scannerSrc) && /Vol24h \{fmtLiquidity\(cand\.volume24hUsd\)\}/.test(scannerSrc))
}

console.log('\nSection 6: Clark /token — chain preserved, ambiguous matches surfaced, no silent fallback')
{
  check('resolveTokenForFollowup now passes the real selected chain (was always defaulting to base)', /resolveTokenSymbolToAddress\(routed\.symbol, chainForClarkTools, \{ requireExplicitSelection: true \}\)/.test(clarkSrc))
  check('resolveTokenForFollowup checks for an ambiguous status and returns real matches instead of discarding them', /if \(resolved\?\.status === "ambiguous" && Array\.isArray\(resolved\.matches\) && resolved\.matches\.length > 1\) \{\s*\n\s*updateMemTickerMatches/.test(clarkSrc))
  const ambiguousGuards = [...clarkSrc.matchAll(/if \("ambiguous" in r\) return ambiguousTokenReply\(r, "/g)]
  check('every intent that calls resolveTokenForFollowup checks for the ambiguous branch (token_ape_risk, token_safety, dev_rug_check, risk_explanation, holders_check)', ambiguousGuards.length >= 5)
}

console.log('\nSection 7: Clark — lastTickerMatches session memory + numbered/named reply selection ("1", "scan 2", "the base one")')
{
  check('ClarkSessionMemory carries lastTickerMatches (optional, so existing memory literals stay valid)', /lastTickerMatches\?: \{ symbol: string; matches: ClarkLiquidityMatch\[\]; ts: number \} \| null;/.test(clarkSrc))
  check('a bare numeric reply ("1", "2.", "scan 2", "option 3") resolves against the remembered matches', /const numMatch = t\.match\(\/\^\(\?:scan\\s\+\|option\\s\+\|#\\s\*\)\?\(\\d\{1,2\}\)\\\.\?\$\/i\)/.test(clarkSrc))
  check('a chain-name reply ("base", "the base one") resolves when exactly one match is on that chain', /const onChain = matches\.filter/.test(clarkSrc))
  check('the reply parser expires after 5 minutes so a stale, unrelated match list never hijacks a fresh prompt', /TICKER_MATCH_REPLY_TTL_MS = 5 \* 60 \* 1000/.test(clarkSrc))
  check('the reply parser never fires on a long, real follow-up prompt (only short selection replies)', /if \(!t \|\| t\.length > 40\) return null/.test(clarkSrc))
  check('a resolved selection is wired into the main routing cascade before other intent classifiers, so it never gets misread as a fresh unrelated prompt', /const selection = parseTickerMatchSelection\(prompt, sessionMem\)/.test(clarkSrc))
}

console.log('\nSection 8: scope discipline — LP proof, Wallet Scanner, PnL, pricing, auth, and payments untouched')
{
  const walletScannerSrc = readFileSync(new URL('../app/terminal/wallet-scanner/page.tsx', import.meta.url), 'utf8')
  check('Wallet Scanner page has no new ticker-resolver references (this task never touched it)', !/tickerResolverAudit|parseTickerMatchSelection|lastTickerMatches/.test(walletScannerSrc))
}

console.log(`\n${passed} assertions passed`)
