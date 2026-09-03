// CLARK MARKET INTENT, DISCLOSED (Clark "ETH price returns random Solana tokens" fix).
// Isolated classifier + formatters. Does not touch scanner math, wallet PnL, LP proof, pricing, or auth.
// Major tickers (ETH/BTC/SOL/BNB/XRP/DOGE/PEPE) route to live CoinGecko market data, never DexScreener
// symbol search. Token Scanner / DexScreener only run when the user pastes a contract or explicitly
// asks to scan/check a token.

import { isValidSolanaMintAddress } from "../solanaAddress.ts"

export type ClarkCanonicalAsset = {
  id: string
  ticker: string
  name: string
}

export const CLARK_CANONICAL_ASSETS: Record<string, ClarkCanonicalAsset> = {
  ETH: { id: "ethereum", ticker: "ETH", name: "Ethereum" },
  ETHEREUM: { id: "ethereum", ticker: "ETH", name: "Ethereum" },
  ETHER: { id: "ethereum", ticker: "ETH", name: "Ethereum" },
  BTC: { id: "bitcoin", ticker: "BTC", name: "Bitcoin" },
  BITCOIN: { id: "bitcoin", ticker: "BTC", name: "Bitcoin" },
  SOL: { id: "solana", ticker: "SOL", name: "Solana" },
  SOLANA: { id: "solana", ticker: "SOL", name: "Solana" },
  BNB: { id: "binancecoin", ticker: "BNB", name: "BNB" },
  XRP: { id: "ripple", ticker: "XRP", name: "XRP" },
  RIPPLE: { id: "ripple", ticker: "XRP", name: "XRP" },
  DOGE: { id: "dogecoin", ticker: "DOGE", name: "Dogecoin" },
  DOGECOIN: { id: "dogecoin", ticker: "DOGE", name: "Dogecoin" },
  PEPE: { id: "pepe", ticker: "PEPE", name: "Pepe" },
}

export const CLARK_CANONICAL_TICKERS = new Set(
  Object.values(CLARK_CANONICAL_ASSETS).map((a) => a.ticker),
)

export type ClarkMarketDetectedIntent =
  | "live_price"
  | "market_cap"
  | "volume"
  | "pumping"
  | "token_scan"
  | "wallet_scan"
  | "lp_check"
  | "clarification"
  | "none"

export type ClarkIntentAudit = {
  prompt: string
  normalizedPrompt: string
  detectedIntent: ClarkMarketDetectedIntent
  canonicalAssetMatched: string | null
  activeContextUsed: boolean
  addressDetected: boolean
  chainHint: string | null
  providerRoute: string | null
  providerUsed: string | null
  ambiguityReason: string | null
  finalAnswerType: string
  failureReason: string | null
}

export type ClarkMarketIntentResult = {
  detectedIntent: ClarkMarketDetectedIntent
  canonicalAsset: ClarkCanonicalAsset | null
  canonicalAssetMatched: string | null
  address: string | null
  chainHint: string | null
  normalizedPrompt: string
  audit: ClarkIntentAudit
}

export type ClarkLiveMarketSnapshot = {
  ticker: string
  name: string
  priceUsd: number
  change24h: number | null
  marketCapUsd: number | null
  volume24hUsd: number | null
  lastUpdatedIso: string | null
  source: "coingecko" | "chainlens_cache"
}

export type ClarkPumpingSnapshot = {
  symbol: string
  address: string | null
  chain: string | null
  priceUsd: number | null
  change24h: number | null
  volume24h: number | null
  liquidityUsd: number | null
  marketCapUsd: number | null
  buys24h: number | null
  sells24h: number | null
  top10Pct: number | null
  holderCount: number | null
  whaleFlowUsd: number | null
  missing: string[]
  source: string
}

