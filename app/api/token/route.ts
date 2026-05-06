/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { fetchHoneypotSecurity } from "@/lib/server/honeypotSecurity";

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
function getPlan(req: Request): 'free' | 'pro' | 'elite' {
  const raw = (req.headers.get('x-user-plan') ?? '').toLowerCase()
  if (raw === 'elite') return 'elite'
  if (raw === 'pro') return 'pro'
  return 'free'
}
function checkRate(req: Request): boolean {
  const ip = getClientIp(req)
  const plan = getPlan(req)
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
    });
    const json = await res.json();
    return json?.result || null;
  } catch (err) {
    console.error(`Error fetching bytecode on ${chain}:`, err);
    return null;
  }
}

async function fetchGoldRush(chain: ChainKey, contract: string): Promise<any> {
  try {
    const res = await fetch(
      `https://api.covalenthq.com/v1/${chain}/tokens/${contract}/?key=${process.env.COVALENT_API_KEY}`
    );
    return res.ok ? await res.json() : null;
  } catch (err) {
    console.error("Error fetching GoldRush:", err);
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
      { cache: 'no-store' }
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
    const res = await fetch(`https://api.gmgn.ai/token/${contract}`);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function fetchTokenMetadata(chain: ChainKey, contract: string): Promise<any> {
  try {
    const res = await fetch(
      `https://api.covalenthq.com/v1/${chain}/address/0x0000000000000000000000000000000000000000/balances_v2/?key=${process.env.COVALENT_API_KEY}&contract-address=${contract}`
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
  if (!checkRate(req)) return NextResponse.json({ error: "Rate limit reached. Try again shortly." }, { status: 429 })

  try {
    console.log("🚀 SCAN ROUTE HIT");

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

    const analysis = analyzeContract(bytecode);

    // GeckoTerminal /tokens/{contract}/pools returns pools for this token directly
    const gtAllPools: any[] = Array.isArray(gtData?.data) ? gtData.data : [];

    // Sort by liquidity descending, pick the deepest pool as main
    const matchingPools = [...gtAllPools].sort(
      (a, b) =>
        parseFloat(b.attributes?.reserve_in_usd || "0") -
        parseFloat(a.attributes?.reserve_in_usd || "0")
    );

    const mainPool = matchingPools[0] ?? null;
    const noActivePools = matchingPools.length === 0;

    // ------------------------------
    // REAL CLAUDE AI SUMMARY
    // ------------------------------
    const aiPrompt = `
You are the Cortex Engine of ChainLens AI.
Summarize this token in 3–4 sentences.
Focus on risks, liquidity, ownership, and suspicious functions.
Output plain text only, no markdown, no tables.
If critical data is missing (no pools, missing security), do NOT speculate and state that the token is unverified.

CHAIN: ${chain}
CONTRACT: ${contract}
GECKOTERMINAL POOLS:
${JSON.stringify(matchingPools.slice(0, 3), null, 2)}
GOLDRUSH:
${JSON.stringify(goldrush, null, 2)}
BYTECODE ANALYSIS:
${JSON.stringify(analysis, null, 2)}
`;

    const hasSecurityData = Boolean((gpRaw as Record<string, unknown>)?.result || hpResult.ok);
    let aiSummary = "Unverified on Base — insufficient data for a risk verdict.";

    if (!noActivePools || hasSecurityData) {
      try {
        const aiResponse = await anthropic.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 1100,
          messages: [{ role: "user", content: aiPrompt }],
        });
        console.log("AI response:", aiResponse);
        aiSummary =
          (aiResponse?.content?.[0]?.type === "text" ? aiResponse.content[0].text : null) ||
          aiSummary;
      } catch (err) {
        console.error("AI summary error:", err);
      }
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
    const gtIncluded: any[] = Array.isArray(gtData?.included) ? gtData.included : [];
    const matchingTokenEntry = gtIncluded.find((i: any) =>
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
    // True market cap only from the GT token endpoint — pool market_cap_usd may be FDV-derived
    const marketCapFromGt = pickNum(
      gtToken?.market_cap_usd, gtToken?.market_cap, gtToken?.marketCap, gtToken?.market_cap_in_usd
    )
    const circulatingSupply = pickNum(gtToken?.circulating_supply, goldItem?.circulating_supply, gmgnItem?.circulating_supply)
    const tokenPrice = pickNum(poolAttr.base_token_price_usd, gtToken?.price_usd, gtToken?.price)
    const marketCapSource = marketCapFromGt != null ? 'geckoterminal' : 'unavailable'
    const fdv = pickNum(gtToken?.fdv_usd, gtToken?.fdv, gtToken?.fully_diluted_valuation, poolAttr.fdv_usd, poolAttr.fdv, mainPool?.fdv_usd, goldItem?.fully_diluted_value, gmgnItem?.fdv)
    const fdvSource = fdv != null ? 'geckoterminal' : 'unavailable'
    const priceUsd = tokenPrice
    // Tier B: onchain estimated MC when true MC is missing and price is known
    let estimatedMarketCap: number | null = null
    let estimatedMarketCapConfidence: 'medium' | 'low' = 'low'
    let estimatedMarketCapReason = ''
    if (marketCapFromGt == null && priceUsd != null) {
      const onchain = await fetchOnchainSupply(chain, contract)
      if (onchain.totalSupply != null) {
        const decimalsNum = typeof resolvedDecimals === 'number' ? resolvedDecimals : (Number(resolvedDecimals) || 18)
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
    console.log('[gt-market] contract', contract, '[gt-market] token status', gtTokenInfo ? 'ok' : 'empty', '[gt-market] pools count', matchingPools.length, '[gt-market] marketCap available', marketCapFromGt != null, '[gt-market] fdv available', fdv != null)
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
      marketCapStatus: marketCapFromGt != null ? 'ok' : 'unavailable',
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
        tokenMarketFieldsPresent: {
          priceUsd: priceUsd != null,
          liquidityUsd: liquidityUsd != null,
          volume24hUsd: volume24hUsd != null,
          marketCapUsd: marketCapFromGt != null,
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

      // AI summary from Cortex Engine
      aiSummary,

      // Token info object for frontend panels
      tokenInfo: {
        name: resolvedName,
        symbol: resolvedSymbol,
        decimals: resolvedDecimals,
      },
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
