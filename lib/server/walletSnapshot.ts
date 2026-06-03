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



type GrTransferDiag = {
  endpointKind?: string | null
  chainUsed?: string | null
  urlTemplate?: string | null
  httpStatus?: number | null
  fetchFailed?: boolean
  failureStage?: "build_url" | "fetch" | "timeout" | "parse" | "empty_response" | "no_items" | null
  rawItemCount?: number
  normalizedEventCount?: number
  firstEventShapeKeys?: string[]
  reason?: string
  attemptedHosts?: Array<{
    requestHost: string
    requestUrlValid: boolean
    httpStatus: number | null
    fetchFailed: boolean
    failureStage: 'build_url' | 'fetch' | 'timeout' | 'empty_response' | 'no_items' | null
    fetchErrorKind?: 'invalid_url' | 'network' | 'timeout' | 'unknown' | null
    fetchErrorMessage?: string | null
  }>
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

export type WalletLotSummary = {
  status: 'ok' | 'partial' | 'unavailable'
  method: 'fifo'
  closedLots: number
  openLots: number
  totalRealizedPnlUsd: number | null
  coveragePercent: number
  reason: string
}

export type WalletTradeStatsSummary = {
  status: 'ok' | 'partial' | 'unavailable'
  source: 'fifo' | 'per_swap_fallback' | 'none'
  tradesAnalyzed: number
  winRate: number | null
  avgWinUsd: number | null
  avgLossUsd: number | null
  totalRealizedPnlUsd: number | null
  bestTradeUsd: number | null
  worstTradeUsd: number | null
  confidence: 'high' | 'medium' | 'low' | null
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
  walletLotSummary?: WalletLotSummary
  walletTradeStatsSummary?: WalletTradeStatsSummary
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
    providers?: {
      zerion: { configured: boolean; attempted: boolean; succeeded: boolean }
      goldrush: {
        configured: boolean
        balancesAttempted: boolean
        transactionsAttempted: boolean
        transfersAttempted: boolean
        eventsReturned: number
        valuedEventsReturned: number
        pnlEventsUsable: number
        endpointKind?: string
        chainUsed?: string
        httpStatus?: number | null
        rawItemCount?: number
        normalizedEventCount?: number
        firstEventShapeKeys?: string[]
        reason: string
      }
      alchemy: { configured: boolean; behaviorAttempted: boolean; transfersReturned: number; reason: string }
      cacheHit?: boolean
    }
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

const EXTENDED_DEX_ROUTERS = new Set<string>([
  // Uniswap
  '0x7a250d5630b4cf539739df2c5dacb4c659f2488d',
  '0xe592427a0aece92de3edee1f18e0157c05861564',
  '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45',
  '0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b',
  '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad',
  // 1inch
  '0x1111111254fb6c44bac0bed2854e76f90643097d',
  '0x1111111254eeb25477b68fb85ed929f73a960582',
  '0x111111125421ca6dc452d289314280a0f8842a65',
  // 0x Protocol
  '0xdef1c0ded9bec7f1a1670819833240f027b25eff',
  '0x55dc0e69ec00debcebdc25fe6f7cad62e63c8f81',
  // Paraswap
  '0x216b4b4ba9f3e719726886d34a177484278bfcae',
  '0xdef171fe48cf0115b1d80b88dc8eab59176fee57',
  // SushiSwap
  '0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f',
  '0x1b02da8cb0d097eb8d57a175b88c7d8b47997506',
  // Aerodrome (Base)
  '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43',
  '0x6cb442acf35158d68425b2a89f7e7b02fb5e42d5',
  // Balancer
  '0xba12222222228d8ba445958a75a0704d566bf2c8',
  // Curve
  '0x99a58482bd75cbab83b27ec03ca68ff489b5788f',
  '0xf0d4c12a5768d806021f80a262b4d39d26c58b8d',
  // BaseSwap
  '0x327df1e6de05895d2ab08513aadd9313fe505d86',
])

const FIFO_QUOTE_ASSETS = new Set<string>([
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC ETH
  '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT ETH
  '0x6b175474e89094c44da98b954eedeac495271d0f', // DAI ETH
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH ETH
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC Base
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb', // DAI Base
  '0x4200000000000000000000000000000000000006', // WETH Base
  '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca', // USDbC Base
])

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

type PnlEvent = {
  contract: string; symbol: string; direction: 'buy' | 'sell' | 'unknown'
  amount: number; usdValue: number | null
  txHash?: string; timestamp?: string; txToAddress?: string; txFromAddress?: string
  chain?: string; isSwapCandidate?: boolean
}
type GoldrushHistoryDiag = {
  endpointKind: 'transfers_v2'
  chainUsed: string
  urlTemplate: string
  httpStatus: number | null
  fetchFailed: boolean
  failureStage: 'build_url' | 'fetch' | 'timeout' | 'empty_response' | 'no_items' | null
  rawItemCount: number
  normalizedEventCount: number
  firstEventShapeKeys: string[]
  reason: string
  fetchErrorKind?: 'invalid_url' | 'network' | 'timeout' | 'unknown' | null
  fetchErrorMessage?: string | null
  hasApiKey?: boolean
  requestHost?: string | null
  requestUrlValid?: boolean
  requestPathTemplate?: string
  authMode?: 'bearer' | 'basic' | 'query' | 'none'
  attemptedHosts?: Array<{
    requestHost: string
    requestUrlValid: boolean
    httpStatus: number | null
    fetchFailed: boolean
    failureStage: 'build_url' | 'fetch' | 'timeout' | 'empty_response' | 'no_items' | null
    fetchErrorKind?: 'invalid_url' | 'network' | 'timeout' | 'unknown' | null
    fetchErrorMessage?: string | null
  }>
}

function buildGoldrushTransfersRequest(chain: string, wallet: string, host: string) {
  const normalizedWallet = wallet.toLowerCase()
  const finalUrl = new URL(`https://${host}/v1/${chain}/address/${normalizedWallet}/transfers_v2/`)
  finalUrl.searchParams.set('page-size', '125')
  finalUrl.searchParams.set('page-number', '0')

  const requestUrl = finalUrl.toString()

  return {
    requestUrl,
    requestHost: finalUrl.hostname,
    requestUrlValid: true,
    requestPathTemplate: '/v1/{chain}/address/{wallet}/transfers_v2/',
    urlTemplate: `https://${host}/v1/${chain}/address/{wallet}/transfers_v2/?page-size=125&page-number=0`,
  }
}

async function fetchGoldrushPnlEvents(address: string, chainName: string, apiKey: string): Promise<{ events: PnlEvent[]; diag: GoldrushHistoryDiag }> {
  const baseDiag = (chain: string): GoldrushHistoryDiag => ({ endpointKind: 'transfers_v2', chainUsed: chain, urlTemplate: `https://api.covalenthq.com/v1/${chain}/address/{wallet}/transfers_v2/?page-size=125&page-number=0`, httpStatus: null, fetchFailed: false, failureStage: null, rawItemCount: 0, normalizedEventCount: 0, firstEventShapeKeys: [], reason: '', fetchErrorKind: null, fetchErrorMessage: null, hasApiKey: Boolean(apiKey), requestHost: 'api.covalenthq.com', requestUrlValid: true, requestPathTemplate: '/v1/{chain}/address/{wallet}/transfers_v2/', authMode: apiKey ? 'bearer' : 'none', attemptedHosts: [] })
  const hostCandidates = ['api.covalenthq.com', 'api.goldrush.dev'] as const
  const sanitizeMessage = (msg: string): string => {
    const shortAddr = address ? `${address.slice(0, 6)}...${address.slice(-4)}` : ''
    return msg
      .replaceAll(apiKey, '[redacted-key]')
      .replace(new RegExp(address, 'ig'), shortAddr)
      .replace(/0x[a-fA-F0-9]{40}/g, (m) => `${m.slice(0, 6)}...${m.slice(-4)}`)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160)
  }
  const classifyFetchError = (err: unknown): { kind: 'invalid_url' | 'network' | 'timeout' | 'unknown'; message: string; isTimeout: boolean } => {
    const msg = err instanceof Error ? `${err.name} ${err.message}`.trim() : String(err ?? 'Unknown fetch error')
    const compact = sanitizeMessage(msg)
    const isTimeout = /timeout|aborted|aborterror/i.test(compact)
    if (/invalid url|failed to parse url|url is malformed|typeerror: fetch failed.*invalid/i.test(compact.toLowerCase())) return { kind: 'invalid_url', message: compact, isTimeout }
    if (isTimeout) return { kind: 'timeout', message: compact, isTimeout: true }
    if (/fetch failed|econn|enotfound|network|socket|connect|tls|certificate|dns/i.test(compact.toLowerCase())) return { kind: 'network', message: compact, isTimeout: false }
    return { kind: 'unknown', message: compact, isTimeout }
  }
  const devLog = (diag: GoldrushHistoryDiag) => {
    if (process.env.NODE_ENV !== 'production') {
      console.info('[goldrush-fetch]', { chainUsed: diag.chainUsed, requestHost: diag.requestHost ?? null, hasApiKey: diag.hasApiKey ?? false, urlTemplate: diag.urlTemplate, httpStatus: diag.httpStatus, fetchFailed: diag.fetchFailed, failureStage: diag.failureStage, fetchErrorKind: diag.fetchErrorKind ?? null })
    }
  }
  const finalizeDiag = (diag: GoldrushHistoryDiag): GoldrushHistoryDiag => {
    if (diag.requestUrlValid === true && diag.failureStage === 'build_url') {
      diag.failureStage = 'fetch'
    }
    if (diag.requestUrlValid === false) {
      diag.failureStage = 'build_url'
      if (!diag.reason) diag.reason = 'GoldRush wallet history URL could not be built.'
    }
    if (diag.fetchFailed === false && diag.httpStatus == null) {
      diag.fetchFailed = true
      diag.failureStage = diag.failureStage ?? 'fetch'
      diag.reason = diag.reason || 'GoldRush wallet history request did not expose an HTTP response.'
    }
    if (diag.fetchFailed === false && diag.httpStatus == null) {
      diag.fetchFailed = true
      diag.failureStage = diag.failureStage ?? 'fetch'
    }
    return diag
  }
  try {
    const chainCandidates = chainName === 'base-mainnet' ? ['8453', 'base-mainnet'] : [chainName]
    let lastAttemptDiag: GoldrushHistoryDiag | null = null
    for (const chainUsed of chainCandidates) {
      const diag = baseDiag(chainUsed)
      const hasBuildInputs = Boolean(chainUsed && address && apiKey)
      if (!hasBuildInputs) {
        const out = finalizeDiag({ ...diag, fetchFailed: true, failureStage: 'build_url', fetchErrorKind: 'invalid_url', fetchErrorMessage: 'Missing required request inputs.', reason: 'GoldRush wallet history URL could not be built.' })
        devLog(out)
        return { events: [], diag: out }
      }
      let res: Response | null = null
      for (const host of hostCandidates) {
        let requestUrl = ''
        try {
          const built = buildGoldrushTransfersRequest(chainUsed, address, host)
          requestUrl = built.requestUrl
          diag.requestHost = built.requestHost
          diag.requestUrlValid = built.requestUrlValid
          diag.requestPathTemplate = built.requestPathTemplate
          diag.urlTemplate = built.urlTemplate
        } catch {
          diag.attemptedHosts?.push({ requestHost: host, requestUrlValid: false, httpStatus: null, fetchFailed: true, failureStage: 'build_url', fetchErrorKind: 'invalid_url', fetchErrorMessage: 'Failed to construct a valid GoldRush request URL.' })
          continue
        }
        try {
          res = await fetch(requestUrl, { cache: 'no-store', headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000) })
          diag.httpStatus = res.status
          diag.fetchFailed = false
          diag.attemptedHosts?.push({ requestHost: host, requestUrlValid: true, httpStatus: res.status, fetchFailed: false, failureStage: null, fetchErrorKind: null, fetchErrorMessage: null })
          break
        } catch (err) {
          const errInfo = classifyFetchError(err)
          diag.fetchFailed = true
          diag.failureStage = errInfo.isTimeout ? 'timeout' : 'fetch'
          diag.fetchErrorKind = errInfo.kind
          diag.fetchErrorMessage = errInfo.message
          diag.httpStatus = null
          diag.reason = 'GoldRush wallet history request failed before response.'
          diag.attemptedHosts?.push({ requestHost: host, requestUrlValid: true, httpStatus: null, fetchFailed: true, failureStage: diag.failureStage, fetchErrorKind: errInfo.kind, fetchErrorMessage: errInfo.message })
        }
      }
      if (!res) {
        const out = finalizeDiag(diag)
        lastAttemptDiag = out
        devLog(out)
        return { events: [], diag: out }
      }
      if (!res.ok) {
        diag.failureStage = 'empty_response'
        diag.reason = `GoldRush wallet history returned HTTP ${res.status}.`
        lastAttemptDiag = finalizeDiag(diag)
        devLog(lastAttemptDiag)
        continue
      }
      const json = await res.json()
      const items: unknown[] = Array.isArray(json?.data?.items) ? json.data.items.slice(0, 125) : []
      diag.rawItemCount = items.length
      diag.firstEventShapeKeys = items[0] && typeof items[0] === 'object' ? Object.keys(items[0] as Record<string, unknown>).slice(0, 12) : []
      if (items.length === 0) {
        diag.failureStage = 'no_items'
        diag.reason = 'GoldRush returned no wallet history items for this address/window.'
        const out = finalizeDiag(diag)
        devLog(out)
        return { events: [], diag: out }
      }
      const lower = address.toLowerCase()
      const events = items.flatMap((it) => {
        const t = it as Record<string, unknown>
        const txHash = String(t.tx_hash ?? '')
        const timestamp = String(t.block_signed_at ?? '')
        const txToAddress = String(t.to_address ?? '').toLowerCase()
        const txFromAddress = String(t.from_address ?? '').toLowerCase()
        const transfers: unknown[] = Array.isArray(t.transfers) ? t.transfers : []
        return transfers.slice(0, 12).map((x) => {
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
          return { contract, symbol, direction, amount, usdValue: quote, txHash, timestamp, txToAddress, txFromAddress, chain: chainUsed }
        })
      }).filter(e => e.contract.startsWith('0x') && e.amount > 0)
      diag.normalizedEventCount = events.length
      diag.reason = events.length > 0 ? '' : 'No indexed wallet transfer history returned from current checks.'
      const out = finalizeDiag(diag)
      devLog(out)
      return { events, diag: out }
    }
    if (lastAttemptDiag) return { events: [], diag: lastAttemptDiag }
    const fallbackChain = (chainName === 'base-mainnet' ? '8453' : chainName) || chainName
    const out = finalizeDiag({ ...baseDiag(fallbackChain), fetchFailed: true, failureStage: 'fetch', fetchErrorKind: 'unknown', fetchErrorMessage: 'No successful GoldRush response across chain candidates; check prior chain diagnostics for concrete HTTP/fetch failure details.', reason: 'GoldRush wallet history request failed before response.' })
    devLog(out)
    return { events: [], diag: out }
  } catch {
    const diag = baseDiag(chainName)
    const out = finalizeDiag({ ...diag, fetchFailed: true, failureStage: 'fetch', fetchErrorKind: 'unknown', fetchErrorMessage: 'Unexpected GoldRush wallet history handler failure.', reason: 'GoldRush wallet history request failed before response.' })
    devLog(out)
    return { events: [], diag: out }
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

type FifoClosedLot = {
  contract: string; symbol: string
  buyTxHash: string; sellTxHash: string
  buyTimestamp: string; sellTimestamp: string
  buyAmount: number; sellAmount: number
  buyCostUsd: number; sellProceedsUsd: number
  realizedPnlUsd: number; chain: string
}

function buildFifoSwapDetection(events: PnlEvent[], walletAddr: string): PnlEvent[] {
  const lower = walletAddr.toLowerCase()
  const byTx = new Map<string, PnlEvent[]>()
  for (const e of events) {
    if (!e.txHash) continue
    const k = e.txHash.toLowerCase()
    if (!byTx.has(k)) byTx.set(k, [])
    byTx.get(k)!.push(e)
  }
  const swapHashes = new Set<string>()
  for (const [txHash, txEvents] of byTx) {
    const hasIn  = txEvents.some(e => e.direction === 'buy')
    const hasOut = txEvents.some(e => e.direction === 'sell')
    const toRouter   = txEvents.some(e => e.txToAddress   && EXTENDED_DEX_ROUTERS.has(e.txToAddress.toLowerCase()))
    const fromRouter = txEvents.some(e => e.txFromAddress && EXTENDED_DEX_ROUTERS.has(e.txFromAddress.toLowerCase()))
    // If tx touches a quote asset (stable/WETH) alongside another token, classify as swap
    const hasQuoteAsset    = txEvents.some(e => FIFO_QUOTE_ASSETS.has(e.contract.toLowerCase()))
    const hasNonQuoteAsset = txEvents.some(e => !FIFO_QUOTE_ASSETS.has(e.contract.toLowerCase()))
    const quoteSwap = hasQuoteAsset && hasNonQuoteAsset && (hasIn || hasOut)
    if ((hasIn && hasOut) || toRouter || fromRouter || quoteSwap) swapHashes.add(txHash)
  }
  void lower
  return events.map(e => ({ ...e, isSwapCandidate: e.txHash ? swapHashes.has(e.txHash.toLowerCase()) : false }))
}

function normalizeSingleLegs(events: PnlEvent[]): PnlEvent[] {
  const byTx = new Map<string, PnlEvent[]>()
  for (const e of events) {
    if (!e.txHash) continue
    const k = e.txHash.toLowerCase()
    if (!byTx.has(k)) byTx.set(k, [])
    byTx.get(k)!.push(e)
  }
  return events.map(e => {
    if (!e.txHash || (e.usdValue ?? 0) > 0) return e
    const txEvents = byTx.get(e.txHash.toLowerCase()) ?? []
    const partner = txEvents.find(p => p !== e && (p.usdValue ?? 0) > 0 && p.amount > 0)
    if (partner?.usdValue) return { ...e, usdValue: partner.usdValue }
    return e
  })
}

function buildFifoLotEngine(events: PnlEvent[]): { closedLots: FifoClosedLot[]; openLots: number; realizedPnlUsd: number } {
  const eligible = events.filter(e =>
    e.isSwapCandidate && e.txHash && e.timestamp &&
    (e.direction === 'buy' || e.direction === 'sell') &&
    (e.usdValue ?? 0) > 0 && e.amount > 0
  ) as Array<PnlEvent & { txHash: string; timestamp: string; usdValue: number }>

  eligible.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())

  type OpenLot = { buyTxHash: string; buyTimestamp: string; amount: number; costPerUnit: number; chain: string }
  const openByToken = new Map<string, OpenLot[]>()
  const closedLots: FifoClosedLot[] = []

  for (const e of eligible) {
    const key = e.contract.toLowerCase()
    if (e.direction === 'buy') {
      const costPerUnit = e.usdValue / e.amount
      if (!openByToken.has(key)) openByToken.set(key, [])
      openByToken.get(key)!.push({ buyTxHash: e.txHash, buyTimestamp: e.timestamp, amount: e.amount, costPerUnit, chain: e.chain ?? 'unknown' })
    } else {
      const lots = openByToken.get(key) ?? []
      let remaining = e.amount
      const procPerUnit = e.usdValue / e.amount
      while (remaining > 1e-9 && lots.length > 0) {
        const lot = lots[0]
        const closed = Math.min(lot.amount, remaining)
        closedLots.push({
          contract: key, symbol: e.symbol,
          buyTxHash: lot.buyTxHash, sellTxHash: e.txHash,
          buyTimestamp: lot.buyTimestamp, sellTimestamp: e.timestamp,
          buyAmount: closed, sellAmount: closed,
          buyCostUsd: closed * lot.costPerUnit,
          sellProceedsUsd: closed * procPerUnit,
          realizedPnlUsd: closed * (procPerUnit - lot.costPerUnit),
          chain: e.chain ?? lot.chain,
        })
        remaining -= closed
        lot.amount -= closed
        if (lot.amount <= 1e-9) lots.shift()
      }
    }
  }

  const openLots = [...openByToken.values()].reduce((s, lots) => s + lots.length, 0)
  const realizedPnlUsd = closedLots.reduce((s, l) => s + l.realizedPnlUsd, 0)
  return { closedLots, openLots, realizedPnlUsd }
}

function buildTradeStatsSummary(closedLots: FifoClosedLot[], swapCandidateCount: number): WalletTradeStatsSummary {
  if (closedLots.length === 0) {
    return { status: 'unavailable', source: 'fifo', tradesAnalyzed: 0, winRate: null, avgWinUsd: null, avgLossUsd: null, totalRealizedPnlUsd: null, bestTradeUsd: null, worstTradeUsd: null, confidence: null, reason: 'No closed FIFO lots found.' }
  }
  const wins   = closedLots.filter(l => l.realizedPnlUsd > 0)
  const losses = closedLots.filter(l => l.realizedPnlUsd <= 0)
  const total  = closedLots.length
  const allPnls = closedLots.map(l => l.realizedPnlUsd)
  const coverage = swapCandidateCount > 0 ? (total / swapCandidateCount) * 100 : 0
  return {
    status: total >= 3 ? 'ok' : 'partial',
    source: 'fifo',
    tradesAnalyzed: total,
    winRate: Math.round((wins.length / total) * 100) / 100,
    avgWinUsd:  wins.length   > 0 ? wins.reduce((s, l) => s + l.realizedPnlUsd, 0)   / wins.length   : null,
    avgLossUsd: losses.length > 0 ? losses.reduce((s, l) => s + l.realizedPnlUsd, 0) / losses.length : null,
    totalRealizedPnlUsd: allPnls.reduce((s, v) => s + v, 0),
    bestTradeUsd:  Math.max(...allPnls),
    worstTradeUsd: Math.min(...allPnls),
    confidence: coverage >= 60 ? 'high' : coverage >= 30 ? 'medium' : 'low',
    reason: `FIFO lot matching across ${total} closed trade(s).`,
  }
}

function buildPerSwapTradeStats(events: PnlEvent[]): WalletTradeStatsSummary {
  const byTx = new Map<string, PnlEvent[]>()
  for (const e of events) {
    if (!e.isSwapCandidate || !e.txHash || (e.usdValue ?? 0) <= 0) continue
    const k = e.txHash.toLowerCase()
    if (!byTx.has(k)) byTx.set(k, [])
    byTx.get(k)!.push(e)
  }
  const trades: Array<{ pnl: number }> = []
  for (const [, txEvents] of byTx) {
    const buys  = txEvents.filter(e => e.direction === 'buy')
    const sells = txEvents.filter(e => e.direction === 'sell')
    if (buys.length === 0 || sells.length === 0) continue
    const buyUsd  = buys.reduce((s, e)  => s + (e.usdValue ?? 0), 0)
    const sellUsd = sells.reduce((s, e) => s + (e.usdValue ?? 0), 0)
    trades.push({ pnl: sellUsd - buyUsd })
  }
  if (trades.length === 0) {
    return { status: 'unavailable', source: 'per_swap_fallback', tradesAnalyzed: 0, winRate: null, avgWinUsd: null, avgLossUsd: null, totalRealizedPnlUsd: null, bestTradeUsd: null, worstTradeUsd: null, confidence: null, reason: 'No priced swap pairs found for per-swap fallback.' }
  }
  const wins   = trades.filter(t => t.pnl > 0)
  const losses = trades.filter(t => t.pnl <= 0)
  const allPnls = trades.map(t => t.pnl)
  return {
    status: trades.length >= 3 ? 'ok' : 'partial',
    source: 'per_swap_fallback',
    tradesAnalyzed: trades.length,
    winRate: Math.round((wins.length / trades.length) * 100) / 100,
    avgWinUsd:  wins.length   > 0 ? wins.reduce((s, t) => s + t.pnl, 0)   / wins.length   : null,
    avgLossUsd: losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : null,
    totalRealizedPnlUsd: allPnls.reduce((s, v) => s + v, 0),
    bestTradeUsd:  Math.max(...allPnls),
    worstTradeUsd: Math.min(...allPnls),
    confidence: trades.length >= 10 ? 'medium' : 'low',
    reason: `Per-swap fallback: ${trades.length} priced swap pair(s) analyzed.`,
  }
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
  const startedAt = Date.now()
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
    GOLDRUSH_KEY ? fetchGoldrushPnlEvents(addr, 'eth-mainnet', GOLDRUSH_KEY) : Promise.resolve({ events: [] as PnlEvent[], diag: { endpointKind: 'transfers_v2' as const, chainUsed: 'eth-mainnet', urlTemplate: 'https://api.covalenthq.com/v1/eth-mainnet/address/{address}/transfers_v2/?quote-currency=USD&page-size=125&page-number=0&no-spam=true', httpStatus: null, fetchFailed: true, failureStage: 'build_url' as const, rawItemCount: 0, normalizedEventCount: 0, firstEventShapeKeys: [], reason: 'GoldRush wallet history URL could not be built.' } }),
    GOLDRUSH_KEY ? fetchGoldrushPnlEvents(addr, 'base-mainnet', GOLDRUSH_KEY) : Promise.resolve({ events: [] as PnlEvent[], diag: { endpointKind: 'transfers_v2' as const, chainUsed: 'base-mainnet', urlTemplate: 'https://api.covalenthq.com/v1/base-mainnet/address/{address}/transfers_v2/?quote-currency=USD&page-size=125&page-number=0&no-spam=true', httpStatus: null, fetchFailed: true, failureStage: 'build_url' as const, rawItemCount: 0, normalizedEventCount: 0, firstEventShapeKeys: [], reason: 'GoldRush wallet history URL could not be built.' } }),
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

  const grEth = grPnlEthRes.status === 'fulfilled' ? grPnlEthRes.value : { events: [] as PnlEvent[], diag: { endpointKind: 'transfers_v2' as const, chainUsed: 'eth-mainnet', urlTemplate: 'https://api.covalenthq.com/v1/eth-mainnet/address/{address}/transfers_v2/?quote-currency=USD&page-size=125&page-number=0&no-spam=true', httpStatus: null, fetchFailed: true, failureStage: 'fetch' as const, rawItemCount: 0, normalizedEventCount: 0, firstEventShapeKeys: [], reason: 'GoldRush wallet history request failed before response.' } }
  const grPnlBaseOut = grPnlBaseRes.status === 'fulfilled' ? grPnlBaseRes.value : { events: [] as PnlEvent[], diag: { endpointKind: 'transfers_v2' as const, chainUsed: 'base-mainnet', urlTemplate: 'https://api.covalenthq.com/v1/base-mainnet/address/{address}/transfers_v2/?quote-currency=USD&page-size=125&page-number=0&no-spam=true', httpStatus: null, fetchFailed: true, failureStage: 'fetch' as const, rawItemCount: 0, normalizedEventCount: 0, firstEventShapeKeys: [], reason: 'GoldRush wallet history request failed before response.' } }
  const grBase = grPnlBaseOut
  const goldrushTransferDiags = [grEth.diag, grBase.diag]
  const baseTransferDiag = goldrushTransferDiags.find((d) => d.chainUsed === '8453' || d.chainUsed === 'base-mainnet') ?? goldrushTransferDiags[0]
  const grEvents = [...grEth.events, ...grBase.events]
  const alchemyEvents = alchemyPnlRes.status === 'fulfilled' ? alchemyPnlRes.value : []
  const valuedGrEvents = grEvents.filter((e) => (e.usdValue ?? 0) > 0)
  const rawEvents = grEvents.length > 0 ? grEvents : alchemyEvents
  const pnlSource: 'goldrush' | 'alchemy' | 'none' = grEvents.length > 0 ? 'goldrush' : alchemyEvents.length > 0 ? 'alchemy' : 'none'

  // Build a current-price map from holdings so events without usdValue can be enriched.
  // Using current price as a proxy is imprecise for historical trades but is consistent
  // with the average_cost_estimate method and prevents valid wallets from returning "unavailable".
  const priceByContract = new Map<string, number>()
  for (const h of holdings) {
    if (h.contract && h.price && h.price > 0) {
      priceByContract.set(h.contract.toLowerCase(), h.price)
    }
  }
  const events: PnlEvent[] = rawEvents.map(e => {
    if ((e.usdValue ?? 0) > 0) return e
    const cp = priceByContract.get(e.contract.toLowerCase())
    if (cp && cp > 0 && e.amount > 0) return { ...e, usdValue: e.amount * cp }
    return e
  })

  // FIFO pipeline
  const swapTagged      = buildFifoSwapDetection(events, addr)
  const normalizedEvents = normalizeSingleLegs(swapTagged)
  const { closedLots, openLots: openFifoLots, realizedPnlUsd: fifoRealizedPnl } = buildFifoLotEngine(normalizedEvents)

  const swapCandidateCount = normalizedEvents.filter(e => e.isSwapCandidate).length
  let walletTradeStatsSummary: WalletTradeStatsSummary
  if (closedLots.length > 0) {
    walletTradeStatsSummary = buildTradeStatsSummary(closedLots, swapCandidateCount)
  } else {
    walletTradeStatsSummary = buildPerSwapTradeStats(normalizedEvents)
  }

  const fifoCoveragePercent = swapCandidateCount > 0
    ? Math.round(Math.min(100, (closedLots.length / swapCandidateCount) * 100))
    : 0
  const walletLotSummary: WalletLotSummary = {
    status: closedLots.length > 0 ? 'ok' : walletTradeStatsSummary.status !== 'unavailable' ? 'partial' : 'unavailable',
    method: 'fifo',
    closedLots: closedLots.length,
    openLots: openFifoLots,
    totalRealizedPnlUsd: closedLots.length > 0 ? fifoRealizedPnl : null,
    coveragePercent: fifoCoveragePercent,
    reason: closedLots.length > 0
      ? `FIFO: ${closedLots.length} closed lot(s), ${openFifoLots} open.`
      : swapCandidateCount > 0
        ? 'Swap candidates found but no matchable buy/sell pairs for FIFO.'
        : 'No swap-classified events found.',
  }

  if (process.env.NODE_ENV !== 'production') {
    const rawValued      = rawEvents.filter(e => (e.usdValue ?? 0) > 0).length
    const enrichedValued = events.filter(e => (e.usdValue ?? 0) > 0).length
    const pricedSwaps    = normalizedEvents.filter(e => e.isSwapCandidate && (e.usdValue ?? 0) > 0).length
    console.log('coverageReport', {
      wallet: addr,
      pnlSource,
      rawEvents: rawEvents.length,
      rawValued,
      enrichedValued,
      inferredViaCurrentPrice: enrichedValued - rawValued,
      holdingsPriced: priceByContract.size,
      swapCandidates: swapCandidateCount,
      pricedSwaps,
      normalizedBuys:  normalizedEvents.filter(e => e.isSwapCandidate && e.direction === 'buy').length,
      normalizedSells: normalizedEvents.filter(e => e.isSwapCandidate && e.direction === 'sell').length,
      fifoClosedLots: closedLots.length,
      perSwapFallbackTrades: walletTradeStatsSummary.source === 'per_swap_fallback' ? walletTradeStatsSummary.tradesAnalyzed : 0,
    })
  }

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
    const COV_THRESHOLD = 40
    if (estimatedUnrealized !== null && coverage >= COV_THRESHOLD) unrealized += estimatedUnrealized
    if (estimatedRealized !== null && coverage >= COV_THRESHOLD) realized += estimatedRealized
    coverageNum += coverage
    pnlTokens.push({ symbol: h.symbol, contract: (h.contract ?? '').toLowerCase(), currentValueUsd: h.value, estimatedCostBasisUsd, estimatedUnrealizedPnlUsd: coverage >= COV_THRESHOLD ? estimatedUnrealized : null, estimatedRealizedPnlUsd: coverage >= COV_THRESHOLD ? estimatedRealized : null, buysDetected: buys.length, sellsDetected: sells.length, unexplainedTransfers: unexplained, coveragePercent: coverage, confidence: conf, reason: coverage < COV_THRESHOLD ? 'PnL partial/unavailable: historical cost basis coverage too low.' : 'Estimated from average-cost using indexed transfers.' })
  }
  const coveragePercent = pnlTokens.length ? Math.round(coverageNum / pnlTokens.length) : 0
  const status: WalletSnapshot['estimatedPnl']['status'] = pnlTokens.length === 0 || pnlSource === 'none' ? 'unavailable' : coveragePercent >= 40 ? 'ok' : 'partial'
  const filteredPnlTokens = pnlTokens.filter((t) => t.coveragePercent > 0).sort((a, b) => (b.currentValueUsd - a.currentValueUsd)).slice(0, 10)
  const pnlCoverageReason = status === 'unavailable'
    ? (pnlSource === 'none' ? 'Need decoded buys/sells with USD values from GoldRush/Covalent or supported transfer history.' : 'Historical cost basis coverage is too low for a reliable estimate.')
    : 'Estimated from indexed transfer history with average-cost method.'
  const estimatedPnl: WalletSnapshot['estimatedPnl'] = { status, confidence: status === 'unavailable' ? null : confidenceFromCoverage(coveragePercent), coveragePercent, source: pnlSource, totalEstimatedPnlUsd: status === 'unavailable' ? null : realized + unrealized, unrealizedPnlUsd: status === 'unavailable' ? null : unrealized, realizedPnlUsd: status === 'unavailable' ? null : realized, method: 'average_cost_estimate', tokens: filteredPnlTokens, reason: status === 'unavailable' ? 'PnL unavailable — historical cost basis coverage is too low.' : 'Estimated PnL Beta derived from indexed wallet transfer history.' }
  const unpricedHoldingsCount = holdings.filter((h) => !h.price || h.price <= 0).length
  const hiddenDustCount = holdings.filter((h) => h.value <= 1).length
  const behaviorTxCount = behaviorRes.status === 'fulfilled' ? (behaviorRes.value.txCount ?? 0) : 0
  const hasHistoricalBaseActivity = grEvents.length > 0
  const walletBehavior = behaviorRes.status === 'fulfilled'
    ? (behaviorTxCount === 0 && hasHistoricalBaseActivity
      ? { ...behaviorRes.value, recentActivitySummary: 'Historical Base activity found, but no recent activity in checked window.' }
      : behaviorRes.value)
    : { ...BEHAVIOR_EMPTY, reason: 'Behavior fetch did not complete.' }
  const goldrushConfigured = Boolean(GOLDRUSH_KEY)
  const goldrushReason = !goldrushConfigured
    ? 'History provider unavailable.'
    : grEvents.length === 0
      ? 'No indexed wallet transfer history returned from current checks.'
      : valuedGrEvents.length === 0
        ? 'Transfer history returned but no valued events for cost-basis estimation.'
        : ''
  const alchemyConfigured = Boolean(ALCHEMY_BASE_KEY)
  if (process.env.NODE_ENV !== 'production') {
    console.log('[wallet-diag] route=/api/wallet goldrushConfigured=', goldrushConfigured, 'goldrushEventsReturned=', grEvents.length, 'valuedEventsReturned=', valuedGrEvents.length, 'alchemyBehaviorAttempted=', alchemyConfigured, 'totalMs=', Date.now() - startedAt)
  }

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
    walletBehavior,
    walletLotSummary,
    walletTradeStatsSummary,
    estimatedPnl,
    _diagnostics: {
      providers: {
        zerion: { configured: Boolean(ZERION_KEY), attempted: true, succeeded: rawPos.length > 0 },
        goldrush: {
          configured: goldrushConfigured,
          balancesAttempted: goldrushConfigured,
          transactionsAttempted: goldrushConfigured,
          transfersAttempted: goldrushConfigured,
          eventsReturned: grEvents.length,
          valuedEventsReturned: valuedGrEvents.length,
          pnlEventsUsable: filteredPnlTokens.length,
          reason: goldrushReason,
          endpointKind: grBase.diag?.endpointKind,
          chainUsed: grBase.diag?.chainUsed,
          httpStatus: grBase.diag?.httpStatus ?? null,
          rawItemCount: grBase.diag?.rawItemCount,
          normalizedEventCount: grBase.diag?.normalizedEventCount,
          firstEventShapeKeys: grBase.diag?.firstEventShapeKeys,
        },
        alchemy: {
          configured: alchemyConfigured,
          behaviorAttempted: alchemyConfigured,
          transfersReturned: behaviorTxCount,
          reason: behaviorRes.status === 'fulfilled' ? '' : 'Behavior check unavailable from current checks.',
        },
      },
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
      goldrushTransferDiags: [grEth.diag, grBase.diag],
    },
  }
}