const EVM_RE = /0x[a-fA-F0-9]{40}(?![a-fA-F0-9])/
const PRICE_RE = /\b(price|worth|cost|trading\s+at|how\s+much\s+is|what'?s?\s+(?:it|eth|btc|sol|bnb|xrp|doge|pepe)\s+at)\b/i
const MCAP_RE = /\b(market\s*cap|marketcap|mcap|fully\s+diluted)\b/i
const VOLUME_RE = /\b(24h\s+)?volume\b|\btrading\s+volume\b/i
const PUMPING_RE = /\bwhy\s+is\s+(?:this|it|the)?\s*(?:token|coin)?\s*pumping\b|\bwhy\s+(?:is\s+)?(?:this|it)\s+pumping\b|\bwhy\s+is\s+(?:0x[a-fA-F0-9]{40}|\$?[a-z0-9]{2,12})\s+pumping\b/i
const NORMAL_ETH_RE = /\b(?:like\s+)?(?:just\s+)?normal\s+(?:eth|ethereum|btc|bitcoin|sol|solana)\b|\bjust\s+(?:eth|ethereum|btc|bitcoin)\b/i
const EXPLICIT_CHAIN_SEARCH_RE = /\b(?:on\s+(?:solana|base|eth|ethereum|bnb|bsc|robinhood)|pair\s+search|contract\s+search|find\s+(?:the\s+)?(?:pair|pool|contract))\b/i
const CHAIN_HINT_RE = /\b(ethereum|eth|solana|sol|bnb|bsc|base|robinhood|polygon)\b/i

const COINGECKO_MARKETS = "https://api.coingecko.com/api/v3/coins/markets"
const DEXSCREENER_TOKEN = "https://api.dexscreener.com/latest/dex/tokens"

function normalizePrompt(prompt: string): string {
  return String(prompt ?? "")
    .toLowerCase()
    .replace(/[‘’ʼ´`]/g, "'")
    .replace(/[?!.,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function extractAddress(text: string): string | null {
  const evm = String(text ?? "").match(EVM_RE)?.[0]
  if (evm) return evm
  const parts = String(text ?? "").split(/[^1-9A-HJ-NP-Za-km-z]+/)
  for (const p of parts) {
    if (p.length >= 32 && p.length <= 44 && isValidSolanaMintAddress(p)) return p
  }
  return null
}

function chainHintFrom(text: string): string | null {
  const m = String(text ?? "").match(CHAIN_HINT_RE)
  if (!m) return null
  const w = m[1].toLowerCase()
  if (w === "eth" || w === "ethereum") return "ethereum"
  if (w === "sol" || w === "solana") return "solana"
  if (w === "bnb" || w === "bsc") return "bnb"
  if (w === "robinhood") return "robinhood"
  if (w === "polygon") return "polygon"
  if (w === "base") return "base"
  return null
}

export function matchCanonicalAsset(prompt: string): ClarkCanonicalAsset | null {
  const t = normalizePrompt(prompt)
  if (!t) return null
  // Longer aliases first so "dogecoin" wins over "doge" and "ethereum" over "eth".
  const keys = Object.keys(CLARK_CANONICAL_ASSETS).sort((a, b) => b.length - a.length)
  for (const key of keys) {
    const re = new RegExp(`\\b${key.toLowerCase()}\\b`, "i")
    if (re.test(t)) return CLARK_CANONICAL_ASSETS[key]
  }
  return null
}

export function isCanonicalMajorAsset(symbol: string | null | undefined): boolean {
  const s = String(symbol ?? "").trim().toUpperCase().replace(/^\$/, "")
  if (!s) return false
  return Boolean(CLARK_CANONICAL_ASSETS[s]) || CLARK_CANONICAL_TICKERS.has(s)
}

export function isExplicitCanonicalPairSearch(prompt: string): boolean {
  return EXPLICIT_CHAIN_SEARCH_RE.test(String(prompt ?? ""))
}

function isShortCanonicalAsk(t: string, asset: ClarkCanonicalAsset): boolean {
  const compact = t.replace(/^(what(?:'s|s|\s+is)|whats|wats|like|just|the)\s+/g, "").trim()
  const ticker = asset.ticker.toLowerCase()
  // Ticker-only ("eth", "what is eth") means the major asset. Full names without a price word
  // ("what is ethereum") stay educational so we don't steal chain-glossary questions.
  if (compact === ticker) return true
  if (compact === `${ticker} please`) return true
  return NORMAL_ETH_RE.test(t)
}

function slashIntent(t: string, address: string | null): ClarkMarketDetectedIntent | null {
  if (/^\s*\/wallet\b/i.test(t) || /\bscan\s+(?:this\s+)?wallet\b/i.test(t)) return "wallet_scan"
  if (/^\s*\/lp\b/i.test(t) || /\blp\s+check\b/i.test(t)) return "lp_check"
  if (/^\s*\/token\b/i.test(t) || /\b(?:scan|check)\s+(?:this\s+)?token\b/i.test(t)) return "token_scan"
  if (address && /\bscan\b/i.test(t)) return "token_scan"
  return null
}

function emptyAudit(prompt: string, normalized: string): ClarkIntentAudit {
  return {
    prompt,
    normalizedPrompt: normalized,
    detectedIntent: "none",
    canonicalAssetMatched: null,
    activeContextUsed: false,
    addressDetected: false,
    chainHint: null,
    providerRoute: null,
    providerUsed: null,
    ambiguityReason: null,
    finalAnswerType: "none",
    failureReason: null,
  }
}

export function classifyClarkMarketIntent(prompt: string, opts?: {
  hasActiveToken?: boolean
  address?: string | null
  chainHint?: string | null
}): ClarkMarketIntentResult {
  const raw = String(prompt ?? "")
  const t = normalizePrompt(raw)
  const address = opts?.address ?? extractAddress(raw)
  const chainHint = opts?.chainHint ?? chainHintFrom(raw)
  const asset = matchCanonicalAsset(raw)
  const slash = slashIntent(t, address)

  const baseAudit = (): ClarkIntentAudit => ({
    ...emptyAudit(raw, t),
    canonicalAssetMatched: asset?.ticker ?? null,
    addressDetected: Boolean(address),
    chainHint,
    activeContextUsed: Boolean(opts?.hasActiveToken),
  })

  const result = (
    detectedIntent: ClarkMarketDetectedIntent,
    extra?: Partial<ClarkIntentAudit>,
  ): ClarkMarketIntentResult => {
    const audit: ClarkIntentAudit = {
      ...baseAudit(),
      detectedIntent,
      finalAnswerType: detectedIntent,
      ...extra,
    }
    return {
      detectedIntent,
      canonicalAsset: asset,
      canonicalAssetMatched: asset?.ticker ?? null,
      address,
      chainHint,
      normalizedPrompt: t,
      audit,
    }
  }

  if (!t) return result("none")
  if (slash === "wallet_scan") return result("wallet_scan")
  if (slash === "lp_check") return result("lp_check")
  if (slash === "token_scan") return result("token_scan")

  if (PUMPING_RE.test(t) || PUMPING_RE.test(raw)) {
    return result("pumping", {
      providerRoute: address ? "contract_market_lookup" : (opts?.hasActiveToken ? "active_token_context" : "need_token"),
      activeContextUsed: Boolean(opts?.hasActiveToken) && !address,
    })
  }

  if (asset) {
    if (MCAP_RE.test(t)) return result("market_cap", { providerRoute: "coingecko" })
    if (VOLUME_RE.test(t) && !/\bscan\b/i.test(t)) return result("volume", { providerRoute: "coingecko" })
    if (PRICE_RE.test(t) || NORMAL_ETH_RE.test(t) || isShortCanonicalAsk(t, asset)) {
      return result("live_price", { providerRoute: "coingecko" })
    }
  }

  return result("none")
}

export function isClarkCanonicalMarketPrompt(prompt: string): boolean {
  const intent = classifyClarkMarketIntent(prompt).detectedIntent
  return intent === "live_price" || intent === "market_cap" || intent === "volume"
}

export function shouldShowCanonicalAmbiguity(query: string, prompt: string): boolean {
  if (!isCanonicalMajorAsset(query)) return true
  return isExplicitCanonicalPairSearch(prompt)
}

export function buildClarkIntentAudit(input: Partial<ClarkIntentAudit> & Pick<ClarkIntentAudit, "prompt" | "detectedIntent">): ClarkIntentAudit {
  const normalized = input.normalizedPrompt ?? normalizePrompt(input.prompt)
  return {
    prompt: input.prompt,
    normalizedPrompt: normalized,
    detectedIntent: input.detectedIntent,
    canonicalAssetMatched: input.canonicalAssetMatched ?? null,
    activeContextUsed: input.activeContextUsed ?? false,
    addressDetected: input.addressDetected ?? false,
    chainHint: input.chainHint ?? null,
    providerRoute: input.providerRoute ?? null,
    providerUsed: input.providerUsed ?? null,
    ambiguityReason: input.ambiguityReason ?? null,
    finalAnswerType: input.finalAnswerType ?? input.detectedIntent,
    failureReason: input.failureReason ?? null,
  }
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && v.trim()) {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

export function formatUsdCompact(n: number): string {
  const abs = Math.abs(n)
  const sign = n < 0 ? "-" : ""
  const v = abs
  if (v >= 1e12) return `${sign}$${(v / 1e12).toFixed(2)}T`
  if (v >= 1e9) return `${sign}$${(v / 1e9).toFixed(2)}B`
  if (v >= 1e6) return `${sign}$${(v / 1e6).toFixed(2)}M`
  if (v >= 1e3) return `${sign}$${(v / 1e3).toFixed(1)}K`
  return `${sign}$${v.toFixed(2)}`
}

export function formatUsdPrice(n: number): string {
  if (n >= 1000) return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  if (n >= 1) return `$${n.toFixed(2)}`
  if (n >= 0.01) return `$${n.toFixed(4)}`
  return `$${n.toPrecision(3)}`
}

function formatChange(n: number | null): string | null {
  if (n == null || !Number.isFinite(n)) return null
  const abs = Math.abs(n).toFixed(1)
  return n >= 0 ? `up ${abs}% in 24h` : `down ${abs}% in 24h`
}

function formatUpdatedAgo(iso: string | null): string {
  if (!iso) return "just now"
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return "just now"
  const s = Math.round(ms / 1000)
  if (s < 60) return `${Math.max(s, 0)}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  return `${h}h ago`
}

export function formatClarkLiveMarketAnswer(
  snap: ClarkLiveMarketSnapshot,
  metric: "live_price" | "market_cap" | "volume" = "live_price",
): string {
  const change = formatChange(snap.change24h)
  const lines: string[] = []
  if (metric === "market_cap") {
    lines.push(snap.marketCapUsd != null
      ? `${snap.ticker} market cap is ${formatUsdCompact(snap.marketCapUsd)}.`
      : `${snap.ticker} price is ${formatUsdPrice(snap.priceUsd)}${change ? `, ${change}` : "."}`)
    if (snap.marketCapUsd != null) lines.push(`${snap.ticker} is ${formatUsdPrice(snap.priceUsd)}${change ? `, ${change}` : "."}`)
  } else if (metric === "volume") {
    lines.push(snap.volume24hUsd != null
      ? `${snap.ticker} 24h volume is ${formatUsdCompact(snap.volume24hUsd)}.`
      : `${snap.ticker} is ${formatUsdPrice(snap.priceUsd)}${change ? `, ${change}` : "."}`)
    if (snap.volume24hUsd != null) lines.push(`${snap.ticker} is ${formatUsdPrice(snap.priceUsd)}${change ? `, ${change}` : "."}`)
  } else {
    lines.push(`${snap.ticker} is ${formatUsdPrice(snap.priceUsd)}${change ? `, ${change}` : "."}`)
  }
  if (snap.marketCapUsd != null && metric !== "market_cap") lines.push(`Market cap: ${formatUsdCompact(snap.marketCapUsd)}`)
  if (snap.volume24hUsd != null && metric !== "volume") lines.push(`24h volume: ${formatUsdCompact(snap.volume24hUsd)}`)
  if (metric === "market_cap" && snap.volume24hUsd != null) lines.push(`24h volume: ${formatUsdCompact(snap.volume24hUsd)}`)
  if (metric === "volume" && snap.marketCapUsd != null) lines.push(`Market cap: ${formatUsdCompact(snap.marketCapUsd)}`)
  const src = snap.source === "chainlens_cache" ? "ChainLens cached market snapshot" : "live market data"
  lines.push(`Source: ${src}, updated ${formatUpdatedAgo(snap.lastUpdatedIso)}.`)
  return lines.join("\n")
}

export function formatClarkLiveMarketUnavailable(asset: ClarkCanonicalAsset, reason: string): string {
  return `${asset.ticker} live market data is unavailable right now (${reason}). I will not guess a price. Try again in a moment.`
}

export function formatClarkPumpingNeedToken(): string {
  return "Which token? Send the contract address or ticker."
}

export function formatClarkCanonicalScanAsk(asset: ClarkCanonicalAsset): string {
  return `${asset.ticker} is ${asset.name}. Paste a contract address to scan a specific token, or ask for the ${asset.ticker} price.`
}

export function formatClarkPumpingAnswer(snap: ClarkPumpingSnapshot): string {
  const lines: string[] = []
  const change = snap.change24h != null && Number.isFinite(snap.change24h)
    ? `${snap.change24h >= 0 ? "up" : "down"} ${Math.abs(snap.change24h).toFixed(1)}% in 24h`
    : null
  if (change) lines.push(`${snap.symbol} is ${change}.`)
  else if (snap.priceUsd != null) lines.push(`${snap.symbol} is ${formatUsdPrice(snap.priceUsd)}.`)
  else lines.push(`${snap.symbol} — live move is not in this read.`)

  if (snap.volume24h != null) lines.push(`Volume 24h: ${formatUsdCompact(snap.volume24h)}`)
  if (snap.liquidityUsd != null) lines.push(`Liquidity: ${formatUsdCompact(snap.liquidityUsd)}`)
  if (snap.buys24h != null || snap.sells24h != null) {
    const b = snap.buys24h != null ? String(snap.buys24h) : "unverified"
    const s = snap.sells24h != null ? String(snap.sells24h) : "unverified"
    if (snap.buys24h != null || snap.sells24h != null) lines.push(`Buys vs sells (24h): ${b} / ${s}`)
  }
  if (snap.top10Pct != null) lines.push(`Top-10 holders: ${snap.top10Pct.toFixed(1)}%`)
  else if (snap.holderCount != null) lines.push(`Holders: ${snap.holderCount.toLocaleString("en-US")}`)
  if (snap.whaleFlowUsd != null) lines.push(`Whale/FOMO net flow: ${formatUsdCompact(snap.whaleFlowUsd)}`)
  if (snap.marketCapUsd != null) lines.push(`Market cap: ${formatUsdCompact(snap.marketCapUsd)}`)

  const verified = [snap.change24h, snap.volume24h, snap.liquidityUsd, snap.buys24h, snap.top10Pct].filter((v) => v != null)
  const confidence = verified.length >= 3 ? "medium" : verified.length >= 1 ? "partial" : "low"
  lines.push(`Confidence: ${confidence}`)
  if (snap.missing.length) lines.push(`Missing: ${snap.missing.join("; ")}`)
  lines.push(`Source: ${snap.source}. A pump is not a safety signal.`)
  return lines.join("\n")
}

export function pumpingSnapshotFromTokenEvidence(input: {
  symbol?: string | null
  address?: string | null
  chain?: string | null
  market?: {
    price?: number | null
    change24h?: number | null
    volume24h?: number | null
    liquidity?: number | null
    marketCap?: number | null
  } | null
  holders?: { top10?: number | null; holderCount?: number | null } | null
  buys24h?: number | null
  sells24h?: number | null
  whaleFlowUsd?: number | null
  source?: string
}): ClarkPumpingSnapshot {
  const m = input.market ?? {}
  const missing: string[] = []
  if (m.change24h == null) missing.push("24h change")
  if (m.volume24h == null) missing.push("volume")
  if (m.liquidity == null) missing.push("liquidity")
  if (input.buys24h == null && input.sells24h == null) missing.push("buy/sell pressure")
  if (input.holders?.top10 == null && input.holders?.holderCount == null) missing.push("holder concentration")
  if (input.whaleFlowUsd == null) missing.push("whale/FOMO flow")
  return {
    symbol: String(input.symbol ?? "TOKEN").toUpperCase(),
    address: input.address ?? null,
    chain: input.chain ?? null,
    priceUsd: m.price ?? null,
    change24h: m.change24h ?? null,
    volume24h: m.volume24h ?? null,
    liquidityUsd: m.liquidity ?? null,
    marketCapUsd: m.marketCap ?? null,
    buys24h: input.buys24h ?? null,
    sells24h: input.sells24h ?? null,
    top10Pct: input.holders?.top10 ?? null,
    holderCount: input.holders?.holderCount ?? null,
    whaleFlowUsd: input.whaleFlowUsd ?? null,
    missing,
    source: input.source ?? "active token context",
  }
}

export function pumpingAnswerHasNaSpam(text: string): boolean {
  return /Momentum Score:\s*n\/a\/100/i.test(text)
    || /Liquidity unverified/i.test(text)
    || /Holders n\/a/i.test(text)
}

type FetchLike = typeof fetch

export async function fetchClarkCanonicalMarket(
  asset: ClarkCanonicalAsset,
  fetchImpl: FetchLike = fetch,
  timeoutMs = 6000,
): Promise<{ ok: true; snapshot: ClarkLiveMarketSnapshot } | { ok: false; reason: string }> {
  try {
    const url = `${COINGECKO_MARKETS}?vs_currency=usd&ids=${encodeURIComponent(asset.id)}&order=market_cap_desc&per_page=1&page=1&sparkline=false&price_change_percentage=24h`
    const res = await fetchImpl(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return { ok: false, reason: `CoinGecko HTTP ${res.status}` }
    const json = await res.json().catch(() => null) as unknown
    const row = Array.isArray(json) ? json[0] as Record<string, unknown> | undefined : null
    const price = num(row?.current_price)
    if (price == null || price <= 0) return { ok: false, reason: "CoinGecko returned no usable price" }
    return {
      ok: true,
      snapshot: {
        ticker: asset.ticker,
        name: asset.name,
        priceUsd: price,
        change24h: num(row?.price_change_percentage_24h) ?? num(row?.price_change_percentage_24h_in_currency),
        marketCapUsd: num(row?.market_cap),
        volume24hUsd: num(row?.total_volume),
        lastUpdatedIso: typeof row?.last_updated === "string" ? row.last_updated : null,
        source: "coingecko",
      },
    }
  } catch {
    return { ok: false, reason: "CoinGecko unreachable" }
  }
}

export async function fetchDexScreenerContractMarket(
  address: string,
  fetchImpl: FetchLike = fetch,
  timeoutMs = 5000,
): Promise<{ ok: true; snapshot: ClarkPumpingSnapshot } | { ok: false; reason: string }> {
  try {
    const res = await fetchImpl(`${DEXSCREENER_TOKEN}/${encodeURIComponent(address)}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return { ok: false, reason: `DexScreener HTTP ${res.status}` }
    const json = await res.json().catch(() => null) as { pairs?: Array<Record<string, unknown>> } | null
    const pairs = Array.isArray(json?.pairs) ? json.pairs : []
    if (pairs.length === 0) return { ok: false, reason: "DexScreener returned no pairs for that contract" }
    const scored = pairs.map((p) => {
      const liq = num((p.liquidity as Record<string, unknown> | undefined)?.usd)
      const vol = num((p.volume as Record<string, unknown> | undefined)?.h24)
      return { p, liq: liq ?? 0, vol: vol ?? 0 }
    }).sort((a, b) => (b.liq - a.liq) || (b.vol - a.vol))
    const best = scored[0]?.p
    if (!best) return { ok: false, reason: "DexScreener returned no usable pair" }
    const base = (best.baseToken ?? {}) as Record<string, unknown>
    const priceChange = (best.priceChange ?? {}) as Record<string, unknown>
    const txns = (best.txns as Record<string, unknown> | undefined)?.h24 as Record<string, unknown> | undefined
    return {
      ok: true,
      snapshot: pumpingSnapshotFromTokenEvidence({
        symbol: typeof base.symbol === "string" ? base.symbol : "TOKEN",
        address,
        chain: typeof best.chainId === "string" ? best.chainId : null,
        market: {
          price: num(best.priceUsd),
          change24h: num(priceChange.h24),
          volume24h: num((best.volume as Record<string, unknown> | undefined)?.h24),
          liquidity: num((best.liquidity as Record<string, unknown> | undefined)?.usd),
          marketCap: num(best.marketCap) ?? num(best.fdv),
        },
        buys24h: num(txns?.buys),
        sells24h: num(txns?.sells),
        source: "DexScreener (contract lookup)",
      }),
    }
  } catch {
    return { ok: false, reason: "DexScreener unreachable" }
  }
}

export function clarkMarketContainsInventedPrice(text: string, snapshot: ClarkLiveMarketSnapshot | null): boolean {
  if (!snapshot) return /\$\d/.test(text) && /unavailable|did not return|will not guess/i.test(text) === false && /which token/i.test(text) === false
  const compact = formatUsdPrice(snapshot.priceUsd).replace(/,/g, "")
  if (text.includes(formatUsdPrice(snapshot.priceUsd))) return false
  if (text.replace(/,/g, "").includes(compact)) return false
  return false
}
