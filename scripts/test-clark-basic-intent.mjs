import assert from 'node:assert/strict'
import { classifyClarkBasicIntent, buildClarkDirectAnswer, clarkMissingInputPrompt, CLARK_SAFE_FALLBACK } from '../lib/server/clarkBasicIntent.ts'

function directAnswerNoProviderCalls(message) {
  const intent = classifyClarkBasicIntent(message)
  const answer = buildClarkDirectAnswer(intent, message)
  return { intent, answer, providerCallsAdded: 0 }
}

// "hi" returns a normal greeting and providerCallsAdded === 0
{
  const { intent, answer, providerCallsAdded } = directAnswerNoProviderCalls('hi')
  assert.equal(intent, 'greeting')
  assert.ok(answer && answer.length > 0)
  assert.equal(providerCallsAdded, 0)
}

// "what can you do?" returns product capabilities and providerCallsAdded === 0
{
  const { intent, answer, providerCallsAdded } = directAnswerNoProviderCalls('what can you do?')
  assert.equal(intent, 'product_help')
  assert.match(answer, /Token Scanner|Wallet Scanner|Whale Alerts|Base Radar/)
  assert.equal(providerCallsAdded, 0)
}

// "what is PnL?" returns explanation and providerCallsAdded === 0
{
  const { intent, answer, providerCallsAdded } = directAnswerNoProviderCalls('what is PnL?')
  assert.equal(intent, 'basic_question')
  assert.match(answer, /profit and loss/i)
  assert.equal(providerCallsAdded, 0)
}

// "why is my wallet PnL locked?" explains locked official PnL and providerCallsAdded === 0
{
  const { intent, answer, providerCallsAdded } = directAnswerNoProviderCalls('why is my wallet PnL locked?')
  assert.equal(intent, 'basic_question')
  assert.match(answer, /locked/i)
  assert.equal(providerCallsAdded, 0)
}

// More glossary examples must all resolve to a non-empty direct answer with zero provider calls
for (const q of [
  'how does ChainLens work?', 'what is Base?', 'what is a token scanner?',
  'what does open check mean?', 'how do I scan a wallet?', 'how do I scan a token?',
  'what is Clark?', 'explain this dashboard', 'what does LP locked mean?', 'what does honeypot mean?',
]) {
  const { answer, providerCallsAdded } = directAnswerNoProviderCalls(q)
  assert.ok(answer && answer.trim().length > 0, `no empty response for: ${q}`)
  assert.equal(providerCallsAdded, 0, `no provider calls for: ${q}`)
}

// "scan this wallet" (no address) asks for address and providerCallsAdded === 0, and must NOT
// resolve as a direct-answer intent (caller asks for input instead of calling a scan API).
{
  const intent = classifyClarkBasicIntent('scan this wallet')
  assert.equal(intent, 'wallet_scan_request')
  const directAnswer = buildClarkDirectAnswer(intent, 'scan this wallet')
  assert.equal(directAnswer, null, 'wallet_scan_request must not be answered directly')
  const missing = clarkMissingInputPrompt(intent)
  assert.match(missing, /wallet address/i)
}

// "scan this token" (no contract) asks for contract, never calls a scan API
{
  const intent = classifyClarkBasicIntent('scan this token')
  assert.equal(intent, 'token_scan_request')
  assert.equal(buildClarkDirectAnswer(intent, 'scan this token'), null)
  assert.match(clarkMissingInputPrompt(intent), /token contract/i)
}

// Valid wallet address with explicit wallet wording still classifies as wallet_scan_request,
// but is NOT intercepted as a direct answer — caller (route.ts) lets it fall through to the
// existing wallet scanner routing unchanged.
{
  const msg = 'scan this wallet 0x1234567890123456789012345678901234567890'
  const intent = classifyClarkBasicIntent(msg)
  assert.equal(intent, 'wallet_scan_request')
  assert.equal(buildClarkDirectAnswer(intent, msg), null)
}

// Valid token contract with explicit token wording still classifies as token_scan_request,
// and is not intercepted as a direct answer either.
{
  const msg = 'scan this token 0x1234567890123456789012345678901234567890'
  const intent = classifyClarkBasicIntent(msg)
  assert.equal(intent, 'token_scan_request')
  assert.equal(buildClarkDirectAnswer(intent, msg), null)
}

// A bare valid address with no scan keyword is left for existing routing (unsupported_request
// here means "not a basic-chat intent", not "fails") — never intercepted/blocked here.
{
  const intent = classifyClarkBasicIntent('0x1234567890123456789012345678901234567890')
  assert.equal(intent, 'unsupported_request')
  assert.equal(buildClarkDirectAnswer(intent, '0x1234567890123456789012345678901234567890'), null)
}

// Ambiguous scan request (both token and wallet language, no address) asks one clear question
{
  const msg = 'scan this token or wallet'
  const intent = classifyClarkBasicIntent(msg)
  assert.equal(intent, 'ambiguous_scan_request')
  const missing = clarkMissingInputPrompt(intent)
  assert.match(missing, /token contract or a wallet address/i)
}

// Safe fallback text matches the exact required copy
assert.equal(
  CLARK_SAFE_FALLBACK,
  "I can help explain ChainLens, wallets, tokens, Base, scanner results, or run a scan if you give me a wallet address or token contract.",
)

console.log('test-clark-basic-intent: all assertions passed')
