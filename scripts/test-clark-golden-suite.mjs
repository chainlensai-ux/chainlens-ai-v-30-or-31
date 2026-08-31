import assert from 'node:assert/strict'
import fs from 'node:fs'
import { classifyClarkPrompt, classifyClarkToolIntent } from '../lib/server/clarkRouting.ts'

// ══════════════════════════════════════════════════════════════════════════════════════════════
// CLARK AI GOLDEN TEST SUITE
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// The behavioural contract for Clark, as a single executable spec. Eight categories (token, wallet,
// deployer, pump, radar, whale, follow-up memory, not-applicable) plus the hard rule that governs
// all of them.
//
// HARD RULE — Clark must never answer randomly. Every response must be exactly one of:
//   1. verified answer with evidence
//   2. partial answer with an explicit missing-evidence reason
//   3. not applicable, with an explanation
//   4. clarification request
//   5. a Deep Scan Token / Deep Scan Wallet CTA
//
// WHY THIS SUITE IS SPLIT IN TWO LAYERS
// ------------------------------------
// Layer 1 (routing) calls the REAL classifier, lib/server/clarkRouting.ts's classifyClarkPrompt —
// a pure function with no Next.js/network dependencies. These are true behavioural assertions: they
// execute the shipping code path and would catch a regression in it immediately.
//
// Layer 2 (response contract) asserts against the SOURCE TEXT of app/api/clark/route.ts. That file
// is ~13k lines, imports next/server, and every answer path is network-dependent, so it cannot be
// invoked from a unit test — static source assertions are this repo's established convention for it
// (see test-clark-entity-routing.mjs, test-clark-execution.mjs, and ~15 others). These assertions
// are genuinely weaker than Layer 1: they prove the contract-enforcing code EXISTS and is wired in
// the right order, not that it produced a given string at runtime. That limitation is stated here
// rather than papered over.
//
// ON "none" AS A ROUTING RESULT
// -----------------------------
// classifyClarkPrompt returning "none" is NOT a failure and NOT "answering randomly". It means "no
// new-style routed intent claimed this prompt — fall through to the legacy detectIntent cascade in
// route.ts". Critically, route.ts's entity gate (classifyClarkQuestionCategory + resolveClarkEntity,
// real eth_getCode) runs BEFORE that cascade, so a "none" token question is still entity-resolved
// before anything routes. What this suite therefore asserts for those prompts is the thing that
// actually matters and is actually checkable here: that they never land on the WRONG engine.

const TOKEN = '0x1234567890123456789012345678901234567890'
const WALLET = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'
const SOL_MINT = 'So11111111111111111111111111111111111111112'

const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
const routeCode = routeSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

let checks = 0
const pass = () => { checks += 1 }

// Intents that run the Wallet Scanner engine, and those that run the Token Scanner engine. The hard
// rule "token questions never route to Wallet Scanner" is enforced as set membership against these.
const WALLET_ENGINE_INTENTS = new Set([
  'wallet_scan', 'wallet_pnl_followup', 'wallet_dig_deeper', 'wallet_compare',
])
const TOKEN_ENGINE_INTENTS = new Set([
  'token_scan', 'token_safety', 'token_full_report', 'token_ape_risk',
  'liquidity_scan', 'lp_lock_check', 'dev_rug_check', 'dev_rug_history',
  'risk_explanation', 'pump_analysis', 'holders_check', 'deployer_check',
])

// TWO-TIER ROUTING, DISCLOSED — this mirrors production ordering and is the single most important
// thing to get right when adding a case here.
//
// route.ts runs TWO classifiers, in this order:
//   Tier 1  classifyClarkToolIntent   (line ~8604) — claims explicit whale/radar FEED questions and
//                                      returns immediately, ~1500 lines before Tier 2 is reached.
//   Tier 2  classifyClarkPrompt       (line ~10081) — claims everything Tier 1 did not.
//
// Testing a whale or radar prompt against Tier 2 alone is therefore MEANINGLESS — production never
// reaches Tier 2 for those. (Writing this suite, an assertion that made exactly that mistake
// reported a "failure" on "what are smart money buying" that could not occur in production, because
// Tier 1 already claims it.) resolveRoute() below reproduces the real ordering so every assertion
// reflects the intent that actually answers the user.
function resolveRoute(prompt) {
  const tier1 = classifyClarkToolIntent(prompt)
  if (tier1.intent !== 'none') return { tier: 1, intent: tier1.intent, address: null, deep: false, symbol: null }
  const tier2 = classifyClarkPrompt(prompt)
  return { tier: 2, ...tier2 }
}

