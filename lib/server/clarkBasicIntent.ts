// CLARK-BASIC-INTENT: isolated, additive module. Classifies a Clark prompt into one of
// the basic/chat intents before any tool routing or provider calls happen, and answers
// greeting/basic_question/product_help/general_crypto_question directly with no provider
// calls. Does not touch token/wallet/whale/radar scan execution — those stay on the
// existing routing path in app/api/clark/route.ts.

import { isValidSolanaMintAddress } from '../solanaAddress'
import { extractAddressForRouting } from './clarkRouting'
import { isClarkCanonicalMarketPrompt } from './clarkMarketIntent'
import {
  CANNED_REPLIES, GLOSSARY, GREETING_RE, SLASH_WALLET_RE, SLASH_TOKEN_RE, PRODUCT_HELP_RE, GENERAL_CRYPTO_RE, SCAN_REQUEST_NO_ADDRESS_TOKEN_RE, SCAN_REQUEST_NO_ADDRESS_WALLET_RE, WHALE_RE, BASE_RADAR_RE,
} from '@/lib/clark/knowledge'

export type ClarkBasicIntent =
  | 'greeting'
  | 'basic_question'
  | 'product_help'
  | 'general_crypto_question'
  | 'token_scan_request'
  | 'wallet_scan_request'
  | 'whale_alerts_request'
  | 'base_radar_request'
  | 'ambiguous_scan_request'
  | 'unsupported_request'

export type ClarkRoutingDebug = {
  intent: ClarkBasicIntent | null
  answeredDirectly: boolean
  providerCallsAdded: number
  routeUsed: string | null
  missingInput: string | null
  reason: string
}

// TRUNCATED-ADDRESS FIX, DISCLOSED (see app/api/clark/route.ts's extractAddress): the lookahead
// stops a malformed 41+-char hex run from being silently truncated into a different real address.
const ADDRESS_RE = /0x[a-fA-F0-9]{40}(?![a-fA-F0-9])/

const DIRECT_ANSWER_INTENTS = new Set<ClarkBasicIntent>([
  'greeting', 'basic_question', 'product_help', 'general_crypto_question',
])



// Glossary covers the explicit "basic examples" the spec lists; keys are matched as substrings
// against the normalized prompt. Order matters — first match wins.

// "analyze" ADDED, DISCLOSED (Clark right-panel suggestion-button audit): the right panel's own
// "Analyze this wallet" suggestion (components/ClarkRadar.tsx's HINT_CHIPS) previously matched
// neither this regex nor route.ts's own WALLET_SCAN_PATTERNS_RE (both required "scan"/"check"
// immediately before "wallet", or "analyze wallet" with no "this" in between — "analyze this
// wallet" satisfies none of them). It still ultimately reached a correct "ask for a wallet
// address" answer via detectIntent()'s broad `/wallet/.test(t)` fallback deep in route.ts, but
// only by missing this module's own explicit guarantee (see this file's header) of a zero-
// provider-call direct answer for a no-address scan request — a real, narrow gap for the one
// prompt this module exists to catch that it didn't. Adding "analyze" as a synonym alongside
// "scan"/"check" (both directions, for symmetry) closes it without changing anything else this
// regex already matched.

function normalize(message: string): string {
  return message.toLowerCase().trim()
}

export function classifyClarkBasicIntent(message: string): ClarkBasicIntent {
  const raw = String(message ?? '')
  const t = normalize(raw)
  if (!t) return 'unsupported_request'

  if (GREETING_RE.test(t)) return 'greeting'
  if (SLASH_WALLET_RE.test(t)) return 'wallet_scan_request'
  if (SLASH_TOKEN_RE.test(t)) return 'token_scan_request'

  const hasAddress = ADDRESS_RE.test(raw)
  const wantsToken = SCAN_REQUEST_NO_ADDRESS_TOKEN_RE.test(t)
  const wantsWallet = SCAN_REQUEST_NO_ADDRESS_WALLET_RE.test(t)

  if (wantsToken && wantsWallet) return 'ambiguous_scan_request'
  if (wantsToken) return 'token_scan_request'
  if (wantsWallet) return 'wallet_scan_request'
  if (hasAddress) return 'unsupported_request' // has address + no explicit scan word — let existing routing decide

  // ETH/BTC/SOL price (and the other canonical tickers) must not be answered as generic chat.
  if (isClarkCanonicalMarketPrompt(raw)) return 'unsupported_request'

  // Exact ChainLens glossary questions are education, not live-feed commands. This must precede
  // the broad whale/radar keyword routes so "Explain Whale Alerts" and "Explain Base Radar"
  // describe the product instead of unexpectedly opening/fetching a feed.
  if (GLOSSARY.some((g) => g.re.test(t))) return 'basic_question'
  if (WHALE_RE.test(t)) return 'whale_alerts_request'
  if (BASE_RADAR_RE.test(t)) return 'base_radar_request'

  if (PRODUCT_HELP_RE.test(t)) return 'product_help'
  if (GENERAL_CRYPTO_RE.test(t)) return 'general_crypto_question'

  // Short, question-shaped prompts with no scan/tool keyword default to basic_question so
  // Clark never silently falls through to "could not complete" for ordinary chat.
  if (/^(what|how|why|who|when|where|can you|do you|does)\b/.test(t) && t.length < 140) return 'basic_question'

  return 'unsupported_request'
}

