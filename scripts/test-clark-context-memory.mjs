import assert from 'node:assert/strict'
import {
  resolveClarkContext,
  buildClarkContextMemoryAudit,
  normalizeClarkChain,
  clarkEntityKey,
  extractExplicitAddress,
  extractRankReference,
  CLARK_CHAIN_IDS,
} from '../lib/server/clarkContextResolver.ts'

// CLARK CONVERSATION MEMORY, DISCLOSED (Clark memory audit).
//
// These walk the exact follow-up chains the audit was raised for. They exercise the real resolver
// the route calls — not a mock — so a regression in subject precedence, chain scoping, or ambiguity
// handling fails here rather than in production.
//
// Root causes these lock closed:
//   - lastDevWallet was declared and read but NEVER written, so "has he rugged before?" could not
//     resolve a deployer under any circumstances.
//   - Memory chain types were "base" | "eth" only, so Robinhood/BNB/Solana subjects could not be
//     recorded with their real chain and follow-ups resolved on the wrong network.
//   - Entity identity was the bare address, so the same CA on two chains collided.
//   - There was no ambiguity concept: with two plausible subjects the first non-null won.

const TOKEN_A = '0xaaaa000000000000000000000000000000000001'
const TOKEN_B = '0xbbbb000000000000000000000000000000000002'
const DEPLOYER = '0xdddd000000000000000000000000000000000003'
const WALLET = '0xeeee000000000000000000000000000000000004'
const SOL_MINT = 'So11111111111111111111111111111111111111112'

const now = 1_700_000_000_000
const t = (offset = 0) => now + offset

function memWithToken(over = {}) {
  return {
    activeToken: {
      tokenAddress: TOKEN_A, chainSlug: 'base', chainId: 8453,
      symbol: 'MOON', name: 'Moon Token', ts: t(-1000),
    },
    recentTokens: [{ address: TOKEN_A, chainSlug: 'base', symbol: 'MOON', ts: t(-1000) }],
    ...over,
  }
}

// ── 1. Scan a Base token, then "who deployed it?" resolves the same token + Base ──
{
  const r = resolveClarkContext('who deployed it?', memWithToken(), {}, now)
  assert.equal(r.resolvedSubjectType, 'token')
  assert.equal(r.resolvedToken, TOKEN_A, 'must resolve the active token, not guess')
  assert.equal(r.resolvedChain, 'base', 'must keep the token\'s chain')
  assert.equal(r.needsClarification, false)
  assert.equal(r.memorySource, 'active_token')
}

// ── 2. "has he rugged before?" resolves the remembered DEPLOYER (the field that was never written) ──
{
  const mem = memWithToken({
    activeDeployer: {
      address: DEPLOYER, chainSlug: 'base', sourceTokenAddress: TOKEN_A,
      confidence: 'high', ts: t(-500),
    },
  })
  const r = resolveClarkContext('has he rugged before?', mem, {}, now)
  assert.equal(r.resolvedSubjectType, 'deployer')
  assert.equal(r.resolvedWallet, DEPLOYER, '"he" must resolve to the deployer wallet')
  assert.equal(r.resolvedDeployer, DEPLOYER)
  assert.equal(r.resolvedChain, 'base')
  assert.equal(r.memorySource, 'active_deployer')
  assert.equal(r.needsClarification, false)
}

// A deployer pronoun with NO deployer in memory must never silently attach to the token.
{
  const r = resolveClarkContext('has he rugged before?', memWithToken(), {}, now)
  assert.notEqual(r.resolvedSubjectType, 'deployer', 'must not invent a deployer')
  assert.equal(r.resolvedToken, TOKEN_A, 'falls back to a real deployer LOOKUP against the active token')
  assert.equal(r.intent, 'deployer_lookup')
}

// ── 3. "what about liquidity?" stays on the same token ──
{
  const r = resolveClarkContext('what about liquidity?', memWithToken(), {}, now)
  assert.equal(r.intent, 'liquidity_question')
  assert.equal(r.resolvedToken, TOKEN_A)
  assert.equal(r.resolvedChain, 'base')
}

