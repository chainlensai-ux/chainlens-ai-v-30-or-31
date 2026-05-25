/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { fetchHoneypotSecurity } from "@/lib/server/honeypotSecurity";
import { getCurrentUserPlanFromBearerToken } from '@/lib/supabase/plans'

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

type ChainKey = "eth" | "base" | "polygon" | "bnb";
function getAlchemyRpcUrl(chain: ChainKey): string | null {
  if (chain === "base") {
    const explicit = process.env.ALCHEMY_BASE_RPC_URL
    if (explicit && /^https?:\/\//.test(explicit)) return explicit
    const key = process.env.ALCHEMY_BASE_KEY
    return key ? `https://base-mainnet.g.alchemy.com/v2/${key}` : null
  }
  const keyMap: Record<Exclude<ChainKey, "base">, string | undefined> = {
    eth: process.env.ALCHEMY_ETHEREUM_KEY,
    polygon: process.env.ALCHEMY_POLYGON_KEY,
    bnb: process.env.ALCHEMY_BNB_KEY,
  }
  const domainMap: Record<Exclude<ChainKey, "base">, string> = {
    eth: "eth-mainnet",
    polygon: "polygon-mainnet",
    bnb: "bnb-mainnet",
  }
  const key = keyMap[chain as Exclude<ChainKey, "base">]
  return key ? `https://${domainMap[chain as Exclude<ChainKey, "base">]}.g.alchemy.com/v2/${key}` : null
}

const TOKEN_CACHE_TTL_MS = 3 * 60 * 1000
const TOKEN_RATE_WINDOW_MS = 60 * 1000
const TOKEN_RATE_BY_PLAN: Record<string, number> = { free: 12, pro: 40, elite: 120 }
// Token scanner caching intentionally disabled for full provider-run scans.
const tokenRateMap = new Map<string, { count: number; resetAt: number }>()
const BASE_TOKEN_ALIAS_MAP: Record<string, { address: string; symbol: string }> = {
  WETH: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH' },
  ETH: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH' },
  USDC: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC' },
  USDBC: { address: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', symbol: 'USDbC' },
  AERO: { address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', symbol: 'AERO' },
  BRETT: { address: '0x532f27101965dd16442E59d40670FaF5eBB142E4', symbol: 'BRETT' },
  VIRTUAL: { address: '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b', symbol: 'VIRTUAL' },
  DEGEN: { address: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', symbol: 'DEGEN' },
  TOSHI: { address: '0xAC1bd2486aAf3B5C0B7b8f6e7DfeF5C0a05D0D89', symbol: 'TOSHI' },
  MORPHO: { address: '0xBAa5BDeA6D371052a6BDeB0eD79B147C43aABF84', symbol: 'MORPHO' },
  CBBTC: { address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', symbol: 'cbBTC' },
  CBETH: { address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', symbol: 'cbETH' },
}

function getClientIp(req: Request): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
}
async function getPlan(req: Request): Promise<'free' | 'pro' | 'elite'> {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (!token) return 'free'
  try { return (await getCurrentUserPlanFromBearerToken(token)).plan } catch { return 'free' }
}
async function checkRate(req: Request): Promise<boolean> {
  const ip = getClientIp(req)
  const plan = await getPlan(req)
  const key = `${plan}:${ip}`
  const now = Date.now()
  const cur = tokenRateMap.get(key)
  const limit = TOKEN_RATE_BY_PLAN[plan]
  if (!cur || cur.resetAt <= now) { tokenRateMap.set(key, { count: 1, resetAt: now + TOKEN_RATE_WINDOW_MS }); return true }
  if (cur.count >= limit) return false
  cur.count += 1
  return true
}

type HolderDistribution = {
  top1: number | null
  top5: number | null
  top10: number | null
  top20: number | null
  others: number | null
  holderCount: number | null
  topHolders: Array<{ rank: number; address: string; amount: string | number | null; percent: number | null }>
}
type HolderDistributionStatus = {
  status: "ok" | "partial" | "empty" | "unavailable" | "error"
  reason: string
  itemCount: number
  normalizedCount: number
  percentSource: "provider" | "calculated" | "unavailable"
}
type RiskEngine = {
  rugRiskScore: number | null
  rugRiskLabel: "low_visible_risk" | "watch" | "high" | "critical" | "unverified"
  confidence: "high" | "medium" | "low"
  cortexRead: string
  verifiedSignals: string[]
  riskDrivers: string[]
  openChecks: string[]
  sniperActivity: {
    status: "low_signal" | "watch" | "high" | "unverified"
    confidence: "high" | "medium" | "low"
    reasons: string[]
  }
}

type RugRiskReport = {
  lp_safety: {
    status: "locked" | "unlocked" | "team_controlled" | "protocol" | "concentrated_liquidity" | "unknown"
    unlock_at: string | null
    countdown_seconds: number | null
    owner: string | null
    contract: string | null
    movement_24h_usd: number | null
    source_status: "ok" | "failed"
  }
  contract_flags: {
    honeypot: boolean | null
    blacklist: boolean | null
    mint: boolean | null
    upgradeable: boolean | null
    source_status: "ok" | "partial" | "failed"
  }
  deployer_reputation: {
    score: number | null
    rug_history: number | null
    deploy_patterns: string[]
    source_status: "ok" | "failed"
  }
  sniper_activity: { level: "low" | "medium" | "high"; score: number; source_status: "ok" | "failed" }
  early_buyers: Array<{ wallet: string; amount_usd: number | null; tx_count: number | null }>
  liquidity_risk: { liquidity_usd: number | null; volatility_24h_pct: number | null; source_status: "ok" | "failed" }
  trading_simulation: { success: boolean | null; buy_tax: number | null; sell_tax: number | null; source_status: "ok" | "failed" }
  risk_drivers: string[]
  overall_rug_risk_score: number | null
}

function toNum(v: unknown): number | null {
  const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

function pickNum(...vals: unknown[]): number | null {
  for (const v of vals) {
    const n = toNum(v)
    if (n != null) return n
  }
  return null
}

function normalizeHolderPercent(v: unknown): number | null {
  const n = toNum(v)
  if (n == null || n <= 0 || n > 100) return null
  if (n > 0 && n <= 1) return n * 100
  return n
}

// BigInt-safe percentage: avoids float precision loss on 18-decimal ERC-20 balances.
// Returns e.g. 5.23 for 5.23%. Uses BigInt() constructor (not literals) for ES2017 compat.
function bigIntPct(balanceRaw: unknown, supplyRaw: unknown): number | null {
  try {
    if (balanceRaw == null || supplyRaw == null) return null
    const b = BigInt(String(balanceRaw).split('.')[0])
    const s = BigInt(String(supplyRaw).split('.')[0])
    if (s === BigInt(0)) return null
    return Number(b * BigInt(1000000) / s) / 10000
  } catch { return null }
}

function withTimeout(ms = 5000): AbortSignal {
  return AbortSignal.timeout(ms)
}

async function rpcCall(chain: ChainKey, method: string, params: unknown[]): Promise<string | null> {
  try {
    const rpcUrl = getAlchemyRpcUrl(chain);
    if (!rpcUrl) return null;
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: withTimeout(),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return typeof json?.result === "string" ? json.result : null;
  } catch { return null; }
}



async function rpcTokenString(chain: ChainKey, contract: string, selector: string): Promise<string | null> {
  const hex = await rpcCall(chain, 'eth_call', [{ to: contract, data: selector }, 'latest'])
  if (!hex || hex === '0x') return null
  try {
    const body = hex.startsWith('0x') ? hex.slice(2) : hex
    if (body.length >= 128) {
      const strHex = body.slice(128).replace(/00+$/, '')
      const text = Buffer.from(strHex, 'hex').toString('utf8').replace(/\u0000/g, '').trim()
      return text || null
    }
  } catch {}
  return null
}
function pad32HexAddress(address: string): string {
  return `000000000000000000000000${address.toLowerCase().replace(/^0x/, "")}`;
}

// ------------------------------
// Fetch helpers
// ------------------------------
async function fetchOnchainSupply(chain: ChainKey, contract: string): Promise<{
  totalSupply: bigint | null; burnedZero: bigint | null; burnedDead: bigint | null
}> {
  const rpcUrl = getAlchemyRpcUrl(chain)
  if (!rpcUrl) return { totalSupply: null, burnedZero: null, burnedDead: null }
  const ZERO = '0x0000000000000000000000000000000000000000'
  const DEAD = '0x000000000000000000000000000000000000dEaD'
  const paddedZero = ZERO.slice(2).padStart(64, '0')
  const paddedDead = DEAD.slice(2).padStart(64, '0')
  try {
    const [tsRes, bzRes, bdRes] = await Promise.all([
      fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: contract, data: '0x18160ddd' }, 'latest'] }),
        signal: AbortSignal.timeout(5000) }).then(r => r.json()),
      fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_call', params: [{ to: contract, data: '0x70a08231' + paddedZero }, 'latest'] }),
        signal: AbortSignal.timeout(5000) }).then(r => r.json()),
      fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'eth_call', params: [{ to: contract, data: '0x70a08231' + paddedDead }, 'latest'] }),
        signal: AbortSignal.timeout(5000) }).then(r => r.json()),
    ])
    const parseBig = (res: any): bigint | null => {
      const hex = res?.result
      if (!hex || hex === '0x' || hex === '0x0') return null
      try { return BigInt(hex) } catch { return null }
    }
    return { totalSupply: parseBig(tsRes), burnedZero: parseBig(bzRes), burnedDead: parseBig(bdRes) }
  } catch { return { totalSupply: null, burnedZero: null, burnedDead: null } }
}

async function fetchBytecode(chain: ChainKey, contract: string): Promise<string | null> {
  try {
    const rpcUrl = getAlchemyRpcUrl(chain);
    if (!rpcUrl) return null;
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getCode",
        params: [contract, "latest"],
      }),
      signal: AbortSignal.timeout(5000),
    });
    const json = await res.json();
    return json?.result || null;
  } catch {
    return null;
  }
}

