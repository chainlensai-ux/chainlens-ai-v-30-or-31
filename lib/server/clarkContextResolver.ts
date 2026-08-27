import { isEvmAddress, isValidSolanaMintAddress } from '../solanaAddress'

// CLARK CONTEXT RESOLVER, DISCLOSED (Clark conversation-memory audit).
//
// Why this module exists: subject resolution for follow-up questions ("who deployed it?", "has he
// rugged?", "what about liquidity?", "scan number 2") was previously scattered across
// app/api/clark/route.ts as ad-hoc `??` fallback chains at half a dozen call sites — e.g.
// `evidence?.tokenScan?.token?.address ?? sessionMem?.lastToken?.address ?? clientContext?.lastToken?.address`.
// That shape has three problems this module fixes:
//   1. Every call site could disagree about precedence, and none of them recorded WHY a subject was
//      picked, so a wrong answer was undebuggable.
//   2. None of them carried the chain alongside the address, so a Base follow-up could silently
//      resolve against a Robinhood/ETH/Solana entity remembered earlier (and a Solana mint could be
//      handed to the EVM scanner).
//   3. There was no ambiguity concept at all — with two plausible subjects the first non-null won
//      and Clark guessed instead of asking.
//
// This module is PURE (no I/O, no network, no route imports) specifically so the whole resolution
// matrix is unit-testable without standing up the 12k-line route handler. The route calls
// resolveClarkContext() and acts on the result; it never re-derives precedence itself.

// ─── Chain identity ─────────────────────────────────────────────────────────────────────────────
// Widened from the route's original `"base" | "eth"`, which could not represent bnb, Robinhood
// Chain or Solana at all — so scanning a Robinhood or Solana token recorded either the wrong chain
// or none, and the next follow-up resolved against whatever the default was. Matches the chain set
// the Token Scanner and lib/server/lpProof.ts already support, plus solana.
export type ClarkChain = 'base' | 'eth' | 'bnb' | 'robinhood' | 'solana'

export const CLARK_CHAIN_IDS: Record<ClarkChain, number | null> = {
  base: 8453,
  eth: 1,
  bnb: 56,
  robinhood: 4663,
  solana: null, // Solana is not an EVM chain and has no EVM chainId — null is the honest value.
}

const CLARK_CHAINS: ClarkChain[] = ['base', 'eth', 'bnb', 'robinhood', 'solana']

export function isClarkChain(value: unknown): value is ClarkChain {
  return typeof value === 'string' && (CLARK_CHAINS as string[]).includes(value)
}

// Normalizes the many chain spellings that reach Clark (UI selectors, prompt text, provider slugs)
// onto one canonical slug. Unknown input returns null rather than defaulting to Base — silently
// defaulting is how a wrong-chain answer gets produced.
export function normalizeClarkChain(value: unknown): ClarkChain | null {
  if (typeof value !== 'string') return null
  const v = value.trim().toLowerCase()
  if (v === 'base') return 'base'
  if (v === 'eth' || v === 'ethereum' || v === 'mainnet') return 'eth'
  if (v === 'bnb' || v === 'bsc' || v === 'binance' || v === 'bnb chain') return 'bnb'
  if (v === 'robinhood' || v === 'robinhood chain' || v === 'rh') return 'robinhood'
  if (v === 'solana' || v === 'sol') return 'solana'
  return null
}

export function isEvmClarkChain(chain: ClarkChain): boolean {
  return chain !== 'solana'
}

// CHAIN-SCOPED IDENTITY, DISCLOSED: memory previously keyed entities by bare lowercase address, so
// the same contract address deployed on two chains was treated as ONE entity and a follow-up could
// answer about the wrong deployment. Identity is always chain + address from here on.
export function clarkEntityKey(chain: ClarkChain, address: string): string {
  return `${chain}:${address.toLowerCase()}`
}

// ─── Remembered entity shapes ───────────────────────────────────────────────────────────────────

export type ClarkActiveToken = {
  tokenAddress: string
  chainSlug: ClarkChain
  chainId: number | null
  symbol: string | null
  name: string | null
  scanCacheKey?: string | null
  deployerAddress?: string | null
  riskScore?: number | null
  liquidityStatus?: string | null
  ts: number
}

