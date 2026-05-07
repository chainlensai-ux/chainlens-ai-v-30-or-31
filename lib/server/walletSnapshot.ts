type Holding = {
  contract?: string
  name: string
  symbol: string
  icon: string | null
  chain: string | null
  balance: number
  value: number
  price: number | null
  change24h: number | null
  verified: boolean
}

export type WalletBehavior = {
  status: 'ok' | 'partial' | 'unavailable'
  source: 'alchemy' | 'unavailable'
  txCount: number | null
  activeDays: number | null
  topTokens: string[]
  topContracts: string[]
  inboundCount: number | null
  outboundCount: number | null
  stablecoinActivity: boolean
  recentActivitySummary: string
  reason: string
}

export type WalletSnapshot = {
  address: string
  totalValue: number
  holdings: Holding[]
  txCount: number | null
  firstTxDate: string | null
  walletAgeDays: number | null
  providerUsed: 'zerion' | 'goldrush' | 'none'
  providerStatus: 'ok' | 'partial' | 'failed'
  holdingsCount: number
  totalUsdAvailable: boolean
  reason: string
  portfolioSource: 'zerion' | 'goldrush' | 'none'
  behaviorSource: 'alchemy' | 'unavailable'
  behaviorChain: 'base'
  pnlSource: 'goldrush' | 'alchemy' | 'unavailable'
  pnlCoverageReason: string
  hiddenDustCount: number
  unpricedHoldingsCount: number
  walletBehavior: WalletBehavior
  estimatedPnl: {
    status: 'ok' | 'partial' | 'unavailable' | 'error'
    confidence: 'high' | 'medium' | 'low' | null
    coveragePercent: number
    source: 'goldrush' | 'alchemy' | 'none'
    totalEstimatedPnlUsd: number | null
    unrealizedPnlUsd: number | null
    realizedPnlUsd: number | null
    method: 'average_cost_estimate'
    tokens: Array<{
      symbol: string
      contract: string
      currentValueUsd: number
      estimatedCostBasisUsd: number | null
      estimatedUnrealizedPnlUsd: number | null
      estimatedRealizedPnlUsd: number | null
      buysDetected: number
      sellsDetected: number
      unexplainedTransfers: number
      coveragePercent: number
      confidence: 'high' | 'medium' | 'low'
      reason: string
    }>
    reason: string
  }
  _diagnostics?: {
    walletProviderFieldsPresent: {
      holdings: boolean
      totalValue: boolean
      txCount: boolean
      walletAgeDays: boolean
    }
    missingReasons: string[]
    goldrushTransferDiags?: GrTransferDiag[]
  }
}

const ZERION_KEY       = process.env.ZERION_KEY ?? ''
const ALCHEMY_ETH_KEY  = process.env.ALCHEMY_ETHEREUM_KEY!
const ALCHEMY_BASE_KEY = process.env.ALCHEMY_BASE_KEY!
const GOLDRUSH_KEY     = process.env.GOLDRUSH_API_KEY ?? process.env.COVALENT_API_KEY ?? ''

function zerionAuth(): string | null {
  if (!ZERION_KEY) return null
  return `Basic ${Buffer.from(`${ZERION_KEY}:`).toString('base64')}`
}

async function zerionGet(path: string, params: Record<string, string> = {}) {
  const auth = zerionAuth()
  if (!auth) throw new Error('Zerion key not configured')
  const url = new URL(`https://api.zerion.io/v1/${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url.toString(), {
    headers: { Accept: 'application/json', Authorization: auth },
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Zerion ${res.status} ${path}`)
  return res.json()
}

async function alchemyRpc(url: string, method: string, params: unknown[]) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }),
    cache: 'no-store',
    signal: AbortSignal.timeout(8_000),
  })
  const json = await res.json()
  return json.result ?? null
}

async function getFirstTxOnChain(address: string, alchemyUrl: string): Promise<Date | null> {
  const baseParams = {
    fromBlock: '0x0',
    category: ['external', 'internal', 'erc20'],
    withMetadata: true,
    maxCount: '0x1',
    order: 'asc',
  }
  const [sent, received] = await Promise.allSettled([
    alchemyRpc(alchemyUrl, 'alchemy_getAssetTransfers', [{ ...baseParams, fromAddress: address }]),
    alchemyRpc(alchemyUrl, 'alchemy_getAssetTransfers', [{ ...baseParams, toAddress: address }]),
  ])
  const dates: Date[] = []
  for (const r of [sent, received]) {
    const ts = r.status === 'fulfilled' && r.value?.transfers?.[0]?.metadata?.blockTimestamp
    if (ts) dates.push(new Date(ts as string))
  }
  return dates.length > 0 ? new Date(Math.min(...dates.map(d => d.getTime()))) : null
}

