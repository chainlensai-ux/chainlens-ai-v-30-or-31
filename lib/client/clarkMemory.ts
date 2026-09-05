'use client'

// Shared Clark client session + memory helper. Every Clark frontend surface (the full
// /terminal/clark-ai page, the /terminal embedded ClarkRadar widget, the global mobile drawer,
// the home Clark panel) must use these functions instead of keeping its own copy, so a wallet or
// token scan made on one surface is immediately visible as memory/context on every other surface.

const SESSION_ID_KEY = 'chainlens:clark-session-id'
const LAST_WALLET_KEY = 'chainlens:clark:last-wallet'
const RECENT_WALLETS_KEY = 'chainlens:clark:recent-wallets'
const LAST_TOKEN_KEY = 'chainlens:clark:last-token'
const RECENT_TOKENS_KEY = 'chainlens:clark:recent-tokens'
const LAST_MOMENTUM_LIST_KEY = 'chainlens:clark:last-momentum-list'
const LAST_MOMENTUM_SHOWN_COUNT_KEY = 'chainlens:clark:last-momentum-shown-count'
// COLD-START MEMORY, DISCLOSED (Clark memory audit): the backend's SESSION_MEMORY is a
// process-local Map, so on a serverless instance switch only what the client can send back
// survives. Token/wallet/momentum already round-tripped; the deployer and the Radar list did not,
// so mid-conversation follow-ups like "has he rugged before?" and "scan number 2" broke as soon as
// the request landed on a cold instance. These mirror those two entities the same way.
const LAST_DEPLOYER_KEY = 'chainlens:clark:last-deployer'
const LAST_RADAR_LIST_KEY = 'chainlens:clark:last-radar-list'
const LAST_RADAR_CHAIN_KEY = 'chainlens:clark:last-radar-chain'
const LAST_RADAR_TS_KEY = 'chainlens:clark:last-radar-ts'
const LAST_CHAIN_KEY = 'chainlens:clark:last-chain'
const LAST_CLARK_SUBJECT_KEY = 'chainlens:clark:last-clark-subject'
const PREV_CLARK_SUBJECT_KEY = 'chainlens:clark:prev-clark-subject'
const LAST_TICKER_MATCHES_KEY = 'chainlens:clark:last-ticker-matches'
const TICKER_SEARCH_ID_KEY = 'chainlens:clark:ticker-search-id'

/** Stable Clark session id. Created once per browser session, reused forever — never regenerated per message. */
export function getClarkSessionId(): string {
  if (typeof window === 'undefined') return 'ssr'
  let id = sessionStorage.getItem(SESSION_ID_KEY)
  if (!id) {
    id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    sessionStorage.setItem(SESSION_ID_KEY, id)
  }
  return id
}

export type ClarkClientContext = {
  lastWallet?: unknown | null
  recentWallets?: unknown[]
  lastToken?: unknown | null
  recentTokens?: unknown[]
  lastMomentumList?: unknown[]
  lastMomentumShownCount?: number
  lastDeployer?: unknown | null
  lastRadarList?: unknown[]
  lastRadarChain?: string | null
  lastRadarTs?: number
  lastChain?: string | null
  lastClarkSubject?: unknown | null
  prevClarkSubject?: unknown | null
  lastTickerMatches?: unknown[]
  tickerSearchId?: string | null
}

function readJson(key: string): unknown {
  if (typeof window === 'undefined') return null
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? 'null')
  } catch {
    return null
  }
}

/** Reads the wallet/token memory shared across every Clark surface from sessionStorage. */
export function readClarkClientContext(): ClarkClientContext {
  if (typeof window === 'undefined') return {}
  return {
    lastWallet: readJson(LAST_WALLET_KEY) ?? undefined,
    recentWallets: (readJson(RECENT_WALLETS_KEY) as unknown[] | null) ?? undefined,
    lastToken: readJson(LAST_TOKEN_KEY) ?? undefined,
    recentTokens: (readJson(RECENT_TOKENS_KEY) as unknown[] | null) ?? undefined,
    lastMomentumList: (readJson(LAST_MOMENTUM_LIST_KEY) as unknown[] | null) ?? undefined,
    lastMomentumShownCount: Number(sessionStorage.getItem(LAST_MOMENTUM_SHOWN_COUNT_KEY) ?? '0') || 0,
    lastDeployer: readJson(LAST_DEPLOYER_KEY) ?? undefined,
    lastRadarList: (readJson(LAST_RADAR_LIST_KEY) as unknown[] | null) ?? undefined,
    lastRadarChain: sessionStorage.getItem(LAST_RADAR_CHAIN_KEY) ?? undefined,
    lastRadarTs: Number(sessionStorage.getItem(LAST_RADAR_TS_KEY) ?? '0') || undefined,
    lastChain: sessionStorage.getItem(LAST_CHAIN_KEY) ?? undefined,
    lastClarkSubject: readJson(LAST_CLARK_SUBJECT_KEY) ?? undefined,
    prevClarkSubject: readJson(PREV_CLARK_SUBJECT_KEY) ?? undefined,
    lastTickerMatches: (readJson(LAST_TICKER_MATCHES_KEY) as unknown[] | null) ?? undefined,
    tickerSearchId: sessionStorage.getItem(TICKER_SEARCH_ID_KEY) ?? undefined,
  }
}