export type ClarkActiveWallet = {
  walletAddress: string
  chainSlug: ClarkChain
  chainScope?: string | null
  scanCacheKey?: string | null
  realizedPnlUsd?: number | null
  riskLabels?: string[]
  ts: number
}

export type ClarkActiveDeployer = {
  address: string
  chainSlug: ClarkChain
  sourceTokenAddress: string | null
  confidence: 'high' | 'medium' | 'low'
  ts: number
}

export type ClarkActivePumpAlert = {
  tokenAddress: string
  chainSlug: ClarkChain
  alertId?: string | null
  reportCacheKey?: string | null
  momentumScore?: number | null
  ts: number
}

export type ClarkActiveWhaleAlert = {
  alertId?: string | null
  walletAddress: string | null
  tokenAddress: string | null
  chainSlug: ClarkChain
  ts: number
}

export type ClarkRankedListItem = {
  rank: number
  address: string
  symbol: string | null
  name?: string | null
}

export type ClarkActiveList = {
  kind: 'radar' | 'pump'
  chainSlug: ClarkChain
  items: ClarkRankedListItem[]
  ts: number
}

// The resolver's view of session memory. Deliberately a narrow structural type rather than an
// import of ClarkSessionMemory: this module must stay free of route.ts (which imports half the
// codebase) so it remains unit-testable in isolation.
export type ClarkMemoryView = {
  activeToken?: ClarkActiveToken | null
  activeWallet?: ClarkActiveWallet | null
  activeDeployer?: ClarkActiveDeployer | null
  activePumpAlert?: ClarkActivePumpAlert | null
  activeWhaleAlert?: ClarkActiveWhaleAlert | null
  activeList?: ClarkActiveList | null
  /** Recently discussed tokens, newest first — used only to DETECT ambiguity, never to guess. */
  recentTokens?: Array<{ address: string; chainSlug: ClarkChain; symbol: string | null; ts: number }>
}

/** Scanner context from the page the user is currently on (priority 3). */
export type ClarkPageContext = {
  selectedTokenAddress?: string | null
  selectedWalletAddress?: string | null
  chainSlug?: ClarkChain | null
}

export type ClarkSubjectType = 'token' | 'wallet' | 'deployer' | 'pump_alert' | 'whale_alert' | 'list_item' | 'none'

export type ClarkMemorySource =
  | 'explicit_prompt'
  | 'active_token'
  | 'active_wallet'
  | 'active_deployer'
  | 'active_pump_alert'
  | 'active_whale_alert'
  | 'active_list_rank'
  | 'page_context'
  | 'none'

export type ClarkContextResolution = {
  intent: ClarkFollowupIntent
  resolvedSubjectType: ClarkSubjectType
  resolvedToken: string | null
  resolvedWallet: string | null
  resolvedChain: ClarkChain | null
  resolvedDeployer: string | null
  confidence: 'high' | 'medium' | 'low'
  ambiguityReason: string | null
  needsClarification: boolean
  clarificationQuestion: string | null
  memorySource: ClarkMemorySource
}

export type ClarkFollowupIntent =
  | 'explicit_target'
  | 'deployer_lookup'
  | 'deployer_history'
  | 'scan_subject'
  | 'liquidity_question'
  | 'safety_question'
  | 'rank_reference'
  | 'explain_previous'
  | 'wallet_reference'
  | 'none'

// ─── Prompt parsing ─────────────────────────────────────────────────────────────────────────────

// TRUNCATED-ADDRESS FIX, DISCLOSED (see app/api/clark/route.ts's extractAddress): the lookahead
// stops a malformed 41+-char hex run from being silently truncated into a different real address.
const EVM_ADDRESS_RE = /0x[a-fA-F0-9]{40}(?![a-fA-F0-9])/
// Solana mints are base58 and 32-44 chars. Anchored on word boundaries so it can't slice a longer
// token; candidates are still validated by isValidSolanaMintAddress before being trusted.
const SOLANA_CANDIDATE_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/

/**
 * Returns the address, its FORMAT, and any chain word that is actually compatible with that format.
 *
 * `addressFormat` is derived from the address itself and is authoritative; the chain word is only
 * ever advisory. Deriving the chain from the prompt word alone let "scan 0xabc… on solana" resolve
 * to Solana — routing an EVM address into the Solana scanner, which the chain rules forbid — so an
 * incompatible chain word is dropped here rather than being allowed to reach the router.
 */