async function fetchGoldrushBalances(address: string, chainName: string, apiKey: string): Promise<Holding[]> {
  try {
    const url = `https://api.covalenthq.com/v1/${chainName}/address/${address}/balances_v2/?no-spam=true&no-nft-fetch=true`
    const res = await fetch(url, {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return []
    const json = await res.json()
    if (json?.error) return []
    const items: unknown[] = Array.isArray(json?.data?.items) ? json.data.items : []
    const chainShort = chainName.replace(/-mainnet$/, '')
    return items
      .map((item) => {
        const it = item as Record<string, unknown>
        const decimals = typeof it.contract_decimals === 'number' ? it.contract_decimals : 18
        const rawBal = String(it.balance ?? '0')
        const balance = parseFloat(rawBal) / Math.pow(10, decimals)
        const value = typeof it.quote === 'number' ? it.quote : 0
        const price = typeof it.quote_rate === 'number' && it.quote_rate > 0 ? it.quote_rate : null
        const logo = typeof it.logo_url === 'string' && it.logo_url.startsWith('http') ? it.logo_url : null
        return {
          contract: typeof it.contract_address === 'string' ? it.contract_address.toLowerCase() : undefined,
          name: typeof it.contract_name === 'string' ? it.contract_name : 'Unknown',
          symbol: typeof it.contract_ticker_symbol === 'string' ? it.contract_ticker_symbol : '?',
          icon: logo,
          chain: chainShort,
          balance,
          value,
          price,
          change24h: null,
          verified: it.is_spam === false,
        } as Holding
      })
      .filter(h => h.value > 0.01)
  } catch {
    return []
  }
}

type PnlEvent = { contract: string; symbol: string; direction: 'buy' | 'sell' | 'unknown'; amount: number; usdValue: number | null }

type GrTransferDiag = {
  endpointKind: 'transfers_v2'
  chainUsed: string
  urlTemplate: string
  httpStatus: number | null
  fetchFailed: boolean
  failureStage: 'build_url' | 'fetch' | 'timeout' | 'parse' | 'empty_response' | 'no_items' | null
  rawItemCount: number
  normalizedEventCount: number
  firstEventShapeKeys: string[]
  reason: string
}

async function fetchGoldrushPnlEvents(address: string, chainName: string, apiKey: string): Promise<{ events: PnlEvent[]; diag: GrTransferDiag }> {
  const chainId = chainName === 'base-mainnet' ? '8453' : chainName === 'eth-mainnet' ? '1' : chainName
  const urlTemplate = `https://api.covalenthq.com/v1/${chainName}/address/{address}/transfers_v2/?quote-currency=USD&page-size=125&no-spam=true`
  const diag: GrTransferDiag = {
    endpointKind: 'transfers_v2',
    chainUsed: chainId,
    urlTemplate,
    httpStatus: null,
    fetchFailed: false,
    failureStage: null,
    rawItemCount: 0,
    normalizedEventCount: 0,
    firstEventShapeKeys: [],
    reason: '',
  }
  try {
    const url = `https://api.covalenthq.com/v1/${chainName}/address/${address}/transfers_v2/?quote-currency=USD&page-size=125&no-spam=true`
    let res: Response
    try {
      res = await fetch(url, { cache: 'no-store', headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000) })
    } catch (fetchErr) {
      diag.fetchFailed = true
      diag.failureStage = fetchErr instanceof Error && fetchErr.name === 'TimeoutError' ? 'timeout' : 'fetch'
      diag.reason = 'GoldRush wallet history request failed before response.'
      return { events: [], diag }
    }
    diag.httpStatus = res.status
    if (!res.ok) {
      diag.failureStage = 'empty_response'
      diag.reason = `GoldRush wallet history returned HTTP ${res.status}.`
      return { events: [], diag }
    }
    let json: unknown
    try {
      json = await res.json()
    } catch {
      diag.failureStage = 'parse'
      diag.reason = 'GoldRush wallet history response could not be parsed as JSON.'
      return { events: [], diag }
    }
    const raw = json as Record<string, unknown>
    const items: unknown[] =
      Array.isArray((raw?.data as Record<string, unknown> | undefined)?.items) ? ((raw.data as Record<string, unknown>).items as unknown[]) :
      Array.isArray(raw?.items) ? (raw.items as unknown[]) :
      Array.isArray(raw?.data) ? (raw.data as unknown[]) :
      Array.isArray(raw?.transfers) ? (raw.transfers as unknown[]) :
      Array.isArray(raw?.transactions) ? (raw.transactions as unknown[]) :
      []
    diag.rawItemCount = items.length
    if (items.length === 0) {
      diag.failureStage = 'no_items'
      diag.reason = 'GoldRush returned no wallet history items for this address/window.'
      return { events: [], diag }
    }
    const first = items[0]
    if (first && typeof first === 'object') diag.firstEventShapeKeys = Object.keys(first as object).slice(0, 8)
    const lower = address.toLowerCase()
    const events = items.slice(0, 125).flatMap((it) => {
      const t = it as Record<string, unknown>
      const transfers: unknown[] = Array.isArray(t.transfers) ? t.transfers : []
      return transfers.slice(0, 3).map((x) => {
        const tr = x as Record<string, unknown>
        const contract = String(tr.contract_address ?? '').toLowerCase()
        const symbol = String(tr.contract_ticker_symbol ?? '?')
        const decimals = typeof tr.contract_decimals === 'number' ? tr.contract_decimals : 18
        const delta = String(tr.delta ?? '0')
        const amount = Math.abs(parseFloat(delta) / Math.pow(10, decimals))
        const from = String(tr.from_address ?? '').toLowerCase()
        const to = String(tr.to_address ?? '').toLowerCase()
        const direction: 'buy' | 'sell' | 'unknown' = to === lower ? 'buy' : from === lower ? 'sell' : 'unknown'
        const quote = typeof tr.delta_quote === 'number' ? Math.abs(tr.delta_quote) : null
        return { contract, symbol, direction, amount, usdValue: quote }
      })
    }).filter(e => e.contract.startsWith('0x') && e.amount > 0)
    diag.normalizedEventCount = events.length
    if (events.length === 0) {
      diag.failureStage = 'no_items'
      diag.reason = 'GoldRush returned items but no valid transfer events after normalization.'
    } else {
      diag.reason = `GoldRush returned ${events.length} normalized transfer events.`
    }
    return { events, diag }
  } catch {
    diag.fetchFailed = true
    diag.failureStage = 'fetch'
    diag.reason = 'GoldRush wallet history request failed before response.'
    return { events: [], diag }
  }
}

async function fetchAlchemyPnlEvents(address: string, baseUrl: string): Promise<PnlEvent[]> {
  try {
    const resp = await alchemyRpc(baseUrl, 'alchemy_getAssetTransfers', [{
      fromBlock: '0x0', category: ['erc20'], withMetadata: false, maxCount: '0x7d', order: 'desc', fromAddress: address,
    }])
    const recv = await alchemyRpc(baseUrl, 'alchemy_getAssetTransfers', [{
      fromBlock: '0x0', category: ['erc20'], withMetadata: false, maxCount: '0x7d', order: 'desc', toAddress: address,
    }])
    const outgoing = (resp?.transfers ?? []).slice(0, 125).map((t: Record<string, unknown>) => ({
      contract: String(((t.rawContract as Record<string, unknown> | undefined)?.address) ?? '').toLowerCase(),
      symbol: String(t.asset ?? '?'),
      direction: 'sell' as const,
      amount: Number(t.value ?? 0),
      usdValue: null,
    }))
    const incoming = (recv?.transfers ?? []).slice(0, 125).map((t: Record<string, unknown>) => ({
      contract: String(((t.rawContract as Record<string, unknown> | undefined)?.address) ?? '').toLowerCase(),
      symbol: String(t.asset ?? '?'),
      direction: 'buy' as const,
      amount: Number(t.value ?? 0),
      usdValue: null,
    }))
    return [...outgoing, ...incoming].filter(e => e.contract.startsWith('0x') && Number.isFinite(e.amount) && e.amount > 0)
  } catch { return [] }
}

function confidenceFromCoverage(c: number): 'high' | 'medium' | 'low' { return c >= 85 ? 'high' : c >= 60 ? 'medium' : 'low' }

const BEHAVIOR_EMPTY: WalletBehavior = {
  status: 'unavailable', source: 'unavailable',
  txCount: null, activeDays: null, topTokens: [], topContracts: [],
  inboundCount: null, outboundCount: null, stablecoinActivity: false,
  recentActivitySummary: 'Activity data unavailable.', reason: '',
}

async function fetchWalletBehavior(address: string, baseUrl: string): Promise<WalletBehavior> {
  if (!ALCHEMY_BASE_KEY) return { ...BEHAVIOR_EMPTY, reason: 'Base key not configured.' }
  try {
    const base = {
      fromBlock: '0x0', category: ['external', 'erc20'],
      withMetadata: true, maxCount: '0x32', order: 'desc',
    }
    const [sentRes, recvRes] = await Promise.allSettled([
      alchemyRpc(baseUrl, 'alchemy_getAssetTransfers', [{ ...base, fromAddress: address }]),
      alchemyRpc(baseUrl, 'alchemy_getAssetTransfers', [{ ...base, toAddress: address }]),
    ])
    type Tx = { to: string | null; asset: string | null; metadata?: { blockTimestamp?: string } }
    const sent: Tx[] = sentRes.status === 'fulfilled' ? (sentRes.value?.transfers ?? []) : []
    const recv: Tx[] = recvRes.status === 'fulfilled' ? (recvRes.value?.transfers ?? []) : []
    const all = [...sent, ...recv]
    if (all.length === 0) {
      return { ...BEHAVIOR_EMPTY, status: 'ok', source: 'alchemy', txCount: 0, activeDays: 0, recentActivitySummary: 'No recent Base activity found in the checked window.' }
    }
    const STABLES = /^(USDC|USDT|DAI|USDBC|EURC|LUSD)$/i
    const days = new Set(all.map(t => t.metadata?.blockTimestamp?.slice(0, 10)).filter(Boolean) as string[])
    const tokenFreq = new Map<string, number>()
    const contractFreq = new Map<string, number>()
    for (const t of all) {
      if (t.asset && t.asset !== 'ETH') tokenFreq.set(t.asset, (tokenFreq.get(t.asset) ?? 0) + 1)
    }
    for (const t of sent) {
      if (t.to && t.to.toLowerCase() !== address.toLowerCase()) {
        const k = t.to.toLowerCase()
        contractFreq.set(k, (contractFreq.get(k) ?? 0) + 1)
      }
    }
    const topTokens = [...tokenFreq].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([s]) => s)
    const topContracts = [...contractFreq].sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([a]) => `${a.slice(0, 6)}…${a.slice(-4)}`)
    const stablecoinActivity = all.some(t => t.asset && STABLES.test(t.asset))
    return {
      status: 'ok', source: 'alchemy',
      txCount: all.length, activeDays: days.size,
      topTokens, topContracts,
      inboundCount: recv.length, outboundCount: sent.length,
      stablecoinActivity,
      recentActivitySummary: [
        `${all.length} recent transfers across ${days.size} active days on Base.`,
        topTokens.length ? `Top tokens: ${topTokens.slice(0, 3).join(', ')}.` : '',
        stablecoinActivity ? 'Includes stablecoin movement.' : '',
      ].filter(Boolean).join(' '),
      reason: '',
    }
  } catch {
    return { ...BEHAVIOR_EMPTY, status: 'unavailable', reason: 'Behavior fetch failed.' }
  }
}

