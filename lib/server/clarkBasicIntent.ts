// CLARK-BASIC-INTENT: isolated, additive module. Classifies a Clark prompt into one of
// the basic/chat intents before any tool routing or provider calls happen, and answers
// greeting/basic_question/product_help/general_crypto_question directly with no provider
// calls. Does not touch token/wallet/whale/radar scan execution — those stay on the
// existing routing path in app/api/clark/route.ts.

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

const ADDRESS_RE = /0x[a-fA-F0-9]{40}/

const DIRECT_ANSWER_INTENTS = new Set<ClarkBasicIntent>([
  'greeting', 'basic_question', 'product_help', 'general_crypto_question',
])

const GREETING_RE = /^\s*(hi|hello|hey|yo|sup|gm|good\s*morning|good\s*evening|good\s*afternoon)[\s!.,]*$/i

const PRODUCT_HELP_RE = /\b(what\s+can\s+you\s+do|what\s+do\s+you\s+do|help\b|how\s+do\s+i\s+use|how\s+does\s+chainlens\s+work|what\s+is\s+chainlens|what\s+is\s+clark\b|who\s+are\s+you|explain\s+this\s+dashboard|how\s+do\s+i\s+scan\s+a\s+wallet|how\s+do\s+i\s+scan\s+a\s+token|how\s+do\s+i\s+get\s+started)\b/i

// Glossary covers the explicit "basic examples" the spec lists; keys are matched as substrings
// against the normalized prompt. Order matters — first match wins.
const GLOSSARY: Array<{ re: RegExp; answer: string }> = [
  { re: /\bwhat\s+is\s+base\b/i, answer: "Base is a low-cost Ethereum Layer 2 chain built by Coinbase. ChainLens scans tokens and wallets on Base by default, alongside Ethereum and other supported chains." },
  { re: /\bwhat\s+is\s+a?\s*token\s+scanner\b/i, answer: "Token Scanner checks a token contract for safety signals — liquidity lock, ownership/mint risk, holder concentration, and honeypot/tax checks — and gives a risk read. It needs a token contract address." },
  { re: /\bwhat\s+is\s+pnl\b/i, answer: "PnL (profit and loss) is how much a wallet has made or lost on its closed trades. ChainLens only reports PnL as \"verified\" once enough closed lots with known cost basis exist — otherwise it stays locked or shown as a limited/estimated read." },
  { re: /\bwhy\s+is\s+(?:my\s+)?wallet\s+pnl\s+locked\b|\bwhy\s+is\s+pnl\s+locked\b/i, answer: "Wallet PnL stays locked until ChainLens can verify enough closed trades with known cost basis (currently 10+ public-grade closed lots). Until then it shows a partial/estimated read instead of an official number, so it's never guessed." },
  { re: /\bwhat\s+does\s+open\s+check\s+mean\b/i, answer: "\"Open Check\" means that part of the read (PnL, activity, pricing, etc.) hasn't been verified yet — not that it's bad. It usually clears after a deep scan recovers more evidence." },
  { re: /\bhow\s+do\s+i\s+scan\s+a\s+wallet\b/i, answer: "Paste a wallet address (0x...) here, or open Wallet Scanner from the terminal — I can route you there directly." },
  { re: /\bhow\s+do\s+i\s+scan\s+a\s+token\b/i, answer: "Paste a token contract address (0x...) here, or open Token Scanner from the terminal — I can route you there directly." },
  { re: /\bwhat\s+is\s+clark\b/i, answer: "I'm Clark, ChainLens' onchain AI assistant. I can explain ChainLens features, answer general crypto questions, and route you to Token Scanner, Wallet Scanner, Whale Alerts, or Base Radar when you give me an address or ask for a scan." },
  { re: /\bexplain\s+this\s+dashboard\b/i, answer: "This terminal gives you live tools: Token Scanner (contract safety), Wallet Scanner (holdings + PnL), Whale Alerts (large wallet activity), and Base Radar (trending Base tokens). Ask me to explain any of them, or give me an address to scan." },
  { re: /\bwhat\s+does\s+lp\s+locked\s+mean\b/i, answer: "\"LP locked\" means the liquidity pool tokens are time-locked or burned so the deployer can't pull liquidity and rug the pool. Locked/burned LP is generally safer than liquidity controlled by an unlocked wallet." },
  { re: /\bwhat\s+does\s+honeypot\s+mean\b/i, answer: "A honeypot is a token contract that lets you buy but blocks or heavily taxes selling, trapping buyers' funds. Token Scanner checks for honeypot behavior as part of its safety read." },
]

const GENERAL_CRYPTO_RE = /\b(what\s+is\s+(?:a\s+)?(?:gas|wallet|smart\s+contract|dex|liquidity|market\s+cap|slippage|stablecoin|airdrop|bridge)|how\s+does\s+(?:a\s+)?(?:dex|swap|gas|bridge)\s+work)\b/i