// A liquidity question must stay on the TOKEN even when a wallet was scanned more recently —
// a wallet has no liquidity.
{
  const mem = memWithToken({
    activeWallet: { walletAddress: WALLET, chainSlug: 'base', ts: t(-10) },
  })
  const r = resolveClarkContext('what about liquidity?', mem, {}, now)
  assert.equal(r.resolvedSubjectType, 'token', 'liquidity is a token property, never a wallet one')
  assert.equal(r.resolvedToken, TOKEN_A)
}

// ── 4. "is it safe to ape?" uses the same token scan context ──
{
  const r = resolveClarkContext('is it safe to ape?', memWithToken(), {}, now)
  assert.equal(r.intent, 'safety_question')
  assert.equal(r.resolvedToken, TOKEN_A)
  assert.equal(r.resolvedChain, 'base')
  assert.equal(r.needsClarification, false)
}

// ── 5. "scan number 2" after a Radar list scans rank 2 ──
{
  const mem = {
    activeList: {
      kind: 'radar', chainSlug: 'base', ts: t(-2000),
      items: [
        { rank: 1, address: TOKEN_A, symbol: 'ONE' },
        { rank: 2, address: TOKEN_B, symbol: 'TWO' },
      ],
    },
  }
  const r = resolveClarkContext('scan number 2', mem, {}, now)
  assert.equal(r.resolvedSubjectType, 'list_item')
  assert.equal(r.resolvedToken, TOKEN_B, 'must scan rank 2, not rank 1')
  assert.equal(r.memorySource, 'active_list_rank')
  assert.equal(r.resolvedChain, 'base')
}

// Ordinal wording resolves identically.
{
  const mem = {
    activeList: {
      kind: 'radar', chainSlug: 'base', ts: t(-2000),
      items: [{ rank: 1, address: TOKEN_A, symbol: 'ONE' }, { rank: 2, address: TOKEN_B, symbol: 'TWO' }],
    },
  }
  assert.equal(resolveClarkContext('open the second one', mem, {}, now).resolvedToken, TOKEN_B)
}

// A rank beyond the list asks instead of clamping to a wrong token.
{
  const mem = {
    activeList: { kind: 'radar', chainSlug: 'base', ts: t(-2000), items: [{ rank: 1, address: TOKEN_A, symbol: 'ONE' }] },
  }
  const r = resolveClarkContext('scan number 9', mem, {}, now)
  assert.equal(r.needsClarification, true)
  assert.equal(r.resolvedToken, null, 'must not silently clamp to an in-range rank')
}

// ── 6. "why is rank 1 pumping?" uses the Pump list's rank 1 on its own chain ──
{
  const mem = {
    activeList: {
      kind: 'pump', chainSlug: 'eth', ts: t(-3000),
      items: [{ rank: 1, address: TOKEN_A, symbol: 'PUMPER' }],
    },
  }
  const r = resolveClarkContext('why is rank 1 pumping?', mem, {}, now)
  assert.equal(r.resolvedToken, TOKEN_A)
  assert.equal(r.resolvedChain, 'eth', 'a pump list on ETH must not resolve its ranks as Base')
}

// ── 7. An explicit new address overrides the active token ──
{
  const r = resolveClarkContext(`scan ${TOKEN_B}`, memWithToken(), {}, now)
  assert.equal(r.resolvedToken, TOKEN_B, 'an explicit address in the message always wins')
  assert.equal(r.memorySource, 'explicit_prompt')
  assert.equal(r.confidence, 'high')
}

// ── 8. Same 0x address on different chains does not collide ──
{
  assert.notEqual(
    clarkEntityKey('base', TOKEN_A), clarkEntityKey('robinhood', TOKEN_A),
    'chain-scoped identity must distinguish the same address on two chains',
  )
  // An explicit chain word retargets the same address to the other chain.
  const r = resolveClarkContext(`scan ${TOKEN_A} on robinhood`, memWithToken(), {}, now)
  assert.equal(r.resolvedToken, TOKEN_A)
  assert.equal(r.resolvedChain, 'robinhood', 'an explicit chain must override the remembered Base chain')
  assert.equal(CLARK_CHAIN_IDS.robinhood, 4663)
}