export async function fetchWalletSnapshot(address: string): Promise<WalletSnapshot> {
  const addr: string = (address ?? '').trim()
  if (!addr || !/^0x[0-9a-fA-F]{40}$/i.test(addr)) {
    throw new Error('Invalid wallet address')
  }

  const ethUrl  = `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_ETH_KEY}`
  const baseUrl = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_BASE_KEY}`

  // Run all providers in parallel: Zerion (primary), GoldRush (fallback), Alchemy tx/nonce
  const [
    positionsRes,
    portfolioRes,
    grEthRes,
    grBaseRes,
    ethFirst,
    baseFirst,
    nonceRes,
    behaviorRes,
    grPnlEthRes,
    grPnlBaseRes,
    alchemyPnlRes,
  ] = await Promise.allSettled([
    ZERION_KEY
      ? zerionGet(`wallets/${addr}/positions/`, {
          currency: 'usd',
          'filter[positions]': 'only_simple',
          'filter[trash]': 'only_non_trash',
          sort: '-value',
          'page[size]': '50',
        })
      : Promise.reject(new Error('Zerion key not configured')),
    ZERION_KEY
      ? zerionGet(`wallets/${addr}/portfolio/`, { currency: 'usd' })
      : Promise.reject(new Error('Zerion key not configured')),
    GOLDRUSH_KEY
      ? fetchGoldrushBalances(addr, 'eth-mainnet', GOLDRUSH_KEY)
      : Promise.resolve([] as Holding[]),
    GOLDRUSH_KEY
      ? fetchGoldrushBalances(addr, 'base-mainnet', GOLDRUSH_KEY)
      : Promise.resolve([] as Holding[]),
    getFirstTxOnChain(addr, ethUrl),
    getFirstTxOnChain(addr, baseUrl),
    alchemyRpc(ethUrl, 'eth_getTransactionCount', [addr, 'latest']),
    fetchWalletBehavior(addr, baseUrl),
    GOLDRUSH_KEY ? fetchGoldrushPnlEvents(addr, 'eth-mainnet', GOLDRUSH_KEY) : Promise.resolve({ events: [] as PnlEvent[], diag: { endpointKind: 'transfers_v2' as const, chainUsed: '1', urlTemplate: '', httpStatus: null, fetchFailed: false, failureStage: null, rawItemCount: 0, normalizedEventCount: 0, firstEventShapeKeys: [], reason: 'GoldRush not configured.' } }),
    GOLDRUSH_KEY ? fetchGoldrushPnlEvents(addr, 'base-mainnet', GOLDRUSH_KEY) : Promise.resolve({ events: [] as PnlEvent[], diag: { endpointKind: 'transfers_v2' as const, chainUsed: '8453', urlTemplate: '', httpStatus: null, fetchFailed: false, failureStage: null, rawItemCount: 0, normalizedEventCount: 0, firstEventShapeKeys: [], reason: 'GoldRush not configured.' } }),
    fetchAlchemyPnlEvents(addr, baseUrl),
  ])

  // ── Tx / age / nonce (from Alchemy — unchanged path) ──
  const firstCandidates: Date[] = []
  if (ethFirst.status === 'fulfilled' && ethFirst.value) firstCandidates.push(ethFirst.value)
  if (baseFirst.status === 'fulfilled' && baseFirst.value) firstCandidates.push(baseFirst.value)
  const firstTxDate = firstCandidates.length > 0
    ? new Date(Math.min(...firstCandidates.map(d => d.getTime())))
    : null
  const walletAgeDays = firstTxDate
    ? Math.floor((Date.now() - firstTxDate.getTime()) / 86_400_000)
    : null
  const txCount = nonceRes.status === 'fulfilled' && nonceRes.value
    ? parseInt(nonceRes.value as string, 16)
    : null

  // ── Provider selection: Zerion first, GoldRush fallback ──
  let holdings: Holding[] = []
  let totalValue = 0
  let providerUsed: 'zerion' | 'goldrush' | 'none' = 'none'
  let providerStatus: 'ok' | 'partial' | 'failed' = 'failed'
  let reason = ''

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawPos: any[] = positionsRes.status === 'fulfilled' ? (positionsRes.value?.data ?? []) : []

  if (rawPos.length > 0) {
    holdings = rawPos
      .map(pos => {
        const a  = pos.attributes ?? {}
        const fi = a.fungible_info ?? {}
        return {
          contract: typeof fi.implementations?.[0]?.address === 'string' ? fi.implementations[0].address.toLowerCase() : undefined,
          name:      fi.name      ?? 'Unknown',
          symbol:    fi.symbol    ?? '?',
          icon:      fi.icon?.url ?? null,
          chain:     pos.relationships?.chain?.data?.id ?? null,
          balance:   a.quantity?.float   ?? 0,
          value:     a.value             ?? 0,
          price:     a.price             ?? null,
          change24h: a.changes?.percent_1d ?? null,
          verified:  fi.flags?.verified  ?? false,
        }
      })
      .filter(h => h.value > 0.01)
    totalValue = portfolioRes.status === 'fulfilled'
      ? (portfolioRes.value?.data?.attributes?.total?.positions ?? holdings.reduce((s, h) => s + h.value, 0))
      : holdings.reduce((s, h) => s + h.value, 0)
    providerUsed = 'zerion'
    providerStatus = 'ok'
  } else {
    // Zerion returned empty or failed — reason for diagnostic logging
    reason = positionsRes.status === 'rejected'
      ? 'Primary provider unavailable.'
      : 'Primary provider returned no positions for this wallet.'
  }

  // GoldRush fallback when Zerion yielded no holdings
  if (holdings.length === 0) {
    const grHoldings = [
      ...(grEthRes.status === 'fulfilled' ? grEthRes.value : []),
      ...(grBaseRes.status === 'fulfilled' ? grBaseRes.value : []),
    ].sort((a, b) => b.value - a.value)

    if (grHoldings.length > 0) {
      holdings = grHoldings
      totalValue = holdings.reduce((s, h) => s + h.value, 0)
      providerUsed = 'goldrush'
      providerStatus = 'ok'
      reason = ''
    } else if (GOLDRUSH_KEY) {
      reason = reason || 'No priced holdings found on Ethereum or Base for this wallet.'
    } else {
      reason = reason || 'Wallet data provider not configured.'
    }
  }

  if (holdings.length === 0 && !reason) {
    reason = 'No token balances found on supported chains.'
  }

  const grPnlEthOut = grPnlEthRes.status === 'fulfilled' ? grPnlEthRes.value : { events: [] as PnlEvent[], diag: null as GrTransferDiag | null }
  const grPnlBaseOut = grPnlBaseRes.status === 'fulfilled' ? grPnlBaseRes.value : { events: [] as PnlEvent[], diag: null as GrTransferDiag | null }
  const grEvents = [...grPnlEthOut.events, ...grPnlBaseOut.events]
  const alchemyEvents = alchemyPnlRes.status === 'fulfilled' ? alchemyPnlRes.value : []
  const events = grEvents.length > 0 ? grEvents : alchemyEvents
  const pnlSource: 'goldrush' | 'alchemy' | 'none' = grEvents.length > 0 ? 'goldrush' : alchemyEvents.length > 0 ? 'alchemy' : 'none'
  const byToken = new Map<string, PnlEvent[]>()
  for (const e of events.slice(0, 250)) byToken.set(e.contract, [...(byToken.get(e.contract) ?? []), e])
  const pnlTokens: WalletSnapshot['estimatedPnl']['tokens'] = []
  let realized = 0, unrealized = 0, coverageNum = 0
  for (const h of holdings.slice(0, 25)) {
    const tokenEvents = byToken.get((h.contract ?? '').toLowerCase()) ?? []
    const buys = tokenEvents.filter(e => e.direction === 'buy')
    const sells = tokenEvents.filter(e => e.direction === 'sell')
    const unexplained = tokenEvents.filter(e => e.direction === 'unknown').length
    const pricedBuys = buys.filter(b => (b.usdValue ?? 0) > 0)
    const buyQty = buys.reduce((s, e) => s + e.amount, 0)
    const sellQty = sells.reduce((s, e) => s + e.amount, 0)
    const buyCost = pricedBuys.reduce((s, e) => s + (e.usdValue ?? 0), 0)
    const avgCost = buyQty > 0 && buyCost > 0 ? buyCost / buyQty : null
    const estimatedCostBasisUsd = avgCost && h.balance > 0 ? avgCost * h.balance : null
    const estimatedUnrealized = estimatedCostBasisUsd !== null ? h.value - estimatedCostBasisUsd : null
    const realizedProceeds = sells.reduce((s, e) => s + (e.usdValue ?? 0), 0)
    const realizedCost = avgCost ? avgCost * Math.min(sellQty, buyQty) : 0
    const estimatedRealized = realizedProceeds > 0 && avgCost ? realizedProceeds - realizedCost : null
    const withUsd = tokenEvents.filter(e => (e.usdValue ?? 0) > 0).length
    const coverage = tokenEvents.length > 0 ? Math.max(0, Math.min(100, Math.round((withUsd / tokenEvents.length) * 100 - unexplained * 5))) : 0
    const conf = confidenceFromCoverage(coverage)
    if (estimatedUnrealized !== null && coverage >= 60) unrealized += estimatedUnrealized
    if (estimatedRealized !== null && coverage >= 60) realized += estimatedRealized
    coverageNum += coverage
    pnlTokens.push({ symbol: h.symbol, contract: (h.contract ?? '').toLowerCase(), currentValueUsd: h.value, estimatedCostBasisUsd, estimatedUnrealizedPnlUsd: coverage >= 60 ? estimatedUnrealized : null, estimatedRealizedPnlUsd: coverage >= 60 ? estimatedRealized : null, buysDetected: buys.length, sellsDetected: sells.length, unexplainedTransfers: unexplained, coveragePercent: coverage, confidence: conf, reason: coverage < 60 ? 'PnL partial/unavailable: historical cost basis coverage too low.' : 'Estimated from average-cost using indexed transfers.' })
  }
  const coveragePercent = pnlTokens.length ? Math.round(coverageNum / pnlTokens.length) : 0
  const status: WalletSnapshot['estimatedPnl']['status'] = pnlTokens.length === 0 || pnlSource === 'none' ? 'unavailable' : coveragePercent >= 60 ? 'ok' : 'partial'
  const filteredPnlTokens = pnlTokens.filter((t) => t.coveragePercent > 0).sort((a, b) => (b.currentValueUsd - a.currentValueUsd)).slice(0, 10)
  const pnlCoverageReason = status === 'unavailable'
    ? (pnlSource === 'none' ? 'Need decoded buys/sells with USD values from GoldRush/Covalent or supported transfer history.' : 'Historical cost basis coverage is too low for a reliable estimate.')
    : 'Estimated from indexed transfer history with average-cost method.'
  const estimatedPnl: WalletSnapshot['estimatedPnl'] = { status, confidence: status === 'unavailable' ? null : confidenceFromCoverage(coveragePercent), coveragePercent, source: pnlSource, totalEstimatedPnlUsd: status === 'unavailable' ? null : realized + unrealized, unrealizedPnlUsd: status === 'unavailable' ? null : unrealized, realizedPnlUsd: status === 'unavailable' ? null : realized, method: 'average_cost_estimate', tokens: filteredPnlTokens, reason: status === 'unavailable' ? 'PnL unavailable — historical cost basis coverage is too low.' : 'Estimated PnL Beta derived from indexed wallet transfer history.' }
  const unpricedHoldingsCount = holdings.filter((h) => !h.price || h.price <= 0).length
  const hiddenDustCount = holdings.filter((h) => h.value <= 1).length

  return {
    address: addr,
    totalValue,
    holdings,
    txCount,
    firstTxDate: firstTxDate?.toISOString() ?? null,
    walletAgeDays,
    providerUsed,
    portfolioSource: providerUsed,
    providerStatus,
    holdingsCount: holdings.length,
    totalUsdAvailable: totalValue > 0,
    reason,
    behaviorSource: behaviorRes.status === 'fulfilled' ? behaviorRes.value.source : 'unavailable',
    behaviorChain: 'base',
    pnlSource: pnlSource === 'none' ? 'unavailable' : pnlSource,
    pnlCoverageReason,
    hiddenDustCount,
    unpricedHoldingsCount,
    walletBehavior: behaviorRes.status === 'fulfilled' ? behaviorRes.value : { ...BEHAVIOR_EMPTY, reason: 'Behavior fetch did not complete.' },
    estimatedPnl,
    _diagnostics: {
      walletProviderFieldsPresent: {
        holdings: holdings.length > 0,
        totalValue: totalValue > 0,
        txCount: txCount !== null,
        walletAgeDays: walletAgeDays !== null,
      },
      missingReasons: [
        holdings.length === 0 ? `holdings: ${reason}` : '',
        totalValue === 0 ? 'totalValue: no priced holdings found' : '',
        txCount === null ? 'txCount: Alchemy nonce unavailable' : '',
        walletAgeDays === null ? 'walletAgeDays: no first-tx on ETH or Base' : '',
      ].filter(Boolean),
      goldrushTransferDiags: [grPnlEthOut.diag, grPnlBaseOut.diag].filter((d): d is GrTransferDiag => d !== null),
    },
  }
}
