#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const route = readFileSync('app/api/clark/route.ts', 'utf8')
const routing = readFileSync('lib/server/clarkRouting.ts', 'utf8')
const publicTokenFormatterBlock = routing.slice(routing.indexOf('export function formatTokenSecurityStatus'), routing.indexOf('export function formatNoTokenInMemory'))

// 1. Initial TOKEN READ public output does not contain provider/path/internal wording.
for (const forbidden of ['current provider', 'provider path', 'honeypot provider', 'API path', 'route path', 'not supported by current provider path']) {
  assert.ok(!publicTokenFormatterBlock.toLowerCase().includes(forbidden.toLowerCase()), `public token formatter leaks internal wording: ${forbidden}`)
}
assert.ok(route.includes('publicReason'), 'initial TOKEN READ must sanitize public missing reasons')
assert.ok(route.includes('Position/controller proof is unavailable in this read'), 'public LP wording should be safe')
assert.ok(routing.includes('Security simulation unavailable'), 'security gaps should use public-safe wording')

// 2. Security unavailable has exact missing reason and independent attempts/mapping debug.
assert.ok(route.includes('await Promise.all([tokenFetchPromise, honeypotPromise])'), 'token and security branches must run independently')
assert.ok(route.includes('security_simulation_timed_out'), 'security timeout must have exact missing reason')
assert.ok(route.includes('auth_failed'), 'auth failures must be preserved as exact reason')
assert.ok(route.includes('securityAttempted'), 'debug must expose securityAttempted')
assert.ok(route.includes('securityStatus'), 'debug must expose securityStatus')
assert.ok(route.includes('securityDurationMs'), 'debug must expose securityDurationMs')
assert.ok(route.includes('securitySourceMappedFromTokenRoute'), 'debug must expose token-route security mapping')
assert.ok(route.includes('securityMissingReason'), 'debug must expose security missing reason')
assert.ok(route.includes('tokenRouteSecurityMapped'), 'Clark must map security fields returned by Token Scanner')

// 3. Concentrated LP maps to position/controller Open Check, not generic provider-path unsupported.
assert.ok(routing.includes('Concentrated liquidity detected. Standard LP-token lock/burn proof does not apply. Position/controller proof is still Open Check.'), 'concentrated LP public wording must be specific')
assert.ok(routing.includes('Controller/position evidence'), 'controller/position evidence must be surfaced if present')
assert.ok(route.includes('lpProofApplicability'), 'debug must expose LP proof applicability')
assert.ok(route.includes('concentratedLpDetected'), 'debug must expose concentratedLpDetected')
assert.ok(route.includes('positionControllerProofStatus'), 'debug must expose position/controller proof status')
assert.ok(route.includes('rawLpState'), 'Clark must map raw LP state')
assert.ok(route.includes('positionProofStatus'), 'Clark must map concentrated position proof status')

// 4. Open Check verdict includes specific reasons.
assert.ok(route.includes('Open Check. Reasons:'), 'partial initial read must include specific Open Check reasons')
assert.ok(routing.includes('- Reasons:'), 'full initial read must include Open Check reasons')
assert.ok(route.includes('Security simulation unavailable'), 'Open Check should include security reason')
assert.ok(route.includes('Concentrated LP position/controller proof unavailable'), 'Open Check should include concentrated LP reason')

// 5. Holder concentration top-1 >= 40 and top-10 >= 40 are risk drivers.
assert.ok(routing.includes('h.top1 >= 40') && routing.includes('Major single-wallet dominance'), 'top-1 >= 40% must be major single-wallet dominance risk')
assert.ok(routing.includes('h.top10 >= 40') && routing.includes('Elevated holder concentration'), 'top-10 >= 40% must be elevated concentration risk')
assert.ok(!routing.includes('positiveSignals.push(`Holder concentration: top-10'), 'top-10 concentration must not be a positive signal')