// A follow-up on a Robinhood token must never resolve as Base.
{
  const mem = memWithToken({
    activeToken: { tokenAddress: TOKEN_A, chainSlug: 'robinhood', chainId: 4663, symbol: 'RH', name: 'RH Token', ts: t(-100) },
    recentTokens: [{ address: TOKEN_A, chainSlug: 'robinhood', symbol: 'RH', ts: t(-100) }],
  })
  assert.equal(resolveClarkContext('is it safe?', mem, {}, now).resolvedChain, 'robinhood')
}

// ── 9. Solana mint context stays Solana and never routes into the EVM scanner ──
{
  const explicit = extractExplicitAddress(`scan ${SOL_MINT}`)
  assert.ok(explicit, 'a valid Solana mint must be recognised')
  assert.equal(explicit.chain, 'solana')
  const r = resolveClarkContext(`scan ${SOL_MINT}`, {}, {}, now)
  assert.equal(r.resolvedChain, 'solana')
  assert.equal(CLARK_CHAIN_IDS.solana, null, 'Solana has no EVM chainId — null is the honest value')

  // A contradictory chain word must NOT drag a Solana mint onto an EVM chain.
  assert.equal(resolveClarkContext(`scan ${SOL_MINT} on base`, {}, {}, now).resolvedChain, 'solana')

  // Conversely an EVM address must never be routed to Solana by the word "solana".
  const evmR = resolveClarkContext(`scan ${TOKEN_A} on solana`, {}, {}, now)
  assert.notEqual(evmR.resolvedChain, 'solana', 'an 0x address must never route into the Solana scanner')

  // A Solana follow-up keeps Solana.
  const solMem = {
    activeToken: { tokenAddress: SOL_MINT, chainSlug: 'solana', chainId: null, symbol: 'WSOL', name: 'Wrapped SOL', ts: t(-100) },
    recentTokens: [{ address: SOL_MINT, chainSlug: 'solana', symbol: 'WSOL', ts: t(-100) }],
  }
  assert.equal(resolveClarkContext('is it safe?', solMem, {}, now).resolvedChain, 'solana')
}

// ── 10. Ambiguous follow-up asks instead of guessing ──
{
  const mem = memWithToken({
    recentTokens: [
      { address: TOKEN_A, chainSlug: 'base', symbol: 'MOON', ts: t(-1000) },
      { address: TOKEN_B, chainSlug: 'base', symbol: 'OTHER', ts: t(-2000) },
    ],
  })
  const r = resolveClarkContext('is it safe?', mem, {}, now)
  assert.equal(r.needsClarification, true, 'two recent tokens make a bare "it" ambiguous')
  assert.equal(r.resolvedToken, null, 'must not guess a subject when ambiguous')
  assert.ok(r.clarificationQuestion && /MOON/.test(r.clarificationQuestion), 'the question must name the candidates')
  assert.ok(/OTHER/.test(r.clarificationQuestion))
  assert.equal(r.confidence, 'low')
}

// The SAME token re-scanned is not ambiguity — chain-scoped identity dedupes it.
{
  const mem = memWithToken({
    recentTokens: [
      { address: TOKEN_A, chainSlug: 'base', symbol: 'MOON', ts: t(-1000) },
      { address: TOKEN_A, chainSlug: 'base', symbol: 'MOON', ts: t(-2000) },
    ],
  })
  assert.equal(resolveClarkContext('is it safe?', mem, {}, now).needsClarification, false)
}

// The same address on TWO chains genuinely IS two subjects.
{
  const mem = memWithToken({
    recentTokens: [
      { address: TOKEN_A, chainSlug: 'base', symbol: 'MOON', ts: t(-1000) },
      { address: TOKEN_A, chainSlug: 'robinhood', symbol: 'MOON', ts: t(-2000) },
    ],
  })
  assert.equal(
    resolveClarkContext('is it safe?', mem, {}, now).needsClarification, true,
    'the same CA on two chains must be treated as two distinct subjects',
  )
}