async function fetchGoldRush(chain: ChainKey, contract: string): Promise<any> {
  try {
    const _grBase = (process.env.GOLDRUSH_BASE_URL ?? 'https://api.covalenthq.com').replace(/\/$/, '')
    const res = await fetch(
      `${_grBase}/v1/${chain}/tokens/${contract}/?key=${process.env.COVALENT_API_KEY}`,
      { signal: AbortSignal.timeout(5000) }
    );
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function fetchGeckoTerminal(contract: string, chain: ChainKey): Promise<any> {
  try {
    const networkMap: Record<ChainKey, string> = {
      eth:     'eth',
      base:    'base',
      polygon: 'polygon_pos',
      bnb:     'bsc',
    };
    const network = networkMap[chain] ?? 'base';
    const _gtBase = (process.env.GECKO_BASE_URL ?? 'https://api.geckoterminal.com').replace(/\/$/, '')
    const res = await fetch(
      `${_gtBase}/api/v2/networks/${network}/tokens/${contract}/pools?page=1&include=base_token%2Cquote_token`,
      {
        headers: { Accept: 'application/json;version=20230302' },
        cache: 'no-store',
        signal: withTimeout(),
      }
    );
    if (!res.ok) {
      console.error('GeckoTerminal pools error:', res.status, await res.text().catch(() => ''));
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error("Error fetching GeckoTerminal pools:", err);
    return null;
  }
}

async function fetchGeckoTerminalToken(contract: string, chain: ChainKey): Promise<any> {
  try {
    const networkMap: Record<ChainKey, string> = {
      eth:     'eth',
      base:    'base',
      polygon: 'polygon_pos',
      bnb:     'bsc',
    };
    const network = networkMap[chain] ?? 'base';
    const _gtBase = (process.env.GECKO_BASE_URL ?? 'https://api.geckoterminal.com').replace(/\/$/, '')
    const res = await fetch(
      `${_gtBase}/api/v2/networks/${network}/tokens/${contract}`,
      {
        headers: { Accept: 'application/json;version=20230302' },
        cache: 'no-store',
        signal: withTimeout(),
      }
    );
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error("Error fetching GeckoTerminal token info:", err);
    return null;
  }
}

async function fetchGeckoTerminalPoolOhlcv(poolAddress: string, chain: ChainKey, timeframe: { resolution: 'minute'|'hour'|'day'; aggregate: number; limit: number }): Promise<any> {
  try {
    const networkMap: Record<ChainKey, string> = {
      eth: 'eth',
      base: 'base',
      polygon: 'polygon_pos',
      bnb: 'bsc',
    }
    const network = networkMap[chain] ?? 'base'
    const res = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/${network}/pools/${poolAddress}/ohlcv/${timeframe.resolution}?aggregate=${timeframe.aggregate}&limit=${timeframe.limit}&currency=usd&token=base`,
      {
        headers: { Accept: 'application/json;version=20230302' },
        cache: 'no-store',
        signal: withTimeout(5000),
      }
    )
    return res.ok ? await res.json() : null
  } catch { return null }
}

const CHAIN_ID_MAP: Record<ChainKey, number> = { eth: 1, base: 8453, polygon: 137, bnb: 56 };

// ─── Secondary market data fallback ──────────────────────────────────────────
// Server-side only. Called once when the primary market source has no pool.
// Any failure (non-200, non-JSON, timeout, wrong chain) silently returns null.

interface DexFallbackResult {
  priceUsd: number | null
  liquidityUsd: number | null
  volume24h: number | null
  priceChange24h: number | null
  fdv: number | null
  pairAddress: string | null
  dexId: string | null
  pairUrl: string | null
  baseToken: { address: string; symbol: string; name: string } | null
  quoteToken: { address: string; symbol: string; name: string } | null
  pairCreatedAt: string | null
}

const _dexFbCache = new Map<string, { data: DexFallbackResult | null; ts: number }>()

async function fetchDexScreenerFallback(tokenAddress: string, chain: ChainKey = 'base'): Promise<DexFallbackResult | null> {
  const dexChainIdMap: Record<ChainKey, string> = {
    eth: 'ethereum',
    base: 'base',
    polygon: 'polygon',
    bnb: 'bsc',
  }
  const dexChainId = dexChainIdMap[chain] ?? 'base'
  const key = `${chain}:${tokenAddress.toLowerCase()}`
  const cached = _dexFbCache.get(key)
  if (cached && Date.now() - cached.ts < 5 * 60 * 1000) return cached.data
  const miss = (data: DexFallbackResult | null) => {
    _dexFbCache.set(key, { data, ts: Date.now() })
    return data
  }

  try {
    const _dsBase = (process.env.DEXSCREENER_BASE_URL ?? 'https://api.dexscreener.com').replace(/\/$/, '')
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 4000)
    let res: Response
    try {
      res = await fetch(
        `${_dsBase}/token-pairs/v1/${dexChainId}/${tokenAddress}`,
        { signal: ctrl.signal, cache: 'no-store' }
      )
    } finally {
      clearTimeout(timer)
    }

    if (!res.ok) return miss(null)
    const ct = res.headers.get('content-type') ?? ''
    if (!ct.includes('json')) return miss(null)

    const json: unknown = await res.json().catch(() => null)
    if (!json) return miss(null)

    const raw = json as Record<string, unknown>
    const pairs: unknown[] = Array.isArray(json) ? json
      : Array.isArray(raw.pairs) ? raw.pairs as unknown[]
      : []

    const addrLower = tokenAddress.toLowerCase()
    const basePairs = pairs.filter((p) => {
      const pair = p as Record<string, unknown>
      const bt = pair.baseToken as Record<string, unknown> | null
      const qt = pair.quoteToken as Record<string, unknown> | null
      return (
        pair.chainId === dexChainId &&
        (String(bt?.address ?? '').toLowerCase() === addrLower ||
         String(qt?.address ?? '').toLowerCase() === addrLower)
      )
    })

    if (basePairs.length === 0) return miss(null)

    // Highest liquidity.usd among pairs that include this token
    const best = basePairs.reduce<Record<string, unknown>>((acc, p) => {
      const pair = p as Record<string, unknown>
      const liqP = Number((pair.liquidity as Record<string, unknown> | null)?.usd ?? 0)
      const liqA = Number((acc.liquidity as Record<string, unknown> | null)?.usd ?? 0)
      return liqP > liqA ? pair : acc
    }, basePairs[0] as Record<string, unknown>)

    const liq = best.liquidity as Record<string, unknown> | null
    const vol = best.volume as Record<string, unknown> | null
    const pc = best.priceChange as Record<string, unknown> | null
    const bt = best.baseToken as Record<string, unknown> | null
    const qt = best.quoteToken as Record<string, unknown> | null

    return miss({
      priceUsd:     best.priceUsd != null ? Number(best.priceUsd) : null,
      liquidityUsd: liq?.usd != null ? Number(liq.usd) : null,
      volume24h:    vol?.h24 != null ? Number(vol.h24) : null,
      priceChange24h: pc?.h24 != null ? Number(pc.h24) : null,
      fdv:          best.fdv != null ? Number(best.fdv) : null,
      pairAddress:  best.pairAddress != null ? String(best.pairAddress) : null,
      dexId:        best.dexId != null ? String(best.dexId) : null,
      pairUrl:      best.url != null ? String(best.url) : null,
      baseToken:    bt != null ? { address: String(bt.address ?? ''), symbol: String(bt.symbol ?? ''), name: String(bt.name ?? '') } : null,
      quoteToken:   qt != null ? { address: String(qt.address ?? ''), symbol: String(qt.symbol ?? ''), name: String(qt.name ?? '') } : null,
      pairCreatedAt: best.pairCreatedAt != null ? String(best.pairCreatedAt) : null,
    })
  } catch {
    return miss(null)
  }
}

async function fetchCoinGeckoToken(chain: ChainKey, contract: string): Promise<any> {
  try {
    const platform = chain === 'eth' ? 'ethereum' : chain === 'base' ? 'base' : chain
    const res = await fetch(`https://api.coingecko.com/api/v3/coins/${platform}/contract/${contract}`, { cache: 'no-store', signal: AbortSignal.timeout(7000) })
    return res.ok ? await res.json() : null
  } catch { return null }
}

async function fetchMoralisHolders(chain: ChainKey, contract: string): Promise<any> {
  try {
    const chainMap: Record<ChainKey, string> = { eth: 'eth', base: 'base', polygon: 'polygon', bnb: 'bsc' }
    const key = process.env.MORALIS_API_KEY
    if (!key) return { __status: 'unavailable' }
    const res = await fetch(`https://deep-index.moralis.io/api/v2.2/erc20/${contract}/owners?chain=${chainMap[chain]}&limit=100`, {
      headers: { 'X-API-Key': key },
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    })
    return res.ok ? await res.json() : { __status: 'error' }
  } catch { return { __status: 'error' } }
}

async function fetchMoralisTransfers(chain: ChainKey, contract: string): Promise<any> {
  try {
    const chainMap: Record<ChainKey, string> = { eth: 'eth', base: 'base', polygon: 'polygon', bnb: 'bsc' }
    const key = process.env.MORALIS_API_KEY
    if (!key) return { __status: 'unavailable' }
    const res = await fetch(`https://deep-index.moralis.io/api/v2.2/erc20/${contract}/transfers?chain=${chainMap[chain]}&limit=50`, {
      headers: { 'X-API-Key': key },
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    })
    return res.ok ? await res.json() : { __status: 'error' }
  } catch { return { __status: 'error' } }
}

function safeHolderReason(reason: string | null | undefined): string {
  const r = String(reason ?? '').toLowerCase().trim()
  if (!r) return 'holder_data_unavailable'
  if (r.includes('missing_api_key')) return 'holder_provider_not_configured'
  if (r.includes('timeout')) return 'holder_provider_timeout'
  if (r.includes('bad_request')) return 'holder_query_rejected'
  if (r.includes('provider_unavailable')) return 'holder_provider_unavailable'
  if (r.includes('no_percentages')) return 'holder_rows_without_percentages'
  if (r.includes('no_rows')) return 'no_holder_rows_returned'
  if (r.includes('derived_from_supply')) return 'holder_percentages_derived_from_supply'
  if (r.includes('api_error') || r.includes('error')) return 'holder_provider_error'
  return reason ?? 'holder_data_unavailable'
}


async function fetchGMGN(contract: string): Promise<any> {
  try {
    const res = await fetch(`https://api.gmgn.ai/token/${contract}`, { signal: AbortSignal.timeout(3000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function fetchTokenMetadata(chain: ChainKey, contract: string): Promise<any> {
  try {
    const res = await fetch(
      `https://api.covalenthq.com/v1/${chain}/address/0x0000000000000000000000000000000000000000/balances_v2/?key=${process.env.COVALENT_API_KEY}&contract-address=${contract}`,
      { signal: AbortSignal.timeout(5000) }
    );
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}


async function fetchTokenHolders(_chain: ChainKey, contract: string): Promise<any> {
  const CHAIN_SLUG_MAP: Record<ChainKey, string> = {
    eth: 'eth-mainnet',
    base: 'base-mainnet',
    polygon: 'matic-mainnet',
    bnb: 'bsc-mainnet',
  }
  const chainSlug = CHAIN_SLUG_MAP[_chain] ?? 'base-mainnet'
  const endpointPath = `/v1/${chainSlug}/tokens/${contract}/token_holders_v2/`
  let statusCode: number | undefined
  try {
    // Use GOLDRUSH_API_KEY first (matches proxy/test routes); fall back to COVALENT_API_KEY
    const apiKey = process.env.GOLDRUSH_API_KEY ?? process.env.COVALENT_API_KEY ?? ''
    if (!apiKey) {
      console.warn('[holder-debug] contract', contract, 'chain', chainSlug, 'result: missing API key')
      return { __status: 'unavailable', __reason: 'missing_api_key', __endpointPath: endpointPath, __chainUsed: chainSlug, __hasApiKey: false }
    }
    // page-size max accepted by Covalent: 100. Values above that (e.g. 200) return HTTP 400.
    const _grBase = (process.env.GOLDRUSH_BASE_URL ?? 'https://api.covalenthq.com').replace(/\/$/, '')
    const url = `${_grBase}${endpointPath}?page-number=0&page-size=100`
    console.log('[holder-debug] contract', contract, 'chain', chainSlug, 'path', endpointPath, 'params page-number=0&page-size=100')
    const res = await fetch(url, {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    })
    statusCode = res.status
    if (!res.ok) {
      // Try to parse JSON error body for a safe reason; fall back to text snippet
      let safeReason = statusCode === 400 ? 'bad_request_check_endpoint_params' : 'provider_unavailable'
      try {
        const errJson = await res.json()
        if (errJson?.error_message) safeReason = errJson.error_message
        console.warn('[holder-debug] non-ok', statusCode, 'error_message:', errJson?.error_message ?? '(none)', 'error_code:', errJson?.error_code ?? '(none)')
      } catch {
        const errText = await res.text().catch(() => '').then(t => t.slice(0, 200))
        console.warn('[holder-debug] non-ok', statusCode, errText)
      }
      return { __status: 'error', __reason: safeReason, __statusCode: statusCode, __endpointPath: endpointPath, __chainUsed: chainSlug, __hasApiKey: true }
    }
    const json = await res.json()
    const topKeys = Object.keys(json ?? {})
    const itemCount = json?.data?.items?.length ?? 0
    console.log('[holder-debug] statusCode', statusCode, 'responseKeys', topKeys, 'data.items.length', itemCount)
    if (json?.error) {
      console.warn('[holder-debug] API-level error:', json?.error_message)
      return { __status: 'error', __reason: json?.error_message ?? 'api_error', __statusCode: statusCode, __endpointPath: endpointPath, __responseKeys: topKeys, __chainUsed: chainSlug, __hasApiKey: true }
    }
    return { ...json, __endpointPath: endpointPath, __statusCode: statusCode, __responseKeys: topKeys, __chainUsed: chainSlug, __hasApiKey: true }
  } catch (err) {
    console.error('[holder-debug] exception', err)
    return { __status: 'error', __reason: 'provider_unavailable', __statusCode: statusCode, __endpointPath: endpointPath, __chainUsed: chainSlug, __hasApiKey: Boolean(process.env.GOLDRUSH_API_KEY ?? process.env.COVALENT_API_KEY) }
  }
}

type LpControlResult = {
  status: "burned" | "locked" | "protocol" | "team_controlled" | "concentrated_liquidity" | "partial" | "unverified" | "no_pool" | "insufficient_data" | "error";
  confidence: "high" | "medium" | "low";
  poolType: "v2" | "v3" | "aerodrome" | "concentrated" | "unknown";
  source: string;
  reason: string;
  evidence: string[];
  poolAddressPresent?: boolean;
  selectedPrimaryPoolSource?: string;
  dexId?: string;
  dexName?: string;
  probeV2Like?: boolean;
  probeV3Like?: boolean;
  lpVerificationPoolReason?: string;
};
type LpDiagnostics = {
  attempted: boolean;
  chain: ChainKey;
  poolCount: number;
  primaryPoolAddress: string | null;
  primaryDex: string | null;
  poolType: string;
  lpTokenFound: boolean;
  lpTokenAddress: string | null;
  lpTokenTotalSupplyFound: boolean;
  burnBalanceFound: boolean;
  lockerBalanceFound: boolean;
  teamBalanceFound: boolean;
  lpState: LpControlResult["status"];
  confidence: LpControlResult["confidence"];
  reason: string;
  goldrushAttempted: boolean;
  goldrushItemCount: number;
  goldrushPctDerived: boolean;
  rpcFallbackAttempted: boolean;
  // Extended diagnostic fields
  goldrushStatus: string | null;
  rpcAttempted: boolean;
  totalSupplyChecked: boolean;
  burnAddressesChecked: boolean;
  lockerAddressesChecked: boolean;
  ownerTeamBalanceChecked: boolean;
  burnPercent: number | null;
  lockedPercent: number | null;
  teamPercent: number | null;
  failureReason: string | null;
  dexscreenerPoolSynthesized: boolean;
  poolDetected: boolean;
  poolSource: string;
  primaryPoolSelected: boolean;
  selectedPoolAddress: string | null;
  selectedPoolDex: string | null;
  selectedPoolType: string | null;
  selectedPoolLiquidityUsd: number | null;
};

type LpControlRead = {
  title: string;
  meaning: string;
  riskLevel: string;
  whatWasFound: string[];
  couldNotVerify: string[];
  nextAction: string;
};

function computeLpControlRead(lp: LpControlResult, pairName?: string | null): LpControlRead {
  const pair = pairName ? `Pair: ${pairName}` : null;
  const poolLine = pair ? ["Verification pool found", pair] : lp.poolAddressPresent ? ["Verification pool found"] : [];
  switch (lp.status) {
    case "burned":
      return {
        title: "LP tokens burned",
        meaning: "The LP tokens for this pool have been sent to a burn/dead address. Liquidity cannot be removed by a team wallet.",
        riskLevel: "Low",
        whatWasFound: [...poolLine, "Dominant LP share in burn/dead address"],
        couldNotVerify: [],
        nextAction: "Burn status confirmed. Standard rug-via-LP-removal risk is significantly reduced.",
      };
    case "locked":
      return {
        title: "LP tokens locked",
        meaning: "The majority of LP tokens are held by a known locker contract. Liquidity is constrained by the lock terms.",
        riskLevel: "Low — verify lock expiry",
        whatWasFound: [...poolLine, "Dominant LP share in known locker"],
        couldNotVerify: ["Lock expiry date", "Specific lock terms"],
        nextAction: "Check the locker contract for expiry date and unlock conditions.",
      };
    case "team_controlled":
      return {
        title: "LP controlled by wallet",
        meaning: "A single wallet holds dominant LP share and can remove liquidity at any time.",
        riskLevel: "High",
        whatWasFound: [...poolLine, "Single wallet holds dominant LP share"],
        couldNotVerify: [],
        nextAction: "Liquidity removal risk exists. Treat with caution until LP is locked or burned.",
      };
    case "protocol":
      if (lp.poolType === "aerodrome") {
        return {
          title: "Protocol liquidity — requires protocol-specific verification",
          meaning: "Liquidity is in an Aerodrome/Velodrome protocol pool. LP positions cannot be verified using the standard V2 LP-holder method.",
          riskLevel: "Not assessable via V2 method",
          whatWasFound: [...poolLine, "Pool type: Aerodrome/Velodrome"],
          couldNotVerify: ["LP holder distribution (V2 method N/A)", "Lock or burn status via standard ERC-20 check"],
          nextAction: "Verify LP lock via Aerodrome protocol — check veNFT positions or protocol lock features.",
        };
      }
      return {
        title: "Protocol liquidity — requires protocol-specific verification",
        meaning: "Liquidity is in a concentrated-liquidity (V3) pool. LP positions are NFTs, not standard ERC-20 tokens — V2 holder checks do not apply.",
        riskLevel: "Not assessable via V2 method",
        whatWasFound: [...poolLine, "Pool type: concentrated / V3"],
        couldNotVerify: ["LP token holder distribution (V2 method N/A)", "Lock or burn status via standard ERC-20 check"],
        nextAction: "Check LP positions on-chain via the V3 position manager or a protocol-specific explorer.",
      };
    case "concentrated_liquidity":
      return {
        title: "Concentrated liquidity detected",
        meaning: "Concentrated liquidity pool detected. Exit depth may shift rapidly.",
        riskLevel: "Caution",
        whatWasFound: [...poolLine, "Pool type: concentrated / V3"],
        couldNotVerify: ["Locker proof unavailable via standard ERC-20 LP holder method"],
        nextAction: "Inspect active position ranges and protocol lock mechanics.",
      };
    case "partial":
      return {
        title: "Partial LP proof",
        meaning: "Pool detected, lock/burn proof not fully confirmed.",
        riskLevel: "Medium",
        whatWasFound: [...poolLine, "Some LP checks returned usable data"],
        couldNotVerify: ["Complete lock/burn/team LP proof"],
        nextAction: "Treat LP control as partial until more holder or RPC evidence is available.",
      };
    case "no_pool":
    case "insufficient_data":
      return {
        title: "Insufficient LP verification data",
        meaning: lp.status === "no_pool" ? "No usable liquidity pool address was found for LP verification." : "LP ownership could not be verified this scan.",
        riskLevel: "Unknown",
        whatWasFound: lp.status === "no_pool" ? [] : [...poolLine, "Pool check attempted"],
        couldNotVerify: ["Burn proof", "Locker proof", "Dominant owner verification"],
        nextAction: lp.status === "no_pool" ? "Confirm token has an active pool with a usable on-chain pair address." : "Rescan and verify with additional on-chain LP ownership data.",
      };
    default: // unverified, error
      if (!lp.poolAddressPresent) {
        return {
          title: "Pool detected, lock/burn proof not confirmed",
          meaning: "Pool detected, lock/burn proof not confirmed.",
          riskLevel: "Unknown",
          whatWasFound: [],
          couldNotVerify: ["LP token distribution", "Lock or burn status", "Liquidity pool existence"],
          nextAction: "Confirm the token is actively traded. No pool means no on-chain liquidity depth to exit through.",
        };
      }
      if (lp.poolType === "v2") {
        return {
          title: "LP check inconclusive",
          meaning: "A V2 pool was found and checked, but holder data did not show a dominant burn, locker, or single-wallet pattern.",
          riskLevel: "Medium",
          whatWasFound: [...poolLine, "V2 LP holder check attempted"],
          couldNotVerify: ["Dominant lock or burn address", "Single-wallet LP concentration"],
          nextAction: "LP control unconfirmed. Monitor for large LP removal transactions.",
        };
      }
      return {
        title: "LP Control: Unverified",
        meaning: "Liquidity exists, but LP lock/control could not be proven from current checks.",
        riskLevel: "Medium — needs verification",
        whatWasFound: [...poolLine, "Major quote pool selected", "Alchemy RPC checks attempted"],
        couldNotVerify: ["LP token holder distribution", "Lock or burn status", "Standard V2/V3 LP interface"],
        nextAction: "Treat LP control as unverified until locker, burn-address, or protocol-specific proof is found.",
      };
  }
}

function normalizeDexLabel(raw: string | null): string | null {
  if (!raw) return null
  const s = raw.toLowerCase().replace(/[-_\s]+/g, '_')
  const map: Record<string, string> = {
    uniswap_v4:           'Uniswap V4',
    uniswapv4:            'Uniswap V4',
    uniswap_v3:           'Uniswap V3',
    uniswapv3:            'Uniswap V3',
    uniswap_v2:           'Uniswap V2',
    uniswapv2:            'Uniswap V2',
    uniswap:              'Uniswap',
    aerodrome_slipstream: 'Aerodrome Slipstream',
    aerodrome:            'Aerodrome',
    baseswap_v2:          'BaseSwap',
    baseswap:             'BaseSwap',
    pancakeswap_v3:       'PancakeSwap V3',
    pancakeswap_v2:       'PancakeSwap V2',
    pancakeswap:          'PancakeSwap',
    sushiswap_v3:         'SushiSwap V3',
    sushiswap_v2:         'SushiSwap V2',
    sushiswap:            'SushiSwap',
    alienbase:            'AlienBase',
    swapbased:            'SwapBased',
  }
  if (map[s]) return map[s]
  // Partial prefix match for network-specific variants (e.g. "uniswap-v4-base", "aerodrome-base")
  if (s.startsWith('uniswap_v4')) return 'Uniswap V4'
  if (s.startsWith('uniswap_v3')) return 'Uniswap V3'
  if (s.startsWith('uniswap_v2')) return 'Uniswap V2'
  if (s.startsWith('aerodrome')) return 'Aerodrome'
  if (s.startsWith('pancakeswap_v3')) return 'PancakeSwap V3'
  if (s.startsWith('pancakeswap')) return 'PancakeSwap'
  if (s.startsWith('sushiswap_v3')) return 'SushiSwap V3'
  if (s.startsWith('sushiswap')) return 'SushiSwap'
  if (s.startsWith('baseswap')) return 'BaseSwap'
  return null
}

function computePairAge(createdAt: string): string | null {
  try {
    const ms = Date.now() - new Date(createdAt).getTime()
    if (isNaN(ms) || ms < 0) return null
    const mins  = Math.floor(ms / 60000)
    const hours = Math.floor(ms / 3600000)
    const days  = Math.floor(ms / 86400000)
    if (mins  < 60) return `${mins}m`
    if (hours < 48) return `${hours}h`
    if (days  < 60) return `${days}d`
    return `${Math.floor(days / 30)}mo`
  } catch { return null }
}

function extractPoolDex(pool: Record<string, unknown> | null, included: unknown[]): { dexId: string; dexName: string } {
  if (!pool) return { dexId: "", dexName: "" };
  const a = (pool.attributes ?? {}) as Record<string, unknown>;
  const rel = (pool.relationships ?? {}) as Record<string, unknown>;
  const attrDexId = String(a.dex_id ?? a.dex ?? "").toLowerCase().trim();
  const attrDexName = String(a.dex_name ?? "").toLowerCase().trim();
  const relDexData = ((rel.dex as Record<string, unknown> | undefined)?.data as Record<string, unknown> | undefined);
  const relDexId = String(relDexData?.id ?? "").toLowerCase().trim();
  const lookupId = relDexId || attrDexId;
  let incDexName = "";
  if (lookupId && included.length) {
    const dexObj = included.find((x) => String((x as Record<string, unknown>).id ?? "").toLowerCase() === lookupId) as Record<string, unknown> | undefined;
    if (dexObj) incDexName = String(((dexObj.attributes ?? {}) as Record<string, unknown>).name ?? "").toLowerCase().trim();
  }
  return { dexId: attrDexId || relDexId, dexName: attrDexName || incDexName || attrDexId || relDexId };
}

function normalizePool(pool: Record<string, unknown> | null, includedTokenById: Map<string, Record<string, unknown>>): NormalizedPool {
  const attrs = (pool?.attributes ?? {}) as Record<string, unknown>;
  const rel = (pool?.relationships ?? {}) as Record<string, unknown>;
  const baseId = String((((rel.base_token as Record<string, unknown> | undefined)?.data as Record<string, unknown> | undefined)?.id) ?? "").trim();
  const quoteId = String((((rel.quote_token as Record<string, unknown> | undefined)?.data as Record<string, unknown> | undefined)?.id) ?? "").trim();
  const baseInc = baseId ? (includedTokenById.get(baseId) ?? {}) : {};
  const quoteInc = quoteId ? (includedTokenById.get(quoteId) ?? {}) : {};
  const baseTokenAddress = String((baseInc as Record<string, unknown>).address ?? "").trim().toLowerCase() || null;
  const quoteTokenAddress = String((quoteInc as Record<string, unknown>).address ?? "").trim().toLowerCase() || null;
  const baseTokenSymbol = String((baseInc as Record<string, unknown>).symbol ?? "").trim() || null;
  const quoteTokenSymbol = String((quoteInc as Record<string, unknown>).symbol ?? "").trim() || null;
  const _addrRaw = String(attrs.address ?? '').trim().toLowerCase()
  const _idHex = String(pool?.id ?? '').match(/0x[a-f0-9]{40}/i)?.[0]?.toLowerCase() ?? null
  const address = (/^0x[a-f0-9]{40}$/.test(_addrRaw) ? _addrRaw : _idHex) || null
  const { dexId, dexName } = extractPoolDex(pool, []);
  return {
    address,
    pairName: String(attrs.name ?? attrs.pool_name ?? attrs.pair_name ?? "").trim() || null,
    liquidityUsd: pickNum(attrs.reserve_in_usd, attrs.liquidity_usd, attrs.reserve_usd) ?? 0,
    dexId: dexId || null,
    dexName: dexName || null,
    baseTokenSymbol,
    quoteTokenSymbol,
    baseTokenAddress,
    quoteTokenAddress,
    poolType: detectPoolType(pool, dexId || undefined),
    hasDexMeta: Boolean(dexId || dexName),
    isValidAddress: Boolean(address && /^0x[a-f0-9]{40}$/.test(address)),
    raw: pool,
  };
}

type NormalizedPool = {
  address?: string | null;
  pairName?: string | null;
  liquidityUsd: number;
  dexId?: string | null;
  dexName?: string | null;
  baseTokenSymbol?: string | null;
  quoteTokenSymbol?: string | null;
  baseTokenAddress?: string | null;
  quoteTokenAddress?: string | null;
  poolType: "v2" | "v3" | "aerodrome" | "concentrated" | "unknown";
  hasDexMeta: boolean;
  isValidAddress: boolean;
  containsScannedToken?: boolean;
  isPreferredQuote?: boolean;
  lpScore?: number;
  selectionReason?: string;
  raw?: unknown;
};

function selectLpVerificationPool(pools: NormalizedPool[], tokenAddress: string): { pool: NormalizedPool | null; reason: string; candidates: NormalizedPool[] } {
  const tokenLc = tokenAddress.toLowerCase();
  const quoteRank: Record<string, number> = {
    WETH: 1,
    USDC: 2,
    USDBC: 3,
    CBBTC: 4,
    DAI: 5,
    USDT: 6,
  };
  let best: { pool: NormalizedPool; score: number; reason: string } | null = null;
  for (const p of pools) {
    const includesToken = p.baseTokenAddress === tokenLc || p.quoteTokenAddress === tokenLc;
    const otherSymbol = p.baseTokenAddress === tokenLc ? p.quoteTokenSymbol : p.baseTokenSymbol;
    const quotePriority = otherSymbol ? quoteRank[otherSymbol.toUpperCase()] ?? null : null;
    const hasPreferredQuote = quotePriority != null;
    const v2LikeMeta = p.poolType === "v2";
    let score = 0;
    if (includesToken) score += 300;
    else score -= 1000;
    if (hasPreferredQuote) score += 500 - (quotePriority! * 50);
    if (v2LikeMeta) score += 20;
    if (p.poolType === "unknown") score -= 5;
    if (p.hasDexMeta) score += 15;
    if (!hasPreferredQuote) score -= 250;
    if (!p.isValidAddress) score -= 150;
    score += Math.min(30, Math.log10(Math.max(1, p.liquidityUsd + 1)) * 6);
    const reason = includesToken
      ? (hasPreferredQuote
          ? `selected quote-priority pool (${otherSymbol}, rank ${quotePriority}) for LP verification`
          : "no preferred quote pair found; selected best token-including fallback pool")
      : "excluded: pool does not include scanned token";
    if (!best || score > best.score) best = { pool: p, score, reason };
    p.containsScannedToken = includesToken;
    p.isPreferredQuote = hasPreferredQuote;
    p.lpScore = score;
    p.selectionReason = reason;
  }
  return best ? { pool: best.pool, reason: best.reason, candidates: pools } : { pool: null, reason: "no_pool_candidates", candidates: pools };
}

function detectPoolType(pool: Record<string, unknown> | null, dexIdHint?: string): LpControlResult["poolType"] {
  const a = (pool?.attributes ?? {}) as Record<string, unknown>;
  const rel = (pool?.relationships ?? {}) as Record<string, unknown>;
  // Correctly extract the dex id from the relationships object (avoids "[object Object]" stringification)
  const relDexId = String(
    ((rel.dex as Record<string, unknown> | undefined)?.data as Record<string, unknown> | undefined)?.id ?? ''
  ).toLowerCase().trim()
  const candidates = [
    dexIdHint,
    relDexId,
    a.dex_id, a.dex, a.dex_name, a.name, a.pool_name, a.pair_name, a.pool_type,
    pool?.id,
  ].map((v) => String(v ?? '').toLowerCase()).filter(Boolean);
  const text = candidates.join(' | ');
  // Fast-path: use startsWith on the most reliable id signals first.
  // This correctly handles network-suffixed variants like "uniswap_v2_eth" or "uniswap_v3_base".
  const idSignals = [dexIdHint ?? '', relDexId, String(a.dex_id ?? a.dex ?? '').toLowerCase().trim()]
  for (const s of idSignals) {
    if (!s) continue
    if (/^aerodrome|^slipstream/.test(s)) return "aerodrome"
    if (/^uniswap_v4|^uniswap-v4/.test(s)) return "v3"  // treat V4 as concentrated
    if (/^uniswap_v3|^uniswap-v3|^pancakeswap_v3|^sushiswap_v3|^algebra/.test(s)) return "v3"
    if (/^uniswap_v2|^uniswap-v2|^pancakeswap_v2|^sushiswap_v2|^baseswap|^alienbase|^swapbased|^shibaswap/.test(s)) return "v2"
    if (/^pancakeswap_v3|^sushiswap_v3/.test(s)) return "v3"
    if (/^sushiswap|^pancakeswap/.test(s)) return "v2"  // unversioned: default to v2
  }
  const has = (re: RegExp) => re.test(text);
  if (has(/\baerodrome\b|\bslipstream\b/)) return "aerodrome";
  if (has(/\bconcentrated\b|\bcl pool\b|\balgebra\b/)) return "concentrated";
  // Use (?:_|-) instead of \b after version number to match "uniswap_v3_eth" etc.
  if (has(/uniswap(?:[_-]?v)?3(?:[_-]|$)|\bpancakeswap(?:[_-]?v)?3(?:[_-]|$)|(?:^| )v3(?:[_-]|$)/)) return "v3";
  if (has(/uniswap(?:[_-]?v)?2(?:[_-]|$)|sushiswap(?:[_-]?v)?2(?:[_-]|$)|pancakeswap(?:[_-]?v)?2(?:[_-]|$)|\bbaseswap\b|\balienbase\b|\bswapbased\b|\bshiba(?:swap)?\b|constant[-_ ]?product|(?:^| )v2(?:[_-]|$)/)) return "v2";
  return "unknown";
}

async function probePoolTypeViaRpc(chain: ChainKey, poolAddr: string): Promise<{ v2Like: boolean; v3Like: boolean; probeSummary: string }> {
  const call = (data: string) => rpcCall(chain, "eth_call", [{ to: poolAddr, data }, "latest"]).catch(() => null);
  const ok = (x: string | null) => Boolean(x && x !== "0x" && x.length > 10);
  const [t0, t1, res, sup, s0, liq] = await Promise.all([
    call("0x0dfe1681"), // token0()
    call("0xd21220a7"), // token1()
    call("0x0902f1ac"), // getReserves()
    call("0x18160ddd"), // totalSupply()
    call("0x3850c7bd"), // slot0()
    call("0x1a686502"), // liquidity()
  ]);
  const v2Like = ok(t0) && ok(t1) && ok(res) && ok(sup);
  const v3Like = ok(t0) && ok(t1) && ok(s0) && ok(liq) && !ok(res);
  return {
    v2Like,
    v3Like,
    probeSummary: `t0=${ok(t0)},t1=${ok(t1)},res=${ok(res)},sup=${ok(sup)},slot0=${ok(s0)},liq=${ok(liq)}`,
  };
}

// ------------------------------
// Contract analysis
// ------------------------------
function analyzeContract(bytecode: string | null): any {
  const suspicious: string[] = [];

  if (!bytecode || bytecode === "0x") {
    return {
      ownerStatus: "Owner/deployer unavailable from current source",
      liquidityStatus: "LP lock/control unavailable from current source",
      honeypot: "Security simulation unavailable from current source",
      suspiciousFunctions: suspicious,
    };
  }

  if (bytecode.includes("selfdestruct") || bytecode.includes("suicide")) {
    suspicious.push("selfdestruct");
  }

  return {
    ownerStatus: "Owner/deployer unavailable from current source",
    liquidityStatus: "LP lock/control unavailable from current source",
    honeypot: "Security simulation unavailable from current source",
    suspiciousFunctions: suspicious,
  };
}

// ------------------------------
// CORTEX Contract Flag Scanner — bytecode + RPC, no external APIs required
// ------------------------------
type ContractFlagStatus = 'verified' | 'possible' | 'not_detected' | 'unverified'
type ContractFlagEntry = { status: ContractFlagStatus; confidence: 'high' | 'medium' | 'low'; note: string | null }
type CortexContractFlagsResult = {
  mint: ContractFlagEntry
  proxy: ContractFlagEntry
  pause: ContractFlagEntry
  blacklist: ContractFlagEntry
  withdraw: ContractFlagEntry
  bytecodeChecked: boolean
  proxySlotChecked: boolean
  pauseCallChecked: boolean
}

// ------------------------------
// CORTEX Risk Engine v1
// Derives risk score from existing scan data only. No external calls.
// ------------------------------
type RiskEngineResult = {
  rugRiskScore: number | null;
  rugRiskLevel: 'low' | 'medium' | 'high' | 'critical' | 'unverified';
  confidence: 'high' | 'medium' | 'low';
  drivers: string[];
  missingChecks: string[];
  sniperActivity: {
    status: 'low_signal' | 'watch' | 'high' | 'unverified';
    confidence: 'high' | 'medium' | 'low';
    reasons: string[];
  };
}

function computeRiskEngine(input: {
  marketCapVerified: boolean;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  holderStatus: string;
  top1: number | null;
  top5: number | null;
  top10: number | null;
  top20: number | null;
  lpStatus: string;
  lpConfidence: string;
  isHoneypot: boolean | null;
  buyTax: number | null;
  sellTax: number | null;
  simulationSuccess: boolean | null;
  pairCreatedAt: string | null;
  holderCount: number | null;
  buys24h: number | null;
  sells24h: number | null;
}): RiskEngineResult {
  let score = 0;
  const drivers: string[] = [];
  const missingChecks: string[] = [];
  let confirmedDataPoints = 0;

  // ── Market cap ─────────────────────────────────────────────────────────────
  if (!input.marketCapVerified) {
    score += 8;
    missingChecks.push('Market cap unverified — circulating supply not confirmed');
  } else {
    confirmedDataPoints++;
  }

  // ── Liquidity depth ────────────────────────────────────────────────────────
  if (input.liquidityUsd == null) {
    score += 5;
    missingChecks.push('Liquidity depth unavailable — pool depth not confirmed');
  } else if (input.liquidityUsd < 25_000) {
    score += 18;
    const liqFmt = input.liquidityUsd < 1_000 ? `<$1K` : `$${(input.liquidityUsd / 1_000).toFixed(1)}K`;
    drivers.push(`Very thin liquidity — ${liqFmt} pool depth`);
    confirmedDataPoints++;
  } else if (input.liquidityUsd < 100_000) {
    score += 10;
    drivers.push(`Thin liquidity — $${(input.liquidityUsd / 1_000).toFixed(0)}K pool depth`);
    confirmedDataPoints++;
  } else {
    confirmedDataPoints++;
  }

  // ── Volume ─────────────────────────────────────────────────────────────────
  if (input.volume24hUsd == null) {
    score += 6;
    missingChecks.push('24h volume unavailable');
  } else if (input.volume24hUsd < 1_000) {
    score += 6;
    drivers.push('Very low 24h trading volume');
    confirmedDataPoints++;
  } else {
    confirmedDataPoints++;
  }

  // ── Holder Map ─────────────────────────────────────────────────────────────
  const holderUnavailable = input.holderStatus === 'unavailable' || input.holderStatus === 'empty' || input.holderStatus === 'error';
  const holderPartial = input.holderStatus === 'partial';
  if (holderUnavailable) {
    score += 15;
    missingChecks.push('Holder Map unavailable — concentration risk cannot be fully verified');
  } else if (holderPartial) {
    score += 8;
    missingChecks.push('Holder Map partial — concentration estimate incomplete');
    confirmedDataPoints++;
  } else if (input.holderStatus === 'ok') {
    confirmedDataPoints++;
    if (input.top10 != null && input.top10 > 50) {
      score += 20;
      drivers.push(`High holder concentration — top 10 wallets hold ${input.top10.toFixed(1)}%`);
    }
    if (input.top20 != null && input.top20 > 60 && !(input.top10 != null && input.top10 > 50)) {
      score += 15;
      drivers.push(`Concentrated ownership — top 20 wallets hold ${input.top20.toFixed(1)}%`);
    }
    if (input.top1 != null && input.top1 > 15) {
      score += 12;
      drivers.push(`Single wallet dominance — top holder owns ${input.top1.toFixed(1)}%`);
    }
  }

  // ── LP Control ─────────────────────────────────────────────────────────────
  const lpSafe = input.lpStatus === 'burned' || input.lpStatus === 'locked';
  const lpTeam = input.lpStatus === 'team_controlled';
  const lpUnverified = input.lpStatus === 'unverified' || input.lpStatus === 'partial' || input.lpStatus === 'no_pool' || input.lpStatus === 'insufficient_data' || input.lpStatus === 'error';
  const lpProtocol = input.lpStatus === 'protocol' || input.lpStatus === 'concentrated_liquidity';

  if (lpTeam) {
    score += 25;
    drivers.push('LP controlled by a team wallet — liquidity can be removed at any time');
    confirmedDataPoints++;
  } else if (lpUnverified) {
    score += 15;
    missingChecks.push('LP Control unverified — lock or burn proof not confirmed');
  } else if (lpSafe) {
    if (input.lpConfidence === 'high') score -= 10;
    confirmedDataPoints++;
  } else if (lpProtocol) {
    missingChecks.push('LP Control uses protocol liquidity — requires protocol-specific verification');
    confirmedDataPoints++;
  }

  // ── Risk Checks (honeypot / tax) ───────────────────────────────────────────
  if (input.isHoneypot === true) {
    score += 30;
    drivers.push('Honeypot detected — sell simulation blocked');
    confirmedDataPoints++;
  } else if (input.isHoneypot === false) {
    confirmedDataPoints++;
  }
  if (input.simulationSuccess === false) {
    missingChecks.push('Risk Checks simulation unavailable — tax and honeypot status unconfirmed');
  }

  const maxTax = Math.max(input.buyTax ?? 0, input.sellTax ?? 0);
  if (maxTax >= 20) {
    score += 20;
    drivers.push(`Very high taxes — buy ${input.buyTax?.toFixed(1) ?? '?'}% / sell ${input.sellTax?.toFixed(1) ?? '?'}%`);
  } else if (maxTax >= 10) {
    score += 10;
    drivers.push(`Elevated taxes — buy ${input.buyTax?.toFixed(1) ?? '?'}% / sell ${input.sellTax?.toFixed(1) ?? '?'}%`);
  }

  // ── Missing checks penalty ─────────────────────────────────────────────────
  score += Math.min(missingChecks.length * 5, 20);

  // ── Clamp ──────────────────────────────────────────────────────────────────
  score = Math.min(100, Math.max(0, Math.round(score)));

  // ── Confidence ────────────────────────────────────────────────────────────
  const confidence: 'high' | 'medium' | 'low' =
    confirmedDataPoints >= 4 ? 'high' :
    confirmedDataPoints >= 2 ? 'medium' : 'low';

  // ── Level ─────────────────────────────────────────────────────────────────
  let rugRiskScore: number | null = score;
  let rugRiskLevel: RiskEngineResult['rugRiskLevel'];
  const coreDataMissing = input.liquidityUsd == null && holderUnavailable && input.simulationSuccess == null && lpUnverified;
  if (confirmedDataPoints === 0 || (confidence === 'low' && coreDataMissing)) {
    rugRiskLevel = 'unverified';
    rugRiskScore = null;
  } else if (score <= 30) {
    rugRiskLevel = 'low';
  } else if (score <= 60) {
    rugRiskLevel = 'medium';
  } else if (score <= 80) {
    rugRiskLevel = 'high';
  } else {
    rugRiskLevel = 'critical';
  }

  // ── Sniper Activity V1 ───────────────────────────────────────────────────
  const sniperReasons: string[] = [];
  let sniperSignalCount = 0;
  let pairAgeMs: number | null = null;
  if (input.pairCreatedAt) {
    try { pairAgeMs = Date.now() - new Date(input.pairCreatedAt).getTime() } catch {}
  }
  const pairAgeHours = pairAgeMs != null ? pairAgeMs / 3_600_000 : null;
  const pairAgeDays = pairAgeMs != null ? pairAgeMs / 86_400_000 : null;

  if (pairAgeHours != null && pairAgeHours < 24) {
    sniperReasons.push(`Pool is very new — launched ${pairAgeHours < 1 ? '<1h' : `~${Math.floor(pairAgeHours)}h`} ago`);
    sniperSignalCount += 2;
  } else if (pairAgeDays != null && pairAgeDays < 7) {
    sniperReasons.push(`Pool launched ${Math.floor(pairAgeDays)}d ago — early phase`);
    sniperSignalCount++;
  }
  if (input.top1 != null && input.top1 > 20 && pairAgeDays != null && pairAgeDays < 14) {
    sniperReasons.push(`Top wallet holds ${input.top1.toFixed(1)}% — early accumulation pattern`);
    sniperSignalCount++;
  }
  if (input.top5 != null && input.top5 > 40 && pairAgeDays != null && pairAgeDays < 14) {
    sniperReasons.push(`Top 5 wallets hold ${input.top5.toFixed(1)}% — concentrated early ownership`);
    sniperSignalCount++;
  }
  if (input.holderCount != null && input.holderCount < 50 && pairAgeDays != null && pairAgeDays < 7) {
    sniperReasons.push(`Very few holders (${input.holderCount}) — entry is highly concentrated`);
    sniperSignalCount++;
  }
  if (input.buys24h != null && input.buys24h > 500 && pairAgeHours != null && pairAgeHours < 6) {
    sniperReasons.push(`${input.buys24h} buys in first hours — abnormal early buy pressure`);
    sniperSignalCount++;
  }

  let sniperStatus: RiskEngineResult['sniperActivity']['status'];
  let sniperConfidence: RiskEngineResult['sniperActivity']['confidence'];
  if (pairAgeHours == null && input.holderStatus !== 'ok') {
    sniperStatus = 'unverified';
    sniperConfidence = 'low';
    if (sniperReasons.length === 0) sniperReasons.push('Early wallet activity unavailable — pool age and holder data not confirmed');
  } else if (sniperSignalCount >= 3) {
    sniperStatus = 'high';
    sniperConfidence = 'high';
  } else if (sniperSignalCount >= 1) {
    sniperStatus = 'watch';
    sniperConfidence = 'medium';
  } else {
    sniperStatus = 'low_signal';
    sniperConfidence = pairAgeHours != null ? 'medium' : 'low';
    if (sniperReasons.length === 0) sniperReasons.push('No strong early wallet concentration signals detected this scan');
  }

  return {
    rugRiskScore,
    rugRiskLevel,
    confidence,
    drivers: drivers.slice(0, 5),
    missingChecks: missingChecks.slice(0, 6),
    sniperActivity: { status: sniperStatus, confidence: sniperConfidence, reasons: sniperReasons.slice(0, 4) },
  };
}

// ------------------------------
// POST handler
// ------------------------------
export async function POST(req: Request) {
  if (!(await checkRate(req))) return NextResponse.json({ error: "Rate limit reached. Try again shortly." }, { status: 429 })

  try {
    const _t0 = Date.now()

    const body = await req.json();
    const { contract: contractInput, debugHolder, debug: debugMode, forceDexFallback: _forceDexFallback } = body;
    const rawChain = String(body.chain ?? 'base').toLowerCase()
    if (rawChain !== 'base' && rawChain !== 'eth') {
      return NextResponse.json({ error: 'Unsupported chain. Use chain=base or chain=eth.' }, { status: 400 })
    }
    const chain: ChainKey = rawChain as ChainKey
    const forceDexFallback = debugMode === true && _forceDexFallback === true
    const originalInput = String(contractInput ?? '').trim()
    const normalizedInput = originalInput.toUpperCase()
    const isAddressInput = /^0x[a-fA-F0-9]{40}$/.test(originalInput)
    const aliasHit = !isAddressInput && chain === 'base' ? BASE_TOKEN_ALIAS_MAP[normalizedInput] : null
    const resolvedAddress = isAddressInput ? originalInput : (aliasHit?.address ?? null)
    const resolvedInput = resolvedAddress ? {
      original: originalInput,
      type: (isAddressInput ? 'address' : 'alias') as 'address' | 'alias' | 'live_search',
      resolvedAddress,
      symbol: aliasHit?.symbol,
      confidence: (isAddressInput ? 'high' : 'high') as 'high' | 'medium' | 'low',
    } : null
    const cacheKey = JSON.stringify({ contract: String(resolvedAddress ?? '').toLowerCase(), chain, _cv: 10, noCache: true })

    // Detect near-valid hex strings (0x prefix but wrong char count) and return a helpful error
    if (!resolvedAddress && /^0x[a-fA-F0-9]+$/i.test(originalInput) && originalInput.length !== 42) {
      return NextResponse.json({
        status: 'invalid_address',
        error: `Invalid EVM address: expected 0x + 40 hex chars, got ${originalInput.length - 2}. Check for typos.`,
      }, { status: 400 })
    }

    if (!resolvedAddress) {
      return NextResponse.json({
        status: 'not_found',
        error: "Couldn't resolve that token. Paste the contract address or try a verified symbol.",
        ...(debugMode === true ? { _diagnostics: { resolverInput: originalInput, resolverType: 'none', resolverCandidatesCount: 0, resolverSelectedAddress: null, resolverReason: 'not_in_alias_map' } } : {}),
      }, { status: 404 })
    }
    const contract = resolvedAddress

    console.log("Incoming scan request:", contract);

    // ETH + BASE are the only chains with full provider support.
    // GoldRush, Moralis, Alchemy RPC, and DexScreener are gated to these chains.
    const SUPPORTED_FULL_SCAN_CHAINS: ChainKey[] = ['eth', 'base']
    const isFullScanChain = SUPPORTED_FULL_SCAN_CHAINS.includes(chain)
    const alchemyConfigured = isFullScanChain && Boolean(getAlchemyRpcUrl(chain))
    const goldrushEnabled = isFullScanChain && Boolean(process.env.GOLDRUSH_API_KEY ?? process.env.COVALENT_API_KEY)
    const moralisEnabled = isFullScanChain && Boolean(process.env.MORALIS_API_KEY)
    const ownerSelectors = ['0x8da5cb5b', '0x893d20e8', '0xf851a440', '0x245a7bfc', '0x5c60da1b']
    let rpcCallsAttempted = 0
    let rpcCallsSucceeded = 0
    let rpcCallsFailed = 0
    const rpcCheckDiagnostics: Array<{ checkName: string; method: string; attempted: boolean; succeeded: boolean; critical: boolean; failureStage: string | null; safeReasonCode: string | null; durationMs: number | null }> = []
    const countedRpcCall = async (method: string, params: unknown[], checkName = "rpcCheck", critical = false) => {
      const t0 = Date.now()
      rpcCallsAttempted += 1
      const out = await rpcCall(chain, method, params)
      if (out) {
        rpcCallsSucceeded += 1
      } else {
        rpcCallsFailed += 1
      }
      if (debugMode) {
        rpcCheckDiagnostics.push({
          checkName,
          method,
          attempted: true,
          succeeded: Boolean(out),
          critical,
          failureStage: out ? null : 'rpc_call',
          safeReasonCode: out
            ? null
            : (!alchemyConfigured
              ? 'missing_env'
              : (checkName === 'ownerCheck' ? 'owner_not_exposed' : 'invalid_contract_response')),
          durationMs: Date.now() - t0,
        })
      }
      return out
    }

    const bytecodePromise = (async () => {
      const t0 = Date.now()
      const out = await fetchBytecode(chain, contract)
      if (debugMode) {
        rpcCheckDiagnostics.push({
          checkName: 'bytecodeCheck',
          method: 'eth_getCode',
          attempted: alchemyConfigured,
          succeeded: Boolean(out),
          critical: true,
          failureStage: out ? null : (alchemyConfigured ? 'rpc_call' : 'preflight'),
          safeReasonCode: out ? null : (alchemyConfigured ? 'rpc_unavailable' : 'missing_env'),
          durationMs: Date.now() - t0,
        })
      }
      return out
    })()
    const [bytecode, goldrush, holdersRaw, gtData, gtTokenInfo, gmgn, metadata, hpResult, coingeckoRaw, moralisHoldersRaw, moralisTransfersRaw, dexFbEarly] = await Promise.all([
      bytecodePromise,
      // GoldRush: ETH + BASE only (metadata token info)
      isFullScanChain ? fetchGoldRush(chain, contract) : Promise.resolve(null),
      // GoldRush holders: ETH + BASE only (LP Safety + holder distribution)
      goldrushEnabled ? fetchTokenHolders(chain, contract) : Promise.resolve({ __status: 'unavailable', __reason: 'chain_not_supported' }),
      fetchGeckoTerminal(contract, chain),
      fetchGeckoTerminalToken(contract, chain),
      fetchGMGN(contract),
      fetchTokenMetadata(chain, contract),
      fetchHoneypotSecurity(contract, CHAIN_ID_MAP[chain]),
      fetchCoinGeckoToken(chain, contract),
      // Moralis: ETH + BASE only (full holder list)
      moralisEnabled ? fetchMoralisHolders(chain, contract) : Promise.resolve({ __status: 'unavailable', __reason: 'chain_not_supported' }),
      moralisEnabled ? fetchMoralisTransfers(chain, contract) : Promise.resolve({ __status: 'unavailable', __reason: 'chain_not_supported' }),
      isFullScanChain ? fetchDexScreenerFallback(contract, chain) : Promise.resolve(null),
    ]);
    const alchemyMandatoryReads = await Promise.all([
      countedRpcCall('eth_call', [{ to: contract, data: ownerSelectors[0] }, 'latest'], 'ownerCheck.owner', false),
      countedRpcCall('eth_call', [{ to: contract, data: ownerSelectors[1] }, 'latest'], 'ownerCheck.getOwner', false),
      countedRpcCall('eth_call', [{ to: contract, data: ownerSelectors[2] }, 'latest'], 'ownerCheck.admin', false),
      countedRpcCall('eth_call', [{ to: contract, data: ownerSelectors[3] }, 'latest'], 'ownerCheck.proxyAdmin', false),
      countedRpcCall('eth_call', [{ to: contract, data: ownerSelectors[4] }, 'latest'], 'ownerCheck.implementation', false),
      countedRpcCall('eth_call', [{ to: contract, data: '0x18160ddd' }, 'latest'], 'totalSupplyCheck.mandatory', true),
    ])
    if (process.env.NODE_ENV === 'development') console.log('[token-timing] phase1Ms', Date.now() - _t0)

    const analysis = analyzeContract(bytecode);

    // GeckoTerminal /tokens/{contract}/pools returns pools for this token directly
    const gtAllPools: any[] = Array.isArray(gtData?.data) ? gtData.data : [];
    const gtIncluded: unknown[] = Array.isArray(gtData?.included) ? gtData.included : [];

    // Sort by liquidity descending — market primary is deepest pool
    const matchingPools = [...gtAllPools].sort(
      (a, b) =>
        parseFloat(b.attributes?.reserve_in_usd || "0") -
        parseFloat(a.attributes?.reserve_in_usd || "0")
    );

    const mainPool = matchingPools[0] ?? null;
    const includedTokenById = new Map<string, Record<string, unknown>>();
    for (const inc of gtIncluded as Array<Record<string, unknown>>) {
      if (inc?.type !== "token") continue;
      const id = String(inc.id ?? "");
      const attrs = (inc.attributes ?? {}) as Record<string, unknown>;
      if (id) includedTokenById.set(id, attrs);
    }
    const normalizedPools = matchingPools.map((p) => normalizePool(p, includedTokenById));
    // When GeckoTerminal has no pool data, synthesize a pool from DexScreener pair address
    // so LP verification (burn/lock/team checks) can still be attempted.
    let _dsFbPoolSynthesized = false
    if (normalizedPools.length === 0 && dexFbEarly?.pairAddress && /^0x[a-f0-9]{40}$/i.test(dexFbEarly.pairAddress)) {
      const _dsFbDexId = dexFbEarly.dexId ?? null
      const _dsFbType = detectPoolType(null, _dsFbDexId ?? undefined)
      normalizedPools.push({
        address: dexFbEarly.pairAddress.toLowerCase(),
        pairName: [dexFbEarly.baseToken?.symbol, dexFbEarly.quoteToken?.symbol].filter(Boolean).join('/') || null,
        liquidityUsd: dexFbEarly.liquidityUsd ?? 0,
        dexId: _dsFbDexId,
        dexName: normalizeDexLabel(_dsFbDexId) || null,
        baseTokenSymbol: dexFbEarly.baseToken?.symbol ?? null,
        quoteTokenSymbol: dexFbEarly.quoteToken?.symbol ?? null,
        baseTokenAddress: dexFbEarly.baseToken?.address?.toLowerCase() ?? null,
        quoteTokenAddress: dexFbEarly.quoteToken?.address?.toLowerCase() ?? null,
        poolType: _dsFbType,
        hasDexMeta: Boolean(_dsFbDexId),
        isValidAddress: true,
      })
      _dsFbPoolSynthesized = true
    }
    const selectedLpPool = selectLpVerificationPool(normalizedPools, String(contract));
    const noActivePools = matchingPools.length === 0;
    const mainPoolAttr = (mainPool?.attributes ?? {}) as Record<string, unknown>;
    const _mpAddrRaw = String(mainPoolAttr.address ?? '').trim().toLowerCase()
    const _mpIdHex = String(mainPool?.id ?? '').match(/0x[a-f0-9]{40}/i)?.[0]?.toLowerCase() ?? null
    const primaryPoolAddress = (/^0x[a-f0-9]{40}$/.test(_mpAddrRaw) ? _mpAddrRaw : _mpIdHex) || null
    // Canonical primary pool for both Liquidity&Pools and LP Control:
    // use the highest-liquidity normalized pool first (same ordering as matchingPools/mainPool),
    // then fall back to LP verification selector if needed.
    const canonicalPrimaryPool = normalizedPools[0] ?? null
    const canonicalPrimaryUsable = Boolean(
      canonicalPrimaryPool?.address &&
      /^0x[a-f0-9]{40}$/.test(canonicalPrimaryPool.address) &&
      (canonicalPrimaryPool.liquidityUsd ?? 0) > 0
    )
    const lpPool = canonicalPrimaryUsable ? canonicalPrimaryPool : selectedLpPool.pool;
    const lpPoolType = lpPool?.poolType ?? "unknown";
    const dexId = String(mainPoolAttr.dex_id ?? mainPoolAttr.dex ?? "").trim() || null;
    const dexName = String(mainPoolAttr.dex_name ?? "").trim() || null;
    // Primary pool DEX display name — exhaustive field search across attributes + relationships
    const _extractedDexId = (() => {
      if (!mainPool) return null
      const mp = mainPool as Record<string, unknown>
      const a = (mp.attributes ?? {}) as Record<string, unknown>
      const rel = (mp.relationships ?? {}) as Record<string, unknown>
      // Pool-level and attribute-level fields
      for (const v of [
        mp.dex, mp.dex_id, mp.dexId, mp.exchange, mp.protocol,
        a.dex, a.dex_id, a.dexId, a.exchange, a.protocol,
      ]) {
        if (v && typeof v === 'string' && v.trim()) return v.trim()
      }
      // relationships.dex.data.id (standard JSON:API format)
      const dexRelData = ((rel.dex as Record<string, unknown>)?.data) as Record<string, unknown> | undefined
      if (dexRelData?.id && typeof dexRelData.id === 'string') return String(dexRelData.id).trim()
      // relationships.dexes.data[0].id
      const dexesArr = ((rel.dexes as Record<string, unknown>)?.data) as Array<Record<string, unknown>> | undefined
      if (Array.isArray(dexesArr) && dexesArr[0]?.id) return String(dexesArr[0].id).trim()
      // Hint from pool name or ID
      const nameHint = String(a.name ?? a.pool_name ?? mp.id ?? '').toLowerCase()
      if (/uniswap[\s\-_v]*4/i.test(nameHint)) return 'uniswap-v4'
      if (/uniswap[\s\-_v]*3/i.test(nameHint)) return 'uniswap-v3'
      if (/uniswap[\s\-_v]*2/i.test(nameHint)) return 'uniswap-v2'
      if (/aerodrome/i.test(nameHint)) return 'aerodrome'
      if (/baseswap/i.test(nameHint)) return 'baseswap'
      if (/pancakeswap/i.test(nameHint)) return 'pancakeswap'
      return dexId || dexName || null
    })()
    const primaryDexName = normalizeDexLabel(_extractedDexId)
    const pairName = String(mainPoolAttr.name ?? mainPoolAttr.pool_name ?? mainPoolAttr.pair_name ?? "").trim() || null;
    const selectedPrimaryPoolSource = String(mainPoolAttr.address ?? "").trim() ? "attributes.address" : (String(mainPool?.id ?? "").trim() ? "pool.id_normalized" : "none");
    const poolAddressPresent = Boolean(primaryPoolAddress && /^0x[a-f0-9]{40}$/.test(primaryPoolAddress));
    // Early signals needed for phase 2 setup (computed before full field resolution)
    const _gtEarly = gtTokenInfo?.data?.attributes ?? null
    const _poolAttrEarly = (mainPool?.attributes ?? {}) as Record<string, unknown>
    const _priceEarly = pickNum(_poolAttrEarly.base_token_price_usd, _gtEarly?.price_usd, _gtEarly?.price)
    const _mcEarly = toNum(_gtEarly?.market_cap_usd)
    const _decEarly: number = typeof _gtEarly?.decimals === 'number' ? _gtEarly.decimals : 18
    const _liqEarly = pickNum(mainPool?.attributes?.reserve_in_usd)
    const hasSecurityData = Boolean(hpResult.ok)
    const lpPoolAddress = lpPool?.address ?? null
    const lpDexId = lpPool?.dexId ?? null
    const lpDexName = lpPool?.dexName ?? null
    const lpPoolAddressPresent = Boolean(lpPoolAddress && /^0x[a-f0-9]{40}$/.test(lpPoolAddress))
    // Log LP pool selection so production scans self-document the fix
    if (process.env.NODE_ENV === 'development' || process.env.LP_DEBUG === '1') {
      console.log('[lp-pool-select]', JSON.stringify({
        contract, chain,
        gtPoolCount: matchingPools.length,
        mainPoolId: mainPool?.id ?? null,
        mainPoolAttrAddress: (mainPool?.attributes as Record<string,unknown>)?.address ?? null,
        normalizedPoolCount: normalizedPools.length,
        lpPoolAddress, lpPoolType, lpPoolAddressPresent,
        dexscreenerPoolSynthesized: _dsFbPoolSynthesized,
      }))
    }
    const needsLpHolderFetch = Boolean(lpPoolAddressPresent && (lpPoolType === 'v2' || lpPoolType === 'unknown'))
    const needsAI = !noActivePools || hasSecurityData
    const needsOnchainMc = _mcEarly == null && _priceEarly != null

    // Compact AI prompt (key fields only — reduces token count and latency)
    const _aiPrompt = [
      `Summarize this ${chain === 'eth' ? 'Ethereum' : 'Base'} token risk in 3-4 sentences. Cover liquidity, security, and ownership. Plain text only, no markdown.`,
      `CONTRACT: ${contract} PRICE: ${_priceEarly ?? 'unknown'} LIQUIDITY: $${_liqEarly?.toFixed(0) ?? 'unknown'} POOLS: ${matchingPools.length}`,
      `SECURITY: ${hpResult.ok ? `honeypot=${hpResult.honeypot} buyTax=${hpResult.buyTax ?? '?'}% sellTax=${hpResult.sellTax ?? '?'}%` : 'simulation unavailable'}`,
      `SUSPICIOUS_BYTECODE: ${analysis.suspiciousFunctions.length ? analysis.suspiciousFunctions.join(', ') : 'none detected'}`,
      noActivePools ? 'NO ACTIVE POOLS FOUND.' : '',
      'If critical data missing, state token is unverified.',
    ].filter(Boolean).join('\n')

    // Phase 2: LP holder fetch + AI summary + onchain supply all in parallel
    const _t2 = Date.now()
    const [_lpHoldersSettled, _aiSettled, _onchainSettled] = await Promise.allSettled([
      needsLpHolderFetch
        ? Promise.race([
            fetchTokenHolders(chain, lpPoolAddress!),
            new Promise<Record<string, unknown>>(r =>
              setTimeout(() => r({ __status: 'error', __reason: 'lp_holder_timeout' }), 7000)
            ),
          ])
        : Promise.resolve(null),
      needsAI
        ? Promise.race([
            anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 600, messages: [{ role: 'user', content: _aiPrompt }] }),
            new Promise<null>(r => setTimeout(() => r(null), 18000)),
          ])
        : Promise.resolve(null),
      needsOnchainMc ? fetchOnchainSupply(chain, contract) : Promise.resolve(null),
    ])
    if (process.env.NODE_ENV === 'development') console.log('[token-timing] phase2Ms', Date.now() - _t2, 'needsLP', needsLpHolderFetch, 'needsAI', needsAI, 'needsOnchain', needsOnchainMc)

    // Early owner fetch for LP team-wallet check — runs after phase2 to not block parallel work.
    // Only needed when pool is V2-like (burn/locker checks will use it). Fast single RPC call.
    const _ownerHexForLp = (lpPoolAddressPresent && (lpPoolType === 'v2' || lpPoolType === 'unknown'))
      ? await rpcCall(chain, 'eth_call', [{ to: contract, data: '0x8da5cb5b' }, 'latest']).catch(() => null)
      : null
    const ownerAddrEarlyForLp = _ownerHexForLp && _ownerHexForLp.length >= 42 ? `0x${_ownerHexForLp.slice(-40)}`.toLowerCase() : null

    // LP control using pre-fetched LP holder data (no sequential blocking)
    const _lpHoldersForControl = (_lpHoldersSettled.status === 'fulfilled' ? _lpHoldersSettled.value : { __status: 'error', __reason: 'lp_fetch_failed' }) as any
    const _lpAddrSnippet = lpPoolAddress ? `${lpPoolAddress.slice(0, 10)}…${lpPoolAddress.slice(-4)}` : "none";
    const lpPair = lpPool?.pairName ?? `${lpPool?.baseTokenSymbol ?? "?"}/${lpPool?.quoteTokenSymbol ?? "?"}`;
    const marketPair = pairName ?? "unknown";
    const lpReason = canonicalPrimaryUsable
      ? "using canonical primary highest-liquidity pool for LP verification"
      : (
          selectedLpPool.reason.includes("no preferred quote pair")
            ? "No WETH/USDC/USDbC/cbBTC verification pool found from provider; using best available pool."
            : selectedLpPool.reason
        );
    const _lpBaseDiagnostics = [
      ...(lpPool ? [`Verification pool: ${lpPair}`] : []),
      `Pool type: ${lpPoolType}`,
      `DEX metadata: ${lpPool?.hasDexMeta ? (lpPool.dexId ?? lpPool.dexName ?? "available") : "unavailable"}`,
    ];
    const DEAD = new Set(["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dead"]);
    const KNOWN_LOCKERS = new Set<string>([
      "0x663a5c229c09b049e36dcca11a9d0d4a0f33f3f9", // UNCX / UniCrypt
      "0x71b5759d73262fbb223956913ecf4ecc51057641", // PinkLock
      "0xe2fe530c047f2d85298b07d9333c05737f1435fb", // Team Finance
      "0xdba68f07d1b7ca219f78ae8582c213d975c25caf", // UniCrypt V3
      "0xf6c7282943dc5ea13461ef77dd3a24e5d01e5e1a", // DxLock
      "0x0be46842df45f36a19bea0de0fd6e34da00fd8a5", // Mudra
    ]);
    const confidenceFor = (pct: number): "high" | "medium" | "low" => pct >= 80 ? "high" : pct >= 50 ? "medium" : "low";
    let lpDiagnostics: LpDiagnostics = {
      attempted: lpPoolAddressPresent,
      chain,
      poolCount: matchingPools.length,
      primaryPoolAddress,
      primaryDex: primaryDexName ?? lpDexName ?? lpDexId ?? null,
      poolType: lpPoolType,
      lpTokenFound: lpPoolAddressPresent,
      lpTokenAddress: lpPoolAddress,
      lpTokenTotalSupplyFound: false,
      burnBalanceFound: false,
      lockerBalanceFound: false,
      teamBalanceFound: false,
      lpState: "unverified",
      confidence: "low",
      reason: "LP control requires holder-level LP token verification.",
      goldrushAttempted: needsLpHolderFetch,
      goldrushItemCount: 0,
      goldrushPctDerived: false,
      rpcFallbackAttempted: false,
      goldrushStatus: null,
      rpcAttempted: false,
      totalSupplyChecked: false,
      burnAddressesChecked: false,
      lockerAddressesChecked: false,
      ownerTeamBalanceChecked: false,
      burnPercent: null,
      lockedPercent: null,
      teamPercent: null,
      failureReason: null,
      dexscreenerPoolSynthesized: _dsFbPoolSynthesized,
      poolDetected: normalizedPools.length > 0,
      poolSource: _dsFbPoolSynthesized ? 'dexscreener_synthesized' : (matchingPools.length > 0 ? 'geckoterminal' : 'none'),
      primaryPoolSelected: Boolean(lpPoolAddressPresent && (lpPool?.liquidityUsd ?? 0) > 0),
      selectedPoolAddress: lpPoolAddress,
      selectedPoolDex: lpPool?.dexId ?? lpPool?.dexName ?? null,
      selectedPoolType: lpPoolType,
      selectedPoolLiquidityUsd: lpPool?.liquidityUsd ?? null,
    };
    let lpControl: LpControlResult = {
      status: "unverified",
      confidence: "low",
      poolType: lpPoolType,
      source: "dex_data",
      reason: "LP control requires holder-level LP token verification.",
      evidence: _lpBaseDiagnostics,
      poolAddressPresent: Boolean(lpPoolAddress),
      dexId: dexId || undefined,
      dexName: dexName || undefined,
      lpVerificationPoolReason: lpReason,
    };
    let _lpGrPctDerived = false
    let _lpRpcFallbackRan = false
    let _lpGrItemCount = 0
    if (!lpPoolAddressPresent) {
      lpControl = { ...lpControl, status: "no_pool", reason: "No pool address found from provider for LP-holder verification." };
    } else if (lpPoolType === "v3" || lpPoolType === "aerodrome" || lpPoolType === "concentrated") {
      lpControl = {
        status: lpPoolType === "aerodrome" ? "protocol" : "concentrated_liquidity",
        confidence: "medium",
        poolType: lpPoolType,
        source: "dex_data",
        reason: "LP lock proof is not applicable to this pool type.",
        evidence: [`pool=${primaryPoolAddress}`, `dex=${lpDexId ?? lpDexName ?? "unknown"}`, `poolType=${lpPoolType}`],
      };
    } else if (lpPoolType === "unknown") {
      // Step 1: try GoldRush LP holder proof (same as v2 path) using pre-fetched data
      const _unknownLpItems = Array.isArray(_lpHoldersForControl?.data?.items) ? _lpHoldersForControl.data.items as Array<Record<string, unknown>> : [];
      _lpGrItemCount = _unknownLpItems.length
      const _grStatus = _lpHoldersForControl?.__status ?? (_unknownLpItems.length > 0 ? 'ok' : 'empty')
      const _unknownLpSupply = _unknownLpItems.find((i: Record<string, unknown>) => i?.total_supply != null)?.total_supply
      const _unknownLpSupplyStr = _unknownLpSupply != null ? String(_unknownLpSupply) : null
      const unknownTop = _unknownLpItems.slice(0, 5).map((h: Record<string, unknown>) => {
        const directPct = toNum(h.percentage) ?? toNum(h.percent) ?? toNum(h.ownership_percentage)
        let derivedPct: number | null = null
        if (directPct == null && _unknownLpSupplyStr != null) {
          derivedPct = bigIntPct(h.balance ?? h.token_balance, _unknownLpSupplyStr)
          if (derivedPct != null) _lpGrPctDerived = true
        }
        return {
          address: String(h.address ?? h.holder_address ?? h.wallet_address ?? "").toLowerCase(),
          pct: directPct ?? derivedPct ?? 0,
        }
      }).filter((x: { address: string; pct: number }) => /^0x[a-f0-9]{40}$/.test(x.address))
      const unknownTopHolder = unknownTop[0] ?? null
      const unknownBurnPct = unknownTop.filter((x: { address: string; pct: number }) => DEAD.has(x.address)).reduce((a: number, b: { pct: number }) => a + (b.pct ?? 0), 0)
      const unknownLockerPct = unknownTop.filter((x: { address: string; pct: number }) => KNOWN_LOCKERS.has(x.address)).reduce((a: number, b: { pct: number }) => a + (b.pct ?? 0), 0)
      const grProvedUnknown = unknownTop.some((x: { pct: number }) => (x.pct ?? 0) > 0)
      if (grProvedUnknown) {
        // GoldRush returned usable holder data — classify from it
        if (unknownBurnPct >= 50) {
          lpControl = { status: "burned", confidence: confidenceFor(unknownBurnPct), poolType: "v2", source: "geckoterminal+goldrush", reason: "Dominant LP share appears in burn/dead addresses.", evidence: [`burn_share=${unknownBurnPct.toFixed(2)}%`, `pool=${_lpAddrSnippet}`], poolAddressPresent: true, dexId: dexId || undefined };
        } else if (unknownLockerPct >= 50) {
          lpControl = { status: "locked", confidence: confidenceFor(unknownLockerPct), poolType: "v2", source: "geckoterminal+goldrush", reason: "Dominant LP share appears in known lockers.", evidence: [`locker_share=${unknownLockerPct.toFixed(2)}%`, `pool=${_lpAddrSnippet}`], poolAddressPresent: true, dexId: dexId || undefined };
        } else if (unknownTopHolder && (unknownTopHolder.pct ?? 0) >= 80 && !DEAD.has(unknownTopHolder.address) && !KNOWN_LOCKERS.has(unknownTopHolder.address)) {
          lpControl = { status: "team_controlled", confidence: "high", poolType: "v2", source: "geckoterminal+goldrush", reason: "Single normal wallet holds dominant LP share.", evidence: [`top_holder=${unknownTopHolder.address}`, `top_share=${(unknownTopHolder.pct ?? 0).toFixed(2)}%`], poolAddressPresent: true, dexId: dexId || undefined };
        } else {
          const partialEv2 = [
            unknownBurnPct > 0.5 ? `burn_share=${unknownBurnPct.toFixed(2)}%` : null,
            unknownLockerPct > 0.5 ? `locker_share=${unknownLockerPct.toFixed(2)}%` : null,
          ].filter(Boolean) as string[]
          lpControl = { status: partialEv2.length ? "partial" : "unverified", confidence: "low", poolType: "v2", source: "geckoterminal+goldrush", reason: "LP holder check inconclusive — no dominant burn/lock pattern.", evidence: [`top_rows=${unknownTop.length}`, ...partialEv2, `pool=${_lpAddrSnippet}`], poolAddressPresent: true, dexId: dexId || undefined };
        }
      } else {
        // Step 2: GoldRush failed or empty — probe pool via RPC to classify
        _lpRpcFallbackRan = true
        const probe = await probePoolTypeViaRpc(chain, lpPoolAddress!);
        if (probe.v2Like) {
          const totalSupplyHex = await countedRpcCall("eth_call", [{ to: lpPoolAddress!, data: "0x18160ddd" }, "latest"], "lpControlCheck.totalSupply", false);
          const totalSupply = totalSupplyHex ? Number(BigInt(totalSupplyHex)) : null;
          if (!totalSupply || totalSupply <= 0) {
            lpControl = { status: "unverified", confidence: "low", poolType: "v2", source: "dex_data+rpc", reason: "Pool probed as V2-like but RPC totalSupply read is unavailable.", evidence: [`Verification pool: ${lpPair}`, "RPC probe: V2-like interface detected"], poolAddressPresent: true, probeV2Like: true, probeV3Like: false, dexId: dexId || undefined };
          } else {
            const readPct = async (addr: string) => {
              const data = `0x70a08231${pad32HexAddress(addr)}`;
              const balHex = await countedRpcCall("eth_call", [{ to: lpPoolAddress!, data }, "latest"], "lpControlCheck.balanceOf", false);
              if (!balHex) return 0;
              return (Number(BigInt(balHex)) / totalSupply) * 100;
            };
            const _ownerForLpProbe = ownerAddrEarlyForLp && !DEAD.has(ownerAddrEarlyForLp) && !KNOWN_LOCKERS.has(ownerAddrEarlyForLp) ? ownerAddrEarlyForLp : null
            const [burn0, burnDead, _lockerPcts, _ownerLpPctProbe] = await Promise.all([
              readPct("0x0000000000000000000000000000000000000000"),
              readPct("0x000000000000000000000000000000000000dEaD"),
              Promise.all([...KNOWN_LOCKERS].map(readPct)),
              _ownerForLpProbe ? readPct(_ownerForLpProbe) : Promise.resolve(0),
            ]);
            const burnShare = burn0 + burnDead;
            const lockerShare = _lockerPcts.reduce((a: number, b: number) => a + b, 0);
            const teamShareProbe = _ownerLpPctProbe ?? 0;
            const base = { poolType: "v2" as const, source: "dex_data+rpc", poolAddressPresent: true, probeV2Like: true, probeV3Like: false, dexId: dexId || undefined };
            if (burnShare >= 50) {
              lpControl = { ...base, status: "burned", confidence: confidenceFor(burnShare), reason: "Dominant LP share appears in burn/dead balances via RPC.", evidence: [`burn_share=${burnShare.toFixed(2)}%`, `pool=${_lpAddrSnippet}`] };
            } else if (lockerShare >= 50) {
              lpControl = { ...base, status: "locked", confidence: confidenceFor(lockerShare), reason: "Dominant LP share appears in known locker balances via RPC.", evidence: [`locker_share=${lockerShare.toFixed(2)}%`, `pool=${_lpAddrSnippet}`] };
            } else if (teamShareProbe >= 80) {
              lpControl = { ...base, status: "team_controlled", confidence: "high", reason: `Owner wallet holds ${teamShareProbe.toFixed(2)}% of LP supply (RPC verified).`, evidence: [`owner_lp_share=${teamShareProbe.toFixed(2)}%`, `pool=${_lpAddrSnippet}`] };
            } else {
              lpControl = { ...base, status: (burnShare > 0 || lockerShare > 0) ? "partial" : "unverified", confidence: "low", reason: "RPC balances do not prove burned/locked LP dominance.", evidence: [`burn_share=${burnShare.toFixed(2)}%`, `locker_share=${lockerShare.toFixed(2)}%`, `pool=${_lpAddrSnippet}`] };
            }
          }
        } else if (probe.v3Like) {
          lpControl = { status: "concentrated_liquidity", confidence: "medium", poolType: "v3", source: "dex_data+rpc", reason: "LP lock proof is not applicable to this pool type.", evidence: [`Verification pool: ${lpPair}`, "RPC probe: concentrated-liquidity interface detected"], poolAddressPresent: true, probeV2Like: false, probeV3Like: true, dexId: dexId || undefined };
        } else {
          lpControl = { status: "unverified", confidence: "low", poolType: "unknown", source: "dex_data+rpc", reason: alchemyConfigured ? "Verification pool found, but current RPC checks did not confirm a standard V2/V3 LP interface." : "LP holder data unavailable and RPC probe did not confirm a standard V2/V3 interface.", evidence: [`Verification pool: ${lpPair}`, "Pool type: unknown", `DEX metadata: ${lpPool?.hasDexMeta ? (lpPool.dexId ?? lpPool.dexName ?? "available") : "unavailable"}`, `GoldRush: ${_grStatus}`, alchemyConfigured ? `RPC probe: ${probe.probeSummary}` : "RPC probe: unavailable (Alchemy not configured)"], poolAddressPresent: true, probeV2Like: false, probeV3Like: false, dexId: dexId || undefined };
        }
      }
    } else {
      // V2 — run GoldRush LP holder check
      const lpItems = Array.isArray(_lpHoldersForControl?.data?.items) ? _lpHoldersForControl.data.items as Array<Record<string, unknown>> : [];
      _lpGrItemCount = lpItems.length
      const _lpGrTotalSupply = lpItems.find(i => i?.total_supply != null)?.total_supply
      const _lpGrSupplyStr = _lpGrTotalSupply != null ? String(_lpGrTotalSupply) : null
      const top = lpItems.slice(0, 5).map((h) => {
        const directPct = toNum(h.percentage) ?? toNum(h.percent) ?? toNum(h.ownership_percentage)
        let derivedPct: number | null = null
        if (directPct == null && _lpGrSupplyStr != null) {
          derivedPct = bigIntPct(h.balance ?? h.token_balance, _lpGrSupplyStr)
          if (derivedPct != null) _lpGrPctDerived = true
        }
        return {
          address: String(h.address ?? h.holder_address ?? h.wallet_address ?? "").toLowerCase(),
          pct: directPct ?? derivedPct ?? 0,
        }
      }).filter((x) => /^0x[a-f0-9]{40}$/.test(x.address));
      const topHolder = top[0] ?? null;
      const burnPct = top.filter((x) => DEAD.has(x.address)).reduce((a, b) => a + (b.pct ?? 0), 0);
      const lockerPct = top.filter((x) => KNOWN_LOCKERS.has(x.address)).reduce((a, b) => a + (b.pct ?? 0), 0);
      if (burnPct >= 50) {
        lpControl = { status: "burned", confidence: confidenceFor(burnPct), poolType: lpPoolType, source: "geckoterminal+goldrush", reason: "Dominant LP share appears in burn/dead addresses.", evidence: [`burn_share=${burnPct.toFixed(2)}%`, `pool=${primaryPoolAddress}`] };
      } else if (lockerPct >= 50) {
        lpControl = { status: "locked", confidence: confidenceFor(lockerPct), poolType: lpPoolType, source: "geckoterminal+goldrush", reason: "Dominant LP share appears in known lockers.", evidence: [`locker_share=${lockerPct.toFixed(2)}%`, `pool=${primaryPoolAddress}`] };
      } else if (topHolder && (topHolder.pct ?? 0) >= 80 && !DEAD.has(topHolder.address) && !KNOWN_LOCKERS.has(topHolder.address)) {
        lpControl = { status: "team_controlled", confidence: "high", poolType: lpPoolType, source: "geckoterminal+goldrush", reason: "Single normal wallet holds dominant LP share.", evidence: [`top_holder=${topHolder.address}`, `top_share=${(topHolder.pct ?? 0).toFixed(2)}%`] };
      } else if (lpItems.length === 0 || !top.some((x) => (x.pct ?? 0) > 0)) {
        // Alchemy RPC fallback when GoldRush holder percentages are unavailable
        _lpRpcFallbackRan = true
        const totalSupplyHex = await countedRpcCall("eth_call", [{ to: lpPoolAddress!, data: "0x18160ddd" }, "latest"], "lpControlCheck.totalSupply", false);
        const totalSupply = totalSupplyHex ? Number(BigInt(totalSupplyHex)) : null;
        if (!totalSupply || totalSupply <= 0) {
          lpControl = { status: "unverified", confidence: "low", poolType: lpPoolType, source: "dex_data+rpc", reason: "LP holder percentages unavailable; RPC totalSupply read is unavailable.", evidence: [`pool=${primaryPoolAddress}`] };
        } else {
          const readPct = async (addr: string) => {
            const data = `0x70a08231${pad32HexAddress(addr)}`;
            const balHex = await countedRpcCall("eth_call", [{ to: lpPoolAddress!, data }, "latest"], "lpControlCheck.balanceOf", false);
            if (!balHex) return 0;
            return (Number(BigInt(balHex)) / totalSupply) * 100;
          };
          const _ownerForLpFallback = ownerAddrEarlyForLp && !DEAD.has(ownerAddrEarlyForLp) && !KNOWN_LOCKERS.has(ownerAddrEarlyForLp) ? ownerAddrEarlyForLp : null
          const [burn0, burnDead, _lockerPcts, _ownerLpPctFallback] = await Promise.all([
            readPct("0x0000000000000000000000000000000000000000"),
            readPct("0x000000000000000000000000000000000000dEaD"),
            Promise.all([...KNOWN_LOCKERS].map(readPct)),
            _ownerForLpFallback ? readPct(_ownerForLpFallback) : Promise.resolve(0),
          ]);
          const burnShare = burn0 + burnDead;
          const lockerShare = _lockerPcts.reduce((a: number, b: number) => a + b, 0);
          const teamShareFallback = _ownerLpPctFallback ?? 0;
          if (burnShare >= 50) {
            lpControl = { status: "burned", confidence: confidenceFor(burnShare), poolType: lpPoolType, source: "dex_data+rpc", reason: "Dominant LP share appears in burn/dead balances via RPC.", evidence: [`burn_share=${burnShare.toFixed(2)}%`] };
          } else if (lockerShare >= 50) {
            lpControl = { status: "locked", confidence: confidenceFor(lockerShare), poolType: lpPoolType, source: "dex_data+rpc", reason: "Dominant LP share appears in known locker balances via RPC.", evidence: [`locker_share=${lockerShare.toFixed(2)}%`] };
          } else if (teamShareFallback >= 80) {
            lpControl = { status: "team_controlled", confidence: "high", poolType: lpPoolType, source: "dex_data+rpc", reason: `Owner wallet holds ${teamShareFallback.toFixed(2)}% of LP supply (RPC verified).`, evidence: [`owner_lp_share=${teamShareFallback.toFixed(2)}%`] };
          } else {
            lpControl = { status: (burnShare > 0 || lockerShare > 0) ? "partial" : "unverified", confidence: "low", poolType: lpPoolType, source: "dex_data+rpc", reason: "RPC balances do not prove burned/locked LP dominance.", evidence: [`burn_share=${burnShare.toFixed(2)}%`, `locker_share=${lockerShare.toFixed(2)}%`] };
          }
        }
      } else {
        const partialEv = [
          burnPct > 0.5 ? `burn_share=${burnPct.toFixed(2)}%` : null,
          lockerPct > 0.5 ? `locker_share=${lockerPct.toFixed(2)}%` : null,
        ].filter(Boolean) as string[]
        const partialReason = partialEv.length
          ? `LP holder check inconclusive — no dominant burn/lock pattern. ${partialEv.join(', ')}.`
          : "LP checks ran but could not prove burned/locked/team-controlled state."
        lpControl = { status: partialEv.length ? "partial" : "unverified", confidence: "low", poolType: lpPoolType, source: "geckoterminal+goldrush", reason: partialReason, evidence: [`top_rows=${top.length}`, ...partialEv] };
      }
    }
    const _extractEvidencePct = (ev: string[], prefix: string): number | null => {
      const line = ev.find(e => e.startsWith(`${prefix}=`))
      if (!line) return null
      return parseFloat(line.split('=')[1]?.replace('%', '') ?? '') || null
    }
    const _lpEv = lpControl.evidence ?? []
    const _extractedBurnPct = _extractEvidencePct(_lpEv, 'burn_share')
    const _extractedLockerPct = _extractEvidencePct(_lpEv, 'locker_share')
    const _extractedTeamPct = _extractEvidencePct(_lpEv, 'owner_lp_share') ?? _extractEvidencePct(_lpEv, 'top_share')
    const _lpFailureReason = lpControl.status === "unverified"
      ? (_lpGrItemCount === 0 && !_lpRpcFallbackRan ? 'goldrush_no_rows'
        : _lpGrItemCount === 0 && _lpRpcFallbackRan ? 'rpc_balance_checks_failed'
        : _lpGrItemCount > 0 ? 'no_burn_or_locker_balance'
        : 'unknown')
      : null
    lpDiagnostics = {
      ...lpDiagnostics,
      lpTokenTotalSupplyFound: _lpEv.some((e) => /totalSupply|burn_share|locker_share|top_rows|top_share/i.test(e)),
      burnBalanceFound: _lpEv.some((e) => /burn_share=/i.test(e)),
      lockerBalanceFound: _lpEv.some((e) => /locker_share=/i.test(e)),
      teamBalanceFound: lpControl.status === "team_controlled",
      lpState: lpControl.status,
      confidence: lpControl.confidence,
      reason: lpControl.reason,
      goldrushItemCount: _lpGrItemCount,
      goldrushPctDerived: _lpGrPctDerived,
      rpcFallbackAttempted: _lpRpcFallbackRan,
      goldrushStatus: needsLpHolderFetch ? (_lpGrItemCount > 0 ? 'ok' : (_lpHoldersForControl?.__reason ?? 'empty')) : 'not_attempted',
      rpcAttempted: _lpRpcFallbackRan || lpPoolType === 'unknown',
      totalSupplyChecked: _lpEv.some((e) => /totalSupply|burn_share|locker_share|top_rows|top_share/i.test(e)),
      burnAddressesChecked: _lpEv.some((e) => /burn_share=/i.test(e)) || _lpRpcFallbackRan,
      lockerAddressesChecked: _lpEv.some((e) => /locker_share=/i.test(e)) || _lpRpcFallbackRan,
      ownerTeamBalanceChecked: lpControl.status === "team_controlled" || _lpEv.some((e) => /owner_lp_share=/i.test(e)),
      burnPercent: _extractedBurnPct,
      lockedPercent: _extractedLockerPct,
      teamPercent: _extractedTeamPct,
      failureReason: _lpFailureReason,
      dexscreenerPoolSynthesized: _dsFbPoolSynthesized,
    };

    // LP Safety debug flags — track proof quality for this scan
    const lpSafetyAttempted = needsLpHolderFetch
    const lpSafetyUsable = lpControl.status === 'burned' || lpControl.status === 'locked' || lpControl.status === 'team_controlled'
    const lpOwnershipVerified = Boolean(ownerAddrEarlyForLp && lpPoolAddressPresent)

    // Ensure poolAddressPresent is always correct on the final object — some inner branches
    // replace lpControl wholesale without setting this field (e.g., GoldRush/RPC paths).
    lpControl.poolAddressPresent = lpPoolAddressPresent;

    lpControl.evidence = [
      ...(lpControl.evidence ?? []),
      `Market primary pair: ${marketPair}`,
      `LP verification pair: ${lpPair}`,
      `LP verification pool address: ${lpPoolAddress ?? 'unavailable'}`,
      `LP verification reason: ${lpReason}`,
      `lpHolderCheckAttempted=${needsLpHolderFetch}`,
    ];

    // AI summary from parallel phase 2
    let aiSummary = `Unverified on ${chain === 'eth' ? 'Ethereum' : 'Base'} — insufficient data for a risk verdict.`;
    const _aiResult = _aiSettled.status === 'fulfilled' ? _aiSettled.value : null
    if (_aiResult && typeof _aiResult === 'object' && 'content' in _aiResult) {
      const _aiContent = (_aiResult as { content: Array<{type: string; text?: string}> }).content
      const _aiText = _aiContent?.[0]
      if (_aiText?.type === 'text' && _aiText.text) aiSummary = _aiText.text
    }

    // ------------------------------
    // Resolve core token fields
    // ------------------------------
    const metaItem = metadata?.data?.items?.[0];
    const goldItem = goldrush?.data?.items?.[0];
    const gmgnItem = gmgn?.data;

    // GeckoTerminal direct token info (most reliable for name/symbol)
    const gtToken = gtTokenInfo?.data?.attributes ?? null;

    // Included token entries from the pools response (with ?include=base_token,quote_token)
    // (gtIncluded extracted earlier for pool type detection)
    const matchingTokenEntry = (gtIncluded as any[]).find((i: any) =>
      i.type === 'token' && i.attributes?.address?.toLowerCase() === contract.toLowerCase()
    );

    const resolvedName =
      gtToken?.name ||
      matchingTokenEntry?.attributes?.name ||
      metaItem?.contract_name ||
      goldItem?.contract_name ||
      gmgnItem?.name ||
      "Unknown";

    const resolvedSymbol =
      gtToken?.symbol ||
      matchingTokenEntry?.attributes?.symbol ||
      metaItem?.contract_ticker_symbol ||
      goldItem?.contract_ticker_symbol ||
      gmgnItem?.symbol ||
      "?";

    const resolvedDecimals =
      gtToken?.decimals ||
      metaItem?.contract_decimals ||
      goldItem?.contract_decimals ||
      gmgnItem?.decimals ||
      18;

    
    const holderCandidates = [
      holdersRaw?.data?.items,
      holdersRaw?.data?.data?.items,
      holdersRaw?.items,
      holdersRaw?.holders,
      holdersRaw?.token_holders,
    ]
    const holderItems: any[] = holderCandidates.find((x) => Array.isArray(x)) ?? []
    console.log('[holders] items length', holderItems.length)

    const holderCount = holdersRaw?.data?.pagination?.total_count ?? holdersRaw?.pagination?.total_count ?? null
    const holderPctFromProvider: boolean[] = []
    const rawBalanceByAddress = new Map<string, unknown>()
    const topHolders = holderItems.slice(0, 200).map((h: any, i: number) => {
      const address = h.address || h.holder_address || h.wallet_address || h.owner_address || h.contract_address || ''
      const balanceRaw = h.balance ?? h.token_balance ?? h.amount ?? null
      const amount = toNum(balanceRaw) ?? toNum(h.balance_quote) ?? null
      const pctRaw = normalizeHolderPercent(h.percentage) ?? normalizeHolderPercent(h.percent) ?? normalizeHolderPercent(h.ownership_percentage) ?? normalizeHolderPercent(h.percent_of_supply) ?? normalizeHolderPercent(h.share) ?? normalizeHolderPercent(h.supply_percentage)
      const percent = pctRaw
      holderPctFromProvider.push(percent != null)
      if (address && balanceRaw != null) rawBalanceByAddress.set(address.toLowerCase(), balanceRaw)
      return { rank: i + 1, address, amount, percent }
    }).filter((h: any) => h.address)

    const percentRows = topHolders.filter((h: any) => h.percent != null)
    let hasPct = percentRows.length > 0
    const anyProviderPct = holderPctFromProvider.some(Boolean)
    let percentSource: 'provider' | 'calculated' | 'unavailable' = hasPct ? (anyProviderPct ? 'provider' : 'calculated') : 'unavailable'
    console.log('[holders] normalized length', topHolders.length, '[holders] percent available', hasPct, '[holders] pct source', percentSource)
    const sum = (n: number) => topHolders.slice(0, n).reduce((acc: number, h: any) => acc + (h.percent ?? 0), 0)
    let top1 = hasPct ? sum(1) : null
    let top5 = hasPct ? sum(5) : null
    let top10 = hasPct ? sum(10) : null
    let top20 = hasPct ? sum(20) : null
    const normalizedTop = topHolders.slice(0, 200)
    let holderDistribution: HolderDistribution = normalizedTop.length
      ? { top1, top5, top10, top20, others: hasPct && top20 != null ? Math.max(0, 100 - top20) : null, holderCount, topHolders: normalizedTop }
      : { top1: null, top5: null, top10: null, top20: null, others: null, holderCount: holderCount ?? null, topHolders: [] }
    let holderDistributionStatus: HolderDistributionStatus = normalizedTop.length > 0
      ? (hasPct
          ? { status: 'ok', reason: 'holder_percentages_verified', itemCount: holderItems.length, normalizedCount: normalizedTop.length, percentSource }
          : { status: 'partial', reason: 'no_percentages', itemCount: holderItems.length, normalizedCount: normalizedTop.length, percentSource })
      : {
          status: (holdersRaw?.__status === 'error' ? 'error' : (holdersRaw?.__status === 'unavailable' ? 'unavailable' : 'empty')) ,
          reason: (holdersRaw?.__reason ?? 'no_rows'),
          itemCount: holderItems.length,
          normalizedCount: 0,
          percentSource,
        }
    let holderDerivationAttempted = false
    let holderDerivationSucceeded = false
    let holderDerivationFailureReason: string | null = null
    // Holder enrichment — derived signals for risk scoring
    const holderDataComplete = holderDistributionStatus.status === 'ok'
    const _whalePressureTop1 = top1 ?? null
    const _whalePressureTop5 = top5 ?? null
    const whalePressure: 'high' | 'medium' | 'low' | 'unverified' =
      _whalePressureTop1 == null && _whalePressureTop5 == null ? 'unverified'
      : (_whalePressureTop1 != null && _whalePressureTop1 > 15) ? 'high'
      : (_whalePressureTop5 != null && _whalePressureTop5 > 40) ? 'high'
      : (_whalePressureTop5 != null && _whalePressureTop5 > 25) ? 'medium'
      : 'low'
    const holderRisk: 'high' | 'medium' | 'low' | 'unverified' =
      top10 == null ? 'unverified'
      : top10 > 70 ? 'high'
      : top10 > 50 ? 'high'
      : top10 > 35 ? 'medium'
      : 'low'
    const supplySpread: 'elevated' | 'normal' | 'unverified' =
      top10 == null ? 'unverified' : top10 > 35 ? 'elevated' : 'normal'

    const poolAttr = mainPool?.attributes ?? {}
    // True market cap priority:
    // 1) GeckoTerminal token endpoint attributes.market_cap_usd
    // 2) explicit market cap fields from token metadata responses (never FDV fields)
    const tokenEndpointMarketCap = pickNum(
      gtToken?.market_cap_usd,
      gtToken?.market_cap,
      gtTokenInfo?.data?.attributes?.market_cap_usd,
      gtTokenInfo?.data?.attributes?.market_cap,
      gtToken?.marketCap,
      gtToken?.market_cap_in_usd,
      goldItem?.market_cap,
      metaItem?.market_cap
    )
    const selectedPoolMarketCapUsd = pickNum(poolAttr.market_cap_usd, poolAttr.market_cap)
    const marketCapFromGt = (tokenEndpointMarketCap != null && tokenEndpointMarketCap > 0)
      ? tokenEndpointMarketCap
      : (selectedPoolMarketCapUsd != null && selectedPoolMarketCapUsd > 0 ? selectedPoolMarketCapUsd : null)
    const poolEndpointMarketCapPresent = toNum(poolAttr.market_cap_usd) != null;
    const circulatingSupply = pickNum(gtToken?.circulating_supply, goldItem?.circulating_supply, gmgnItem?.circulating_supply)
    const tokenPrice = pickNum(poolAttr.base_token_price_usd, gtToken?.price_usd, gtToken?.price)
    const marketCapSource = marketCapFromGt != null
      ? ((tokenEndpointMarketCap != null && tokenEndpointMarketCap > 0) ? 'geckoterminal' : 'coingecko_terminal')
      : 'unavailable'
    const fdv = pickNum(gtToken?.fdv_usd, gtToken?.fdv, gtToken?.fully_diluted_valuation, poolAttr.fdv_usd, poolAttr.fdv, mainPool?.fdv_usd, goldItem?.fully_diluted_value, gmgnItem?.fdv)
    const fdvSource = fdv != null ? 'geckoterminal' : 'unavailable'
    const priceUsd = tokenPrice
    // Tier B: onchain estimated MC — uses result from parallel phase 2 (no extra await)
    let estimatedMarketCap: number | null = null
    let estimatedMarketCapConfidence: 'medium' | 'low' = 'low'
    let estimatedMarketCapReason = ''
    if (marketCapFromGt == null && priceUsd != null) {
      const onchain = _onchainSettled.status === 'fulfilled' ? _onchainSettled.value as Awaited<ReturnType<typeof fetchOnchainSupply>> | null : null
      if (onchain?.totalSupply != null) {
        const decimalsNum = typeof resolvedDecimals === 'number' ? resolvedDecimals : (Number(resolvedDecimals) || _decEarly)
        const divisor = BigInt(10) ** BigInt(decimalsNum)
        const burned = (onchain.burnedZero ?? BigInt(0)) + (onchain.burnedDead ?? BigInt(0))
        const circulatingRaw = onchain.totalSupply - burned
        const circulatingHuman = Number(circulatingRaw) / Number(divisor)
        if (circulatingHuman > 0) {
          estimatedMarketCap = priceUsd * circulatingHuman
          estimatedMarketCapConfidence = (onchain.burnedZero != null || onchain.burnedDead != null) ? 'medium' : 'low'
          estimatedMarketCapReason = `Estimated from price × on-chain total supply${burned > BigInt(0) ? ' minus burn balances' : ''}. Circulating supply not fully verified.`
        }
      }
    }

    let displayMarketValue: number | null
    let displayMarketValueLabel: 'Market Cap' | 'Estimated MC' | 'FDV'
    let displayMarketValueConfidence: 'verified' | 'medium' | 'low'
    let displayMarketValueReason: string

    if (marketCapFromGt != null) {
      displayMarketValue = marketCapFromGt
      displayMarketValueLabel = 'Market Cap'
      displayMarketValueConfidence = 'verified'
      displayMarketValueReason = 'Verified market cap from live token market data.'
    } else if (fdv != null) {
      displayMarketValue = fdv
      displayMarketValueLabel = 'FDV'
      displayMarketValueConfidence = 'low'
      displayMarketValueReason = 'True market cap unavailable; showing FDV because circulating supply is not verified.'
    } else {
      displayMarketValue = null
      displayMarketValueLabel = 'Market Cap'
      displayMarketValueConfidence = 'low'
      displayMarketValueReason = 'Market value unavailable because price/supply data is unavailable.'
    }

    const liquidityUsd = pickNum(mainPool?.attributes?.reserve_in_usd)
    const volume24hUsd = pickNum((mainPool?.attributes?.volume_usd as Record<string, unknown> | undefined)?.h24)
    // Pool activity — extracted from primary pool attributes, no extra API calls
    const _txns = mainPoolAttr.transactions as Record<string, unknown> | null | undefined
    const _txnsH24Any = _txns?.h24
    const _txnsH24Obj = _txnsH24Any && typeof _txnsH24Any === 'object' ? _txnsH24Any as Record<string, unknown> : null
    const _txnsH24Total = _txnsH24Any && typeof _txnsH24Any !== 'object' ? toNum(_txnsH24Any) : null
    const buys24h: number | null = _txnsH24Obj != null ? (toNum(_txnsH24Obj.buys) ?? toNum(_txnsH24Obj.buy) ?? null) : null
    const sells24h: number | null = _txnsH24Obj != null ? (toNum(_txnsH24Obj.sells) ?? toNum(_txnsH24Obj.sell) ?? null) : null
    const transactions24h: number | null = buys24h != null && sells24h != null ? buys24h + sells24h : (_txnsH24Total ?? null)
    const _volH24 = (mainPoolAttr.volume_usd as Record<string, unknown> | undefined)?.h24
    const _volH24Obj = typeof _volH24 === 'object' && _volH24 !== null ? _volH24 as Record<string, unknown> : null
    const splitCandidates: Array<{ key: string; value: unknown; side: 'buy'|'sell'|'total' }> = [
      { key: 'attributes.volume_usd.h24.buy', value: _volH24Obj?.buy, side: 'buy' },
      { key: 'attributes.volume_usd.h24.sell', value: _volH24Obj?.sell, side: 'sell' },
      { key: 'attributes.volume_usd.h24.buys', value: _volH24Obj?.buys, side: 'buy' },
      { key: 'attributes.volume_usd.h24.sells', value: _volH24Obj?.sells, side: 'sell' },
      { key: 'attributes.volume_usd.h24.buy_volume', value: _volH24Obj?.buy_volume, side: 'buy' },
      { key: 'attributes.volume_usd.h24.sell_volume', value: _volH24Obj?.sell_volume, side: 'sell' },
      { key: 'attributes.volume_usd.h24.buy_volume_usd', value: _volH24Obj?.buy_volume_usd, side: 'buy' },
      { key: 'attributes.volume_usd.h24.sell_volume_usd', value: _volH24Obj?.sell_volume_usd, side: 'sell' },
      { key: 'attributes.buy_volume_usd.h24', value: (mainPoolAttr.buy_volume_usd as Record<string, unknown> | undefined)?.h24, side: 'buy' },
      { key: 'attributes.sell_volume_usd.h24', value: (mainPoolAttr.sell_volume_usd as Record<string, unknown> | undefined)?.h24, side: 'sell' },
      { key: 'attributes.volume_buy_usd.h24', value: (mainPoolAttr.volume_buy_usd as Record<string, unknown> | undefined)?.h24, side: 'buy' },
      { key: 'attributes.volume_sell_usd.h24', value: (mainPoolAttr.volume_sell_usd as Record<string, unknown> | undefined)?.h24, side: 'sell' },
      { key: 'attributes.buyVolumeUsd.h24', value: (mainPoolAttr.buyVolumeUsd as Record<string, unknown> | undefined)?.h24, side: 'buy' },
      { key: 'attributes.sellVolumeUsd.h24', value: (mainPoolAttr.sellVolumeUsd as Record<string, unknown> | undefined)?.h24, side: 'sell' },
      { key: 'attributes.buy_volume_usd_24h', value: mainPoolAttr.buy_volume_usd_24h, side: 'buy' },
      { key: 'attributes.sell_volume_usd_24h', value: mainPoolAttr.sell_volume_usd_24h, side: 'sell' },
      { key: 'attributes.volume_usd.h24.total', value: _volH24Obj?.total, side: 'total' },
      { key: 'attributes.volume_usd.h24', value: typeof _volH24 === 'object' ? null : _volH24, side: 'total' },
      { key: 'selectedPoolVolume24h', value: volume24hUsd, side: 'total' },
    ]
    const pickFrom = (side: 'buy'|'sell'|'total') => {
      for (const c of splitCandidates) {
        if (c.side !== side) continue
        const n = toNum(c.value)
        if (n != null) return { value: n, key: c.key }
      }
      return { value: null as number | null, key: null as string | null }
    }
    const buyPick = pickFrom('buy')
    const sellPick = pickFrom('sell')
    const totalPick = pickFrom('total')
    const buyVolume24hUsd: number | null = buyPick.value
    const sellVolume24hUsd: number | null = sellPick.value
    const resolvedVolume24hUsd: number | null = totalPick.value ?? volume24hUsd

    // Secondary market read — fires once, server-side, when primary has no pool/price/liquidity.
    // In debug-only mode, forceDexFallback=true skips primary market values and calls the
    // fallback directly so it can be verified from production without altering normal scans.
    const _primaryHasMarket = priceUsd != null || liquidityUsd != null
    const _fallbackNeeded = true
    let _dexFb: DexFallbackResult | null = null
    let marketDataSource: 'primary' | 'fallback' | 'none' = (_primaryHasMarket && !forceDexFallback) ? 'primary' : 'none'
    let marketConfidence: 'high' | 'medium' | 'low' = (_primaryHasMarket && !forceDexFallback) ? 'high' : 'low'
    _dexFb = dexFbEarly  // already fetched in phase 1 (cache hit if called again)
    if (_dexFb != null && (!_primaryHasMarket || forceDexFallback)) {
      marketDataSource = 'fallback'
      marketConfidence = 'medium'
    }

    if (debugMode) {
      console.log('[dex-fallback-debug]',
        'primaryMarketAvailable:', _primaryHasMarket,
        'forceDexFallback:', forceDexFallback,
        'fallbackAttempted:', _fallbackNeeded,
        'fallbackUsable:', _dexFb != null,
        'contract:', contract,
      )
    }

    // Effective market values:
    // - Normal scan: primary wins, fallback fills only when primary is null
    // - forceDexFallback (debug only): fallback values override primary
    const _ep   = forceDexFallback ? (_dexFb?.priceUsd ?? null)      : (priceUsd ?? _dexFb?.priceUsd ?? null)
    const _el   = forceDexFallback ? (_dexFb?.liquidityUsd ?? null)   : (liquidityUsd ?? _dexFb?.liquidityUsd ?? null)
    const _ev   = forceDexFallback ? (_dexFb?.volume24h ?? null)      : (resolvedVolume24hUsd ?? _dexFb?.volume24h ?? null)
    const _efdv = forceDexFallback ? (_dexFb?.fdv ?? null)            : (fdv ?? _dexFb?.fdv ?? null)
    // If fallback has FDV and primary displayMarketValue is null, show fallback FDV
    if (_dexFb?.fdv != null && displayMarketValue == null) {
      displayMarketValue = _dexFb.fdv
      displayMarketValueLabel = 'FDV'
      displayMarketValueConfidence = 'low'
      displayMarketValueReason = 'Market cap unavailable; FDV from fallback market read. Not verified as circulating market cap.'
    }

    const buySellVolumeSplitAvailable = buyVolume24hUsd != null && sellVolume24hUsd != null
    const buySellVolumeReason = buySellVolumeSplitAvailable ? 'split_exposed' : (resolvedVolume24hUsd != null ? 'only_total_exposed' : 'volume_not_exposed')
    let priceChart: { timeframe: '24h'|'48h'|'7d'; points: Array<{ timestamp: string; priceUsd: number }>; sourceStatus: 'ok'|'unavailable'|'error'; reason?: string; fallbackUsed?: boolean } = {
      timeframe: '24h',
      points: [],
      sourceStatus: 'unavailable',
      reason: 'primary_pool_missing',
    }
    const chartAttemptedPools: Array<{ address: string; name: string | null; liquidityUsd: number | null }> = []
    const chartPoolCandidates = [mainPool, ...matchingPools.filter((p) => p !== mainPool)]
      .filter((p): p is NonNullable<typeof mainPool> => Boolean(p?.attributes?.address))
      .map((p) => ({
        pool: p,
        address: String(p.attributes.address),
        name: typeof p.attributes.name === 'string' ? p.attributes.name : null,
        liquidityUsd: toNum(p.attributes.reserve_in_usd),
        volume24hUsd: toNum((p.attributes.volume_usd as Record<string, unknown> | undefined)?.h24),
      }))
      .sort((a, b) => ((b.liquidityUsd ?? -1) - (a.liquidityUsd ?? -1)) || ((b.volume24hUsd ?? -1) - (a.volume24hUsd ?? -1)))
    const primaryAddr = String(mainPoolAttr.address ?? '').toLowerCase()
    chartPoolCandidates.sort((a, b) => {
      if (a.address.toLowerCase() === primaryAddr) return -1
      if (b.address.toLowerCase() === primaryAddr) return 1
      return 0
    })
    const uniqueChartPools = chartPoolCandidates.filter((c, i, arr) => arr.findIndex((x) => x.address.toLowerCase() === c.address.toLowerCase()) === i)
    const maxAttempts = Math.min(uniqueChartPools.length, 4)
    const chartAttemptedTimeframes: string[] = []
    const timeframeAttempts: Array<{ key: '24h'|'48h'|'7d'; resolution: 'minute'|'hour'|'day'; aggregate: number; limit: number }> = [
      { key: '24h', resolution: 'minute', aggregate: 15, limit: 96 },
      { key: '48h', resolution: 'hour', aggregate: 1, limit: 48 },
      { key: '7d', resolution: 'day', aggregate: 1, limit: 7 },
    ]
    let chartFailureReason: string | null = maxAttempts > 0 ? null : 'primary_pool_missing'
    let chartSelectedPoolForChart: { address: string; name: string | null } | null = null
    for (let i = 0; i < maxAttempts; i += 1) {
      const candidate = uniqueChartPools[i]
      chartAttemptedPools.push({ address: candidate.address, name: candidate.name, liquidityUsd: candidate.liquidityUsd })
      for (let t = 0; t < Math.min(2, timeframeAttempts.length); t += 1) {
        const tf = timeframeAttempts[t + (i > 1 ? 1 : 0)] ?? timeframeAttempts[t]
        chartAttemptedTimeframes.push(`${tf.key}:${tf.resolution}/${tf.aggregate}x${tf.limit}`)
        const chartRaw = await fetchGeckoTerminalPoolOhlcv(candidate.address, chain, tf)
        const list = chartRaw?.data?.attributes?.ohlcv_list
        if (!Array.isArray(list)) { chartFailureReason = 'ohlcv_not_exposed'; continue }
        const points = list.map((row: unknown) => {
          const arr = Array.isArray(row) ? row : null
          const tsNum = toNum(arr?.[0])
          const close = toNum(arr?.[4])
          if (tsNum == null || close == null || close <= 0) return null
          const ms = tsNum > 1e12 ? tsNum : tsNum * 1000
          return { timestamp: new Date(ms).toISOString(), priceUsd: close }
        }).filter((p: { timestamp: string; priceUsd: number } | null): p is { timestamp: string; priceUsd: number } => p != null)
          .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
        if (points.length >= 2) {
          priceChart = { timeframe: tf.key, points, sourceStatus: 'ok' }
          chartSelectedPoolForChart = { address: candidate.address, name: candidate.name }
          chartFailureReason = null
          break
        }
        chartFailureReason = 'insufficient_points'
      }
      if (priceChart.sourceStatus === 'ok') break
    }
    if (priceChart.sourceStatus !== 'ok' && maxAttempts > 0) {
      priceChart = { timeframe: '24h', points: [], sourceStatus: 'unavailable', reason: chartFailureReason ?? 'ohlcv_not_exposed' }
    }
    const chartAttempted = chartAttemptedPools.length > 0
    const chartFallbackUsed = chartSelectedPoolForChart != null && chartSelectedPoolForChart.address.toLowerCase() !== primaryAddr
    if (priceChart.sourceStatus === 'ok') priceChart.fallbackUsed = chartFallbackUsed
    const chartStatus: 'ok' | 'no_candles' | 'fallback_snapshot_only' | 'unavailable' =
      priceChart.sourceStatus === 'ok' ? 'ok' :
      marketDataSource === 'fallback' ? 'fallback_snapshot_only' :
      noActivePools ? 'unavailable' :
      'no_candles'
    const chartDataSource: 'primary' | 'fallback' | 'none' =
      priceChart.sourceStatus === 'ok' ? (chartFallbackUsed ? 'fallback' : 'primary') :
      marketDataSource === 'fallback' ? 'fallback' :
      'none'
    const pairCreatedAt = String(mainPoolAttr.pool_created_at ?? '').trim() || null
    const pairAgeLabel = pairCreatedAt ? computePairAge(pairCreatedAt) : null
    const poolCount = matchingPools.length
    if (process.env.NODE_ENV === "development") {
      console.log('[gt-market] contract', contract, '[gt-market] token status', gtTokenInfo ? 'ok' : 'empty', '[gt-market] pools count', matchingPools.length, '[gt-market] tokenEndpointMarketCapPresent', tokenEndpointMarketCap != null && tokenEndpointMarketCap > 0, '[gt-market] poolEndpointMarketCapPresent', poolEndpointMarketCapPresent, '[gt-market] marketCap available', marketCapFromGt != null, '[gt-market] fdv available', fdv != null)
    }
    // Security fallbacks are disabled: risk layer uses active scan providers only.
    const gpHasData = false
    const gpHoneypot: null = null
    const gpMint = null
    const gpUpgradeable = null
    const gpBlacklist = null

    // Final JSON response
    const marketStatus: "ok" | "fallback_ok" | "partial" | "no_pool_found" | "unavailable" | "error" =
      (_ep != null && _el != null && _ev != null && marketDataSource === 'primary') ? "ok" :
      (_ep != null && _el != null && marketDataSource === 'fallback') ? "fallback_ok" :
      (_ep != null || _el != null || _ev != null || _efdv != null) ? "partial" :
      (noActivePools ? "no_pool_found" : "unavailable");
    const marketReason = marketStatus === "ok" ? null
      : marketStatus === "fallback_ok" ? "market_data_from_secondary_source"
      : marketCapFromGt == null ? "unavailable_circulating_supply_not_verified"
      : "partial_market_fields_from_provider";
    const securityStatus: "ok" | "partial" | "unavailable" | "error" =
      hpResult.ok ? "ok" : "unavailable";
    const securityReason = hpResult.ok ? null : "security_simulation_unavailable";
    const holdersStatus: "ok" | "partial" | "unavailable" | "error" =
      holderDistributionStatus.status === 'ok' ? 'ok' :
      holderDistributionStatus.status === 'partial' ? 'partial' :
      holderDistributionStatus.status === 'error' ? 'error' :
      'unavailable';
    const holdersReason = holdersStatus === "ok" ? null : safeHolderReason(holderDistributionStatus?.reason ?? "holder_data_unavailable");
    const liquidityStatus: "ok" | "partial" | "unavailable" | "error" =
      mainPool ? "ok" : (_dexFb?.liquidityUsd != null ? "partial" : (matchingPools.length > 0 ? "partial" : "unavailable"));
    const liquidityReason = mainPool ? null : (_dexFb?.liquidityUsd != null ? "liquidity_from_fallback_market_read" : "no_active_liquidity_pool_found");
    const ownerCall = _ownerHexForLp ?? alchemyMandatoryReads[0] ?? alchemyMandatoryReads[1] ?? alchemyMandatoryReads[2] ?? alchemyMandatoryReads[3] ?? await countedRpcCall('eth_call', [{ to: contract, data: '0x8da5cb5b' }, 'latest'], 'ownerCheck', false)
    const ownerAddr = ownerCall && ownerCall.length >= 42 ? `0x${ownerCall.slice(-40)}`.toLowerCase() : null
    // Ownership / control derivation — RPC-sourced admin and proxy implementation
    const _adminHex = alchemyMandatoryReads[2] ?? alchemyMandatoryReads[3] ?? null
    const adminAddr = _adminHex && _adminHex.length >= 42 && _adminHex !== '0x' ? `0x${_adminHex.slice(-40)}`.toLowerCase() : null
    const _implHex = alchemyMandatoryReads[4] ?? null
    const _ZERO_ADDR = '0x0000000000000000000000000000000000000000'
    const proxyImplAddr = _implHex && _implHex.length >= 42 && _implHex !== '0x' ? `0x${_implHex.slice(-40)}`.toLowerCase() : null
    const isRenounced = !ownerAddr || ownerAddr === _ZERO_ADDR
    const ownershipVerified = Boolean(ownerAddr || adminAddr)
    const rpcSupply = await countedRpcCall('eth_call', [{ to: contract, data: '0x18160ddd' }, 'latest'], 'totalSupplyCheck', true)
    const rpcDecimalsHex = await countedRpcCall('eth_call', [{ to: contract, data: '0x313ce567' }, 'latest'], 'decimalsCheck', true)

    // CORTEX Contract Flag Scanner — bytecode selector scan + 2 RPC probes
    const _hasBytecode = Boolean(bytecode && bytecode !== '0x' && bytecode.length > 10)
    const _bytecodeLc = _hasBytecode ? bytecode!.toLowerCase() : ''
    // PUSH4 opcode (0x63) followed by 4-byte selector in deployed bytecode
    const _selPresent = (sel4: string) => _hasBytecode && _bytecodeLc.includes('63' + sel4)
    const _cortexMintSel = _selPresent('40c10f19') || _selPresent('a0712d68')    // mint(address,uint256) | mint(uint256)
    const _cortexProxySel = _selPresent('3659cfe6') || _selPresent('4f1ef286') || _selPresent('52d1902d') // upgradeTo | upgradeToAndCall | proxiableUUID
    const _cortexPauseSel = _selPresent('8456cb59') || _selPresent('3f4ba83a')   // pause() | unpause()
    const _cortexWithdrawSel = _selPresent('3ccfd60b') || _selPresent('2e1a7d4d') // withdraw() | withdraw(uint256)
    const _cortexBlacklistStr = _hasBytecode && _bytecodeLc.includes('626c61636b6c697374') // ascii "blacklist"
    const _EIP1967_IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
    const _EIP1967_ZERO = '0x0000000000000000000000000000000000000000000000000000000000000000'
    const [_proxySlotHex, _pausedCallHex] = await Promise.all([
      _hasBytecode ? countedRpcCall('eth_getStorageAt', [contract, _EIP1967_IMPL, 'latest'], 'proxySlotCheck', false) : Promise.resolve(null),
      _hasBytecode ? countedRpcCall('eth_call', [{ to: contract, data: '0x5c975abb' }, 'latest'], 'pausedCheck', false) : Promise.resolve(null),
    ])
    const _isVerifiedProxy = Boolean(
      _proxySlotHex && _proxySlotHex !== '0x' && _proxySlotHex !== _EIP1967_ZERO &&
      _proxySlotHex.replace(/^0x0+/, '').length > 0
    )
    const _pauseFunctionExists = Boolean(_pausedCallHex && _pausedCallHex !== '0x')

    // Merge bytecode signals with optional GoPlus enrichment (GoPlus is low-confidence fallback)
    const cortexContractFlags: CortexContractFlagsResult = {
      mint: !_hasBytecode
        ? { status: 'unverified', confidence: 'low', note: 'Bytecode unavailable' }
        : _cortexMintSel
          ? { status: 'verified', confidence: 'high', note: 'Mint selector found in bytecode' }
          : gpMint === true
            ? { status: 'possible', confidence: 'low', note: 'Not in bytecode; optional enrichment signal only' }
            : { status: 'not_detected', confidence: 'medium', note: 'No mint selector in bytecode' },
      proxy: !_hasBytecode
        ? { status: 'unverified', confidence: 'low', note: 'Bytecode unavailable' }
        : _isVerifiedProxy
          ? { status: 'verified', confidence: 'high', note: 'EIP-1967 implementation slot is non-zero' }
          : _cortexProxySel
            ? { status: 'possible', confidence: 'medium', note: 'Upgrade selector in bytecode; no EIP-1967 slot confirmed' }
            : gpUpgradeable === true
              ? { status: 'possible', confidence: 'low', note: 'Not in bytecode; optional enrichment signal only' }
              : { status: 'not_detected', confidence: 'medium', note: 'No proxy slot or upgrade selector detected' },
      pause: !_hasBytecode
        ? { status: 'unverified', confidence: 'low', note: 'Bytecode unavailable' }
        : (_pauseFunctionExists || _cortexPauseSel)
          ? { status: 'verified', confidence: 'high', note: _pauseFunctionExists ? 'paused() call responded' : 'Pause selector in bytecode' }
          : { status: 'not_detected', confidence: 'medium', note: 'No pause selector or paused() response detected' },
      blacklist: !_hasBytecode
        ? { status: 'unverified', confidence: 'low', note: 'Bytecode unavailable' }
        : _cortexBlacklistStr
          ? { status: 'verified', confidence: 'high', note: 'Blacklist string pattern in bytecode' }
          : gpBlacklist === true
            ? { status: 'possible', confidence: 'low', note: 'Not in bytecode; optional enrichment signal only' }
            : { status: 'not_detected', confidence: 'medium', note: 'No blacklist pattern in bytecode' },
      withdraw: !_hasBytecode
        ? { status: 'unverified', confidence: 'low', note: 'Bytecode unavailable' }
        : _cortexWithdrawSel
          ? { status: 'verified', confidence: 'high', note: 'Withdraw selector found in bytecode' }
          : { status: 'not_detected', confidence: 'medium', note: 'No withdraw selector in bytecode' },
      bytecodeChecked: _hasBytecode,
      proxySlotChecked: _proxySlotHex != null,
      pauseCallChecked: _pausedCallHex != null,
    }

    const riskVerifiedSignals: string[] = []
    const riskDrivers: string[] = []
    const openChecks: string[] = []
    let riskScore = 35
    const lpState = lpControl.status
    const top10Pct = holderDistribution.top10
    const top20Pct = holderDistribution.top20

    if (marketCapFromGt != null) riskVerifiedSignals.push('Market data verified: market cap is available.')
    else if (fdv != null) {
      riskVerifiedSignals.push('Market data partial: FDV is available.')
      openChecks.push('Market cap is not verified. Circulating supply confidence is lower.')
      riskScore += 10
    } else {
      openChecks.push('Market value data is missing, which limits risk context.')
      riskScore += 15
    }
    if (liquidityUsd != null) riskVerifiedSignals.push(`Liquidity depth detected (${Math.round(liquidityUsd).toLocaleString()} USD).`)
    else openChecks.push('Liquidity depth is unavailable.')
    if (holderDistributionStatus.status === 'ok' && top10Pct != null) {
      riskVerifiedSignals.push(`Holder Map verified with Top 10 concentration at ${top10Pct.toFixed(1)}%.`)
      if (top10Pct > 70) { riskDrivers.push('Holder concentration is very high (Top 10 > 70%).'); riskScore += 30 }
      else if (top10Pct > 50) { riskDrivers.push('Holder concentration is elevated (Top 10 > 50%).'); riskScore += 20 }
      else if (top10Pct > 35) { riskDrivers.push('Holder concentration is moderate (Top 10 > 35%).'); riskScore += 10 }
      else riskScore -= 5
    } else if (holderDistributionStatus.status === 'partial') {
      riskVerifiedSignals.push('Holder Map rows were returned but concentration percentages are partial.')
      openChecks.push('Holder concentration percentages are incomplete.')
      riskScore += 8
    } else {
      openChecks.push('Holder Map could not verify concentration in this scan.')
      riskScore += 15
    }
    if (lpState === 'burned' || lpState === 'locked') { riskVerifiedSignals.push(`LP Control shows ${lpState}.`); riskScore -= 12 }
    else if (lpState === 'protocol' || lpState === 'concentrated_liquidity') { riskVerifiedSignals.push('LP Control indicates protocol-managed liquidity structure.'); riskScore += 3 }
    else if (lpState === 'team_controlled') { riskDrivers.push('LP Control indicates a dominant team wallet can control liquidity.'); riskScore += 28 }
    else { openChecks.push('LP Control does not provide lock or burn proof.'); riskScore += 10 }

    const riskOwnerStatus = isRenounced ? 'renounced' : (ownershipVerified ? 'held' : 'unverified')
    if (riskOwnerStatus === 'renounced') { riskVerifiedSignals.push('Dev Control: ownership appears renounced.'); riskScore -= 6 }
    else if (riskOwnerStatus === 'held') { riskDrivers.push('Dev Control: ownership is held by a wallet.'); riskScore += 10 }
    else openChecks.push('Dev Control ownership status is unverified.')
    if (proxyImplAddr && !isRenounced) { riskDrivers.push('Proxy contract with active owner — upgrade risk present.'); riskScore += 5 }

    if (hpResult.ok) {
      riskVerifiedSignals.push('Trading simulation returned tax and transfer signals.')
      if (hpResult.honeypot === true) { riskDrivers.push('Trading simulation indicates a blocked or trapped sell path.'); riskScore += 45 }
      if ((hpResult.buyTax ?? 0) > 12 || (hpResult.sellTax ?? 0) > 12) { riskDrivers.push('Trading taxes are high (>12%).'); riskScore += 20 }
      else if ((hpResult.buyTax ?? 0) > 7 || (hpResult.sellTax ?? 0) > 7) { riskDrivers.push('Trading taxes are elevated (>7%).'); riskScore += 10 }
    } else {
      openChecks.push('Trading simulation is unavailable; tax behavior remains less certain.')
      riskScore += 8
    }

    if (cortexContractFlags.mint.status === 'verified') { riskDrivers.push('Contract can mint supply.'); riskScore += 12 }
    else if (cortexContractFlags.mint.status === 'possible') { riskDrivers.push('Contract may have mint capability (low-confidence signal).'); riskScore += 5 }
    if (cortexContractFlags.proxy.status === 'verified') { riskDrivers.push('Contract is upgradeable (proxy confirmed).'); riskScore += 10 }
    else if (cortexContractFlags.proxy.status === 'possible') { riskDrivers.push('Contract may be upgradeable (partial signal).'); riskScore += 5 }
    if (cortexContractFlags.withdraw.status === 'verified') { riskDrivers.push('Contract includes withdraw/sweep style controls.'); riskScore += 10 }
    // Whale pressure and supply spread signals
    if (whalePressure === 'high') { riskDrivers.push('Whale pressure is high: top holder or top-5 hold a dominant share.'); riskScore += 8 }
    else if (whalePressure === 'medium') { riskDrivers.push('Whale pressure is medium: notable top-holder concentration.'); riskScore += 4 }
    if (supplySpread === 'elevated') riskDrivers.push('Supply spread elevated: Top 10 hold more than 35% of supply.')
    // Missing LP or holder data flags
    if (!lpSafetyAttempted && lpDiagnostics.poolDetected) openChecks.push('LP safety proof was not attempted despite an active pool.')
    if (!holderDataComplete) openChecks.push('Holder data is incomplete; concentration may be understated.')

    const majorMissingCount = [
      marketCapFromGt == null,
      holderDistributionStatus.status !== 'ok',
      !(lpState === 'burned' || lpState === 'locked' || lpState === 'protocol' || lpState === 'concentrated_liquidity' || lpState === 'team_controlled'),
      !hpResult.ok,
    ].filter(Boolean).length
    // Only withhold a score when ALL core providers returned null — i.e. zero usable data.
    // If any provider returned data, compute the score with missing-data penalties in riskScore.
    const anyProviderData = [
      marketCapFromGt != null || fdv != null || liquidityUsd != null,
      holderDistributionStatus.status === 'ok' || holderDistributionStatus.status === 'partial',
      lpControl.status !== 'error' && lpControl.status !== 'insufficient_data' && lpControl.status !== 'unverified',
      hpResult.ok,
      Boolean(bytecode && bytecode !== '0x'),
    ].some(Boolean)
    const sufficientCoreData = [
      marketCapFromGt != null || fdv != null,
      liquidityUsd != null,
      holderDistributionStatus.status === 'ok' || holderDistributionStatus.status === 'partial',
      lpControl.status !== 'error' && lpControl.status !== 'insufficient_data',
    ].filter(Boolean).length >= 3
    // Compute score if any provider returned data; only null when completely blind.
    let rugRiskScore: number | null = anyProviderData ? Math.max(0, Math.min(100, Math.round(riskScore))) : null
    let rugRiskLabel: RiskEngine["rugRiskLabel"] = 'unverified'
    if (rugRiskScore != null) {
      if (rugRiskScore >= 85) rugRiskLabel = 'critical'
      else if (rugRiskScore >= 65) rugRiskLabel = 'high'
      else if (rugRiskScore >= 40) rugRiskLabel = 'watch'
      else rugRiskLabel = majorMissingCount >= 2 ? 'watch' : 'low_visible_risk'
    }
    const riskConfidence: RiskEngine["confidence"] = majorMissingCount >= 3 ? 'low' : majorMissingCount >= 2 ? 'medium' : 'high'
    const sniperStatus: RiskEngine["sniperActivity"]["status"] = transactions24h == null ? 'unverified' : transactions24h > 800 ? 'high' : transactions24h > 250 ? 'watch' : 'low_signal'
    const sniperActivity: RiskEngine["sniperActivity"] = {
      status: sniperStatus,
      confidence: transactions24h == null ? 'low' : 'medium',
      reasons: transactions24h == null
        ? ['No early-wallet or trade-cluster telemetry is available in this scan.']
        : [`24h transaction count observed: ${transactions24h}.`, 'No direct sniper-wallet attribution is available; this is a market-activity signal only.'],
    }
    const riskEngine: RiskEngine = {
      rugRiskScore,
      rugRiskLabel,
      confidence: riskConfidence,
      cortexRead: rugRiskScore == null
        ? 'CORTEX Risk Engine is unverified because multiple core checks are missing in this scan.'
        : rugRiskLabel === 'critical'
          ? 'CORTEX Risk Engine flags critical rug risk from combined control and concentration signals.'
          : rugRiskLabel === 'high'
            ? 'CORTEX Risk Engine flags high risk and recommends a strict watch stance.'
            : rugRiskLabel === 'watch'
              ? 'CORTEX Risk Engine shows watch conditions due to active risks or incomplete checks.'
              : 'CORTEX Risk Engine shows low visible risk with currently verified signals.',
      verifiedSignals: riskVerifiedSignals,
      riskDrivers,
      openChecks,
      sniperActivity,
    }
    const lpUnlockAt = goldrush?.lock?.unlockAt ?? null
    const unlockEpoch = lpUnlockAt ? Date.parse(String(lpUnlockAt)) : NaN
    const lpCountdownSeconds = Number.isFinite(unlockEpoch) ? Math.max(0, Math.floor((unlockEpoch - Date.now()) / 1000)) : null
    const rugRisk: RugRiskReport = {
      lp_safety: {
        status: lpControl.status === "burned" || lpControl.status === "locked"
          ? "locked"
          : lpControl.status === "team_controlled"
            ? "team_controlled"
            : lpControl.status === "protocol"
              ? "protocol"
              : lpControl.status === "concentrated_liquidity"
                ? "concentrated_liquidity"
                : "unlocked",
        unlock_at: lpUnlockAt,
        countdown_seconds: lpCountdownSeconds,
        owner: ownerAddr ?? null,
        contract: primaryPoolAddress ?? null,
        movement_24h_usd: _ev ?? null,
        source_status: "ok",
      },
      contract_flags: {
        honeypot: hpResult.ok ? hpResult.honeypot : null,
        blacklist: cortexContractFlags.blacklist.status === 'verified' ? true : cortexContractFlags.blacklist.status === 'not_detected' ? false : null,
        mint: cortexContractFlags.mint.status === 'verified' ? true : cortexContractFlags.mint.status === 'not_detected' ? false : null,
        upgradeable: cortexContractFlags.proxy.status === 'verified' ? true : cortexContractFlags.proxy.status === 'not_detected' ? false : null,
        source_status: cortexContractFlags.bytecodeChecked ? "ok" : (hpResult.ok || gpHasData) ? "partial" : "failed",
      },
      deployer_reputation: {
        score: ownerAddr && ownerAddr !== '0x0000000000000000000000000000000000000000' ? (rugRiskScore != null ? Math.max(0, 100 - rugRiskScore) : 50) : null,
        rug_history: null,
        deploy_patterns: ownerAddr ? [`owner_wallet=${ownerAddr}`] : [],
        source_status: ownerAddr ? "ok" : "failed",
      },
      sniper_activity: {
        level: sniperStatus === "high" ? "high" : sniperStatus === "watch" ? "medium" : "low",
        score: sniperStatus === "high" ? 85 : sniperStatus === "watch" ? 55 : 25,
        source_status: transactions24h == null ? "failed" : "ok",
      },
      early_buyers: [],
      liquidity_risk: {
        liquidity_usd: _el ?? null,
        volatility_24h_pct: _dexFb?.priceChange24h ?? pickNum((poolAttr.price_change_percentage as Record<string, unknown> | undefined)?.h24),
        source_status: (_el != null) ? "ok" : "failed",
      },
      trading_simulation: {
        success: hpResult.ok ? hpResult.simulationSuccess : null,
        buy_tax: hpResult.ok ? hpResult.buyTax : null,
        sell_tax: hpResult.ok ? hpResult.sellTax : null,
        source_status: hpResult.ok ? "ok" : "failed",
      },
      risk_drivers: riskDrivers,
      overall_rug_risk_score: rugRiskScore,
    }

    // Derive holder percentages when provider rows have raw balances but no percent fields.
    // bigIntPct(balance, supply) divides in the same raw unit so decimals cancel — no normalization needed.
    // Guard: both values must be raw integer strings (no decimal point, no scientific notation).
    // Prefer RPC totalSupply; fall back to provider-supplied total_supply when RPC is unavailable (e.g. ETH without Alchemy key).
    const _holderProviderSupply = holderItems.find((h: any) => h?.total_supply != null)?.total_supply
    const _derivationSupply: string | null = (rpcSupply && rpcSupply !== '0x' && rpcSupply !== '0x0')
      ? rpcSupply
      : (_holderProviderSupply != null ? String(_holderProviderSupply) : null)
    const _derivationSupplySource: 'rpc' | 'provider' | null = (rpcSupply && rpcSupply !== '0x' && rpcSupply !== '0x0') ? 'rpc' : (_derivationSupply ? 'provider' : null)
    if (!hasPct && normalizedTop.length > 0 && _derivationSupply != null) {
      holderDerivationAttempted = true
      let derivedCount = 0
      for (const h of normalizedTop as any[]) {
        if (h.percent != null) continue
        const rawBal = rawBalanceByAddress.get((h.address ?? '').toLowerCase())
        if (rawBal == null) continue
        const rawStr = String(rawBal)
        // Skip human-readable amounts (already divided) — only process raw integer strings
        if (rawStr === '' || rawStr.includes('.') || /[eE]/.test(rawStr)) continue
        const pct = bigIntPct(rawBal, _derivationSupply)
        if (pct != null && pct > 0 && pct <= 100) {
          h.percent = Math.round(pct * 10000) / 10000
          derivedCount++
        }
      }
      if (derivedCount > 0) {
        holderDerivationSucceeded = true
        hasPct = true
        percentSource = 'calculated'
        top1 = sum(1); top5 = sum(5); top10 = sum(10); top20 = sum(20)
        holderDistribution = {
          top1, top5, top10, top20,
          others: top20 != null ? Math.max(0, 100 - top20) : null,
          holderCount,
          topHolders: normalizedTop,
        }
        holderDistributionStatus = {
          status: 'ok',
          reason: _derivationSupplySource === 'provider'
            ? 'holder_percentages_derived_from_provider_supply'
            : 'holder_percentages_derived_from_rpc_supply',
          itemCount: holderItems.length,
          normalizedCount: normalizedTop.length,
          percentSource,
        }
      } else {
        holderDerivationFailureReason = normalizedTop.length > 0
          ? 'raw_balance_missing_or_float_format'
          : 'no_holder_rows'
      }
    }

    const rpcName = await rpcTokenString(chain, contract, '0x06fdde03')
    const rpcSymbol = await rpcTokenString(chain, contract, '0x95d89b41')

    // Upgrade name/symbol with RPC fallback when all API sources returned nothing
    const finalResolvedName = (resolvedName && resolvedName !== 'Unknown') ? resolvedName : (rpcName ?? 'Unknown')
    const finalResolvedSymbol = (resolvedSymbol && resolvedSymbol !== '?') ? resolvedSymbol : (rpcSymbol ?? '?')

    const bytecodeStatus = bytecode && bytecode !== '0x' ? 'ok' : 'unavailable'
    const ownerStatus = ownerAddr ? 'ok' : 'unavailable'
    const mintStatus = cortexContractFlags.mint.status !== 'unverified' ? 'ok' : 'unavailable'
    const proxyStatus = cortexContractFlags.proxy.status !== 'unverified' ? 'ok' : 'unavailable'
    const transferControlStatus = hpResult.ok ? 'partial' : 'unavailable'
    const contractChecksStatus: "ok" | "partial" | "unavailable" | "error" =
      cortexContractFlags.bytecodeChecked ? 'partial' : (bytecodeStatus === 'ok' ? 'partial' : 'unavailable')
    const contractChecksReason = contractChecksStatus === 'unavailable'
      ? 'Unavailable from current checks.'
      : 'Contract bytecode, supply, owner, and CORTEX flag scan reviewed.'

    const responsePayload = {
      chain,
      contract,
      resolvedInput,

      // Core token fields
      name: finalResolvedName,
      symbol: finalResolvedSymbol,
      decimals: resolvedDecimals,

      // Pool state — reflects both primary and fallback market reads
      noActivePools: noActivePools && _dexFb == null,

      // Market source flags
      marketDataSource,
      marketConfidence,
      marketStatus,

      // Extra data
      holders: goldrush?.holders || null,
      holderDistribution,
      holderDistributionStatus,
      ...(process.env.NODE_ENV !== 'production' || debugHolder === true ? {
        debugHolderStatus: {
          providerCalled: holdersRaw?.__status !== 'unavailable',
          chain: chain === 'eth' ? 'eth-mainnet' : 'base-mainnet',
          endpointPath: holdersRaw?.__endpointPath ?? `/v1/${chain === 'eth' ? 'eth-mainnet' : 'base-mainnet'}/tokens/${contract}/token_holders_v2/`,
          authMode: 'bearer',
          holderKeyConfigured: Boolean(process.env.GOLDRUSH_API_KEY),
          holderAltKeyConfigured: Boolean(process.env.COVALENT_API_KEY),
          statusCode: holdersRaw?.__statusCode ?? null,
          itemCount: holderItems.length,
          normalizedCount: normalizedTop.length,
          reason: holderDistributionStatus?.reason ?? holderDistributionStatus?.status ?? null,
          responseKeys: holdersRaw?.__responseKeys ?? null,
          dataKeys: holdersRaw?.data ? Object.keys(holdersRaw.data) : null,
          firstItemKeys: holderItems[0] ? Object.keys(holderItems[0]) : null,
        }
      } : {}),
      // Normalized top-level market fields
      priceUsd: _ep,
      liquidityUsd: _el,
      volume24hUsd: _ev,
      poolCount,
      primaryDexName,
      // Legacy pool-level field kept for frontend pair display
      liquidity: mainPool?.attributes?.reserve_in_usd ?? _dexFb?.liquidityUsd ?? null,
      market_cap: marketCapFromGt,
      marketCapUsd: marketCapFromGt,
      marketCapStatus: marketCapFromGt != null ? 'verified' : 'unavailable',
      marketCapSource,
      marketCapReason: marketCapFromGt != null
        ? ((tokenEndpointMarketCap != null && tokenEndpointMarketCap > 0) ? 'Verified live market data' : 'Verified live pool market data')
        : 'Circulating supply not verified by live market data',
      circulating_supply: circulatingSupply,
      fdv: _efdv,
      fdvUsd: _efdv,
      fdvSource: _efdv != null ? (fdv != null ? fdvSource : 'fallback') : 'unavailable',
      displayMarketValue,
      displayMarketValueLabel,
      displayMarketValueConfidence,
      displayMarketValueReason,
      valuationContext: {
        primaryValuationLabel: marketCapFromGt != null ? 'Market Cap' : (_efdv != null ? 'FDV' : 'Market Cap'),
        primaryValuationUsd: marketCapFromGt ?? _efdv ?? null,
        primaryValuationStatus: marketCapFromGt != null ? 'verified_mc' : (_efdv != null ? 'fdv_only' : 'unavailable'),
        marketCapStatus: marketCapFromGt != null ? 'verified' : 'unavailable',
        fdvUsd: _efdv ?? null,
        reason: marketCapFromGt != null ? 'Verified live market data' : (_efdv != null ? 'Market cap not verified live; FDV used as valuation context.' : 'No live valuation context was verified.'),
      },
      estimatedMarketCap: null,
      estimatedMarketCapConfidence: null,
      estimatedMarketCapReason: marketCapFromGt != null ? 'Verified live market data' : 'Circulating supply not verified by live market data',

      poolActivity: {
        transactions24h,
        buys24h,
        sells24h,
        volume24hUsd: _ev,
        buyVolume24hUsd,
        sellVolume24hUsd,
        pairCreatedAt: pairCreatedAt ?? _dexFb?.pairCreatedAt ?? null,
        pairAgeLabel,
      },
      priceChart,
      chartStatus,
      chartDataSource,

      pairs: matchingPools,
      gtPools: matchingPools,
      gtRaw: gtData || null,

      gmgn: gmgn?.data || null,

      contractSecurity: null,

      // Internal diagnostics
      _diagnostics: {
        marketPrimaryPair: marketPair,
        lpVerificationPair: lpPair,
        lpVerificationPoolAddress: lpPoolAddress,
        lpVerificationPoolReason: lpReason,
        ...((process.env.NODE_ENV !== 'production' || debugHolder === true) ? {
          lpPoolCandidates: selectedLpPool.candidates.slice(0, 10).map((c) => ({
            pair: c.pairName ?? `${c.baseTokenSymbol ?? "?"}/${c.quoteTokenSymbol ?? "?"}`,
            poolAddress: c.address ? `${c.address.slice(0, 10)}…${c.address.slice(-4)}` : "unavailable",
            liquidityUsd: c.liquidityUsd,
            dexId: c.dexId,
            dexName: c.dexName,
            quoteSymbol: c.quoteTokenAddress === String(contract).toLowerCase() ? c.baseTokenSymbol : c.quoteTokenSymbol,
            quoteAddress: (() => {
              const qa = c.quoteTokenAddress === String(contract).toLowerCase() ? c.baseTokenAddress : c.quoteTokenAddress;
              return qa ? `${qa.slice(0, 10)}…${qa.slice(-4)}` : "unavailable";
            })(),
            containsScannedToken: c.containsScannedToken ?? false,
            isPreferredQuote: c.isPreferredQuote ?? false,
            poolType: c.poolType,
            lpScore: c.lpScore ?? null,
            selectionReason: c.selectionReason ?? null,
          })),
        } : {}),
        alchemy: {
          configured: alchemyConfigured,
          lpProbeAttempted: Boolean(lpPoolAddress && (lpPoolType === "unknown" || lpPoolType === "v2")),
          lpProbeReason: !lpPoolAddress ? "no_pool_address" : (!alchemyConfigured ? "alchemy_not_configured" : (lpPoolType === "unknown" ? "unknown_pool_type_probe" : (lpPoolType === "v2" ? "v2_fallback_checks" : "not_needed"))),
          rpcCallsAttempted,
          rpcCallsSucceeded,
          rpcCallsFailed,
          contractChecksAttempted: true,
        },
        providerUsed: { market: 'market_layer', holders: 'holders_layer', security: hpResult.ok ? 'risk_layer' : 'unavailable', contractChecks: 'risk_layer', liquidity: 'lp_layer' },
        marketFallback: { attempted: !_primaryHasMarket, found: _dexFb != null, pairAddress: _dexFb?.pairAddress ?? null, dexId: _dexFb?.dexId ?? null },
        tokenMarketFieldsPresent: {
          priceUsd: _ep != null,
          liquidityUsd: _el != null,
          volume24hUsd: _ev != null,
          marketCapUsd: marketCapFromGt != null,
          tokenEndpointMarketCapPresent: tokenEndpointMarketCap != null && tokenEndpointMarketCap > 0,
          poolEndpointMarketCapPresent,
          fdvUsd: _efdv != null,
          poolCount: poolCount > 0,
        },
        missingReasons: [
          _ep == null ? 'priceUsd: no pool price' : '',
          _el == null ? 'liquidityUsd: no pool reserve' : '',
          _ev == null ? 'volume24hUsd: no pool volume' : '',
          marketCapFromGt == null ? 'marketCapUsd: not in GT token response' : '',
          _efdv == null ? 'fdvUsd: not in GT token or pool response' : '',
        ].filter(Boolean),
        ...((debugMode === true || debugHolder === true) ? { debug: (() => {
          const mp = mainPool as Record<string, unknown> | null
          const mpAttr = (mp?.attributes ?? {}) as Record<string, unknown>
          const mpRel = (mp?.relationships ?? {}) as Record<string, unknown>
          const mpRelDex = ((mpRel.dex as Record<string, unknown>)?.data) as Record<string, unknown> | undefined
          const mpRelDexes = ((mpRel.dexes as Record<string, unknown>)?.data) as Array<Record<string, unknown>> | undefined
          const gtTokenAttr = gtTokenInfo?.data?.attributes ?? null
          return {
            resolverInput: originalInput,
            resolverType: resolvedInput?.type ?? 'none',
            resolverCandidatesCount: resolvedInput ? 1 : 0,
            resolverSelectedAddress: resolvedInput?.resolvedAddress ?? null,
            resolverReason: resolvedInput ? (resolvedInput.type === 'alias' ? 'canonical_alias' : 'direct_address') : 'not_resolved',
            // A) Token identity
            inputContract: contract,
            normalizedContract: String(contract).toLowerCase(),
            chain,
            tokenName: resolvedName,
            tokenSymbol: resolvedSymbol,
            tokenDecimals: resolvedDecimals,
            // B) Price diagnostics
            rawPriceUsd: priceUsd,
            priceIsScientificRisk: priceUsd != null && priceUsd < 0.000001,
            priceSourceField: priceUsd === pickNum(mpAttr.base_token_price_usd) ? 'pool.attributes.base_token_price_usd'
              : priceUsd === pickNum(gtTokenAttr?.price_usd) ? 'gtToken.attributes.price_usd'
              : priceUsd === pickNum(gtTokenAttr?.price) ? 'gtToken.attributes.price'
              : 'unknown',
            rawPoolBaseTokenPriceUsd: mpAttr.base_token_price_usd ?? null,
            rawGtTokenPriceUsd: gtTokenAttr?.price_usd ?? null,
            // C) Market cap diagnostics
            rawMarketCapUsd: marketCapFromGt,
            rawEstimatedMarketCap: estimatedMarketCap,
            rawFdvUsd: fdv,
            circulatingSupply,
            marketCapStatus: marketCapFromGt != null ? 'verified' : 'unavailable',
            marketCapReason: marketCapFromGt != null
              ? ((tokenEndpointMarketCap != null && tokenEndpointMarketCap > 0) ? 'Verified live market data' : 'Verified live pool market data')
              : 'Circulating supply not verified by live market data',
            marketCapFinalSource: marketCapFromGt != null
              ? ((tokenEndpointMarketCap != null && tokenEndpointMarketCap > 0) ? 'token_endpoint' : 'selected_pool')
              : 'none',
            estimatedMarketCapDebugOnly: estimatedMarketCap,
            gtTokenMarketCapUsd: gtTokenAttr?.market_cap_usd ?? null,
            selectedPoolMarketCapUsd: selectedPoolMarketCapUsd,
            gtTokenFdvUsd: gtTokenAttr?.fdv_usd ?? null,
            // D) Pool diagnostics
            totalPoolsReturned: matchingPools.length,
            selectedPoolIndex: 0,
            selectedPoolId: mp?.id ?? null,
            selectedPoolAddress: mpAttr.address ?? null,
            selectedPoolName: mpAttr.name ?? null,
            selectedPoolLiquidityUsd: mpAttr.reserve_in_usd ?? null,
            selectedPoolVolume24h: (mpAttr.volume_usd as Record<string, unknown> | undefined)?.h24 ?? null,
            selectedPoolCreatedAt: mpAttr.pool_created_at ?? null,
            // E) DEX/protocol diagnostics
            dexNameFinal: primaryDexName,
            dexExtractedRawId: _extractedDexId,
            dexRawCandidates: {
              'pool.dex': (mp as Record<string, unknown>)?.dex ?? null,
              'pool.dex_id': (mp as Record<string, unknown>)?.dex_id ?? null,
              'attributes.dex': mpAttr.dex ?? null,
              'attributes.dex_id': mpAttr.dex_id ?? null,
              'attributes.dexId': (mpAttr as Record<string, unknown>).dexId ?? null,
              'attributes.exchange': mpAttr.exchange ?? null,
              'attributes.protocol': mpAttr.protocol ?? null,
              'attributes.name': mpAttr.name ?? null,
              'attributes.pool_name': mpAttr.pool_name ?? null,
              'relationships.dex.data.id': mpRelDex?.id ?? null,
              'relationships.dex.data.type': mpRelDex?.type ?? null,
              'relationships.dexes.data[0].id': mpRelDexes?.[0]?.id ?? null,
            },
            poolTopLevelKeys: mp ? Object.keys(mp) : [],
            poolAttributeKeys: Object.keys(mpAttr),
            poolRelationshipKeys: Object.keys(mpRel),
            whyDexNotConfirmed: primaryDexName ? null
              : _extractedDexId ? `normalizeDexLabel("${_extractedDexId}") returned null — add to map`
              : 'No dex id found in any checked field',
            // F) First 3 pool summaries
            first3Pools: matchingPools.slice(0, 3).map((p) => {
              const pa = (p?.attributes ?? {}) as Record<string, unknown>
              const pr = (p?.relationships ?? {}) as Record<string, unknown>
              const prd = ((pr.dex as Record<string, unknown>)?.data) as Record<string, unknown> | undefined
              return {
                id: p.id ?? null,
                name: pa.name ?? null,
                liquidityUsd: pa.reserve_in_usd ?? null,
                dex_id_attr: pa.dex_id ?? null,
                dex_rel_id: prd?.id ?? null,
              }
            }),
            // G) UI mapping summary
            uiMapping: {
              priceCard: priceUsd != null ? (priceUsd < 0.000001 ? `SCIENTIFIC RISK: ${priceUsd}` : String(priceUsd)) : 'N/A',
              dexCard: primaryDexName ?? 'DEX unverified',
              marketCapCard: marketCapFromGt != null ? `$${marketCapFromGt}` : (estimatedMarketCap != null && estimatedMarketCapConfidence !== 'low' ? `~$${estimatedMarketCap}` : 'MC unverified'),
              fdvCard: fdv != null ? `$${fdv}` : 'Unverified',
            },
            // H) Pool activity diagnostics
            transactionRawShape: mainPoolAttr.transactions ?? null,
            volumeRawShape: mainPoolAttr.volume_usd ?? null,
            volumeSplitCandidateFields: splitCandidates.map((c) => c.key),
            buyVolumeFoundFrom: buyPick.key,
            sellVolumeFoundFrom: sellPick.key,
            volumeTotalFoundFrom: totalPick.key,
            buySellVolumeSplitAvailable,
            buySellVolumeReason,
            chartAttempted,
            chartPointCount: priceChart.points.length,
            chartAttemptedPools,
            chartAttemptedTimeframes,
            chartSelectedPoolForChart,
            chartFallbackUsed,
            chartTimeframe: '24h',
            chartSelectedPoolId: mp?.id ?? null,
            chartSelectedPoolAddress: mpAttr.address ?? null,
            chartFailureReason,
            chartFirstTimestamp: priceChart.points[0]?.timestamp ?? null,
            chartLastTimestamp: priceChart.points[priceChart.points.length - 1]?.timestamp ?? null,
            poolActivityExtractionReason: {
              transactions24hSource: _txnsH24Obj != null ? 'transactions.h24 (object)' : _txnsH24Total != null ? 'transactions.h24 (scalar)' : 'unavailable',
              buys24hFound: buys24h != null,
              sells24hFound: sells24h != null,
              transactions24hResult: transactions24h,
              buyVolumeFound: buyVolume24hUsd != null,
              sellVolumeFound: sellVolume24hUsd != null,
              pairCreatedAtFound: pairCreatedAt != null,
              pairAgeLabelResult: pairAgeLabel,
            },
          }
        })() } : {}),
      },

      // Security simulation — Honeypot.is is the preferred provider.
      // GoPlus is an optional low-confidence fallback only; not a core provider.
      honeypot: hpResult.ok ? {
        isHoneypot:        hpResult.honeypot,
        buyTax:            hpResult.buyTax,
        sellTax:           hpResult.sellTax,
        transferTax:       hpResult.transferTax,
        simulationSuccess: hpResult.simulationSuccess,
      } : gpHoneypot,
      securityDiagnostics: {
        honeypotProvider: hpResult.ok ? "ok" : hpResult.honeypotProvider,
        honeypotSource:   hpResult.ok ? "risk_layer" : "unavailable",
        honeypotChecked:  true,
      },

      // Contract analysis
      analysis,
      lpControl,
      lpControlRead: computeLpControlRead(lpControl, String(lpPool?.pairName ?? "")),

      // AI summary from Cortex Engine
      aiSummary,

      // CORTEX Risk Engine v1 — pure derivation, no extra API calls
      riskEngine,
      rugRisk,
      contractFlags: cortexContractFlags,

      // Token info object for frontend panels
      tokenInfo: {
        name: finalResolvedName,
        symbol: finalResolvedSymbol,
        decimals: resolvedDecimals,
      },
      sections: {
        market: {
          status: marketStatus,
          reason: marketReason,
          source: 'market_data',
          price: _ep,
          liquidity: _el,
          volume24h: _ev,
          change24h: _dexFb?.priceChange24h ?? pickNum((poolAttr.price_change_percentage as Record<string, unknown> | undefined)?.h24),
          marketCap: marketCapFromGt,
          fdv: _efdv,
        },
        security: {
          status: securityStatus,
          reason: securityReason,
          source: hpResult.ok ? "risk_layer" : "unavailable",
          honeypot: hpResult.ok ? hpResult.honeypot : null,
          buyTax: hpResult.ok ? hpResult.buyTax : null,
          sellTax: hpResult.ok ? hpResult.sellTax : null,
          simulationSuccess: hpResult.ok ? hpResult.simulationSuccess : null,
        },
        holders: {
          status: holdersStatus,
          reason: holdersReason,
          source: "holders_layer",
          holderCount: holderCount ?? null,
          top1, top5, top10, top20,
          whale_pressure: whalePressure,
          holder_risk: holderRisk,
          supply_spread: supplySpread,
          holderDataComplete,
        },
        liquidity: {
          status: liquidityStatus,
          reason: liquidityReason,
          source: "lp_layer",
          poolCount: matchingPools.length,
          primaryPair: mainPool?.attributes?.name ?? null,
          liquidityDepth: liquidityUsd,
          pool_age: pairCreatedAt ?? _dexFb?.pairCreatedAt ?? null,
          pool_protocol: primaryDexName ?? lpPool?.dexName ?? null,
          pool_fragmentation: matchingPools.length > 2 ? 'fragmented' : matchingPools.length === 2 ? 'split' : matchingPools.length === 1 ? 'single' : 'none',
          lpSafetyAttempted,
          lpSafetyUsable,
          lpOwnershipVerified,
          lpControl,
          lpControlRead: computeLpControlRead(lpControl, String(lpPool?.pairName ?? "")),
        },
        ownership: {
          is_renounced: isRenounced,
          owner_address: ownerAddr,
          admin_address: adminAddr,
          proxy_implementation: proxyImplAddr,
          ownership_verified: ownershipVerified,
        },
        contractChecks: {
          status: contractChecksStatus,
          reason: contractChecksReason,
          source: "risk_layer",
          bytecodeStatus,
          ownerStatus,
          mintStatus,
          proxyStatus,
          transferControlStatus,
          owner: ownerAddr ?? null,
          totalSupply: rpcSupply ?? null,
          decimalsRpc: rpcDecimalsHex ?? null,
          nameFallback: rpcName ?? null,
          symbolFallback: rpcSymbol ?? null,
        },
      },
    }
    if (process.env.NODE_ENV === 'development') {
      const _totalMs = Date.now() - _t0
      console.log('[token-timing] totalMs', _totalMs, 'contract', contract)
      console.log('[alchemy-diag] route=/api/token configured=', alchemyConfigured, 'lpProbeAttempted=', Boolean(lpPoolAddress && (lpPoolType === "unknown" || lpPoolType === "v2")), 'rpcAttempted=', rpcCallsAttempted, 'rpcSucceeded=', rpcCallsSucceeded, 'rpcFailed=', rpcCallsFailed, 'totalMs=', _totalMs)
      ;(responsePayload as any)._timing = { totalMs: _totalMs }
    }
    if (debugMode) {
      const skippedChecks: string[] = []
      if (!alchemyConfigured) skippedChecks.push('rpc_checks_missing_configuration')
      if (holdersStatus !== 'ok') skippedChecks.push('holder_verification_incomplete')
      if (lpControl.status === 'insufficient_data' || lpControl.status === 'error' || lpControl.status === 'unverified' || lpControl.status === 'partial' || lpControl.status === 'no_pool') skippedChecks.push('lp_proof_incomplete')
      if (!hpResult.ok) skippedChecks.push('trading_simulation_incomplete')
      const chainReasons = [
        holdersReason ? `holders:${holdersReason}` : null,
        lpControl.reason ? `lp:${lpControl.reason}` : null,
        securityReason ? `security:${securityReason}` : null,
      ].filter(Boolean) as string[]
      ;(responsePayload as any)._debug = {
        routeName: '/api/token',
        cacheHit: false,
        goldrushUsage: {
          endpointName: `token_holders_v2`,
          feature: 'token-scanner',
          trigger: 'scan_button',
          attempted: Boolean(process.env.GOLDRUSH_API_KEY ?? process.env.COVALENT_API_KEY),
          cacheHit: false,
          deduped: false,
          statusCode: holdersRaw?.__statusCode ?? null,
          durationMs: null,
          failureStage: holdersRaw?.__status === 'error' ? (holdersRaw?.__reason ?? 'unknown') : null,
          reason: holderDistributionStatus.reason ?? holderDistributionStatus.status ?? null,
        },
        alchemyConfigured,
        alchemyCallsAttempted: rpcCallsAttempted,
        alchemyCallsSucceeded: rpcCallsSucceeded,
        alchemyCallsFailed: rpcCallsFailed,
        rpcMethodsUsed: rpcCallsAttempted > 0 ? ['eth_call'] : [],
        skippedReason: rpcCallsAttempted > 0 ? null : (alchemyConfigured ? 'no_rpc_path_needed' : 'alchemy_not_configured'),
        fallbackUsed: rpcCallsSucceeded < rpcCallsAttempted,
        requestDurationMs: Date.now() - _t0,
        checks: rpcCheckDiagnostics,
        dexFallbackTest: forceDexFallback ? {
          forced: true,
          primaryMarketAvailable: _primaryHasMarket,
          fallbackAttempted: _fallbackNeeded,
          fallbackUsable: _dexFb != null,
          fallbackPairAddress: _dexFb?.pairAddress ?? null,
          fallbackDexId: _dexFb?.dexId ?? null,
          effectivePriceUsd: _ep,
          effectiveLiquidityUsd: _el,
          effectiveVolume24h: _ev,
          effectiveFdv: _efdv,
          marketDataSource,
          marketConfidence,
          marketStatus,
        } : null,
        holderDiagnostics: {
          attempted: holdersRaw?.__status !== 'unavailable',
          chainUsed: holdersRaw?.__chainUsed ?? (chain === 'eth' ? 'eth-mainnet' : chain === 'base' ? 'base-mainnet' : chain),
          endpointTemplate: holdersRaw?.__endpointPath ?? undefined,
          hasApiKey: holdersRaw?.__hasApiKey ?? Boolean(process.env.GOLDRUSH_API_KEY ?? process.env.COVALENT_API_KEY),
          statusCode: holdersRaw?.__statusCode ?? undefined,
          fetchFailed: holdersRaw?.__status === 'error',
          failureStage: holderDistributionStatus.status === 'ok' ? undefined : (holderDistributionStatus.reason ?? holdersRaw?.__status ?? 'unknown'),
          rawItemCount: holderItems.length,
          rawTopLevelKeys: holdersRaw ? Object.keys(holdersRaw) : undefined,
          normalizedCount: normalizedTop.length,
          firstItemKeys: holderItems[0] ? Object.keys(holderItems[0]) : undefined,
          reason: holderDistributionStatus.reason,
          percentSource,
          totalSupplyAvailable: Boolean(rpcSupply && rpcSupply !== '0x' && rpcSupply !== '0x0'),
          providerTotalSupplyAvailable: _holderProviderSupply != null,
          derivationSupplySource: _derivationSupplySource,
          decimalsAvailable: resolvedDecimals != null,
          derivationAttempted: holderDerivationAttempted,
          derivationSucceeded: holderDerivationSucceeded,
          derivationFailureReason: holderDerivationFailureReason,
        },
        lpDiagnostics: {
          chain: lpDiagnostics.chain,
          poolDetected: lpDiagnostics.poolDetected,
          primaryPoolSelected: lpDiagnostics.primaryPoolSelected,
          poolSource: lpDiagnostics.poolSource,
          poolCount: lpDiagnostics.poolCount,
          selectedPoolAddress: lpDiagnostics.selectedPoolAddress,
          selectedPoolDex: lpDiagnostics.selectedPoolDex,
          selectedPoolType: lpDiagnostics.selectedPoolType,
          selectedPoolLiquidityUsd: lpDiagnostics.selectedPoolLiquidityUsd,
          lpToken: lpDiagnostics.lpTokenAddress,
          lpProofAttempted: lpDiagnostics.attempted,
          holderProofAttempted: lpDiagnostics.goldrushAttempted,
          holderRawItemCount: lpDiagnostics.goldrushItemCount,
          rpcAttempted: lpDiagnostics.rpcAttempted,
          totalSupplyChecked: lpDiagnostics.totalSupplyChecked,
          burnAddressesChecked: lpDiagnostics.burnAddressesChecked,
          lockerAddressesChecked: lpDiagnostics.lockerAddressesChecked,
          ownerTeamBalanceChecked: lpDiagnostics.ownerTeamBalanceChecked,
          burnPercent: lpDiagnostics.burnPercent,
          lockedPercent: lpDiagnostics.lockedPercent,
          teamPercent: lpDiagnostics.teamPercent,
          proofStatus: lpDiagnostics.lpState,
          failureReason: lpDiagnostics.failureReason,
          dexscreenerPoolSynthesized: lpDiagnostics.dexscreenerPoolSynthesized,
          lpSafetyAttempted,
          lpSafetyUsable,
          lpOwnershipVerified,
          reason: lpDiagnostics.reason,
          _full: lpDiagnostics,
        },
        contractFlagDiagnostics: {
          bytecodeChecked: cortexContractFlags.bytecodeChecked,
          proxySlotChecked: cortexContractFlags.proxySlotChecked,
          pauseCallChecked: cortexContractFlags.pauseCallChecked,
          rawSelectors: {
            mintSel: _cortexMintSel,
            proxySel: _cortexProxySel,
            pauseSel: _cortexPauseSel,
            withdrawSel: _cortexWithdrawSel,
            blacklistStr: _cortexBlacklistStr,
          },
          proxySlotRaw: _proxySlotHex ?? null,
          pausedCallRaw: _pausedCallHex ?? null,
          isVerifiedProxy: _isVerifiedProxy,
          pauseFunctionExists: _pauseFunctionExists,
          gpEnrichment: { mint: gpMint, upgradeable: gpUpgradeable, blacklist: gpBlacklist },
          flags: {
            mint: cortexContractFlags.mint,
            proxy: cortexContractFlags.proxy,
            pause: cortexContractFlags.pause,
            blacklist: cortexContractFlags.blacklist,
            withdraw: cortexContractFlags.withdraw,
          },
        },
        chainDiagnostics: {
          requestedChain: rawChain,
          resolvedChain: chain,
          isFullScanChain,
          supportedFullScanChains: SUPPORTED_FULL_SCAN_CHAINS,
          goldrushEnabled,
          moralisEnabled,
          alchemyEnabled: alchemyConfigured,
          marketNetwork: chain,
          holderChainUsed: holdersRaw?.__chainUsed ?? (chain === 'eth' ? 'eth-mainnet' : 'base-mainnet'),
          rpcChainUsed: chain,
          lpChainUsed: chain,
          contractFlagChainUsed: chain,
          securityChainUsed: chain,
          chainParity: {
            market_layer: (marketCapFromGt != null || fdv != null || liquidityUsd != null) ? 'populated' : 'empty',
            holders_layer: holderDistributionStatus.status === 'ok' || holderDistributionStatus.status === 'partial' ? 'populated' : 'empty',
            lp_layer: lpDiagnostics.poolDetected ? 'populated' : 'empty',
            contract_flags: cortexContractFlags.bytecodeChecked ? 'populated' : 'empty',
            risk_engine: anyProviderData ? 'populated' : 'empty',
          },
          skippedChecks,
          reasons: chainReasons,
        },
        providerFlow: {
          requestedChain: rawChain,
          deepScan: true,
          coingeckoAttempted: true,
          dexScreenerAttempted: true,
          moralisAttempted: true,
          goldrushAttempted: true,
          alchemyAttempted: true,
          coingeckoUsable: Boolean(coingeckoRaw),
          dexScreenerUsable: Boolean(gtData || _dexFb),
          moralisUsable: Boolean((moralisHoldersRaw && moralisHoldersRaw.__status !== 'error') || (moralisTransfersRaw && moralisTransfersRaw.__status !== 'error')),
          goldrushUsable: Boolean(goldrush || holdersRaw),
          alchemyUsable: alchemyConfigured && rpcCallsSucceeded > 0,
          cacheHits: 0,
          dedupedCalls: 0,
          providerCallCounts: { coingecko: 1, dexScreener: 1, moralis: 2, goldrush: 2, alchemy: rpcCallsAttempted },
          // Layer-level breakdown
          marketFlow: {
            geckoterminalAttempted: true,
            geckoterminalUsable: Boolean(gtData?.data),
            dexscreenerAttempted: true,
            dexscreenerUsable: Boolean(_dexFb),
            coingeckoAttempted: true,
            coingeckoUsable: Boolean(coingeckoRaw),
            effectiveSource: marketDataSource,
          },
          holderFlow: {
            goldrushAttempted: Boolean(process.env.GOLDRUSH_API_KEY ?? process.env.COVALENT_API_KEY),
            goldrushUsable: holderDistributionStatus.status === 'ok' || holderDistributionStatus.status === 'partial',
            goldrushStatus: holdersRaw?.__status ?? 'unknown',
            moralisAttempted: Boolean(process.env.MORALIS_API_KEY),
            moralisUsable: Boolean(moralisHoldersRaw && moralisHoldersRaw.__status !== 'error' && moralisHoldersRaw.__status !== 'unavailable'),
            holderDataComplete,
            holderCount: holderCount ?? null,
            top10Pct: top10 ?? null,
            supplySpread,
            holderRisk,
            whalePressure,
          },
          lpFlow: {
            poolDetected: lpDiagnostics.poolDetected,
            poolSource: lpDiagnostics.poolSource,
            poolCount: lpDiagnostics.poolCount,
            goldrushLpAttempted: lpSafetyAttempted,
            goldrushLpUsable: lpSafetyUsable,
            rpcLpAttempted: lpDiagnostics.rpcAttempted,
            lpSafetyAttempted,
            lpSafetyUsable,
            lpOwnershipVerified,
            proofStatus: lpDiagnostics.lpState,
          },
          contractFlow: {
            bytecodeAvailable: _hasBytecode,
            honeypotAttempted: true,
            honeypotUsable: hpResult.ok,
            mintDetected: cortexContractFlags.mint.status === 'verified' || cortexContractFlags.mint.status === 'possible',
            blacklistDetected: cortexContractFlags.blacklist.status === 'verified',
            pauseDetected: cortexContractFlags.pause.status === 'verified',
            proxyDetected: cortexContractFlags.proxy.status === 'verified' || cortexContractFlags.proxy.status === 'possible',
            withdrawDetected: cortexContractFlags.withdraw.status === 'verified',
          },
          ownershipFlow: {
            rpcAttempted: alchemyConfigured,
            ownerFound: Boolean(ownerAddr),
            adminFound: Boolean(adminAddr),
            proxyImplFound: Boolean(proxyImplAddr),
            is_renounced: isRenounced,
            ownership_verified: ownershipVerified,
            owner_address: ownerAddr,
            admin_address: adminAddr,
          },
          riskFlow: {
            rugRiskScore: riskEngine.rugRiskScore,
            rugRiskLabel: riskEngine.rugRiskLabel,
            confidence: riskEngine.confidence,
            majorMissingCount,
            sufficientCoreData,
            verifiedSignalCount: riskEngine.verifiedSignals.length,
            riskDriverCount: riskEngine.riskDrivers.length,
            openCheckCount: riskEngine.openChecks.length,
          },
        },
      }
    } else {
      delete (responsePayload as any)._diagnostics
    }
    return NextResponse.json(responsePayload)
  } catch (err) {
    console.error("Fatal backend error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