// 6. Follow-ups use stored normalized evidence and do not drift market values.
assert.ok(route.includes('normalizedEvidence'), 'token memory must store structured normalized evidence')
assert.ok(route.includes('cachedEvidence && mem.address'), 'follow-ups must use token memory first')
assert.ok(route.includes('resolveTokenForFollowup({ fromMemoryOnly: true })'), 'LP follow-ups must use lastToken memory before live LP calls')
assert.ok(route.includes('toolsUsed: ["memory"]'), 'follow-up responses must identify memory usage')
assert.ok(route.includes('tokenFollowupRefreshRequested'), 'refresh gate must control rescans')

// 7. No fake “safe” / “locked LP” when security or controller proof is missing.
assert.ok(routing.includes('Safe? Not enough confirmed evidence to call it safe'), 'safety answer should stay Open Check when evidence is missing')
assert.ok(routing.includes('Confidence: ${hasControllerProof ? (lp?.confidence ?? "partial") : "open_check"}'), 'concentrated LP without controller proof must be open_check')
assert.ok(!routing.includes('lp?.confidence ?? "medium"'), 'concentrated LP without controller proof must not default to medium confidence')
assert.ok(routing.includes('standard LP-token lock/burn proof does not apply'), 'concentrated LP must not be called a normal locked LP')

// 8. Token prompt never routes to Wallet Read.
assert.ok(!/intent:\s*"wallet_analysis"[\s\S]{0,120}token_scan/.test(route), 'token scan branch must not route to Wallet Read')
assert.ok(route.includes('walletScanAttempted: false'), 'token scan debug must confirm wallet scanner was not attempted')



// 9. Ethereum Token Core compatibility: prompt chain must be preserved end-to-end.
assert.ok(routing.includes('ETH_CHAIN_WORD_RE'), 'routing must recognize ETH/Ethereum token prompts')
assert.ok(routing.includes('on\\s+eth') && routing.includes('ethereum\\s+token'), 'ETH token prompts must be treated as token prompts, not wallet prompts')
assert.ok(route.includes('const chain: SupportedChain = promptChain ?? body.chain ?? memSelectedChain'), 'explicit ETH prompt chain must override UI/default chain')
assert.ok(route.includes('tokenInternalApiPayload = { contract: tokenAddress, chain: toTokenApiChain(chain) ?? "base"'), '/api/token payload must use resolved ETH chain')
assert.ok(route.includes('fetchHoneypotSecurity(tokenAddress, toTokenApiChain(chain) ?? "base")'), 'independent security check must use ETH chain when requested')
assert.ok(route.includes('chainDisplayLabel(tokenEvidenceChain(ev, chain))'), 'formatter/debug path must preserve Ethereum chain label')
assert.ok(route.includes('Chain: ${chainDisplayLabel(tokenEvidenceChain(ev, chain))}'), 'partial TOKEN READ must print resolved chain')
assert.ok(route.includes('followUpUsedMemory') && route.includes('evidenceSource: fromMemory ? "lastToken"'), 'ETH follow-ups must use lastToken memory debug')
assert.ok(route.includes('toolsUsed: fromMemory ? ["memory"]'), 'token follow-ups from lastToken must report memory tools')
assert.ok(route.includes('LP proof is open check'), 'missing LP evidence must remain Open Check')
assert.ok(!route.includes('no active pool data on Base"'), 'Token Core must not hardcode Base no-pool wording')
assert.ok(!route.includes('Token not found on Base or no active pool data'), 'Token Core missing evidence must not hardcode Base')

// 10. Required ETH prompts should classify as Token Core / follow-up intents.
const ethPrompts = [
  'scan token 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 on eth',
  'scan this ethereum token 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
]
for (const prompt of ethPrompts) {
  const classified = routing.match(/export function classifyClarkPrompt/)
  assert.ok(classified, 'classifyClarkPrompt must exist for ETH token routing checks')
  assert.ok(/on\\s\+eth|ethereum\\s\+token/.test(routing), `ETH prompt must have token routing coverage: ${prompt}`)
}
for (const prompt of ['is it safe?', 'is LP locked?', 'can dev rug?', 'why high risk?']) {
  assert.ok(routing.includes('TOKEN_FOLLOWUP_RE') && routing.toLowerCase().includes(prompt.replace('?', '').toLowerCase().split(' ')[0]), `token follow-up must be covered: ${prompt}`)
}

console.log('Clark Token Core checks passed')