export function buildClarkDirectAnswer(intent: ClarkBasicIntent, message: string): string | null {
  if (!DIRECT_ANSWER_INTENTS.has(intent)) return null
  const t = normalize(message)

  if (intent === 'greeting') {
    // COMPACT-GREETING FIX, DISCLOSED (Clark AI conversation polish): the full intro paragraph
    // used to repeat on every casual "hi"/"hey", producing near-duplicate low-value replies and
    // chat-history entries. A greeting now gets a short, useful nudge instead — the full intro
    // is shown once by the page's own empty-state UI (app/terminal/clark-ai/page.tsx), not
    // re-sent as a chat message every time someone says hi.
    return CANNED_REPLIES.direct1
  }
  if (intent === 'product_help') {
    if (/what\s+can\s+you\s+do|what\s+do\s+you\s+do/.test(t)) {
      return CANNED_REPLIES.direct2
    }
    if (/how\s+does\s+chainlens\s+work/.test(t)) {
      return CANNED_REPLIES.direct3
    }
    if (/what\s+is\s+chainlens/.test(t)) {
      return CANNED_REPLIES.direct4
    }
    const match = GLOSSARY.find((g) => g.re.test(t))
    if (match) return match.answer
    return CANNED_REPLIES.direct5
  }
  if (intent === 'basic_question') {
    const match = GLOSSARY.find((g) => g.re.test(t))
    if (match) return match.answer
    return CANNED_REPLIES.direct6
  }
  if (intent === 'general_crypto_question') {
    if (/\bgas\b/.test(t)) return CANNED_REPLIES.direct7
    if (/\bwallet\b/.test(t)) return CANNED_REPLIES.direct8
    if (/\bsmart\s+contract\b/.test(t)) return CANNED_REPLIES.direct9
    if (/\bdex\b|\bswap\b/.test(t)) return CANNED_REPLIES.direct10
    if (/\bliquidity\b/.test(t)) return CANNED_REPLIES.direct11
    if (/\bmarket\s+cap\b/.test(t)) return CANNED_REPLIES.direct12
    if (/\bslippage\b/.test(t)) return CANNED_REPLIES.direct13
    if (/\bstablecoin\b/.test(t)) return CANNED_REPLIES.direct14
    if (/\bairdrop\b/.test(t)) return CANNED_REPLIES.direct15
    if (/\bbridge\b/.test(t)) return CANNED_REPLIES.direct16
    return CANNED_REPLIES.direct17
  }
  return null
}

export function clarkMissingInputPrompt(intent: ClarkBasicIntent, message?: string): string | null {
  const raw = String(message ?? '')
  const t = normalize(raw)
  // A classified scan request that already contains a valid address must continue to the real
  // scanner route. Previously this helper still returned "paste an address", blocking both
  // "analyze this wallet: 0x..." and "scan this token: 0x..." before tool execution.
  //
  // SOLANA-ADDRESS-BLIND FIX, DISCLOSED (same bug class as app/api/clark/route.ts's hasAnyAddress,
  // caught by a test added in another session's merge: "scan this token <Solana mint>" still
  // answered "Paste the token contract address (0x...)" even with a real Solana address right
  // there, because ADDRESS_RE only ever matches 0x-EVM shapes). Checked separately from ADDRESS_RE
  // (not folded into it) since a Solana mint is base58, never 0x-prefixed.
  if (ADDRESS_RE.test(raw) || isValidSolanaMintAddress(extractAddressForRouting(raw) ?? '')) return null
  // SLASH-COMMAND WORDING, DISCLOSED (Clark AI conversation polish): /wallet and /token with no
  // input use the exact short copy the spec asks for; every other route into the same intents
  // (e.g. "scan wallet" with no address) keeps its existing, slightly more explicit wording.
  if (intent === 'wallet_scan_request' && SLASH_WALLET_RE.test(t)) return CANNED_REPLIES.missingInput1
  if (intent === 'token_scan_request' && SLASH_TOKEN_RE.test(t)) return CANNED_REPLIES.missingInput2
  if (intent === 'token_scan_request') return CANNED_REPLIES.missingInput3
  if (intent === 'wallet_scan_request') return CANNED_REPLIES.missingInput4
  if (intent === 'ambiguous_scan_request') return CANNED_REPLIES.missingInput5
  return null
}

export { CLARK_SAFE_FALLBACK } from '@/lib/clark/knowledge'

export function buildClarkRoutingDebug(input: {
  intent: ClarkBasicIntent | null
  answeredDirectly: boolean
  providerCallsAdded: number
  routeUsed: string | null
  missingInput: string | null
  reason: string
}): ClarkRoutingDebug {
  return { ...input }
}