export function extractExplicitAddress(
  prompt: string,
): { address: string; addressFormat: 'evm' | 'solana'; chain: ClarkChain | null } | null {
  const evm = prompt.match(EVM_ADDRESS_RE)
  if (evm && isEvmAddress(evm[0])) {
    const worded = extractExplicitChain(prompt)
    // 'solana' is never a valid chain for an 0x address — ignore it rather than misroute.
    const chain = worded && worded !== 'solana' ? worded : null
    return { address: evm[0].toLowerCase(), addressFormat: 'evm', chain }
  }
  const solCandidate = prompt.match(SOLANA_CANDIDATE_RE)
  if (solCandidate && isValidSolanaMintAddress(solCandidate[0])) {
    // A valid Solana mint pins the chain to Solana regardless of any chain word in the prompt —
    // a base58 mint can never be scanned on an EVM chain.
    return { address: solCandidate[0], addressFormat: 'solana', chain: 'solana' }
  }
  return null
}

export function extractExplicitChain(prompt: string): ClarkChain | null {
  const t = prompt.toLowerCase()
  if (/\brobinhood\b|\brh\s+chain\b/.test(t)) return 'robinhood'
  if (/\bsolana\b|\bsol\b/.test(t)) return 'solana'
  if (/\bbnb\b|\bbsc\b|\bbinance\b/.test(t)) return 'bnb'
  if (/\b(?:eth|ethereum)\b/.test(t)) return 'eth'
  if (/\bbase\b/.test(t)) return 'base'
  return null
}