/** Tier 2 only — for prompts Tier 1 provably does not claim (asserted where it matters). */
function route(prompt) {
  return classifyClarkPrompt(prompt)
}

/** A token question must never reach a Wallet Scanner intent. "none" is allowed (see header). */
function assertNeverWalletEngine(prompt, label) {
  const r = route(prompt)
  assert.ok(
    !WALLET_ENGINE_INTENTS.has(r.intent),
    `HARD RULE VIOLATED — token question routed to Wallet Scanner: ${label}\n  prompt: ${prompt}\n  intent: ${r.intent}`,
  )
  pass()
  return r
}

/** A wallet question must never reach a Token Scanner intent. "none" is allowed (see header). */
function assertNeverTokenEngine(prompt, label) {
  const r = route(prompt)
  assert.ok(
    !TOKEN_ENGINE_INTENTS.has(r.intent),
    `HARD RULE VIOLATED — wallet question routed to Token Scanner: ${label}\n  prompt: ${prompt}\n  intent: ${r.intent}`,
  )
  pass()
  return r
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 1. TOKEN QUESTIONS
// ══════════════════════════════════════════════════════════════════════════════════════════════
// Every one of these is unambiguously about a token contract. None may reach the Wallet Scanner.
{
  const tokenPrompts = [
    [`Is ${TOKEN} safe?`, 'safety'],
    [`What is the market cap of ${TOKEN}?`, 'market cap'],
    [`Who deployed ${TOKEN}?`, 'deployer'],
    [`Top holders for ${TOKEN}?`, 'top holders'],
    [`Is LP locked on ${TOKEN}?`, 'LP lock'],
    [`Why is ${TOKEN} pumping?`, 'pump reason'],
    ['Has this dev rugged before?', 'dev rug history'],
    ['Deep scan this token.', 'deep scan token'],
  ]
  for (const [prompt, label] of tokenPrompts) assertNeverWalletEngine(prompt, label)

  // The subset that must claim a specific routed intent (not fall through to the legacy cascade),
  // because a dedicated handler exists for them and regressing off it would lose real evidence.
  assert.equal(route(`Is ${TOKEN} safe?`).intent, 'token_safety', '"is X safe" must route to token_safety')
  assert.equal(route(`Is LP locked on ${TOKEN}?`).intent, 'liquidity_scan', 'LP-lock phrasing must stay LP-only, never TOKEN READ')
  assert.equal(route('Has this dev rugged before?').intent, 'dev_rug_history', 'dev rug history must have its own intent')
  assert.equal(route('Deep scan this token.').intent, 'token_scan', 'deep scan token must route to the token engine')
  checks += 4

  // The address must survive classification — a token question that loses its address cannot be
  // answered against the right contract.
  for (const [prompt, label] of tokenPrompts.filter(([p]) => p.includes(TOKEN))) {
    assert.equal(route(prompt).address, TOKEN, `token address must be preserved through routing: ${label}`)
    pass()
  }

  // TOKEN-METRIC-VOCABULARY FIX, REGRESSION GUARD: "market cap of 0x..." and "top holders for 0x..."
  // both used to fall through to classifyClarkPrompt's bare-address default and run WALLET_SCAN
  // against a token contract — a direct violation of this suite's hard rule, found by this suite.
  // Root cause: route.ts's entity gate already classed both as token questions
  // (CLARK_TOKEN_QUESTION_RE), but clarkRouting.ts's own hasOtherStrongIntent list was out of sync
  // and recognised neither, so the routing layer contradicted the entity layer.
  assert.ok(!WALLET_ENGINE_INTENTS.has(route(`What is the market cap of ${TOKEN}?`).intent), 'market cap must never be a wallet scan')
  assert.ok(!WALLET_ENGINE_INTENTS.has(route(`Top holders for ${TOKEN}?`).intent), 'top holders must never be a wallet scan')
  checks += 2
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 2. WALLET QUESTIONS
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  const walletPrompts = [
    [`Explain wallet ${WALLET}.`, 'explain wallet'],
    ['Is this wallet profitable?', 'profitability'],
    ['What is this wallet holding?', 'holdings'],
    ['What are its best trades?', 'best trades'],
    ['What are its worst trades?', 'worst trades'],
    ['Why is PnL partial?', 'partial PnL'],
    ['Deep scan this wallet.', 'deep scan wallet'],
  ]
  for (const [prompt, label] of walletPrompts) assertNeverTokenEngine(prompt, label)

  assert.equal(route(`Explain wallet ${WALLET}.`).intent, 'wallet_scan', 'explicit wallet + address must route to wallet_scan')
  assert.equal(route(`Explain wallet ${WALLET}.`).address, WALLET, 'wallet address must be preserved')
  assert.equal(route('Why is PnL partial?').intent, 'wallet_pnl_followup', 'partial-PnL questions must reach the PnL follow-up handler')
  checks += 3

  // ADDRESSLESS WALLET FOLLOW-UP FIX, REGRESSION GUARD: "deep scan this wallet" / "scan that wallet"
  // carry no address (it comes from session memory) so neither wallet gate fired — both require an
  // address — and both fell to the token_scan fallback purely on the bare word "scan". Found by this
  // suite; a direct violation of "wallet questions never route to Token Scanner".
  const deepWallet = route('Deep scan this wallet.')
  assert.equal(deepWallet.intent, 'wallet_scan', 'addressless "deep scan this wallet" must route to wallet_scan, not token_scan')
  assert.equal(deepWallet.deep, true, 'deep scan must set the deep flag so the CTA and scan depth are right')
  assert.equal(deepWallet.address, null, 'an addressless follow-up correctly carries a null address for memory resolution')
  checks += 3
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 3. DEPLOYER QUESTIONS
// ══════════════════════════════════════════════════════════════════════════════════════════════
// A deployer question is a TOKEN question ("who made this contract"), never a wallet portfolio read
// on the token address itself.
{
  for (const [prompt, label] of [
    [`Who deployed ${TOKEN}?`, 'who deployed <token>'],
    [`Deployer of ${TOKEN}?`, 'deployer of <token>'],
    ['Has this dev rugged before?', 'dev rug history'],
    ['Check the deployer.', 'check deployer'],
  ]) assertNeverWalletEngine(prompt, label)

  // The deployer answer itself must be evidence-bearing and must never silently omit the cluster /
  // rug-history work the fast path deliberately skips (hard rule: partial answers state what is
  // missing). renderFastDeployerAnswer is the fast path's renderer.
  assert.match(routeCode, /function renderFastDeployerAnswer\(/, 'a dedicated fast-deployer renderer must exist')
  assert.match(
    routeCode,
    /nextAction: "Related deployments and rug history were not checked in this fast lookup/,
    'the fast deployer answer must state exactly which checks it did NOT run — never present a partial read as complete',
  )
  // Evidence source must be named, not implied.
  assert.match(routeCode, /const evidenceLabel = devWallet\.evidenceSource === "explorer_creation_lookup"/, 'the deployer answer must name its real evidence source')
  checks += 3
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 4. PUMP ALERTS QUESTIONS
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  assert.equal(route("What's pumping on Base?").intent, 'base_market_discovery', 'pump discovery must route to base_market_discovery')
  assert.equal(route('What is pumping on Base?').intent, 'base_market_discovery', 'the non-contracted phrasing must route identically')
  checks += 2

  // A pump question must never be answered as a wallet read.
  for (const [prompt, label] of [
    ["What's pumping on Base?", 'pump discovery'],
    [`Why is ${TOKEN} pumping?`, 'pump reason for a token'],
    ['Is the pump likely to continue?', 'pump continuation'],
    ['What is the buy/sell pressure?', 'buy/sell pressure'],
  ]) assertNeverWalletEngine(prompt, label)

  assert.equal(route('Is the pump likely to continue?').intent, 'pump_analysis', 'pump continuation must reach pump_analysis')
  assert.equal(route('What could kill this pump?').intent, 'pump_analysis', 'pump-risk phrasing must reach pump_analysis')
  checks += 2
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 5. BASE RADAR QUESTIONS
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  // Explicit radar phrasings are claimed by Tier 1 and answered by the radar tool handler.
  for (const prompt of ['Show me Base Radar', 'Open radar', 'Base radar movers']) {
    const r = resolveRoute(prompt)
    assert.equal(r.tier, 1, `explicit radar phrasing must be claimed by the Tier 1 tool classifier: ${prompt}`)
    assert.match(r.intent, /^base_radar_/, `radar must route to a base_radar_* tool intent: ${prompt}`)
    checks += 2
  }

  // Trending/discovery phrasing is NOT a radar tool call — it is the Base market feed, claimed by
  // Tier 2. Asserting the tier as well as the intent keeps the two feeds from silently merging.
  const trending = resolveRoute('Show me trending Base tokens')
  assert.equal(trending.tier, 2, 'trending-Base discovery is a Tier 2 market question, not a radar tool call')
  assert.equal(trending.intent, 'base_market_discovery', 'trending-Base discovery must route to the market feed')
  checks += 2

  // Radar/discovery answers carry no address, so they must never claim one — a radar answer that
  // silently inherited a stale address would be exactly the "random answer" this rule forbids.
  assert.equal(resolveRoute('Show me Base Radar').address, null, 'a radar question must not carry an address')
  assert.equal(resolveRoute("What's pumping on Base?").address, null, 'a discovery question must not carry an address')
  checks += 2
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 6. WHALE ALERTS QUESTIONS
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  // Explicit whale phrasings are claimed by Tier 1 and answered by the whale tool handler.
  for (const [prompt, expected] of [
    ['Show me whale alerts', 'whale_alerts_summary'],
    ['Show Base whales', 'whale_alerts_summary'],
    ['What are whales buying?', 'whale_alerts_buying'],
    ['what are smart money buying', 'whale_alerts_buying'],
  ]) {
    const r = resolveRoute(prompt)
    assert.equal(r.tier, 1, `explicit whale phrasing must be claimed by the Tier 1 tool classifier: ${prompt}`)
    assert.equal(r.intent, expected, `whale phrasing must route to ${expected}: ${prompt}`)
    checks += 2
  }

  // Looser whale phrasings fall to Tier 2 and must land on whale_alert there — never on a wallet read.
  for (const prompt of ['Any smart money moving?', 'Show me accumulation', 'show me smart money']) {
    const r = resolveRoute(prompt)
    assert.equal(r.intent, 'whale_alert', `looser whale phrasing must still reach the whale feed: ${prompt}`)
    assert.ok(!WALLET_ENGINE_INTENTS.has(r.intent), `a whale-feed question must never become a wallet read: ${prompt}`)
    checks += 2
  }

  // SMART-MONEY-FEED-VS-WALLET FIX, REGRESSION GUARD (found by this suite): WALLET_FOLLOWUP_CORE_RE
  // carried a bare `smart money` alternative and its gate runs BEFORE the whale gate in Tier 2, so
  // "any smart money moving?" — a feed question with no wallet in context — was answered as a wallet
  // PnL follow-up against whatever wallet happened to be in session memory.
  assert.equal(resolveRoute('Any smart money moving?').intent, 'whale_alert', 'an unscoped smart-money feed query must reach the whale feed, not wallet memory')
  pass()

  // The genuinely wallet-scoped smart-money questions must STILL be wallet questions — the fix above
  // narrowed the pattern, and narrowing it too far would break these.
  for (const prompt of ['why is this not smart money', 'why smart money', 'is this wallet smart money?']) {
    const r = resolveRoute(prompt)
    assert.ok(WALLET_ENGINE_INTENTS.has(r.intent), `a wallet-scoped smart-money question must stay a wallet question: ${prompt} (got ${r.intent})`)
    pass()
  }

  assert.equal(resolveRoute('Show me whale alerts').address, null, 'a whale-feed question must not carry an address')
  pass()
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 7. FOLLOW-UP MEMORY
// ══════════════════════════════════════════════════════════════════════════════════════════════
// Follow-ups carry no address of their own — the address and chain come from session memory. The
// contract here is: (a) they never claim an address they weren't given, and (b) they never land on
// the wrong engine.
{
  const followups = [
    ['What about holders?', 'token'],
    ['What about LP?', 'token'],
    ['Who deployed it?', 'token'],
    ['Scan that wallet.', 'wallet'],
    ['Open number 1.', 'neutral'],
    ['Is it safe?', 'token'],
    ['Should I watch it?', 'neutral'],
  ]
  for (const [prompt, side] of followups) {
    const r = route(prompt)
    assert.equal(r.address, null, `a follow-up must never fabricate an address: ${prompt}`)
    pass()
    if (side === 'token') assertNeverWalletEngine(prompt, `follow-up: ${prompt}`)
    if (side === 'wallet') assertNeverTokenEngine(prompt, `follow-up: ${prompt}`)
  }

  // "Scan that wallet." — the natural phrasing right after a deployer answer. Used to become a
  // token_scan because walletScanRe only covered "this wallet", never "that wallet", so TOKEN_SCAN_RE's
  // bare "scan" alternative claimed it. Found by this suite.
  assert.equal(route('Scan that wallet.').intent, 'wallet_scan', '"scan that wallet" must route to the wallet engine')
  assert.equal(route('Deep scan that wallet.').intent, 'wallet_scan', '"deep scan that wallet" must route to the wallet engine')
  checks += 2

  // Follow-up memory must preserve chain + address together. ClarkMemoryChain spans every supported
  // chain, and updateMemToken must record the real chain rather than collapsing to Base.
  assert.match(routeCode, /mem\.lastToken = \{\s*\n\s*address, symbol, name, scanSummary, chain: evidenceChain, ts: Date\.now\(\),/, 'token memory must store the address and its real chain together')
  assert.match(routeCode, /mem\.lastTokenChain = evidenceChain;/, 'the remembered chain must be the evidence chain, never a default')
  assert.match(routeCode, /chain: opts\?\.chain \?\? mem\.lastToken\?\.chain \?\? mem\.selectedChain,/, 'deployer memory must inherit the token\'s real chain')
  checks += 3

  // A follow-up that resolves from memory must say so and state the age of what it used — a silent
  // memory answer is indistinguishable from a fresh verified one, which the hard rule forbids.
  assert.match(routeCode, /tokenMemoryAgeMs:/, 'memory-resolved answers must carry the age of the memory they used')
  assert.match(routeCode, /followUpUsedMemory:/, 'the response must record whether a follow-up was answered from memory')
  checks += 2
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 8. NOT-APPLICABLE QUESTIONS
// ══════════════════════════════════════════════════════════════════════════════════════════════
// The entity gate is the enforcement point: it resolves the address's REAL on-chain type via
// eth_getCode before any branch routes, and returns an explicit not-applicable answer on a mismatch.
{
  // The gate must exist, be wired before every intent branch, and reuse the real on-chain check.
  assert.match(routeCode, /function classifyClarkQuestionCategory\(prompt: string\): 'token' \| 'wallet' \| 'ambiguous' \{/, 'a token-vs-wallet question classifier must exist')
  assert.match(routeCode, /async function resolveClarkEntity\(/, 'an entity resolver must exist')
  assert.match(routeCode, /const kind = await classifyAddressForClark\(input\.address, input\.requestedChain\);/, 'the resolver must reuse the real eth_getCode classifier, never reimplement it')
  checks += 3

  // ACCEPTANCE: "Clark resolves entity type before routing." Ordering is the whole guarantee.
  const gateIdx = routeCode.indexOf('const questionCategory = classifyClarkQuestionCategory(prompt);')
  const basicIntentIdx = routeCode.indexOf('const basicIntent = classifyClarkBasicIntent(prompt);')
  const routedIdx = routeCode.indexOf('const routed = classifyClarkPrompt(prompt);')
  assert.ok(gateIdx > 0, 'the entity gate must be present')
  assert.ok(basicIntentIdx > gateIdx, 'the entity gate must run BEFORE the basic-intent classifier')
  assert.ok(routedIdx > gateIdx, 'the entity gate must run BEFORE the routed-intent classifier')
  checks += 3

  // Both mismatch directions must be detected, and ONLY on a confirmed opposite type — an unresolved
  // ('unknown') check must fall through rather than assert a wrong not-applicable answer.
  assert.match(
    routeCode,
    /\(questionCategory === 'token' && resolvedEntityType === 'wallet'\) \? 'token_question_wallet_address' :\s*\n\s*\(questionCategory === 'wallet' && resolvedEntityType === 'contract' && contractSubtype === 'token'\) \? 'wallet_question_token_address' :\s*\n\s*\(questionCategory === 'wallet' && resolvedEntityType === 'contract' && contractSubtype === 'pair'\) \? 'wallet_question_pair_address' :\s*\n\s*null;/,
    // CONTRACT-WALLET FIX, DISCLOSED (later task): strengthened further — a bare contract-code hit
    // is no longer enough on its own; the wallet-question mismatch now also requires a CONFIRMED
    // token/pair subtype, so a real contract/smart wallet is never auto-rejected.
    'both mismatch directions must be detected, and only on a confirmed opposite entity type (now including a confirmed token/pair subtype, not bare contract code)',
  )
  assert.match(routeCode, /return \{ hasContractCode: null, resolvedEntityType: 'unknown' \};/, 'the entity check must fail open (unknown) rather than guess when the RPC itself fails')
  checks += 2

  // "Market cap of 0xWALLET" / "LP locked on 0xWALLET" → must say wallet, not token, and name the
  // inapplicable checks explicitly rather than returning an empty token read.
  assert.match(
    routeCode,
    /This address is a wallet, not a token contract, on \$\{chainDisplayLabel\(chainForClarkTools\)\}\. Market cap\/holders\/LP\/deployer do not apply\./,
    'a token question on a wallet address must say it is a wallet AND name the checks that do not apply',
  )
  // The honest multi-chain variant, for when no chain was named: must state which chains were
  // actually checked rather than implying a universal negative.
  assert.match(routeCode, /checked across \$\{checkedChainLabels\.join\(", "\)\}, no contract code found on any of them\./, 'the no-chain-named variant must name every chain actually checked')
  assert.match(routeCode, /couldn't be checked — not configured on this deployment/, 'chains that could not be checked must be disclosed, never silently counted as "no contract"')
  checks += 3

  // "PnL of 0xTOKEN" / "portfolio of 0xTOKEN" → must say token contract, not wallet.
  assert.match(routeCode, /if \(mismatch === 'wallet_question_token_address'\) \{/, 'the wallet-question-on-a-token-address direction must be handled')
  assert.match(routeCode, /routeSelected: mismatch \? 'not_applicable'/, 'a mismatch must select the not-applicable route, never an engine')
  assert.match(routeCode, /responseMode: mismatch \? 'not_applicable' : 'normal'/, 'a mismatch must set the not-applicable response mode')
  checks += 3

  // A not-applicable answer must still hand the user the correct next step (hard rule option 5).
  assert.match(routeCode, /ui: \{ intentBadge: 'Entity Check', actions: \[\{ label: 'Scan Wallet', href \}, \{ label: 'Deep Scan Wallet', href: walletScannerDeepLink\(inlineAddress, true\) \}\] \}/, 'a not-applicable token-question answer must offer the correct wallet CTAs')
  pass()

  // A malformed address must produce a clarification request with the real character count, never a
  // silent truncation into a different valid address.
  assert.match(routeCode, /found \$\{hexLen\} hex characters after "0x", but a real EVM contract or wallet address needs exactly 40/, 'a malformed address must produce an honest clarification request naming the real length')
  pass()
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// HARD RULE — RESPONSE SHAPE: confidence, evidence, next action
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  assert.match(routeCode, /function formatClarkStructuredAnswer\(input: \{/, 'a single structured-answer formatter must exist')
  // Every one of the three required fields must be non-optional in the formatter's input type, so a
  // caller physically cannot emit an answer missing confidence, evidence, or a next action.
  assert.match(routeCode, /confidence: "High" \| "Medium" \| "Low";/, 'confidence must be a required, closed enum — never free text or absent')
  assert.match(routeCode, /confidenceReason: string;/, 'a confidence REASON must be required — a bare score explains nothing')
  assert.match(routeCode, /nextAction: string;/, 'a next action must be required on every structured answer')
  assert.match(routeCode, /evidence: string\[\];/, 'evidence must be a required field')
  checks += 5

  // And they must actually be rendered, not merely accepted.
  assert.match(routeCode, /lines\.push\(`Confidence: \$\{input\.confidence\} — \$\{input\.confidenceReason\}`\);/, 'confidence and its reason must be rendered together')
  assert.match(routeCode, /lines\.push\(`Recommended next action: \$\{input\.nextAction\}`\);/, 'the next action must be rendered')
  assert.match(routeCode, /lines\.push\(`Last updated: \$\{input\.lastUpdatedLabel\}`\);/, 'answer freshness must be rendered — a stale read must never look live')
  assert.match(routeCode, /if \(input\.evidence\.length > 0\) lines\.push\("Evidence", \.\.\.input\.evidence\.map\(\(e\) => `- \$\{e\}`\), ""\);/, 'evidence must be rendered as its own labelled section')
  checks += 4
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// HARD RULE — DEEP SCAN CTAs
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  const actionsSrc = fs.readFileSync(new URL('../lib/server/clarkRouting.ts', import.meta.url), 'utf8')
  for (const cta of ['Deep Scan Wallet', 'Open Token Scanner', 'Scan Wallet', 'Check Deployer', 'Run LP Check']) {
    assert.ok(actionsSrc.includes(`"${cta}"`), `"${cta}" must be in the fixed CTA vocabulary`)
    pass()
  }
  assert.ok(!actionsSrc.includes('"Deep Scan Token"'), 'Deep Scan Token is not a real feature and must not be in the CTA vocabulary')
  // Deep-scan CTAs must be reachable on BOTH sides — a token-side answer with only wallet CTAs (or
  // vice versa) leaves the user with no correct next step.
  assert.match(routeCode, /walletScannerDeepLink\(inlineAddress, true\)/, 'the Deep Scan Wallet CTA must link to a real deep-scan deep link')
  assert.match(routeCode, /function walletScannerDeepLink\(address: string, deepScan: boolean\): string \{/, 'the wallet deep link must be built by a single shared helper')
  assert.match(routeCode, /deepScan=true/, 'the deep-scan deep link must actually request a deep scan')
  checks += 3
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// HARD RULE — RAW DEBUG FIELDS ARE NEVER SHOWN
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  // Debug/audit payloads must be conditionally attached behind the debug flag, never unconditionally.
  assert.match(routeCode, /const clarkDebugMode = Boolean\(\(body as unknown as Record<string, unknown>\)\.debug\) \|\| process\.env\.NODE_ENV !== 'production';/, 'debug mode must be explicitly opt-in (or non-production), never on by default in production')
  const auditAttachments = routeCode.match(/clarkToolCallAudit: clarkDebugMode \? /g) ?? []
  assert.ok(auditAttachments.length >= 4, `every clarkToolCallAudit attachment must be debug-gated (found ${auditAttachments.length})`)
  assert.doesNotMatch(routeCode, /clarkToolCallAudit: buildClarkToolCallAudit\(/, 'a tool-call audit must never be attached unconditionally')
  checks += 3

  // The user-visible `analysis` string must never interpolate a raw audit object. These are the
  // internal receipt fields; they belong in sibling JSON keys, never in the rendered answer text.
  for (const field of ['clarkDeployerLookupAudit', 'clarkToolCallAudit', 'clarkDebugReceipt', 'entityAudit']) {
    assert.doesNotMatch(
      routeCode,
      new RegExp(`analysis:[^\\n]*\\$\\{[^}]*${field}`),
      `the rendered analysis text must never interpolate the raw ${field} object`,
    )
    pass()
  }
  // Nor may raw diagnostics be pushed into the answer body.
  assert.doesNotMatch(routeCode, /lines\.push\(JSON\.stringify\(/, 'raw JSON must never be pushed into a rendered answer')
  pass()
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// CROSS-CHAIN INVARIANT — no silent Base fallback
// ══════════════════════════════════════════════════════════════════════════════════════════════
// A "verified answer" that silently ran on the wrong chain is a random answer wearing a badge.
{
  assert.match(routeCode, /function toTokenApiChain\(chain: string\): "base" \| "eth" \| "bnb" \| "robinhood" \| null \{/, 'the chain mapper must return null for genuinely unsupported chains, never a Base default')
  assert.match(routeCode, /if \(chain === "bnb"\) return "bnb";/, 'BNB must map to its own slug')
  assert.match(routeCode, /if \(chain === "robinhood"\) return "robinhood";/, 'Robinhood must map to its own slug')
  checks += 3

  // A Solana mint is a token, never a wallet — the bare-address default is EVM-shaped and must not
  // claim it.
  const solRoute = route(`Is ${SOL_MINT} safe?`)
  assert.ok(!WALLET_ENGINE_INTENTS.has(solRoute.intent), 'a Solana safety question must never route to the Wallet Scanner')
  assert.equal(solRoute.address, SOL_MINT, 'a Solana mint must survive routing intact')
  assert.equal(route(SOL_MINT).intent, 'token_scan', 'a bare Solana mint must default to a token scan')
  checks += 3
}

console.log(`test-clark-golden-suite.mjs: all ${checks} golden assertions passed`)
