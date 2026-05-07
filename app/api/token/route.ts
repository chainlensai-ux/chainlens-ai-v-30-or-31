/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { fetchHoneypotSecurity } from "@/lib/server/honeypotSecurity";
import { getCurrentUserPlanFromBearerToken } from '@/lib/supabase/plans'

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const CHAIN_RPC_MAP = {
  eth: `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_ETHEREUM_KEY}`,
  base: `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_BASE_KEY}`,
  polygon: `https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_POLYGON_KEY}`,
  bnb: `https://bnb-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_BNB_KEY}`,
} as const;

type ChainKey = keyof typeof CHAIN_RPC_MAP;

const TOKEN_CACHE_TTL_MS = 3 * 60 * 1000
const TOKEN_RATE_WINDOW_MS = 60 * 1000
const TOKEN_RATE_BY_PLAN: Record<string, number> = { free: 12, pro: 40, elite: 120 }
const tokenResponseCache = new Map<string, { exp: number; payload: unknown }>()
const tokenRateMap = new Map<string, { count: number; resetAt: number }>()

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
    const rpcUrl = CHAIN_RPC_MAP[chain];
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
  const rpcUrl = CHAIN_RPC_MAP[chain]
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
    const rpcUrl = CHAIN_RPC_MAP[chain];
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
    const res = await fetch(
      `https://api.covalenthq.com/v1/${chain}/tokens/${contract}/?key=${process.env.COVALENT_API_KEY}`,
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
    const res = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${contract}/pools?page=1&include=base_token%2Cquote_token`,
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
    const res = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${contract}`,
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

const CHAIN_ID_MAP: Record<ChainKey, number> = { eth: 1, base: 8453, polygon: 137, bnb: 56 };


async function fetchGoPlus(chain: ChainKey, contract: string): Promise<unknown> {
  try {
    const chainIdMap: Record<ChainKey, string> = {
      eth:     '1',
      base:    '8453',
      polygon: '137',
      bnb:     '56',
    };
    const chainId = chainIdMap[chain];
    if (!chainId) return null;
    const res = await fetch(
      `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${contract}`,
      { cache: 'no-store', signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) {
      console.error('GoPlus error:', res.status);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error('Error fetching GoPlus:', err);
    return null;
  }
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
  const chainSlug = 'base-mainnet'
  const endpointPath = `/v1/${chainSlug}/tokens/${contract}/token_holders_v2/`
  let statusCode: number | undefined
  try {
    // Use GOLDRUSH_API_KEY first (matches proxy/test routes); fall back to COVALENT_API_KEY
    const apiKey = process.env.GOLDRUSH_API_KEY ?? process.env.COVALENT_API_KEY ?? ''
    if (!apiKey) {
      console.warn('[holder-debug] contract', contract, 'chain', chainSlug, 'result: missing API key')
      return { __status: 'unavailable', __reason: 'missing_api_key', __endpointPath: endpointPath }
    }
    // page-size max accepted by Covalent: 100. Values above that (e.g. 200) return HTTP 400.
    const url = `https://api.covalenthq.com${endpointPath}?page-number=0&page-size=100`
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
      return { __status: 'error', __reason: safeReason, __statusCode: statusCode, __endpointPath: endpointPath }
    }
    const json = await res.json()
    const topKeys = Object.keys(json ?? {})
    const itemCount = json?.data?.items?.length ?? 0
    console.log('[holder-debug] statusCode', statusCode, 'responseKeys', topKeys, 'data.items.length', itemCount)
    if (json?.error) {
      console.warn('[holder-debug] API-level error:', json?.error_message)
      return { __status: 'error', __reason: json?.error_message ?? 'api_error', __statusCode: statusCode, __endpointPath: endpointPath, __responseKeys: topKeys }
    }
    return { ...json, __endpointPath: endpointPath, __statusCode: statusCode, __responseKeys: topKeys }
  } catch (err) {
    console.error('[holder-debug] exception', err)
    return { __status: 'error', __reason: 'provider_unavailable', __statusCode: statusCode, __endpointPath: endpointPath }
  }
}

type LpControlResult = {
  status: "burned" | "locked" | "team_controlled" | "unverified" | "unsupported" | "error";
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

type NormalizedPool = {
  raw: any;
  address: string | null;
  pairName: string | null;
  dexId: string | null;
  dexName: string | null;
  liquidityUsd: number;
  baseTokenAddress: string | null;
  quoteTokenAddress: string | null;
  baseTokenSymbol: string | null;
  quoteTokenSymbol: string | null;
  poolType: LpControlResult["poolType"];
  hasDexMeta: boolean;
  isValidAddress: boolean;
};

function normalizePool(pool: any): NormalizedPool {
  const a = (pool?.attributes ?? {}) as Record<string, unknown>;
  const base = (pool?.relationships?.base_token?.data ?? {}) as Record<string, unknown>;
  const quote = (pool?.relationships?.quote_token?.data ?? {}) as Record<string, unknown>;
  const cleanAddr = (v: unknown) => {
    const s = String(v ?? "").trim().toLowerCase();
    return /^0x[a-f0-9]{40}$/.test(s) ? s : null;
  };
  const cleanSym = (v: unknown) => {
    const s = String(v ?? "").trim();
    return s ? s.toUpperCase() : null;
  };
  const idToAddr = (id: string | null) => (id && id.includes("_") ? id.split("_").pop() ?? null : id);
  const baseTokenObj = (a.base_token ?? {}) as Record<string, unknown>;
  const quoteTokenObj = (a.quote_token ?? {}) as Record<string, unknown>;
  const baseTokenAddress = cleanAddr(a.base_token_address ?? baseTokenObj.address ?? idToAddr(String(base.id ?? "")));
  const quoteTokenAddress = cleanAddr(a.quote_token_address ?? quoteTokenObj.address ?? idToAddr(String(quote.id ?? "")));
  return {
    raw: pool,
    address: cleanAddr(a.address ?? pool?.id),
    pairName: String(a.name ?? a.pool_name ?? a.pair_name ?? "").trim() || null,
    dexId: String(a.dex_id ?? a.dex ?? "").trim() || null,
    dexName: String(a.dex_name ?? "").trim() || null,
    liquidityUsd: toNum(a.reserve_in_usd) ?? 0,
    baseTokenAddress,
    quoteTokenAddress,
    baseTokenSymbol: cleanSym(a.base_token_symbol ?? a.base_symbol ?? baseTokenObj.symbol),
    quoteTokenSymbol: cleanSym(a.quote_token_symbol ?? a.quote_symbol ?? quoteTokenObj.symbol),
    poolType: detectPoolType(pool as Record<string, unknown>),
    hasDexMeta: Boolean(String(a.dex_id ?? a.dex ?? a.dex_name ?? "").trim()),
    isValidAddress: Boolean(cleanAddr(a.address ?? pool?.id)),
  };
}

function selectLpVerificationPool(pools: NormalizedPool[], tokenAddress: string): { pool: NormalizedPool | null; reason: string } {
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
    const quotePriority = otherSymbol ? quoteRank[otherSymbol] ?? null : null;
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
  }
  return best ? { pool: best.pool, reason: best.reason } : { pool: null, reason: "no_pool_candidates" };
}

function detectPoolType(pool: Record<string, unknown> | null): LpControlResult["poolType"] {
  const a = (pool?.attributes ?? {}) as Record<string, unknown>;
  const rel = (pool?.relationships ?? {}) as Record<string, unknown>;
  const candidates = [
    a.dex_id, a.dex, a.dex_name, a.name, a.pool_name, a.pair_name, a.pool_type, a.address,
    rel?.dex, rel?.base_token, rel?.quote_token,
    pool?.id,
  ].map((v) => String(v ?? '').toLowerCase()).filter(Boolean);
  const text = candidates.join(' | ');

  const has = (re: RegExp) => re.test(text);

  if (has(/\baerodrome\b|\bslipstream\b/)) return "aerodrome";
  if (has(/\bconcentrated\b|\bcl pool\b|\balgebra\b/)) return "concentrated";
  if (has(/\buniswap(?:[_-]?v)?3\b|\bpancakeswap(?:[_-]?v)?3\b|\bv3\b/)) return "v3";

  if (has(/\buniswap(?:[_-]?v)?2\b|\bsushiswap(?:[_-]?v)?2\b|\bpancakeswap(?:[_-]?v)?2\b|\bbaseswap\b|\balienbase\b|\bswapbased\b|\bconstant[-_ ]?product\b|\bv2\b/)) {
    return "v2";
  }

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
// POST handler
// ------------------------------
export async function POST(req: Request) {
  if (!(await checkRate(req))) return NextResponse.json({ error: "Rate limit reached. Try again shortly." }, { status: 429 })

  try {
    const _t0 = Date.now()

    const body = await req.json();
    const { contract, debugHolder } = body;
    const cacheKey = JSON.stringify({ contract: String(contract ?? "").toLowerCase(), chain: "base" })
    const cached = tokenResponseCache.get(cacheKey)
    if (cached && cached.exp > Date.now()) return NextResponse.json(cached.payload)

    if (!contract || !/^0x[a-fA-F0-9]{40}$/.test(contract)) {
      return NextResponse.json({ error: "Invalid contract address" }, { status: 400 })
    }

    console.log("Incoming scan request:", contract);

    // Token Scanner is Base-only.
    const chain: ChainKey = "base";

    const [bytecode, goldrush, holdersRaw, gtData, gtTokenInfo, gmgn, metadata, gpRaw, hpResult] = await Promise.all([
      fetchBytecode(chain, contract),
      fetchGoldRush(chain, contract),
      fetchTokenHolders(chain, contract),
      fetchGeckoTerminal(contract, chain),
      fetchGeckoTerminalToken(contract, chain),
      fetchGMGN(contract),
      fetchTokenMetadata(chain, contract),
      fetchGoPlus(chain, contract),
      fetchHoneypotSecurity(contract, CHAIN_ID_MAP[chain]),
    ]);
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
    const normalizedPools = matchingPools.map(normalizePool);
    const selectedLpPool = selectLpVerificationPool(normalizedPools, String(contract));
    const noActivePools = matchingPools.length === 0;
    const mainPoolAttr = (mainPool?.attributes ?? {}) as Record<string, unknown>;
    const primaryPoolAddress = String(mainPoolAttr.address ?? mainPool?.id ?? "").trim().toLowerCase() || null;
    const lpPool = selectedLpPool.pool;
    const lpPoolType = lpPool?.poolType ?? "unknown";
    const dexId = String(mainPoolAttr.dex_id ?? mainPoolAttr.dex ?? "").trim() || null;
    const dexName = String(mainPoolAttr.dex_name ?? "").trim() || null;
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
    const hasSecurityData = Boolean((gpRaw as Record<string, unknown>)?.result || hpResult.ok)
    const lpPoolAddress = lpPool?.address ?? null
    const lpPoolAddressPresent = Boolean(lpPoolAddress && /^0x[a-f0-9]{40}$/.test(lpPoolAddress))
    const needsLpHolderFetch = Boolean(lpPoolAddressPresent && lpPoolType === 'v2')
    const needsAI = !noActivePools || hasSecurityData
    const needsOnchainMc = _mcEarly == null && _priceEarly != null

    // Compact AI prompt (key fields only — reduces token count and latency)
    const _aiPrompt = [
      'Summarize this Base token risk in 3-4 sentences. Cover liquidity, security, and ownership. Plain text only, no markdown.',
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

    // LP control using pre-fetched LP holder data (no sequential blocking)
    const _lpHoldersForControl = (_lpHoldersSettled.status === 'fulfilled' ? _lpHoldersSettled.value : { __status: 'error', __reason: 'lp_fetch_failed' }) as any
    const _lpAddrSnippet = lpPoolAddress ? `${lpPoolAddress.slice(0, 10)}…${lpPoolAddress.slice(-4)}` : "none";
    const lpPair = lpPool?.pairName ?? `${lpPool?.baseTokenSymbol ?? "?"}/${lpPool?.quoteTokenSymbol ?? "?"}`;
    const marketPair = pairName ?? "unknown";
    const _lpBaseDiagnostics = [
      `Verification pool: ${lpPair}`,
      `Pool type: ${lpPoolType}`,
      `DEX metadata: ${lpPool?.hasDexMeta ? (lpPool.dexId ?? lpPool.dexName ?? "available") : "unavailable"}`,
    ];
    let lpControl: LpControlResult = {
      status: "unverified",
      confidence: "low",
      poolType: lpPoolType,
      source: "geckoterminal",
      reason: "LP control requires holder-level LP token verification.",
      evidence: _lpBaseDiagnostics,
      poolAddressPresent: Boolean(lpPoolAddress),
      dexId: dexId || undefined,
      dexName: dexName || undefined,
      lpVerificationPoolReason: selectedPrimaryPoolSource,
    };
    if (!lpPoolAddressPresent) {
      lpControl = { ...lpControl, status: "unverified", reason: "No pool address found from provider for LP-holder verification." };
    } else if (lpPoolType === "v3" || lpPoolType === "aerodrome" || lpPoolType === "concentrated") {
      lpControl = {
        status: "unsupported",
        confidence: "low",
        poolType: lpPoolType,
        source: "geckoterminal",
        reason: "Pool uses concentrated/protocol liquidity; LP lock requires protocol-specific verification.",
        evidence: [`pool=${primaryPoolAddress}`, `dex=${dexId ?? dexName ?? "unknown"}`, `poolType=${lpPoolType}`],
      };
    } else if (lpPoolType === "unknown") {
      // Probe pool via RPC to classify before giving up
      const probe = await probePoolTypeViaRpc(chain, lpPoolAddress!);
      if (probe.v2Like) {
        // Pool behaves like V2 — run Alchemy burn/locker check directly
        const confidenceFor = (pct: number): "high" | "medium" | "low" => pct >= 80 ? "high" : pct >= 50 ? "medium" : "low";
        const DEAD = new Set(["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dead"]);
        const KNOWN_LOCKERS = new Set(["0x663a5c229c09b049e36dcca11a9d0d4a0f33f3f9", "0x71b5759d73262fbb223956913ecf4ecc51057641"]);
        const totalSupplyHex = await rpcCall(chain, "eth_call", [{ to: lpPoolAddress!, data: "0x18160ddd" }, "latest"]);
        const totalSupply = totalSupplyHex ? Number(BigInt(totalSupplyHex)) : null;
        if (!totalSupply || totalSupply <= 0) {
          lpControl = { status: "unverified", confidence: "low", poolType: "v2", source: "geckoterminal+alchemy_rpc", reason: "Pool probed as V2-like but RPC totalSupply read is unavailable.", evidence: [`Verification pool: ${lpPair}`, "RPC probe: V2-like interface detected"], poolAddressPresent: true, probeV2Like: true, probeV3Like: false, dexId: dexId || undefined };
        } else {
          const readPct = async (addr: string) => {
            const data = `0x70a08231${pad32HexAddress(addr)}`;
            const balHex = await rpcCall(chain, "eth_call", [{ to: lpPoolAddress!, data }, "latest"]);
            if (!balHex) return 0;
            return (Number(BigInt(balHex)) / totalSupply) * 100;
          };
          const [burn0, burnDead, _lockerPcts] = await Promise.all([
            readPct("0x0000000000000000000000000000000000000000"),
            readPct("0x000000000000000000000000000000000000dEaD"),
            Promise.all([...KNOWN_LOCKERS].map(readPct)),
          ]);
          const burnShare = burn0 + burnDead;
          const lockerShare = _lockerPcts.reduce((a: number, b: number) => a + b, 0);
          const base = { poolType: "v2" as const, source: "geckoterminal+alchemy_rpc", poolAddressPresent: true, probeV2Like: true, probeV3Like: false, dexId: dexId || undefined };
          if (burnShare >= 50) {
            lpControl = { ...base, status: "burned", confidence: confidenceFor(burnShare), reason: "Dominant LP share appears in burn/dead balances via RPC.", evidence: [`burn_share=${burnShare.toFixed(2)}%`, `pool=${_lpAddrSnippet}`] };
          } else if (lockerShare >= 50) {
            lpControl = { ...base, status: "locked", confidence: confidenceFor(lockerShare), reason: "Dominant LP share appears in known locker balances via RPC.", evidence: [`locker_share=${lockerShare.toFixed(2)}%`, `pool=${_lpAddrSnippet}`] };
          } else {
            lpControl = { ...base, status: "unverified", confidence: "low", reason: "RPC balances do not prove burned/locked LP dominance.", evidence: [`burn_share=${burnShare.toFixed(2)}%`, `locker_share=${lockerShare.toFixed(2)}%`, `pool=${_lpAddrSnippet}`] };
          }
        }
      } else if (probe.v3Like) {
        lpControl = { status: "unsupported", confidence: "low", poolType: "v3", source: "geckoterminal+alchemy_rpc", reason: "Pool probed as concentrated-liquidity (V3-like); LP lock requires protocol-specific verification.", evidence: [`Verification pool: ${lpPair}`, "RPC probe: concentrated-liquidity interface detected"], poolAddressPresent: true, probeV2Like: false, probeV3Like: true, dexId: dexId || undefined };
      } else {
        lpControl = { status: "unverified", confidence: "low", poolType: "unknown", source: "geckoterminal+alchemy_rpc", reason: "Pool address found, but no standard V2/V3 LP interface was confirmed.", evidence: [`Verification pool: ${lpPair}`, "Pool type: unknown", `DEX metadata: ${lpPool?.hasDexMeta ? (lpPool.dexId ?? lpPool.dexName ?? "available") : "unavailable"}`, "RPC probe: no V2/V3 interface confirmed"], poolAddressPresent: true, probeV2Like: false, probeV3Like: false, dexId: dexId || undefined };
      }
    } else {
      // V2 — run GoldRush LP holder check
      const confidenceFor = (pct: number): "high" | "medium" | "low" => pct >= 80 ? "high" : pct >= 50 ? "medium" : "low";
      const DEAD = new Set(["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dead"]);
      const KNOWN_LOCKERS = new Set<string>(["0x663a5c229c09b049e36dcca11a9d0d4a0f33f3f9", "0x71b5759d73262fbb223956913ecf4ecc51057641"]);
      const lpItems = Array.isArray(_lpHoldersForControl?.data?.items) ? _lpHoldersForControl.data.items as Array<Record<string, unknown>> : [];
      const top = lpItems.slice(0, 5).map((h) => ({
        address: String(h.address ?? h.holder_address ?? h.wallet_address ?? "").toLowerCase(),
        pct: toNum(h.percentage) ?? toNum(h.percent) ?? toNum(h.ownership_percentage) ?? 0,
      })).filter((x) => /^0x[a-f0-9]{40}$/.test(x.address));
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
        const totalSupplyHex = await rpcCall(chain, "eth_call", [{ to: lpPoolAddress!, data: "0x18160ddd" }, "latest"]);
        const totalSupply = totalSupplyHex ? Number(BigInt(totalSupplyHex)) : null;
        if (!totalSupply || totalSupply <= 0) {
          lpControl = { status: "unverified", confidence: "low", poolType: lpPoolType, source: "geckoterminal+alchemy_rpc", reason: "LP holder percentages unavailable; RPC totalSupply read is unavailable.", evidence: [`pool=${primaryPoolAddress}`] };
        } else {
          const readPct = async (addr: string) => {
            const data = `0x70a08231${pad32HexAddress(addr)}`;
            const balHex = await rpcCall(chain, "eth_call", [{ to: lpPoolAddress!, data }, "latest"]);
            if (!balHex) return 0;
            return (Number(BigInt(balHex)) / totalSupply) * 100;
          };
          const [burn0, burnDead, _lockerPcts] = await Promise.all([
            readPct("0x0000000000000000000000000000000000000000"),
            readPct("0x000000000000000000000000000000000000dEaD"),
            Promise.all([...KNOWN_LOCKERS].map(readPct)),
          ]);
          const burnShare = burn0 + burnDead;
          const lockerShare = _lockerPcts.reduce((a: number, b: number) => a + b, 0);
          if (burnShare >= 50) {
            lpControl = { status: "burned", confidence: confidenceFor(burnShare), poolType: lpPoolType, source: "geckoterminal+alchemy_rpc", reason: "Dominant LP share appears in burn/dead balances via RPC.", evidence: [`burn_share=${burnShare.toFixed(2)}%`] };
          } else if (lockerShare >= 50) {
            lpControl = { status: "locked", confidence: confidenceFor(lockerShare), poolType: lpPoolType, source: "geckoterminal+alchemy_rpc", reason: "Dominant LP share appears in known locker balances via RPC.", evidence: [`locker_share=${lockerShare.toFixed(2)}%`] };
          } else {
            lpControl = { status: "unverified", confidence: "low", poolType: lpPoolType, source: "geckoterminal+alchemy_rpc", reason: "RPC balances do not prove burned/locked LP dominance.", evidence: [`burn_share=${burnShare.toFixed(2)}%`, `locker_share=${lockerShare.toFixed(2)}%`] };
          }
        }
      } else {
        lpControl = { status: "unverified", confidence: "low", poolType: lpPoolType, source: "geckoterminal+goldrush", reason: "LP holder distribution does not prove burned/locked/team control.", evidence: [`top_rows=${top.length}`] };
      }
    }

    lpControl.evidence = [
      ...(lpControl.evidence ?? []),
      `Market primary pair: ${marketPair}`,
      `LP verification pair: ${lpPair}`,
      `LP verification pool address: ${lpPoolAddress ?? 'unavailable'}`,
      `LP verification reason: ${selectedLpPool.reason}`,
      `lpHolderCheckAttempted=${needsLpHolderFetch}`,
    ];

    // AI summary from parallel phase 2
    let aiSummary = "Unverified on Base — insufficient data for a risk verdict.";
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
    const topHolders = holderItems.slice(0, 200).map((h: any, i: number) => {
      const address = h.address || h.holder_address || h.wallet_address || h.owner_address || h.contract_address || ''
      // Prefer raw string balances for BigInt math; also accept numeric fields
      const balanceRaw = h.balance ?? h.token_balance ?? h.amount ?? null
      const amount = toNum(balanceRaw) ?? toNum(h.balance_quote) ?? null
      // Prefer explicit percent fields; fall back to BigInt division of balance/total_supply
      const pctRaw = toNum(h.percentage) ?? toNum(h.percent) ?? toNum(h.ownership_percentage) ?? toNum(h.percent_of_supply) ?? toNum(h.share) ?? toNum(h.supply_percentage)
      const supplyRaw = h.total_supply ?? h.circulating_supply ?? goldrush?.data?.items?.[0]?.total_supply ?? gtToken?.total_supply ?? gtToken?.circulating_supply ?? null
      const percent = pctRaw != null
        ? pctRaw
        : bigIntPct(balanceRaw, supplyRaw)
          ?? (amount != null && toNum(supplyRaw) != null ? (amount / toNum(supplyRaw)!) * 100 : null)
      return { rank: i + 1, address, amount, percent }
    }).filter((h: any) => h.address)

    const hasPct = topHolders.some((h: any) => h.percent != null)
    console.log('[holders] normalized length', topHolders.length, '[holders] percent available', hasPct)
    const sum = (n: number) => topHolders.slice(0, n).reduce((acc: number, h: any) => acc + (h.percent ?? 0), 0)
    const top1 = hasPct ? sum(1) : null
    const top5 = hasPct ? sum(5) : null
    const top10 = hasPct ? sum(10) : null
    const top20 = hasPct ? sum(20) : null
    const normalizedTop = topHolders.slice(0, 200)
    const holderDistribution: HolderDistribution | null = normalizedTop.length ? { top1, top5, top10, top20, others: hasPct && top20 != null ? Math.max(0, 100 - top20) : null, holderCount, topHolders: normalizedTop } : null
    const holderDistributionStatus = holderDistribution
      ? (hasPct
          ? { source: 'goldrush', status: 'ok', itemCount: holderItems.length, normalizedCount: normalizedTop.length }
          : { source: 'goldrush', status: 'empty', reason: 'no_percentages', itemCount: holderItems.length, normalizedCount: normalizedTop.length })
      : (holderItems.length
          ? { source: 'goldrush', status: 'empty', reason: 'no_rows', itemCount: holderItems.length, normalizedCount: 0 }
          : { source: 'unavailable', status: (holdersRaw?.__status ?? 'empty'), reason: (holdersRaw?.__reason ?? 'no_rows'), itemCount: 0, normalizedCount: 0 })

    const poolAttr = mainPool?.attributes ?? {}
    // True market cap priority:
    // 1) GeckoTerminal token endpoint attributes.market_cap_usd
    // 2) explicit market cap fields from token metadata responses (never FDV fields)
    const tokenEndpointMarketCap = toNum(gtToken?.market_cap_usd)
    const metadataMarketCap = pickNum(gtToken?.market_cap, gtToken?.marketCap, gtToken?.market_cap_in_usd, goldItem?.market_cap, metaItem?.market_cap)
    const marketCapFromGt = (tokenEndpointMarketCap != null && tokenEndpointMarketCap > 0)
      ? tokenEndpointMarketCap
      : (metadataMarketCap != null && metadataMarketCap > 0 ? metadataMarketCap : null)
    const poolEndpointMarketCapPresent = toNum(poolAttr.market_cap_usd) != null;
    const circulatingSupply = pickNum(gtToken?.circulating_supply, goldItem?.circulating_supply, gmgnItem?.circulating_supply)
    const tokenPrice = pickNum(poolAttr.base_token_price_usd, gtToken?.price_usd, gtToken?.price)
    const marketCapSource = marketCapFromGt != null ? 'geckoterminal' : 'unavailable'
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
          estimatedMarketCapReason = `Estimated from price × onchain totalSupply${burned > BigInt(0) ? ' minus burn balances' : ''}. Circulating supply not provider-verified.`
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
      displayMarketValueReason = 'Provider-backed market_cap_usd from GeckoTerminal.'
    } else if (estimatedMarketCap != null) {
      displayMarketValue = estimatedMarketCap
      displayMarketValueLabel = 'Estimated MC'
      displayMarketValueConfidence = estimatedMarketCapConfidence
      displayMarketValueReason = estimatedMarketCapReason
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
    const poolCount = matchingPools.length
    if (process.env.NODE_ENV === "development") {
      console.log('[gt-market] contract', contract, '[gt-market] token status', gtTokenInfo ? 'ok' : 'empty', '[gt-market] pools count', matchingPools.length, '[gt-market] tokenEndpointMarketCapPresent', tokenEndpointMarketCap != null && tokenEndpointMarketCap > 0, '[gt-market] poolEndpointMarketCapPresent', poolEndpointMarketCapPresent, '[gt-market] marketCap available', marketCapFromGt != null, '[gt-market] fdv available', fdv != null)
    }
    // Optional GoPlus data — only used if already present and Honeypot.is is unavailable.
    // GoPlus is not a core ChainLens security provider; treat its data as low-confidence fallback only.
    const gpResultObj = (gpRaw as Record<string, unknown>)?.result as Record<string, unknown> ?? {};
    const gpToken = gpResultObj[contract.toLowerCase()] as Record<string, unknown> ?? {};
    const gpHasData = Object.keys(gpToken).length > 0;
    const gpHoneypot = gpHasData ? {
      isHoneypot:        gpToken.is_honeypot != null ? String(gpToken.is_honeypot) === "1" : null,
      buyTax:            gpToken.buy_tax != null && gpToken.buy_tax !== "" ? Number(gpToken.buy_tax) : null,
      sellTax:           gpToken.sell_tax != null && gpToken.sell_tax !== "" ? Number(gpToken.sell_tax) : null,
      transferTax:       gpToken.transfer_tax != null && gpToken.transfer_tax !== "" ? Number(gpToken.transfer_tax) : null,
      simulationSuccess: null as boolean | null,
    } : null;

    // Final JSON response
    const marketStatus: "ok" | "partial" | "unavailable" | "error" =
      (priceUsd != null && liquidityUsd != null && volume24hUsd != null) ? "ok" :
      (priceUsd != null || liquidityUsd != null || volume24hUsd != null || fdv != null) ? "partial" : "unavailable";
    const marketReason = marketStatus === "ok" ? null
      : marketCapFromGt == null ? "unavailable_circulating_supply_not_verified"
      : "partial_market_fields_from_provider";
    const securityStatus: "ok" | "partial" | "unavailable" | "error" =
      hpResult.ok ? "ok" : gpHasData ? "partial" : "unavailable";
    const securityReason = hpResult.ok ? null : (gpHasData ? "honeypot_provider_unavailable_using_limited_fallback" : "honeypot_simulation_unavailable_from_provider");
    const holdersStatus: "ok" | "partial" | "unavailable" | "error" =
      holderDistribution && hasPct ? "ok" :
      holderDistribution ? "partial" :
      (holdersRaw?.__status === "error" ? "error" : "unavailable");
    const holdersReason = holdersStatus === "ok" ? null : (holderDistributionStatus?.reason ?? "holder_data_unavailable");
    const liquidityStatus: "ok" | "partial" | "unavailable" | "error" =
      mainPool ? "ok" : (matchingPools.length > 0 ? "partial" : "unavailable");
    const liquidityReason = mainPool ? null : "no_active_liquidity_pool_found";
    const ownerCall = await rpcCall(chain, 'eth_call', [{ to: contract, data: '0x8da5cb5b' }, 'latest'])
    const ownerAddr = ownerCall && ownerCall.length >= 42 ? `0x${ownerCall.slice(-40)}`.toLowerCase() : null
    const rpcSupply = await rpcCall(chain, 'eth_call', [{ to: contract, data: '0x18160ddd' }, 'latest'])
    const rpcDecimalsHex = await rpcCall(chain, 'eth_call', [{ to: contract, data: '0x313ce567' }, 'latest'])
    const rpcName = await rpcTokenString(chain, contract, '0x06fdde03')
    const rpcSymbol = await rpcTokenString(chain, contract, '0x95d89b41')

    const bytecodeStatus = bytecode && bytecode !== '0x' ? 'ok' : 'unavailable'
    const ownerStatus = ownerAddr ? 'ok' : 'unavailable'
    const mintStatus = gpToken?.is_mintable != null ? 'ok' : 'unavailable'
    const proxyStatus = gpToken?.is_proxy != null ? 'ok' : 'unavailable'
    const transferControlStatus = (hpResult.ok || gpHasData) ? 'partial' : 'unavailable'
    const contractChecksStatus: "ok" | "partial" | "unavailable" | "error" =
      bytecodeStatus === 'ok' && (ownerStatus === 'ok' || mintStatus === 'ok' || proxyStatus === 'ok') ? 'partial' : (bytecodeStatus === 'ok' ? 'partial' : 'unavailable')
    const contractChecksReason = contractChecksStatus === 'unavailable'
      ? 'Unavailable from current checks.'
      : 'Alchemy bytecode/supply/owner checks plus available security flags.'

    const responsePayload = {
      chain,
      contract,

      // Core token fields
      name: resolvedName,
      symbol: resolvedSymbol,
      decimals: resolvedDecimals,

      // Pool state
      noActivePools,

      // Extra data
      holders: goldrush?.holders || null,
      holderDistribution,
      holderDistributionStatus,
      ...(process.env.NODE_ENV !== 'production' || debugHolder === true ? {
        debugHolderStatus: {
          providerCalled: holdersRaw?.__status !== 'unavailable',
          chain: 'base-mainnet',
          endpointPath: holdersRaw?.__endpointPath ?? `/v1/base-mainnet/tokens/${contract}/token_holders_v2/`,
          authMode: 'bearer',
          hasGoldrushKey: Boolean(process.env.GOLDRUSH_API_KEY),
          hasCovalentKey: Boolean(process.env.COVALENT_API_KEY),
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
      priceUsd,
      liquidityUsd,
      volume24hUsd,
      poolCount,
      // Legacy pool-level field kept for frontend pair display
      liquidity: mainPool?.attributes?.reserve_in_usd ?? null,
      market_cap: marketCapFromGt,
      marketCapUsd: marketCapFromGt,
      marketCapStatus: marketCapFromGt != null ? 'ok' : 'unavailable_circulating_supply_not_verified',
      marketCapSource,
      circulating_supply: circulatingSupply,
      fdv,
      fdvUsd: fdv,
      fdvSource,
      displayMarketValue,
      displayMarketValueLabel,
      displayMarketValueConfidence,
      displayMarketValueReason,
      estimatedMarketCap,
      estimatedMarketCapConfidence,
      estimatedMarketCapReason,

      pairs: matchingPools,
      gtPools: matchingPools,
      gtRaw: gtData || null,

      gmgn: gmgn?.data || null,

      // GoPlus security data — keyed by lowercase contract address
      goplus: (gpRaw as Record<string, unknown>)?.result ?? null,

      // Internal diagnostics
      _diagnostics: {
        marketPrimaryPair: marketPair,
        lpVerificationPair: lpPair,
        lpVerificationPoolAddress: lpPoolAddress,
        lpVerificationPoolReason: selectedLpPool.reason,
        providerUsed: { market: 'geckoterminal', holders: 'goldrush', security: hpResult.ok ? 'honeypot.is' : (gpHasData ? 'goplus_limited_fallback' : 'unavailable'), contractChecks: 'alchemy_rpc', liquidity: lpControl.source ?? 'geckoterminal' },
        tokenMarketFieldsPresent: {
          priceUsd: priceUsd != null,
          liquidityUsd: liquidityUsd != null,
          volume24hUsd: volume24hUsd != null,
          marketCapUsd: marketCapFromGt != null,
          tokenEndpointMarketCapPresent: tokenEndpointMarketCap != null && tokenEndpointMarketCap > 0,
          poolEndpointMarketCapPresent,
          fdvUsd: fdv != null,
          poolCount: poolCount > 0,
        },
        missingReasons: [
          priceUsd == null ? 'priceUsd: no pool price' : '',
          liquidityUsd == null ? 'liquidityUsd: no pool reserve' : '',
          volume24hUsd == null ? 'volume24hUsd: no pool volume' : '',
          marketCapFromGt == null ? 'marketCapUsd: not in GT token response' : '',
          fdv == null ? 'fdvUsd: not in GT token or pool response' : '',
        ].filter(Boolean),
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
        honeypotProvider: hpResult.ok ? "ok" : (gpHasData ? "optional_fallback_goplus" : hpResult.honeypotProvider),
        honeypotSource:   hpResult.ok ? "honeypot.is" : (gpHasData ? "goplus_optional_fallback" : "unavailable"),
        honeypotChecked:  true,
      },

      // Contract analysis
      analysis,
      lpControl,

      // AI summary from Cortex Engine
      aiSummary,

      // Token info object for frontend panels
      tokenInfo: {
        name: resolvedName,
        symbol: resolvedSymbol,
        decimals: resolvedDecimals,
      },
      sections: {
        market: {
          status: marketStatus,
          reason: marketReason,
          source: "geckoterminal",
          price: priceUsd,
          liquidity: liquidityUsd,
          volume24h: volume24hUsd,
          change24h: pickNum((poolAttr.price_change_percentage as Record<string, unknown> | undefined)?.h24),
          marketCap: marketCapFromGt,
          fdv,
        },
        security: {
          status: securityStatus,
          reason: securityReason,
          source: hpResult.ok ? "honeypot.is" : (gpHasData ? "goplus_limited_fallback" : "unavailable"),
          honeypot: hpResult.ok ? hpResult.honeypot : null,
          buyTax: hpResult.ok ? hpResult.buyTax : null,
          sellTax: hpResult.ok ? hpResult.sellTax : null,
          simulationSuccess: hpResult.ok ? hpResult.simulationSuccess : null,
        },
        holders: {
          status: holdersStatus,
          reason: holdersReason,
          source: "goldrush",
          holderCount: holderCount ?? null,
          top1, top5, top10, top20,
        },
        liquidity: {
          status: liquidityStatus,
          reason: liquidityReason,
          source: "geckoterminal",
          poolCount: matchingPools.length,
          primaryPair: mainPool?.attributes?.name ?? null,
          liquidityDepth: liquidityUsd,
          lpControl,
        },
        contractChecks: {
          status: contractChecksStatus,
          reason: contractChecksReason,
          source: "alchemy_rpc",
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
      ;(responsePayload as any)._timing = { totalMs: _totalMs }
    }
    tokenResponseCache.set(cacheKey, { exp: Date.now() + TOKEN_CACHE_TTL_MS, payload: responsePayload })
    return NextResponse.json(responsePayload)
  } catch (err) {
    console.error("Fatal backend error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