/** Rank reference: "number 2", "rank 2", "the second one", "#2". */
export function extractRankReference(prompt: string): number | null {
  const t = prompt.toLowerCase()
  const ordinals: Record<string, number> = {
    first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
    sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  }
  const ordinalMatch = t.match(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/)
  if (ordinalMatch) return ordinals[ordinalMatch[1]]
  // The `#` alternative deliberately carries no leading \b: `#` is a non-word character, so a \b
  // before it would require a word character immediately prior — making a leading "#2" unmatchable.
  const numeric = t.match(/(?:\b(?:number|rank)\s*|#\s*)(\d{1,2})\b/)
  if (numeric) return Number(numeric[1])
  return null
}

// Deployer-reference detection. "he"/"him"/"they" only count as a deployer reference when a
// deployer is actually in memory — the caller enforces that; matching the pronoun alone here keeps
// this function purely syntactic.
const DEPLOYER_PRONOUN_RE = /\b(?:he|him|his|they|them|their)\b/i
const DEPLOYER_NOUN_RE = /\b(?:dev|devs|deployer|creator|owner|team)\b/i
const DEPLOYER_LOOKUP_RE = /\bwho\s+(?:deployed|created|made|launched|owns)\b|\bwho\s+is\s+the\s+(?:dev|deployer|creator|owner)\b|\bdeployer\s+(?:address|wallet)\b/i
const DEPLOYER_HISTORY_RE = /\b(?:rug|rugged|rugpull|rug\s*pull|scam|scammed|history|track\s*record|before|previous)\b/i
const LIQUIDITY_RE = /\bliquidity\b|\blp\b|\bpool\b|\blocked\b|\bburn(?:ed)?\b/i
const SAFETY_RE = /\bsafe\b|\bsafety\b|\bape\b|\brisk(?:y)?\b|\bscam\b|\bhoneypot\b|\brug\b/i
const SCAN_RE = /\bscan\b|\bopen\b|\bcheck\b|\blook\s+up\b|\banalyz|\banalys/i
const EXPLAIN_RE = /^\s*why\??\s*$|\bwhy\s+(?:is|was|did|does)\b|\bexplain\b|\bwhat\s+do\s+you\s+mean\b/i
const WALLET_REF_RE = /\bthat\s+wallet\b|\bthis\s+wallet\b|\bhis\s+wallet\b|\bthe\s+wallet\b/i

export function classifyFollowupIntent(prompt: string, mem: ClarkMemoryView): ClarkFollowupIntent {
  if (extractExplicitAddress(prompt)) return 'explicit_target'
  if (extractRankReference(prompt) != null) return 'rank_reference'
  if (DEPLOYER_LOOKUP_RE.test(prompt)) return 'deployer_lookup'

  const mentionsDeployerNoun = DEPLOYER_NOUN_RE.test(prompt)
  const hasPronoun = DEPLOYER_PRONOUN_RE.test(prompt)
  // A personal pronoun plus rug/scam/history wording ("has he rugged before?") is deployer-directed
  // on its own wording, whether or not a deployer is already remembered — when none is, the
  // resolver turns it into a real deployer LOOKUP against the active token rather than guessing or
  // bailing. A bare pronoun with no such wording is only treated as the deployer when one is
  // actually in memory, so an unrelated "he" in ordinary chat can't hijack the subject.
  if ((mentionsDeployerNoun || hasPronoun) && DEPLOYER_HISTORY_RE.test(prompt)) return 'deployer_history'
  const mentionsDeployerPronoun = hasPronoun && Boolean(mem.activeDeployer)
  if (WALLET_REF_RE.test(prompt) || (mentionsDeployerPronoun && SCAN_RE.test(prompt))) return 'wallet_reference'
  if (mentionsDeployerNoun || mentionsDeployerPronoun) return 'deployer_history'

  if (LIQUIDITY_RE.test(prompt)) return 'liquidity_question'
  if (SAFETY_RE.test(prompt)) return 'safety_question'
  if (EXPLAIN_RE.test(prompt)) return 'explain_previous'
  if (SCAN_RE.test(prompt)) return 'scan_subject'
  return 'none'
}

// ─── Ambiguity ──────────────────────────────────────────────────────────────────────────────────

const AMBIGUITY_WINDOW_MS = 10 * 60 * 1000

/**
 * Two DIFFERENT tokens discussed close together make a bare "it"/"is it safe?" genuinely ambiguous.
 * Detected on chain-scoped identity, so the same token re-scanned on the same chain is never
 * mistaken for two subjects — while the same address on two chains correctly IS two subjects.
 */
export function findCompetingTokens(mem: ClarkMemoryView, now: number): Array<{ address: string; chainSlug: ClarkChain; symbol: string | null }> {
  const active = mem.activeToken
  if (!active) return []
  const recent = mem.recentTokens ?? []
  const activeKey = clarkEntityKey(active.chainSlug, active.tokenAddress)
  const competing = recent.filter(t =>
    now - t.ts <= AMBIGUITY_WINDOW_MS &&
    clarkEntityKey(t.chainSlug, t.address) !== activeKey,
  )
  // Deduplicate by chain-scoped identity so one token mentioned repeatedly isn't counted twice.
  const seen = new Set<string>()
  const out: Array<{ address: string; chainSlug: ClarkChain; symbol: string | null }> = []
  for (const t of competing) {
    const key = clarkEntityKey(t.chainSlug, t.address)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ address: t.address, chainSlug: t.chainSlug, symbol: t.symbol })
  }
  return out
}

function describeToken(t: { symbol: string | null; address: string; chainSlug: ClarkChain }): string {
  const label = t.symbol ?? `${t.address.slice(0, 6)}…${t.address.slice(-4)}`
  const chainName = t.chainSlug === 'robinhood' ? 'Robinhood Chain'
    : t.chainSlug === 'eth' ? 'Ethereum'
    : t.chainSlug === 'bnb' ? 'BNB Chain'
    : t.chainSlug === 'solana' ? 'Solana'
    : 'Base'
  return `${label} on ${chainName}`
}

// ─── Resolver ───────────────────────────────────────────────────────────────────────────────────

function noSubject(intent: ClarkFollowupIntent, reason: string, question: string): ClarkContextResolution {
  return {
    intent,
    resolvedSubjectType: 'none',
    resolvedToken: null,
    resolvedWallet: null,
    resolvedChain: null,
    resolvedDeployer: null,
    confidence: 'low',
    ambiguityReason: reason,
    needsClarification: true,
    clarificationQuestion: question,
    memorySource: 'none',
  }
}

