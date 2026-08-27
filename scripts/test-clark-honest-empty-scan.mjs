import assert from 'node:assert/strict'
import fs from 'node:fs'

// HONEST-EMPTY-RESULT FIX, DISCLOSED.
//
// Reported live, two connected symptoms in the same conversation:
//  1. A real ETH token, asked about with no chain named in the prompt (Clark defaults to Base),
//     got "This address is a wallet, not a token contract" — stated as a universal fact when it
//     was really only "no contract code found on Base specifically." The address was in fact a
//     real token, just on a different chain.
//  2. After correcting Clark ("its a token"), the follow-up scan resolved nothing (still checking
//     the wrong chain) and rendered the FULL noisy "TOKEN SCAN READ" template — 20+ lines of "No
//     signal in checked window" and a bare "VERDICT: UNKNOWN" — reading as a real, if thin,
//     analysis rather than "I found nothing here." User's own words: "make the ai just say i dont
//     understand instead of random bullshit."
//
// Static source assertions, matching this repo's established convention for this route file.

const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
const routeCode = routeSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

// ─── Genuinely-empty detection must check every real evidence field, not just one ──────────────
assert.match(routeCode, /function isGenuinelyEmptyReport\(report: ClarkFullReportEvidence\): boolean \{/, 'a dedicated genuinely-empty check must exist')
for (const field of [
  'report.token.name == null && report.token.symbol == null',
  'report.market.price == null && report.market.liquidity == null && report.market.volume24h == null && report.market.marketCap == null',
  'report.holders.holderCount == null && report.holders.topHolderPct == null',
  'report.contract.honeypot == null && report.contract.buyTax == null && report.contract.sellTax == null',
]) {
  assert.ok(routeCode.includes(field), `isGenuinelyEmptyReport must check: ${field}`)
}

// ─── The short, honest reply must actually be short and name the real reason ───────────────────
assert.match(routeCode, /function buildEmptyTokenScanReply\(address: string \| null\): string \{/, 'a dedicated short honest-empty reply builder must exist')
assert.match(routeCode, /"I couldn't verify this token\."/, 'the empty-result reply must open with a direct, honest statement — not a fabricated analysis')
assert.match(routeCode, /defaults to Base unless you name one/, 'the reply must explain WHY nothing was found (chain default), not just that nothing was found')
assert.match(routeCode, /tell me which one and I'll check there instead — for example \\"is 0x\.\.\. safe on eth\\"/, 'the reply must give a concrete, actionable next step')

// ─── Must actually gate the noisy template, at the top of the function, for every caller ───────
assert.match(routeCode, /function renderQuickTokenScan\(report: ClarkFullReportEvidence\): string \{\s*\n\s*if \(isGenuinelyEmptyReport\(report\)\) return buildEmptyTokenScanReply\(report\.token\.address\);/, 'renderQuickTokenScan must check for a genuinely empty result BEFORE building the full noisy template — this covers every one of its call sites automatically')

// ─── Sanity: a report with even ONE real signal must NOT be treated as empty (never suppress a
// real, if partial, finding just because most fields are unresolved) ────────────────────────────
assert.doesNotMatch(routeCode, /isGenuinelyEmptyReport\(report\): boolean \{\s*\n\s*return true;/, 'the empty check must never be a stub that always returns true')

console.log('test-clark-honest-empty-scan.mjs: all assertions passed')