/** Persists a Clark API response's memoryEcho into the shared sessionStorage keys every surface reads from. */
export function persistClarkMemoryEcho(payload: unknown): void {
  if (typeof window === 'undefined') return
  if (!payload || typeof payload !== 'object') return
  const memoryEcho = (payload as Record<string, unknown>).memoryEcho
  if (!memoryEcho || typeof memoryEcho !== 'object') return
  const echo = memoryEcho as Record<string, unknown>

  const payloadChain = (payload as Record<string, unknown>).chain
  if (typeof payloadChain === 'string' && payloadChain.trim()) {
    sessionStorage.setItem(LAST_CHAIN_KEY, payloadChain.trim())
  }

  const lastWallet = echo.lastWallet as { address?: unknown } | undefined
  if (lastWallet && typeof lastWallet === 'object' && typeof lastWallet.address === 'string') {
    const walletAddress = lastWallet.address.trim()
    if (walletAddress && walletAddress !== '?' && walletAddress.toLowerCase() !== 'none yet') {
      sessionStorage.setItem(LAST_WALLET_KEY, JSON.stringify({ ...lastWallet, address: walletAddress }))
      const walletChain = (lastWallet as { chain?: unknown }).chain
      if (typeof walletChain === 'string' && walletChain.trim()) {
        sessionStorage.setItem(LAST_CHAIN_KEY, walletChain.trim())
      }
    }
  }
  if (Array.isArray(echo.recentWallets)) {
    sessionStorage.setItem(RECENT_WALLETS_KEY, JSON.stringify(echo.recentWallets))
  }

  const lastToken = echo.lastToken as { address?: unknown; mint?: unknown; tokenAddress?: unknown; chain?: unknown } | undefined
  if (lastToken && typeof lastToken === 'object') {
    const tokenAddress =
      (typeof lastToken.address === 'string' && lastToken.address) ||
      (typeof lastToken.mint === 'string' && lastToken.mint) ||
      (typeof lastToken.tokenAddress === 'string' && lastToken.tokenAddress) ||
      null
    if (tokenAddress) {
      sessionStorage.setItem(LAST_TOKEN_KEY, JSON.stringify({ ...lastToken, address: tokenAddress }))
    }
    if (typeof lastToken.chain === 'string' && lastToken.chain.trim()) {
      sessionStorage.setItem(LAST_CHAIN_KEY, lastToken.chain.trim())
    }
  }
  if (Array.isArray(echo.recentTokens)) {
    sessionStorage.setItem(RECENT_TOKENS_KEY, JSON.stringify(echo.recentTokens))
  }

  // Deployer + Radar list: only ever written when the echo carries a real value, so a response that
  // simply didn't touch them can never erase a deployer or list resolved earlier in the session.
  const lastDeployer = echo.lastDeployer as { address?: unknown } | undefined
  if (lastDeployer && typeof lastDeployer === 'object' && typeof lastDeployer.address === 'string') {
    sessionStorage.setItem(LAST_DEPLOYER_KEY, JSON.stringify(lastDeployer))
  }
  if (Array.isArray(echo.lastRadarList) && echo.lastRadarList.length > 0) {
    sessionStorage.setItem(LAST_RADAR_LIST_KEY, JSON.stringify(echo.lastRadarList))
    if (typeof echo.lastRadarChain === 'string') sessionStorage.setItem(LAST_RADAR_CHAIN_KEY, echo.lastRadarChain)
    if (typeof echo.lastRadarTs === 'number') sessionStorage.setItem(LAST_RADAR_TS_KEY, String(echo.lastRadarTs))
  }

  const lastClarkSubject = echo.lastClarkSubject as { address?: unknown } | undefined
  if (lastClarkSubject && typeof lastClarkSubject === 'object' && typeof lastClarkSubject.address === 'string' && lastClarkSubject.address.trim()) {
    sessionStorage.setItem(LAST_CLARK_SUBJECT_KEY, JSON.stringify(lastClarkSubject))
  }
  const prevClarkSubject = echo.prevClarkSubject as { address?: unknown } | undefined
  if (prevClarkSubject && typeof prevClarkSubject === 'object' && typeof prevClarkSubject.address === 'string' && prevClarkSubject.address.trim()) {
    sessionStorage.setItem(PREV_CLARK_SUBJECT_KEY, JSON.stringify(prevClarkSubject))
  }
  if (Array.isArray(echo.lastTickerMatches)) {
    if (echo.lastTickerMatches.length > 0) {
      sessionStorage.setItem(LAST_TICKER_MATCHES_KEY, JSON.stringify(echo.lastTickerMatches))
      if (typeof echo.tickerSearchId === 'string' && echo.tickerSearchId.trim()) {
        sessionStorage.setItem(TICKER_SEARCH_ID_KEY, echo.tickerSearchId.trim())
      }
    } else {
      sessionStorage.removeItem(LAST_TICKER_MATCHES_KEY)
      sessionStorage.removeItem(TICKER_SEARCH_ID_KEY)
    }
  }

}