const SCAN_REQUEST_NO_ADDRESS_TOKEN_RE = /\b(scan\s+(?:this\s+)?token|check\s+(?:this\s+)?token|token\s+scan)\b/i
const SCAN_REQUEST_NO_ADDRESS_WALLET_RE = /\b(scan\s+(?:this\s+)?wallet|check\s+(?:this\s+)?wallet|wallet\s+scan|scan\s+wallet|or\s+wallet)\b/i
const WHALE_RE = /\b(whale\s+alerts?|whales?|big\s+wallets?|large\s+wallets?)\b/i
const BASE_RADAR_RE = /\b(base\s+radar|what'?s\s+pumping|trending\s+on\s+base)\b/i

function normalize(message: string): string {
  return message.toLowerCase().trim()
}

export function classifyClarkBasicIntent(message: string): ClarkBasicIntent {
  const raw = String(message ?? '')
  const t = normalize(raw)
  if (!t) return 'unsupported_request'

  if (GREETING_RE.test(t)) return 'greeting'

  const hasAddress = ADDRESS_RE.test(raw)
  const wantsToken = SCAN_REQUEST_NO_ADDRESS_TOKEN_RE.test(t)
  const wantsWallet = SCAN_REQUEST_NO_ADDRESS_WALLET_RE.test(t)

  if (wantsToken && wantsWallet) return 'ambiguous_scan_request'
  if (wantsToken) return 'token_scan_request'
  if (wantsWallet) return 'wallet_scan_request'
  if (hasAddress) return 'unsupported_request' // has address + no explicit scan word — let existing routing decide
  if (WHALE_RE.test(t)) return 'whale_alerts_request'
  if (BASE_RADAR_RE.test(t)) return 'base_radar_request'

  if (PRODUCT_HELP_RE.test(t)) return 'product_help'
  if (GLOSSARY.some((g) => g.re.test(t))) return 'basic_question'
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
    return "Hey — I'm Clark. Ask me about ChainLens, wallets, tokens, or paste an address and I'll scan it."
  }
  if (intent === 'product_help') {
    if (/what\s+can\s+you\s+do|what\s+do\s+you\s+do/.test(t)) {
      return "I can explain ChainLens features, answer general crypto/onchain questions, and run scans when you give me an address: Token Scanner (contract safety), Wallet Scanner (holdings + PnL), Whale Alerts (large wallet activity), and Base Radar (trending Base tokens)."
    }
    if (/how\s+does\s+chainlens\s+work/.test(t)) {
      return "ChainLens pulls live onchain data and runs it through safety/PnL checks. Give me a token contract or wallet address (or use the terminal tools directly) and I'll walk you through the read."
    }
    if (/what\s+is\s+chainlens/.test(t)) {
      return "ChainLens is an onchain intelligence platform — token safety scanning, wallet PnL/holdings analysis, whale tracking, and Base trending discovery, all in one terminal."
    }
    const match = GLOSSARY.find((g) => g.re.test(t))
    if (match) return match.answer
    return "I can explain ChainLens, walk you through any terminal tool, or run a scan if you give me a wallet address or token contract."
  }
  if (intent === 'basic_question') {
    const match = GLOSSARY.find((g) => g.re.test(t))
    if (match) return match.answer
    return "I can help explain that, or run a scan if you give me a wallet address or token contract."
  }
  if (intent === 'general_crypto_question') {
    if (/\bgas\b/.test(t)) return "Gas is the fee paid to validators/miners to process a transaction onchain. It varies with network congestion."
    if (/\bwallet\b/.test(t)) return "A crypto wallet holds the private keys that control your onchain funds. ChainLens never asks for private keys — we only read public addresses."
    if (/\bsmart\s+contract\b/.test(t)) return "A smart contract is self-executing code deployed onchain. Tokens, DEX pools, and most DeFi apps are smart contracts."
    if (/\bdex\b|\bswap\b/.test(t)) return "A DEX (decentralized exchange) lets you swap tokens directly from a liquidity pool, without a centralized order book."
    if (/\bliquidity\b/.test(t)) return "Liquidity is the funds sitting in a trading pool that let people buy/sell a token without huge price impact. Low liquidity means more slippage and easier price manipulation."
    if (/\bmarket\s+cap\b/.test(t)) return "Market cap is token price multiplied by circulating supply — a rough size measure, not a safety signal on its own."
    if (/\bslippage\b/.test(t)) return "Slippage is the difference between the expected and actual trade price, usually caused by low liquidity or fast price moves."
    if (/\bstablecoin\b/.test(t)) return "A stablecoin is a token designed to hold a steady value, usually pegged to a currency like USD (e.g. USDC, USDT)."
    if (/\bairdrop\b/.test(t)) return "An airdrop is a free token distribution, often to reward early users or community members of a project."
    if (/\bbridge\b/.test(t)) return "A bridge moves assets between blockchains, usually by locking tokens on one chain and minting a representation on another."
    return "That's a general crypto question — happy to explain further, or I can run a scan if you give me an address."
  }
  return null
}

export function clarkMissingInputPrompt(intent: ClarkBasicIntent): string | null {
  if (intent === 'token_scan_request') return "Paste the token contract address (0x...) and I'll scan it."
  if (intent === 'wallet_scan_request') return "Paste the wallet address (0x...) and I'll scan it."
  if (intent === 'ambiguous_scan_request') return "Do you want me to scan a token contract or a wallet address? Paste the address and tell me which, and I'll run it."
  return null
}

export const CLARK_SAFE_FALLBACK =
  "I can help explain ChainLens, wallets, tokens, Base, scanner results, or run a scan if you give me a wallet address or token contract."

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