/**
 * Resolves which on-chain subject a Clark message is about.
 *
 * Priority, in strict order (matches the product rule):
 *   1. An explicit address in the current message.
 *   2. A rank reference against the active Radar/Pump list.
 *   3. The active entity in session memory, chosen by the message's intent.
 *   4. The current page's selected scanner context.
 *   5. Ambiguous -> ask, never guess.
 */
export function resolveClarkContext(
  userPrompt: string,
  memory: ClarkMemoryView,
  pageContext: ClarkPageContext = {},
  now: number = Date.now(),
): ClarkContextResolution {
  const prompt = (userPrompt ?? '').trim()
  const intent = classifyFollowupIntent(prompt, memory)

  // ── Priority 1: explicit address in the current message always wins ──────────────────────────
  const explicit = extractExplicitAddress(prompt)
  if (explicit) {
    // Keyed on the address FORMAT, never on a chain word in the prompt.
    const isSolanaMint = explicit.addressFormat === 'solana'
    // An explicit chain word only applies when it is compatible with the address format. A Solana
    // mint can never be an EVM target and an 0x address can never be a Solana one, so a
    // contradictory chain word is ignored rather than allowed to route the address to the wrong
    // scanner. Without an explicit chain, fall back to the active chain, then the page's.
    const resolvedChain: ClarkChain = isSolanaMint
      ? 'solana'
      : (explicit.chain && explicit.chain !== 'solana' ? explicit.chain
        : (memory.activeToken?.chainSlug && memory.activeToken.chainSlug !== 'solana' ? memory.activeToken.chainSlug
          : (pageContext.chainSlug && pageContext.chainSlug !== 'solana' ? pageContext.chainSlug : 'base')))
    return {
      intent: 'explicit_target',
      resolvedSubjectType: 'token',
      resolvedToken: explicit.address,
      resolvedWallet: null,
      resolvedChain,
      resolvedDeployer: null,
      confidence: 'high',
      ambiguityReason: null,
      needsClarification: false,
      clarificationQuestion: null,
      memorySource: 'explicit_prompt',
    }
  }

  // ── Priority 2: rank reference against the active list ───────────────────────────────────────
  const rank = extractRankReference(prompt)
  if (rank != null) {
    const list = memory.activeList
    if (!list || list.items.length === 0) {
      return noSubject('rank_reference', 'A rank was referenced but no Radar or Pump list is in memory.',
        'I don\'t have a ranked list in this session yet. Want me to pull up Base Radar or Pump Alerts first?')
    }
    const item = list.items.find(i => i.rank === rank)
    if (!item) {
      return noSubject('rank_reference', `Rank ${rank} is outside the remembered list of ${list.items.length}.`,
        `That list only has ${list.items.length} entries — which rank did you mean?`)
    }
    return {
      intent: 'rank_reference',
      resolvedSubjectType: 'list_item',
      resolvedToken: item.address.toLowerCase(),
      resolvedWallet: null,
      resolvedChain: list.chainSlug,
      resolvedDeployer: null,
      confidence: 'high',
      ambiguityReason: null,
      needsClarification: false,
      clarificationQuestion: null,
      memorySource: 'active_list_rank',
    }
  }

  // ── Priority 3: active entity, selected by intent ────────────────────────────────────────────

  // Deployer-directed questions resolve to the remembered deployer.
  if (intent === 'deployer_history' || intent === 'wallet_reference') {
    const dep = memory.activeDeployer
    if (dep) {
      return {
        intent,
        resolvedSubjectType: 'deployer',
        resolvedToken: dep.sourceTokenAddress,
        resolvedWallet: dep.address,
        resolvedChain: dep.chainSlug,
        resolvedDeployer: dep.address,
        confidence: dep.confidence,
        ambiguityReason: null,
        needsClarification: false,
        clarificationQuestion: null,
        memorySource: 'active_deployer',
      }
    }
    // "that wallet" with a scanned wallet but no deployer resolves to the wallet.
    if (intent === 'wallet_reference' && memory.activeWallet) {
      const w = memory.activeWallet
      return {
        intent,
        resolvedSubjectType: 'wallet',
        resolvedToken: null,
        resolvedWallet: w.walletAddress,
        resolvedChain: w.chainSlug,
        resolvedDeployer: null,
        confidence: 'high',
        ambiguityReason: null,
        needsClarification: false,
        clarificationQuestion: null,
        memorySource: 'active_wallet',
      }
    }
    // A deployer question with a known token but no resolved deployer is a real lookup, not a
    // failure — the route runs the deployer lookup against the active token.
    if (memory.activeToken) {
      const t = memory.activeToken
      return {
        intent: 'deployer_lookup',
        resolvedSubjectType: 'token',
        resolvedToken: t.tokenAddress,
        resolvedWallet: null,
        resolvedChain: t.chainSlug,
        resolvedDeployer: null,
        confidence: 'medium',
        ambiguityReason: null,
        needsClarification: false,
        clarificationQuestion: null,
        memorySource: 'active_token',
      }
    }
    return noSubject(intent, 'A deployer was referenced but no deployer or token is in memory.',
      'Which token\'s deployer do you mean? Paste the contract address and I\'ll pull it up.')
  }

  // "who deployed it?" — needs the active token to look the deployer up against.
  if (intent === 'deployer_lookup') {
    const t = memory.activeToken
    if (!t) {
      return noSubject(intent, 'A deployer lookup was requested but no active token is in memory.',
        'Which token? Paste the contract address and I\'ll find the deployer.')
    }
    const competing = findCompetingTokens(memory, now)
    if (competing.length > 0) {
      return {
        intent, resolvedSubjectType: 'none', resolvedToken: null, resolvedWallet: null,
        resolvedChain: null, resolvedDeployer: null, confidence: 'low',
        ambiguityReason: `${competing.length + 1} tokens discussed recently.`,
        needsClarification: true,
        clarificationQuestion: `You've discussed a few tokens recently. Do you mean ${describeToken({ symbol: t.symbol, address: t.tokenAddress, chainSlug: t.chainSlug })} or ${describeToken(competing[0])}?`,
        memorySource: 'none',
      }
    }
    return {
      intent, resolvedSubjectType: 'token', resolvedToken: t.tokenAddress, resolvedWallet: null,
      resolvedChain: t.chainSlug, resolvedDeployer: t.deployerAddress ?? null,
      confidence: 'high', ambiguityReason: null, needsClarification: false,
      clarificationQuestion: null, memorySource: 'active_token',
    }
  }

  // Token-directed follow-ups: liquidity, safety, explain, scan, bare reference.
  const tokenDirected = intent === 'liquidity_question' || intent === 'safety_question'
    || intent === 'explain_previous' || intent === 'scan_subject' || intent === 'none'

  if (tokenDirected) {
    const t = memory.activeToken
    const w = memory.activeWallet

    // A liquidity question is always about a token — a wallet has no liquidity.
    const walletIsStronger = Boolean(w && (!t || w.ts > t.ts)) && intent !== 'liquidity_question'

    if (t && !walletIsStronger) {
      const competing = findCompetingTokens(memory, now)
      if (competing.length > 0) {
        return {
          intent, resolvedSubjectType: 'none', resolvedToken: null, resolvedWallet: null,
          resolvedChain: null, resolvedDeployer: null, confidence: 'low',
          ambiguityReason: `${competing.length + 1} tokens discussed recently.`,
          needsClarification: true,
          clarificationQuestion: `You've discussed more than one token recently. Do you mean ${describeToken({ symbol: t.symbol, address: t.tokenAddress, chainSlug: t.chainSlug })} or ${describeToken(competing[0])}?`,
          memorySource: 'none',
        }
      }
      return {
        intent, resolvedSubjectType: 'token', resolvedToken: t.tokenAddress, resolvedWallet: null,
        resolvedChain: t.chainSlug, resolvedDeployer: t.deployerAddress ?? null,
        confidence: 'high', ambiguityReason: null, needsClarification: false,
        clarificationQuestion: null, memorySource: 'active_token',
      }
    }

    if (w) {
      return {
        intent, resolvedSubjectType: 'wallet', resolvedToken: null, resolvedWallet: w.walletAddress,
        resolvedChain: w.chainSlug, resolvedDeployer: null,
        confidence: 'high', ambiguityReason: null, needsClarification: false,
        clarificationQuestion: null, memorySource: 'active_wallet',
      }
    }

    // ── Priority 4: the page's own selected scanner context ────────────────────────────────────
    if (pageContext.selectedTokenAddress) {
      return {
        intent, resolvedSubjectType: 'token',
        resolvedToken: pageContext.selectedTokenAddress.toLowerCase(), resolvedWallet: null,
        resolvedChain: pageContext.chainSlug ?? 'base', resolvedDeployer: null,
        confidence: 'medium', ambiguityReason: null, needsClarification: false,
        clarificationQuestion: null, memorySource: 'page_context',
      }
    }
    if (pageContext.selectedWalletAddress) {
      return {
        intent, resolvedSubjectType: 'wallet', resolvedToken: null,
        resolvedWallet: pageContext.selectedWalletAddress.toLowerCase(),
        resolvedChain: pageContext.chainSlug ?? 'base', resolvedDeployer: null,
        confidence: 'medium', ambiguityReason: null, needsClarification: false,
        clarificationQuestion: null, memorySource: 'page_context',
      }
    }
  }

  // ── Priority 5: nothing to resolve against ───────────────────────────────────────────────────
  return {
    intent,
    resolvedSubjectType: 'none',
    resolvedToken: null,
    resolvedWallet: null,
    resolvedChain: null,
    resolvedDeployer: null,
    confidence: 'low',
    ambiguityReason: intent === 'none' ? null : 'No active token or wallet in this session to resolve the reference against.',
    needsClarification: intent !== 'none',
    clarificationQuestion: intent === 'none' ? null : 'Which token or wallet do you mean? Paste an address and I\'ll take it from there.',
    memorySource: 'none',
  }
}