// ── 11. "scan that wallet" after a deployer answer scans the DEPLOYER wallet ──
{
  const mem = memWithToken({
    activeDeployer: { address: DEPLOYER, chainSlug: 'base', sourceTokenAddress: TOKEN_A, confidence: 'high', ts: t(-200) },
  })
  const r = resolveClarkContext('scan that wallet', mem, {}, now)
  assert.equal(r.resolvedWallet, DEPLOYER)
  assert.equal(r.resolvedSubjectType, 'deployer')
}

// "that wallet" with a scanned wallet but no deployer resolves to that wallet.
{
  const mem = { activeWallet: { walletAddress: WALLET, chainSlug: 'base', ts: t(-50) } }
  const r = resolveClarkContext('scan that wallet', mem, {}, now)
  assert.equal(r.resolvedWallet, WALLET)
  assert.equal(r.resolvedSubjectType, 'wallet')
}

// ── 12. "explain the risk" uses the latest token/wallet context ──
{
  const r = resolveClarkContext('explain the risk', memWithToken(), {}, now)
  assert.equal(r.resolvedToken, TOKEN_A)
  assert.equal(r.needsClarification, false)
}

// A bare "why?" resolves against the active subject rather than generic chat.
{
  const r = resolveClarkContext('why?', memWithToken(), {}, now)
  assert.equal(r.intent, 'explain_previous')
  assert.equal(r.resolvedToken, TOKEN_A)
}

// ── 13. A brand-new session inherits nothing and asks rather than inventing ──
{
  const r = resolveClarkContext('is it safe?', {}, {}, now)
  assert.equal(r.resolvedSubjectType, 'none')
  assert.equal(r.resolvedToken, null)
  assert.equal(r.resolvedWallet, null)
  assert.equal(r.needsClarification, true, 'an empty session must ask, never fabricate a subject')
  assert.equal(r.memorySource, 'none')
}

// A greeting in an empty session is not a subject question and must not demand clarification.
{
  const r = resolveClarkContext('hello', {}, {}, now)
  assert.equal(r.intent, 'none')
  assert.equal(r.needsClarification, false, 'plain chat must not trigger a clarification prompt')
}

// ── Priority 3: page scanner context is used only when session memory has nothing ──
{
  const r = resolveClarkContext('is it safe?', {}, { selectedTokenAddress: TOKEN_B, chainSlug: 'bnb' }, now)
  assert.equal(r.resolvedToken, TOKEN_B)
  assert.equal(r.resolvedChain, 'bnb')
  assert.equal(r.memorySource, 'page_context')
  assert.equal(r.confidence, 'medium', 'page context is weaker evidence than an explicit scan')
}
// Session memory outranks page context.
{
  const r = resolveClarkContext('is it safe?', memWithToken(), { selectedTokenAddress: TOKEN_B, chainSlug: 'bnb' }, now)
  assert.equal(r.resolvedToken, TOKEN_A, 'the session\'s active token beats the page selection')
  assert.equal(r.memorySource, 'active_token')
}

// ── Chain normalization ──
assert.equal(normalizeClarkChain('Ethereum'), 'eth')
assert.equal(normalizeClarkChain('BSC'), 'bnb')
assert.equal(normalizeClarkChain('Robinhood Chain'), 'robinhood')
assert.equal(normalizeClarkChain('SOL'), 'solana')
assert.equal(normalizeClarkChain('polygon'), null, 'an unsupported chain must return null, never default to Base')
assert.equal(normalizeClarkChain(undefined), null)

// ── Rank extraction ──
assert.equal(extractRankReference('scan number 3'), 3)
assert.equal(extractRankReference('rank 1'), 1)
assert.equal(extractRankReference('the third one'), 3)
assert.equal(extractRankReference('#2'), 2)
assert.equal(extractRankReference('is it safe'), null)

