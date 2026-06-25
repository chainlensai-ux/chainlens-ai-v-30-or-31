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
  }
}

/** Persists a Clark API response's memoryEcho into the shared sessionStorage keys every surface reads from. */
export function persistClarkMemoryEcho(payload: unknown): void {
  if (typeof window === 'undefined') return
  if (!payload || typeof payload !== 'object') return
  const memoryEcho = (payload as Record<string, unknown>).memoryEcho
  if (!memoryEcho || typeof memoryEcho !== 'object') return
  const echo = memoryEcho as Record<string, unknown>

  const lastWallet = echo.lastWallet as { address?: unknown } | undefined
  if (lastWallet && typeof lastWallet === 'object' && typeof lastWallet.address === 'string') {
    sessionStorage.setItem(LAST_WALLET_KEY, JSON.stringify(lastWallet))
  }
  if (Array.isArray(echo.recentWallets)) {
    sessionStorage.setItem(RECENT_WALLETS_KEY, JSON.stringify(echo.recentWallets))
  }

  const lastToken = echo.lastToken as { address?: unknown } | undefined
  if (lastToken && typeof lastToken === 'object' && typeof lastToken.address === 'string') {
    sessionStorage.setItem(LAST_TOKEN_KEY, JSON.stringify(lastToken))
  }
  if (Array.isArray(echo.recentTokens)) {
    sessionStorage.setItem(RECENT_TOKENS_KEY, JSON.stringify(echo.recentTokens))
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
