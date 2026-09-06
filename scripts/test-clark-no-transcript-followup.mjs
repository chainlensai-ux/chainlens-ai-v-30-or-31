import assert from 'node:assert/strict'
import fs from 'node:fs'

// Clark/CORTEX audit Item 6: token follow-ups must never treat regex-parsed assistant
// prose as evidence. Identity comes from lastToken / lastClarkSubject; evidence comes
// from cached TokenScanEvidence or a real scanner call.

const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
const routeCode = routeSrc.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')

assert.doesNotMatch(routeCode, /function extractLastTokenScanFromHistory\(/, 'transcript scraper extractLastTokenScanFromHistory must be gone')
assert.doesNotMatch(routeCode, /function buildWatchVerdictFromScan\(/, 'watch verdict must not regex-parse scan text')
assert.doesNotMatch(routeCode, /msg\.includes\("TOKEN SCAN READ"\)/, 'follow-up identity must not scrape TOKEN SCAN READ chat text')

assert.match(routeCode, /type TokenFollowupType = "lp" \| "deployer" \| "holders" \| "combined";/, 'holders/LP/deployer follow-ups stay classified')
assert.match(routeCode, /function detectTokenFollowup\(/, 'token followup detector must still exist')
assert.match(routeCode, /lastToken: \{ address: string \} \| null \| undefined/, 'detectTokenFollowup must resolve identity from lastToken, not chat history')
assert.doesNotMatch(routeCode, /detectTokenFollowup\(prompt, body\.history\)/, 'detectTokenFollowup must not take chat history as evidence')

assert.match(routeCode, /function buildTokenFollowupReply\(type: TokenFollowupType, ev: TokenScanEvidence, chainLabel: string\)/, 'follow-up replies must take TokenScanEvidence, not scanText')
assert.match(routeCode, /if \(type === "lp"\) return formatLpLockCheck\(ev, chainLabel\);/, 'LP follow-ups use the canonical LP formatter')
assert.match(routeCode, /if \(type === "deployer"\) return formatDevRugCheck\(ev, chainLabel\);/, 'deployer follow-ups use the canonical dev/rug formatter')
assert.match(routeCode, /if \(type === "holders"\) return formatHoldersCheck\(ev, chainLabel\);/, 'holder follow-ups use the canonical holders formatter')
assert.match(routeCode, /return formatTokenSafetyAnswer\(ev, chainLabel\);/, 'combined leftover follow-ups use the canonical safety formatter')

assert.match(routeCode, /const r = await resolveTokenForFollowup\(\);/, 'leftover follow-up intercept must resolve cached or live scanner evidence')
assert.match(routeCode, /analysis: formatTokenAnalystFollowup\(r\.ev, chainDisplayLabel\(tokenEvidenceChain\(r\.ev, chainForClarkTools\)\)\)/, 'watch-verdict follow-ups use formatTokenAnalystFollowup on canonical evidence')
assert.match(routeCode, /analysis: formatRiskExplanation\(r\.ev, chainDisplayLabel\(tokenEvidenceChain\(r\.ev, chainForClarkTools\)\)\)/, 'why-risky follow-ups use formatRiskExplanation on canonical evidence')
assert.match(routeCode, /analysis: formatMissingChecksFromEvidence\(r\.ev, tokenLabel\)/, 'missing-check follow-ups use canonical coverage, not scanSummary regex')
assert.match(routeCode, /analysis: buildCasualContextualReply\(prompt, cached\)/, 'casual replies may use cached TokenScanEvidence only')
assert.doesNotMatch(routeCode, /buildCasualContextualReply\(prompt, lastScan/, 'casual replies must not take scraped scan text')

const { formatHoldersCheck, formatDevRugCheck, formatLpLockCheck, formatTokenSafetyAnswer, formatRiskExplanation, formatTokenAnalystFollowup, tokenEvidenceCoverage } = await import('../lib/server/clarkRouting.ts')

const ev = {
  ok: true,
  token: { name: 'Brett', symbol: 'BRETT', address: '0x532f27101965dd16442e59d40670faf5ebb142e4' },
  chain: 'base',
  riskScore: 62,
  riskLabel: 'Caution',
  market: { liquidity: 1_200_000, volume24h: 400_000, price: 0.12 },
  holders: { top1: 18, top10: 41, holderCount: 12000 },
  security: { honeypot: false, ownerRenounced: true, mintable: false, proxy: false, buyTax: 0, sellTax: 0 },
  lpControl: { status: 'locked', reason: 'lp locked' },
}

const holders = formatHoldersCheck(ev, 'Base')
assert.match(holders, /HOLDER/i)
assert.match(holders, /41\.0%/)
assert.doesNotMatch(holders, /No signal in checked window/)

const dev = formatDevRugCheck(ev, 'Base')
assert.match(dev, /DEV\/RUG CHECK/)
assert.doesNotMatch(dev, /not fully wired in Clark chat follow-ups/)

const lp = formatLpLockCheck(ev, 'Base')
assert.match(lp, /LP/i)
assert.doesNotMatch(lp, /Not confirmed from current data/)

const safety = formatTokenSafetyAnswer(ev, 'Base')
assert.match(safety, /BRETT/i)

const risk = formatRiskExplanation(ev, 'Base')
assert.match(risk, /RISK EXPLANATION/)
assert.doesNotMatch(risk, /last CORTEX scan text/)

const watch = formatTokenAnalystFollowup(ev, 'Base')
assert.match(watch, /WATCH READ/)
assert.doesNotMatch(watch, /WATCH VERDICT/)

const coverage = tokenEvidenceCoverage(ev)
assert.equal(coverage.holderDistribution, 'verified')
assert.equal(coverage.lpControl, 'verified')

console.log('test-clark-no-transcript-followup.mjs: all assertions passed')