/** Persists the momentum/movers list a Clark response returns, shared across surfaces. */
export function persistClarkMomentumList(items: unknown[]): void {
  if (typeof window === 'undefined') return
  sessionStorage.setItem(LAST_MOMENTUM_LIST_KEY, JSON.stringify(items))
  sessionStorage.setItem(LAST_MOMENTUM_SHOWN_COUNT_KEY, String(Math.min(7, items.length)))
}

// ── Persisted market momentum (survives page refresh, 15-minute expiry) ────────────────────────
const MARKET_MOMENTUM_KEY = 'chainlens:lastMarketMomentum'
const MARKET_MOMENTUM_TTL_MS = 15 * 60 * 1000

export type ClarkMarketMomentumItem = {
  rank: number
  symbol: string
  name?: string | null
  chain?: string | null
  tokenAddress?: string | null
  poolAddress?: string | null
  scanTarget?: string | null
  scanTargetType?: string | null
  liquidity?: number | null
  volume24h?: number | null
  change24h?: number | null
  tag?: string | null
}

/** Persists the latest Clark market momentum list to localStorage with a 15-minute expiry. */
export function persistMarketMomentum(items: ClarkMarketMomentumItem[]): void {
  if (typeof window === 'undefined') return
  // Never overwrite a previously persisted, still-valid market momentum list with an empty one —
  // an empty server response (e.g. a transient market read) must not erase real prior context.
  if (!Array.isArray(items) || items.length === 0) return
  try {
    const createdAt = Date.now()
    localStorage.setItem(MARKET_MOMENTUM_KEY, JSON.stringify({ items, createdAt, expiresAt: createdAt + MARKET_MOMENTUM_TTL_MS }))
  } catch { /* localStorage unavailable or quota exceeded — safe to ignore */ }
}

/** Reads the persisted market momentum list from localStorage, ignoring expired or malformed entries. */
export function readMarketMomentum(): ClarkMarketMomentumItem[] | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(MARKET_MOMENTUM_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { items?: unknown; createdAt?: unknown; expiresAt?: unknown }
    if (!Array.isArray(parsed.items) || typeof parsed.expiresAt !== 'number') return null
    if (Date.now() > parsed.expiresAt) return null
    return parsed.items as ClarkMarketMomentumItem[]
  } catch {
    return null
  }
}

/** Headers + body fields every Clark request must send so the backend can route/restore memory. */
export function buildClarkRequestMeta(): { headers: { 'x-clark-session': string }; body: { sessionId: string; clientContext: ClarkClientContext } } {
  const sessionId = getClarkSessionId()
  return {
    headers: { 'x-clark-session': sessionId },
    body: { sessionId, clientContext: readClarkClientContext() },
  }
}

export type ClarkCommandChipKind = 'lp' | 'token' | 'wallet' | 'holders' | 'deployer' | 'explain'

/** Address a /lp /token /wallet /holders /deployer chip should auto-run against, or null to just insert the command. */
export function resolveClarkCommandChipTarget(kind: ClarkCommandChipKind, ctx?: ClarkClientContext): string | null {
  const c = ctx ?? readClarkClientContext()
  const sub = c.lastClarkSubject as { entityType?: string; address?: string } | null | undefined
  if (kind === 'lp' || kind === 'token' || kind === 'holders' || kind === 'deployer' || kind === 'explain') {
    if (sub?.address && (sub.entityType === 'token' || sub.entityType === 'pair' || sub.entityType === 'unknown')) return sub.address
    const t = c.lastToken as { address?: string } | undefined
    return typeof t?.address === 'string' && t.address.trim() ? t.address : null
  }
  if (sub?.address && sub.entityType === 'wallet') return sub.address
  const w = c.lastWallet as { address?: string } | undefined
  return typeof w?.address === 'string' && w.address.trim() ? w.address : null
}