// ─── Audit ──────────────────────────────────────────────────────────────────────────────────────

export type ClarkContextMemoryAudit = {
  chatId: string
  messageId: string
  userPrompt: string
  parsedIntent: ClarkFollowupIntent
  explicitAddressFound: string | null
  explicitChainFound: ClarkChain | null
  previousActiveToken: string | null
  previousActiveWallet: string | null
  previousActiveDeployer: string | null
  previousActiveList: string | null
  resolvedSubjectType: ClarkSubjectType
  resolvedAddress: string | null
  resolvedChainSlug: ClarkChain | null
  memorySource: ClarkMemorySource
  confidence: 'high' | 'medium' | 'low'
  needsClarification: boolean
  clarificationReason: string | null
  memoryUpdated: boolean
}

/**
 * Builds the per-message context audit. Every resolution decision is recorded — including the
 * memory that was available BEFORE resolution — so a wrong subject can be diagnosed after the fact
 * rather than guessed at. Addresses only; never message content beyond the prompt itself.
 */
export function buildClarkContextMemoryAudit(args: {
  chatId: string
  messageId: string
  userPrompt: string
  memory: ClarkMemoryView
  resolution: ClarkContextResolution
  memoryUpdated: boolean
}): ClarkContextMemoryAudit {
  const { chatId, messageId, userPrompt, memory, resolution, memoryUpdated } = args
  const explicit = extractExplicitAddress(userPrompt)
  return {
    chatId,
    messageId,
    userPrompt,
    parsedIntent: resolution.intent,
    explicitAddressFound: explicit?.address ?? null,
    explicitChainFound: explicit?.chain ?? extractExplicitChain(userPrompt),
    previousActiveToken: memory.activeToken
      ? clarkEntityKey(memory.activeToken.chainSlug, memory.activeToken.tokenAddress) : null,
    previousActiveWallet: memory.activeWallet
      ? clarkEntityKey(memory.activeWallet.chainSlug, memory.activeWallet.walletAddress) : null,
    previousActiveDeployer: memory.activeDeployer
      ? clarkEntityKey(memory.activeDeployer.chainSlug, memory.activeDeployer.address) : null,
    previousActiveList: memory.activeList
      ? `${memory.activeList.kind}:${memory.activeList.chainSlug}:${memory.activeList.items.length}` : null,
    resolvedSubjectType: resolution.resolvedSubjectType,
    resolvedAddress: resolution.resolvedWallet ?? resolution.resolvedToken,
    resolvedChainSlug: resolution.resolvedChain,
    memorySource: resolution.memorySource,
    confidence: resolution.confidence,
    needsClarification: resolution.needsClarification,
    clarificationReason: resolution.ambiguityReason,
    memoryUpdated,
  }
}