// ── Audit shape: every field the spec requires, with pre-resolution memory recorded ──
{
  const mem = memWithToken({
    activeDeployer: { address: DEPLOYER, chainSlug: 'base', sourceTokenAddress: TOKEN_A, confidence: 'high', ts: t(-200) },
    activeList: { kind: 'radar', chainSlug: 'base', ts: t(-9), items: [{ rank: 1, address: TOKEN_B, symbol: 'X' }] },
  })
  const resolution = resolveClarkContext('has he rugged before?', mem, {}, now)
  const audit = buildClarkContextMemoryAudit({
    chatId: 'chat_1', messageId: 'msg_1', userPrompt: 'has he rugged before?',
    memory: mem, resolution, memoryUpdated: true,
  })
  for (const field of [
    'chatId', 'messageId', 'userPrompt', 'parsedIntent', 'explicitAddressFound', 'explicitChainFound',
    'previousActiveToken', 'previousActiveWallet', 'previousActiveDeployer', 'previousActiveList',
    'resolvedSubjectType', 'resolvedAddress', 'resolvedChainSlug', 'memorySource', 'confidence',
    'needsClarification', 'clarificationReason', 'memoryUpdated',
  ]) {
    assert.ok(field in audit, `clarkContextMemoryAudit must include ${field}`)
  }
  assert.equal(audit.previousActiveToken, `base:${TOKEN_A}`, 'audit must record chain-scoped prior memory')
  assert.equal(audit.previousActiveDeployer, `base:${DEPLOYER}`)
  assert.equal(audit.previousActiveList, 'radar:base:1')
  assert.equal(audit.resolvedAddress, DEPLOYER)
  assert.equal(audit.resolvedChainSlug, 'base')
  assert.equal(audit.memoryUpdated, true)
}

// ─── Route + client wiring (static source assertions) ───────────────────────
// The pure resolver above can't reach the orchestration, so these lock the wiring that makes the
// memory actually survive: the deployer write that never existed, cold-start rehydration, and the
// chain normalization that used to collapse every chain onto Base.
import fs from 'node:fs'
const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
const routeCode = routeSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

// The deployer memory is now actually WRITTEN (the original bug: declared, read, never assigned).
assert.match(routeCode, /function rememberClarkDeployer\(/, 'a deployer write path must exist')
assert.match(routeCode, /rememberClarkDeployer\(sessionMem, deployerCandidate/, 'a resolved deployer must be committed to session memory')
assert.match(routeCode, /mem\.lastDevWallet = \{/, 'rememberClarkDeployer must assign lastDevWallet')

// Deployer + radar list round-trip so they survive a serverless cold start.
assert.match(routeCode, /genericMemoryEcho\.lastDeployer = \{/, 'the deployer must be echoed to the client')
assert.match(routeCode, /genericMemoryEcho\.lastRadarList =/, 'the radar list must be echoed to the client')
assert.match(routeCode, /body\.clientContext\?\.lastDeployer\?\.address/, 'the deployer must be rehydrated from clientContext')
assert.match(routeCode, /body\.clientContext\?\.lastRadarList/, 'the radar list must be rehydrated from clientContext')

// The silent chain collapse is gone.
assert.doesNotMatch(
  routeCode,
  /selectedChain = \(earlyPromptChain \?\? body\.chain\) === "ethereum" \? "eth" : "base"/,
  'selectedChain must not collapse every non-ethereum chain onto base',
)
assert.match(routeCode, /sessionMem\.selectedChain = normalizeClarkChain\(/, 'selectedChain must be normalized across the full supported chain set')

// The memory resolver is actually invoked and audited per request.
assert.match(routeCode, /resolveClarkMemoryContext\(/, 'the memory resolver must be called on the request path')
assert.match(routeCode, /clarkContextMemoryAudit = buildClarkContextMemoryAudit\(/, 'each message must emit a context audit')

// The pre-existing transcript-scraping resolver is left intact (routing must not change).
assert.match(routeCode, /function resolveClarkContext\(message: string, history/, 'the original text-based resolver must remain untouched')

// Client mirrors the two entities that previously died on cold start.
const clientSrc = fs.readFileSync(new URL('../lib/client/clarkMemory.ts', import.meta.url), 'utf8')
assert.match(clientSrc, /LAST_DEPLOYER_KEY/, 'the client must persist the deployer')
assert.match(clientSrc, /LAST_RADAR_LIST_KEY/, 'the client must persist the radar list')
assert.match(clientSrc, /lastDeployer: readJson\(LAST_DEPLOYER_KEY\)/, 'the client must send the deployer back as context')

console.log('test-clark-context-memory.mjs: all assertions passed')
