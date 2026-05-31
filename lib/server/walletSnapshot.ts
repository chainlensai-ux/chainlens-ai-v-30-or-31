import { fetchMoralisBalances, type MoralisFetchResult, type MoralisChain } from './moralis'

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
  transferArrayCount?: number
  firstTransferKeys?: string[]
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
  source: 'activity_layer' | 'unavailable'
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
  providerUsed: 'portfolio_layer' | 'holdings_layer' | 'fallback_layer' | 'unverified' | 'none'
  providerStatus: 'ok' | 'partial' | 'failed'
  holdingsCount: number
  totalUsdAvailable: boolean
  reason: string
  portfolioSource: 'portfolio_layer' | 'holdings_layer' | 'fallback_layer' | 'unverified' | 'none'
  behaviorSource: 'activity_layer' | 'unavailable'
  behaviorChain: 'base'
  pnlSource: 'activity_layer' | 'fallback_layer' | 'unavailable'
  pnlCoverageReason: string
  hiddenDustCount: number
  unpricedHoldingsCount: number
  walletBehavior: WalletBehavior
  estimatedPnl: {
    status: 'ok' | 'partial' | 'unavailable' | 'error'
    confidence: 'high' | 'medium' | 'low' | null
    coveragePercent: number
    source: 'activity_layer' | 'fallback_layer' | 'none'
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
  walletEvidenceSummary: {
    status: 'ready' | 'partial' | 'missing_hashes' | 'no_events' | 'not_requested'
    totalEvents: number
    eventsWithHash: number
    eventsWithTimestamp: number
    hashCoverage: number
    timestampCoverage: number
    readyForSwapDetection: boolean
    missing: string[]
  }
  dataFreshness?: 'live' | 'cached' | 'partial'
  cacheAgeSeconds?: number | null
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
        transferArrayCount?: number
        reason: string
      }
      alchemy: { configured: boolean; behaviorAttempted: boolean; transfersReturned: number; reason: string }
      moralis?: {
        configured: boolean
        attempted: boolean
        usable: boolean
        holdingsReturned: number
        cacheHit: boolean
        reason: string
        httpStatus?: number | null
        chain?: string
      }
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
    snapshotCache?: {
      memoryHit: boolean
      persistentHit: boolean
      providerFetchNeeded: boolean
      refreshBypassedCache: boolean
      cacheAgeSeconds: number | null
      cacheTtlSeconds: number
    }
    moralis?: {
      configured: boolean
      attempted: boolean
      usable: boolean
      holdingsReturned: number
      cacheHit: boolean
      reason: string
      httpStatus?: number | null
    }
    providerFallback?: {
      primaryAttempted: boolean
      primaryUsable: boolean
      fallbackAttempted: boolean
      fallbackUsed: boolean
      tertiaryAttempted: boolean
      tertiaryUsed: boolean
      fallbackReason: string
      cacheHit: boolean
      reason: string
    }
    moralisUsage?: {
      attempted: boolean
      endpointNames: string[]
      requestedChain: MoralisChain
      callCount: number
      cacheHit: boolean
      deduped: boolean
      durationMs: number
      skippedReason: string | null
    }
    providerFlow?: {
      chainMode: 'auto' | 'base' | 'eth' | 'base_eth' | 'all_supported'
      minChainValueUsd: number
      supportedChains: MoralisChain[]
      discoveredChains: Array<{ chain: MoralisChain; usdValue: number }>
      activeChains: MoralisChain[]
      skippedDustChains: MoralisChain[]
      maxChainsBasicScan: number
      moralisChainsAttempted: MoralisChain[]
      moralisCallCount: number
      cacheHits: number
      dedupedCalls: number
      partialFailures: number
      goldrushAttempted: boolean
      goldrushSkippedReason: string | null
    }
    chainUsage?: {
      requestedChain: string
      chainMode: 'auto' | 'base' | 'eth' | 'base_eth' | 'all_supported'
      activeChains: MoralisChain[]
      alchemyChainsAttempted: string[]
      skippedChains: MoralisChain[]
      reason: string
    }
    walletProviderRouting?: {
      primaryProviders: string[]
      alchemyUsed: boolean
      alchemyMethods: string[]
      alchemyChainsUsed: string[]
      alchemyReason: string
      skippedAlchemyChains: string[]
      pageLoadTriggered: boolean
      zerionSucceeded: boolean
      goldrushBalancesSkipped: boolean
      deepScan: boolean
    }
    walletTxEvidenceDebug?: {
      sourceProvider: 'goldrush' | 'alchemy' | 'none'
      totalRawEvents: number
      eventsWithHash: number
      eventsWithTimestamp: number
      sampleHashes: string[]
      sampleTimestamps: string[]
      activityRequested?: boolean
      eventFetchAttempted?: boolean
      goldrushEthAttempted?: boolean
      goldrushBaseAttempted?: boolean
      alchemyAttempted?: boolean
      goldrushEthRawCount?: number
      goldrushBaseRawCount?: number
      alchemyRawCount?: number
      normalizedPnlEventCount?: number
      totalEvidenceEvents?: number
      eventsWithTxHash?: number
      missingHashCount?: number
      missingTimestampCount?: number
      skippedReasons?: string[]
      providerErrorSamples?: string[]
    }
  }
}

const ZERION_KEY       = process.env.ZERION_KEY ?? ''
const ALCHEMY_ETH_KEY  = process.env.ALCHEMY_ETHEREUM_KEY!
const ALCHEMY_BASE_KEY = process.env.ALCHEMY_BASE_KEY!
const GOLDRUSH_KEY     = process.env.GOLDRUSH_API_KEY ?? process.env.COVALENT_API_KEY ?? ''

export type WalletSnapshotOptions = { refresh?: boolean; chain?: 'eth' | 'base'; deepScan?: boolean; deepActivity?: boolean; chainMode?: 'auto' | 'base' | 'eth' | 'base_eth' | 'all_supported' }

const SNAPSHOT_TTL_MS         = 5  * 60 * 1000
const SNAPSHOT_HISTORY_TTL_MS = 15 * 60 * 1000
type SnapshotCacheEntry = { snapshot: WalletSnapshot; cachedAt: number; ttlMs: number }
const snapshotMemCache = new Map<string, SnapshotCacheEntry>()

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

export type WalletTxEvidence = {
  txHash: string
  timestamp: string | null
  fromAddress: string | null
  toAddress: string | null
  contract: string
  symbol: string
  amountRaw: string | null
  tokenDecimals: number | null
  amount: number
  usdValue: number | null
  direction: 'buy' | 'sell' | 'unknown'
  chain: string
}

type PnlEvent = {
  contract: string
  symbol: string
  direction: 'buy' | 'sell' | 'unknown'
  amount: number
  amountRaw: string | null
  tokenDecimals: number | null
  usdValue: number | null
  txHash: string | null
  timestamp: string | null
  fromAddress: string | null
  toAddress: string | null
  chain: string
}
type GoldrushHistoryDiag = {
  endpointKind: 'transfers_v2' | 'transactions_v3'
  chainUsed: string
  urlTemplate: string
  httpStatus: number | null
  fetchFailed: boolean
  failureStage: 'build_url' | 'fetch' | 'timeout' | 'empty_response' | 'no_items' | null
  rawItemCount: number
  normalizedEventCount: number
  firstEventShapeKeys: string[]
  transferArrayCount: number
  firstTransferKeys: string[]
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
  const finalUrl = new URL(`https://${host}/v1/${chain}/address/${normalizedWallet}/transactions_v3/`)
  finalUrl.searchParams.set('page-size', '50')
  finalUrl.searchParams.set('page-number', '0')
  finalUrl.searchParams.set('with-logs', 'true')
  finalUrl.searchParams.set('no-spam', 'true')

  const requestUrl = finalUrl.toString()

  return {
    requestUrl,
    requestHost: finalUrl.hostname,
    requestUrlValid: true,
    requestPathTemplate: '/v1/{chain}/address/{wallet}/transactions_v3/',
    urlTemplate: `https://${host}/v1/${chain}/address/{wallet}/transactions_v3/?page-size=50&page-number=0&with-logs=true&no-spam=true`,
  }
}

async function fetchGoldrushPnlEvents(address: string, chainName: string, apiKey: string): Promise<{ events: PnlEvent[]; diag: GoldrushHistoryDiag }> {
  const baseDiag = (chain: string): GoldrushHistoryDiag => ({ endpointKind: 'transactions_v3', chainUsed: chain, urlTemplate: `https://api.covalenthq.com/v1/${chain}/address/{wallet}/transactions_v3/?page-size=50&page-number=0&with-logs=true&no-spam=true`, httpStatus: null, fetchFailed: false, failureStage: null, rawItemCount: 0, normalizedEventCount: 0, firstEventShapeKeys: [], transferArrayCount: 0, firstTransferKeys: [], reason: '', fetchErrorKind: null, fetchErrorMessage: null, hasApiKey: Boolean(apiKey), requestHost: 'api.covalenthq.com', requestUrlValid: true, requestPathTemplate: '/v1/{chain}/address/{wallet}/transactions_v3/', authMode: apiKey ? 'bearer' : 'none', attemptedHosts: [] })
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
    const chainCandidates = chainName === 'base-mainnet' ? ['base-mainnet', '8453'] : [chainName]
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
        let errHint = ''
        try {
          const errBody = await res.json()
          const m = errBody?.error_message ?? errBody?.message ?? errBody?.error ?? ''
          if (typeof m === 'string' && m) errHint = sanitizeMessage(m.slice(0, 100))
        } catch { /* ignore parse errors */ }
        diag.failureStage = 'empty_response'
        diag.reason = errHint
          ? `GoldRush returned HTTP ${res.status}: ${errHint}`
          : `GoldRush returned HTTP ${res.status}.`
        diag.fetchErrorMessage = errHint || null
        lastAttemptDiag = finalizeDiag(diag)
        devLog(lastAttemptDiag)
        continue
      }
      const json = await res.json()
      const items: unknown[] = Array.isArray(json?.data?.items) ? json.data.items.slice(0, 50) : []
      diag.rawItemCount = items.length
      diag.firstEventShapeKeys = items[0] && typeof items[0] === 'object' ? Object.keys(items[0] as Record<string, unknown>).slice(0, 12) : []
      if (items.length === 0) {
        diag.failureStage = 'no_items'
        diag.reason = 'No transactions found for this address in the checked window.'
        const out = finalizeDiag(diag)
        devLog(out)
        return { events: [], diag: out }
      }
      const lower = address.toLowerCase()
      let transferArrayCount = 0
      const firstTransferKeysCapture: string[] = []
      const events = items.flatMap((it) => {
        const t = it as Record<string, unknown>
        const txHash = typeof t.tx_hash === 'string' ? t.tx_hash : null
        const timestamp = typeof t.block_signed_at === 'string' ? t.block_signed_at : null
        const logEvents: unknown[] = Array.isArray(t.log_events) ? t.log_events : []
        return logEvents.flatMap((logEvent) => {
          const le = logEvent as Record<string, unknown>
          const decoded = le.decoded as Record<string, unknown> | null | undefined
          if (!decoded || decoded.name !== 'Transfer') return []
          const params = Array.isArray(decoded.params) ? (decoded.params as Record<string, unknown>[]) : []
          const fromParam = params.find(p => p.name === 'from')
          const toParam = params.find(p => p.name === 'to')
          const valueParam = params.find(p => p.name === 'value')
          if (!fromParam || !toParam || !valueParam) return []
          transferArrayCount++
          if (firstTransferKeysCapture.length === 0) {
            firstTransferKeysCapture.push(...Object.keys(le).slice(0, 12))
          }
          const contract = String(le.sender_address ?? '').toLowerCase()
          const symbol = String(le.sender_contract_ticker_symbol ?? '?')
          const decimals = typeof le.sender_contract_decimals === 'number' ? le.sender_contract_decimals : 18
          const from = String(fromParam.value ?? '').toLowerCase()
          const to = String(toParam.value ?? '').toLowerCase()
          const rawValue = String(valueParam.value ?? '0')
          const amount = Math.abs(parseFloat(rawValue) / Math.pow(10, decimals))
          const direction: 'buy' | 'sell' | 'unknown' = to === lower ? 'buy' : from === lower ? 'sell' : 'unknown'
          return [{ contract, symbol, direction, amount, amountRaw: rawValue !== '0' ? rawValue : null, tokenDecimals: decimals, usdValue: null, txHash, timestamp, fromAddress: from, toAddress: to, chain: chainName }]
        })
      }).filter(e => e.contract.startsWith('0x') && e.amount > 0)
      diag.transferArrayCount = transferArrayCount
      diag.firstTransferKeys = firstTransferKeysCapture
      diag.normalizedEventCount = events.length
      if (items.length > 0 && transferArrayCount === 0) {
        diag.reason = 'Transactions returned but no decoded ERC20 Transfer log events found (logs may be unavailable for this API plan).'
      } else {
        diag.reason = events.length > 0 ? '' : 'Transfer events parsed but all filtered out (zero amount or non-contract addresses).'
      }
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
      fromBlock: '0x0', category: ['erc20'], withMetadata: true, maxCount: '0x7d', order: 'desc', fromAddress: address,
    }])
    const recv = await alchemyRpc(baseUrl, 'alchemy_getAssetTransfers', [{
      fromBlock: '0x0', category: ['erc20'], withMetadata: true, maxCount: '0x7d', order: 'desc', toAddress: address,
    }])
    const mapTransfer = (t: Record<string, unknown>, dir: 'buy' | 'sell'): PnlEvent => {
      const meta = t.metadata as Record<string, unknown> | undefined
      return {
        contract: String(((t.rawContract as Record<string, unknown> | undefined)?.address) ?? '').toLowerCase(),
        symbol: String(t.asset ?? '?'),
        direction: dir,
        amount: Number(t.value ?? 0),
        amountRaw: String((t.rawContract as Record<string, unknown> | undefined)?.value ?? '') || null,
        tokenDecimals: null,
        usdValue: null,
        txHash: typeof t.hash === 'string' ? t.hash : null,
        timestamp: typeof meta?.blockTimestamp === 'string' ? meta.blockTimestamp : null,
        fromAddress: typeof t.from === 'string' ? t.from.toLowerCase() : null,
        toAddress: typeof t.to === 'string' ? (t.to as string).toLowerCase() : null,
        chain: 'base',
      }
    }
    const outgoing = (resp?.transfers ?? []).slice(0, 125).map((t: Record<string, unknown>) => mapTransfer(t, 'sell'))
    const incoming = (recv?.transfers ?? []).slice(0, 125).map((t: Record<string, unknown>) => mapTransfer(t, 'buy'))
    return [...outgoing, ...incoming].filter(e => e.contract.startsWith('0x') && Number.isFinite(e.amount) && e.amount > 0)
  } catch { return [] }
}

function buildTxEvidenceFromEvents(events: PnlEvent[], requested: boolean): {
  evidenceList: WalletTxEvidence[]
  summary: WalletSnapshot['walletEvidenceSummary']
  debug: NonNullable<NonNullable<WalletSnapshot['_diagnostics']>['walletTxEvidenceDebug']>
} {
  if (!requested) {
    return {
      evidenceList: [],
      summary: { status: 'not_requested', totalEvents: 0, eventsWithHash: 0, eventsWithTimestamp: 0, hashCoverage: 0, timestampCoverage: 0, readyForSwapDetection: false, missing: ['deep_activity_not_requested'] },
      debug: { sourceProvider: 'none', totalRawEvents: 0, eventsWithHash: 0, eventsWithTimestamp: 0, sampleHashes: [], sampleTimestamps: [] },
    }
  }
  const evidenceList: WalletTxEvidence[] = events
    .filter(e => Boolean(e.txHash))
    .map(e => ({
      txHash: e.txHash!,
      timestamp: e.timestamp,
      fromAddress: e.fromAddress,
      toAddress: e.toAddress,
      contract: e.contract,
      symbol: e.symbol,
      amountRaw: e.amountRaw,
      tokenDecimals: e.tokenDecimals,
      amount: e.amount,
      usdValue: e.usdValue,
      direction: e.direction,
      chain: e.chain,
    }))

  const totalEvents = events.length
  const eventsWithHash = events.filter(e => Boolean(e.txHash)).length
  const eventsWithTimestamp = events.filter(e => Boolean(e.timestamp)).length
  const hashCoverage = totalEvents > 0 ? Math.round((eventsWithHash / totalEvents) * 100) : 0
  const timestampCoverage = totalEvents > 0 ? Math.round((eventsWithTimestamp / totalEvents) * 100) : 0
  const readyForSwapDetection = eventsWithHash > 0 && eventsWithTimestamp > 0

  const missing: string[] = []
  if (totalEvents === 0) {
    missing.push('no_transfer_events_indexed')
  } else {
    if (eventsWithHash < totalEvents) missing.push(`${totalEvents - eventsWithHash} events missing txHash`)
    if (eventsWithTimestamp < totalEvents) missing.push(`${totalEvents - eventsWithTimestamp} events missing timestamp`)
  }

  const status: WalletSnapshot['walletEvidenceSummary']['status'] =
    totalEvents === 0 ? 'no_events'
    : readyForSwapDetection ? 'ready'
    : eventsWithHash > 0 ? 'partial'
    : 'missing_hashes'

  const sourceProvider = events.length > 0
    ? (events[0].chain === 'base' && events.some(e => Boolean(e.usdValue)) ? 'goldrush' : 'alchemy')
    : 'none'

  return {
    evidenceList,
    summary: { status, totalEvents, eventsWithHash, eventsWithTimestamp, hashCoverage, timestampCoverage, readyForSwapDetection, missing },
    debug: {
      sourceProvider: sourceProvider as 'goldrush' | 'alchemy' | 'none',
      totalRawEvents: totalEvents,
      eventsWithHash,
      eventsWithTimestamp,
      sampleHashes: evidenceList.slice(0, 3).map(e => e.txHash),
      sampleTimestamps: evidenceList.slice(0, 3).map(e => e.timestamp ?? ''),
    },
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
      return { ...BEHAVIOR_EMPTY, status: 'ok', source: 'activity_layer' as const, txCount: 0, activeDays: 0, recentActivitySummary: 'No recent Base activity found in the checked window.' }
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
      status: 'ok', source: 'activity_layer' as const,
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

export async function fetchWalletSnapshot(address: string, options: WalletSnapshotOptions = {}): Promise<WalletSnapshot> {
  const { refresh = false, chain: requestedChain = 'base', deepScan = false, deepActivity = false, chainMode = 'auto' } = options
  // activityRequested: true when either deepScan (full holdings+activity) or deepActivity (activity-only) is set
  const activityRequested = deepScan || deepActivity
  // Separate address normalisation from cache key so regex validation always checks the address portion only
  const addrNorm = (address ?? '').trim().toLowerCase()
  const cacheKey = addrNorm + (activityRequested ? ':activity' : ':holdings')

  // Memory cache check — bypassed when refresh=true
  if (!refresh && /^0x[0-9a-fA-F]{40}$/i.test(addrNorm)) {
    const cached = snapshotMemCache.get(cacheKey)
    if (cached) {
      const ageMs = Date.now() - cached.cachedAt
      if (ageMs <= cached.ttlMs) {
        const cacheAgeSeconds = Math.floor(ageMs / 1000)
        return {
          ...cached.snapshot,
          dataFreshness: 'cached',
          cacheAgeSeconds,
          _diagnostics: cached.snapshot._diagnostics ? {
            ...cached.snapshot._diagnostics,
            snapshotCache: {
              memoryHit: true, persistentHit: false, providerFetchNeeded: false,
              refreshBypassedCache: false, cacheAgeSeconds, cacheTtlSeconds: cached.ttlMs / 1000,
            },
          } : undefined,
        }
      }
      snapshotMemCache.delete(cacheKey)
    }
  }

  const startedAt = Date.now()
  const addr: string = (address ?? '').trim()
  if (!addr || !/^0x[0-9a-fA-F]{40}$/i.test(addr)) {
    throw new Error('Invalid wallet address')
  }

  const ethUrl  = `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_ETH_KEY}`
  const baseUrl = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_BASE_KEY}`

  // ETH Alchemy calls only when explicitly requested — default is Base only
  const useEthAlchemy = requestedChain === 'eth' && Boolean(ALCHEMY_ETH_KEY)
  const nonceUrl = useEthAlchemy ? ethUrl : baseUrl

  // Determine Moralis chain before Phase 1 so it can run in the parallel batch.
  const _moralisChain: 'eth' | 'base' = requestedChain === 'eth' ? 'eth' : 'base'

  // Phase 1 (parallel): Zerion portfolio value + Moralis holdings (primary) + Alchemy metadata.
  // Zerion positions are fetched in parallel as a fallback_layer — used only if Moralis fails.
  // GoldRush excluded — runs only in Phase 3 (both primary/fallback fail) or deepScan=true.
  const [
    portfolioRes,    // Zerion: total portfolio value
    positionsRes,    // Zerion: token positions — fallback_layer only
    moralisRes,      // Moralis: primary holdings source
    ethFirst,
    baseFirst,
    nonceRes,
    behaviorRes,
    grPnlEthRes,
    grPnlBaseRes,
    alchemyPnlRes,
  ] = await Promise.allSettled([
    ZERION_KEY
      ? zerionGet(`wallets/${addr}/portfolio/`, { currency: 'usd' })
      : Promise.reject(new Error('Zerion key not configured')),
    ZERION_KEY
      ? zerionGet(`wallets/${addr}/positions/`, {
          currency: 'usd',
          'filter[positions]': 'only_simple',
          'filter[trash]': 'only_non_trash',
          sort: '-value',
          'page[size]': '50',
        })
      : Promise.reject(new Error('Zerion key not configured')),
    fetchMoralisBalances(addr, _moralisChain),  // handles not-configured internally
    useEthAlchemy ? getFirstTxOnChain(addr, ethUrl) : Promise.resolve(null),
    getFirstTxOnChain(addr, baseUrl),
    alchemyRpc(nonceUrl, 'eth_getTransactionCount', [addr, 'latest']),
    deepScan ? fetchWalletBehavior(addr, baseUrl) : Promise.resolve(BEHAVIOR_EMPTY),
    // ETH mainnet PnL transfers only when activity is requested AND ETH chain is selected.
    // Default (base) scans skip this to avoid a wasted transactions_v3 call.
    activityRequested && GOLDRUSH_KEY && useEthAlchemy ? fetchGoldrushPnlEvents(addr, 'eth-mainnet', GOLDRUSH_KEY) : Promise.resolve({ events: [] as PnlEvent[], diag: { endpointKind: 'transactions_v3' as const, chainUsed: 'eth-mainnet', urlTemplate: 'https://api.covalenthq.com/v1/eth-mainnet/address/{wallet}/transactions_v3/?page-size=50&page-number=0&with-logs=true&no-spam=true', httpStatus: null, fetchFailed: true, failureStage: 'build_url' as const, rawItemCount: 0, normalizedEventCount: 0, firstEventShapeKeys: [], transferArrayCount: 0, firstTransferKeys: [], reason: activityRequested ? 'ETH chain not requested — skipped to reduce API usage.' : 'Activity scan not requested — skipped.' } }),
    activityRequested && GOLDRUSH_KEY ? fetchGoldrushPnlEvents(addr, 'base-mainnet', GOLDRUSH_KEY) : Promise.resolve({ events: [] as PnlEvent[], diag: { endpointKind: 'transactions_v3' as const, chainUsed: 'base-mainnet', urlTemplate: 'https://api.covalenthq.com/v1/base-mainnet/address/{wallet}/transactions_v3/?page-size=50&page-number=0&with-logs=true&no-spam=true', httpStatus: null, fetchFailed: true, failureStage: 'build_url' as const, rawItemCount: 0, normalizedEventCount: 0, firstEventShapeKeys: [], transferArrayCount: 0, firstTransferKeys: [], reason: activityRequested ? 'GoldRush activity fetch skipped — provider not configured.' : 'Activity scan not requested — skipped.' } }),
    activityRequested && Boolean(ALCHEMY_BASE_KEY) ? fetchAlchemyPnlEvents(addr, baseUrl) : Promise.resolve([] as PnlEvent[]),
  ])

  // ── Tx / age / nonce ──
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

  // ── Provider values extracted from Phase 1 results ──
  // Zerion portfolio total (for wallet value only — not for individual token positions)
  const _zerionPortfolioTotal: number | null = portfolioRes.status === 'fulfilled'
    ? (portfolioRes.value?.data?.attributes?.total?.positions ?? null)
    : null
  const _zerionValueUsable = typeof _zerionPortfolioTotal === 'number' && _zerionPortfolioTotal > 0

  // Zerion positions (fallback_layer only — lower priority than Moralis)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawPos: any[] = positionsRes.status === 'fulfilled' ? (positionsRes.value?.data ?? []) : []
  const _zerionPositionsUsable = rawPos.length > 0

  // Moralis holdings (primary source)
  const _moralisResult: MoralisFetchResult = moralisRes.status === 'fulfilled'
    ? moralisRes.value
    : { holdings: [], attempted: true, usable: false, cacheHit: false, reason: 'fetch_error' }
  const _moralisHoldingsUsable = _moralisResult.usable && _moralisResult.holdings.length > 0
  const _moralisAttempted = Boolean(process.env.MORALIS_API_KEY)

  // ── Provider selection: Moralis (primary) → Zerion positions (fallback) → GoldRush ──
  let holdings: Holding[] = []
  let totalValue = 0
  let providerUsed: 'portfolio_layer' | 'holdings_layer' | 'fallback_layer' | 'unverified' | 'none' = 'none'
  let providerStatus: 'ok' | 'partial' | 'failed' = 'failed'
  let reason = ''

  if (_moralisHoldingsUsable) {
    // Moralis is primary — use its holdings with Zerion portfolio value when available
    holdings = _moralisResult.holdings as Holding[]
    totalValue = _zerionValueUsable
      ? _zerionPortfolioTotal!
      : holdings.reduce((s, h) => s + h.value, 0)
    providerUsed = _zerionValueUsable ? 'portfolio_layer' : 'holdings_layer'
    providerStatus = _zerionValueUsable ? 'ok' : 'partial'
    if (!_zerionValueUsable) reason = 'Portfolio value estimated from holdings — could not verify total.'
  } else if (_zerionPositionsUsable) {
    // Moralis failed — use Zerion positions as fallback_layer for holdings
    holdings = rawPos
      .map((pos) => {
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
    totalValue = _zerionPortfolioTotal ?? holdings.reduce((s, h) => s + h.value, 0)
    providerUsed = 'fallback_layer'
    providerStatus = 'partial'
    reason = 'Holdings from fallback layer — data may be incomplete.'
  } else {
    reason = positionsRes.status === 'rejected' && moralisRes.status === 'rejected'
      ? 'Portfolio layer and holdings layer both unavailable.'
      : 'No token balances found for this wallet.'
  }

  const minChainValueUsd = 1
  const maxChainsBasicScan = 5
  const supportedMoralisChains: MoralisChain[] = ['eth', 'base', 'polygon', 'bsc', 'arbitrum', 'optimism', 'avalanche', 'fantom', 'cronos', 'gnosis']
  const mapChain = (raw: string): MoralisChain | null => {
    const c = raw.toLowerCase()
    if (c === 'eth' || c.includes('ethereum')) return 'eth'
    if (c.includes('base')) return 'base'
    if (c.includes('polygon') || c === 'matic') return 'polygon'
    if (c.includes('binance') || c.includes('bsc')) return 'bsc'
    if (c.includes('arbitrum')) return 'arbitrum'
    if (c.includes('optimism')) return 'optimism'
    if (c.includes('avalanche')) return 'avalanche'
    if (c.includes('fantom')) return 'fantom'
    if (c.includes('cronos')) return 'cronos'
    if (c.includes('gnosis') || c.includes('xdai')) return 'gnosis'
    return null
  }
  const chainValueMap = new Map<MoralisChain, number>()
  for (const h of holdings) {
    const rawChain = String(h.chain ?? '').toLowerCase()
    const mapped = mapChain(rawChain)
    if (!mapped) continue
    chainValueMap.set(mapped, (chainValueMap.get(mapped) ?? 0) + (h.value ?? 0))
  }
  const discoveredChains = [...chainValueMap.entries()].map(([chain, usdValue]) => ({ chain, usdValue })).sort((a,b)=>b.usdValue-a.usdValue)
  const skippedDustChains = discoveredChains.filter(c => c.usdValue < minChainValueUsd).map(c => c.chain)
  let activeChains: MoralisChain[] = []
  if (chainMode === 'base') activeChains = ['base']
  else if (chainMode === 'eth') activeChains = ['eth']
  else if (chainMode === 'base_eth') activeChains = ['base','eth']
  else if (chainMode === 'all_supported' && deepScan) activeChains = [...supportedMoralisChains]
  else activeChains = discoveredChains.filter(c => c.usdValue >= minChainValueUsd).map(c => c.chain)
  if (activeChains.length === 0 && (requestedChain === 'base' || requestedChain === 'eth')) activeChains = [requestedChain]
  if (activeChains.length === 0) activeChains = ['base', 'eth']
  activeChains = activeChains.filter((c, i, a) => supportedMoralisChains.includes(c) && a.indexOf(c) === i).slice(0, chainMode === 'all_supported' && deepScan ? supportedMoralisChains.length : maxChainsBasicScan)

  // Moralis holdings layer for active chains.
  let grEthRes: PromiseSettledResult<Holding[]>
  let grBaseRes: PromiseSettledResult<Holding[]>
  const _moralisByChain = new Map<MoralisChain, MoralisFetchResult>()
  let _moralisUsed = false
  if (Boolean(process.env.MORALIS_API_KEY)) {
    for (const c of activeChains) _moralisByChain.set(c, await fetchMoralisBalances(addr, c))
    const moralisHoldings = [..._moralisByChain.values()].flatMap((r) => r.holdings).sort((a, b) => b.value - a.value)

    if (moralisHoldings.length > 0) {
      holdings = moralisHoldings as Holding[]
      totalValue = holdings.reduce((s, h) => s + h.value, 0)
      providerStatus = 'partial'
      reason = ''
      _moralisUsed = true
    }
  }
  // GoldRush balances fallback only when Moralis has no usable holdings for active chains, or deepScan=true.
  const _goldrushBalancesSkipped = !deepScan && _moralisUsed
  const _goldrushSkippedReason = _goldrushBalancesSkipped ? 'moralis_holdings_available' : null
  if (_goldrushBalancesSkipped) {
    grEthRes = { status: 'fulfilled', value: [] }; grBaseRes = { status: 'fulfilled', value: [] }
  } else {
    ;[grEthRes, grBaseRes] = await Promise.allSettled([
      GOLDRUSH_KEY && (deepScan || !_moralisUsed) ? fetchGoldrushBalances(addr, 'eth-mainnet', GOLDRUSH_KEY) : Promise.resolve([] as Holding[]),
      GOLDRUSH_KEY && (deepScan || !_moralisUsed) ? fetchGoldrushBalances(addr, 'base-mainnet', GOLDRUSH_KEY) : Promise.resolve([] as Holding[]),
    ])
  }
  const _grPrimaryAttempted = Boolean(GOLDRUSH_KEY) && (deepScan || !_moralisUsed)
  const _preFallbackReason = reason
  const _grPrimaryUsable = false
  if (holdings.length === 0) {
    const grHoldings = [
      ...(grEthRes.status === 'fulfilled' ? grEthRes.value : []),
      ...(grBaseRes.status === 'fulfilled' ? grBaseRes.value : []),
    ].sort((a, b) => b.value - a.value)
    if (grHoldings.length > 0) {
      holdings = grHoldings
      totalValue = holdings.reduce((s, h) => s + h.value, 0)
      providerStatus = 'partial'
      reason = ''
    }
  }

  if (holdings.length === 0 && !reason) {
    reason = 'No token balances found on supported chains.'
  }

  const grEth = grPnlEthRes.status === 'fulfilled' ? grPnlEthRes.value : { events: [] as PnlEvent[], diag: { endpointKind: 'transactions_v3' as const, chainUsed: 'eth-mainnet', urlTemplate: 'https://api.covalenthq.com/v1/eth-mainnet/address/{wallet}/transactions_v3/?page-size=50&page-number=0&with-logs=true&no-spam=true', httpStatus: null, fetchFailed: true, failureStage: 'fetch' as const, rawItemCount: 0, normalizedEventCount: 0, firstEventShapeKeys: [], transferArrayCount: 0, firstTransferKeys: [], reason: 'GoldRush transaction history request failed before response.' } }
  const grPnlBaseOut = grPnlBaseRes.status === 'fulfilled' ? grPnlBaseRes.value : { events: [] as PnlEvent[], diag: { endpointKind: 'transactions_v3' as const, chainUsed: 'base-mainnet', urlTemplate: 'https://api.covalenthq.com/v1/base-mainnet/address/{wallet}/transactions_v3/?page-size=50&page-number=0&with-logs=true&no-spam=true', httpStatus: null, fetchFailed: true, failureStage: 'fetch' as const, rawItemCount: 0, normalizedEventCount: 0, firstEventShapeKeys: [], transferArrayCount: 0, firstTransferKeys: [], reason: 'GoldRush transaction history request failed before response.' } }
  const grBase = grPnlBaseOut
  const goldrushTransferDiags = [grEth.diag, grBase.diag]
  const baseTransferDiag = goldrushTransferDiags.find((d) => d.chainUsed === '8453' || d.chainUsed === 'base-mainnet') ?? goldrushTransferDiags[0]
  const grEvents = [...grEth.events, ...grBase.events]
  const alchemyEvents = alchemyPnlRes.status === 'fulfilled' ? alchemyPnlRes.value : []
  const valuedGrEvents = grEvents.filter((e) => (e.usdValue ?? 0) > 0)
  const events = grEvents.length > 0 ? grEvents : alchemyEvents
  const _pnlSourceRaw: 'goldrush' | 'alchemy' | 'none' = grEvents.length > 0 ? 'goldrush' : alchemyEvents.length > 0 ? 'alchemy' : 'none'
  const pnlSource: 'activity_layer' | 'fallback_layer' | 'none' = _pnlSourceRaw === 'goldrush' ? 'activity_layer' : _pnlSourceRaw === 'alchemy' ? 'fallback_layer' : 'none'
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
    ? (pnlSource === 'none' ? 'Enable Deep Activity Scan for full transfer history and cost-basis estimation.' : 'Historical cost basis coverage is too low for a reliable estimate.')
    : 'Estimated from indexed transfer history with average-cost method.'
  const pnlSourcePublic: 'activity_layer' | 'fallback_layer' | 'unavailable' = pnlSource === 'none' ? 'unavailable' : pnlSource
  const estimatedPnl: WalletSnapshot['estimatedPnl'] = { status, confidence: status === 'unavailable' ? null : confidenceFromCoverage(coveragePercent), coveragePercent, source: pnlSourcePublic === 'unavailable' ? 'none' : pnlSourcePublic, totalEstimatedPnlUsd: status === 'unavailable' ? null : realized + unrealized, unrealizedPnlUsd: status === 'unavailable' ? null : unrealized, realizedPnlUsd: status === 'unavailable' ? null : realized, method: 'average_cost_estimate', tokens: filteredPnlTokens, reason: status === 'unavailable' ? 'PnL unavailable — historical cost basis coverage is too low.' : 'Estimated PnL Beta derived from indexed wallet transfer history.' }
  const { summary: walletEvidenceSummary, debug: _txEvidenceDebugBase } = buildTxEvidenceFromEvents(events, activityRequested)
  const _grEthAttempted = activityRequested && Boolean(GOLDRUSH_KEY) && useEthAlchemy
  const _grBaseAttempted = activityRequested && Boolean(GOLDRUSH_KEY)
  const _alchemyAttempted = activityRequested && Boolean(ALCHEMY_BASE_KEY)
  const _txSkippedReasons: string[] = []
  if (!activityRequested) {
    _txSkippedReasons.push('activity_not_requested')
  } else {
    if (!GOLDRUSH_KEY) _txSkippedReasons.push('goldrush_not_configured')
    if (!useEthAlchemy) _txSkippedReasons.push('goldrush_eth_skipped_chain_not_eth')
    if (!ALCHEMY_BASE_KEY) _txSkippedReasons.push('alchemy_not_configured')
  }
  const _txProviderErrors: string[] = []
  const _grEthErrMsg = 'fetchErrorMessage' in grEth.diag ? (grEth.diag as GoldrushHistoryDiag).fetchErrorMessage : undefined
  const _grBaseErrMsg = 'fetchErrorMessage' in grBase.diag ? (grBase.diag as GoldrushHistoryDiag).fetchErrorMessage : undefined
  if (_grEthErrMsg) _txProviderErrors.push(`grEth: ${_grEthErrMsg}`)
  if (_grBaseErrMsg) _txProviderErrors.push(`grBase: ${_grBaseErrMsg}`)
  const _txEvidenceDebug = {
    ..._txEvidenceDebugBase,
    activityRequested,
    eventFetchAttempted: _grEthAttempted || _grBaseAttempted || _alchemyAttempted,
    goldrushEthAttempted: _grEthAttempted,
    goldrushBaseAttempted: _grBaseAttempted,
    alchemyAttempted: _alchemyAttempted,
    goldrushEthRawCount: grEth.diag.rawItemCount ?? 0,
    goldrushBaseRawCount: grBase.diag.rawItemCount ?? 0,
    alchemyRawCount: alchemyEvents.length,
    normalizedPnlEventCount: events.length,
    totalEvidenceEvents: _txEvidenceDebugBase.totalRawEvents,
    eventsWithTxHash: _txEvidenceDebugBase.eventsWithHash,
    missingHashCount: _txEvidenceDebugBase.totalRawEvents - _txEvidenceDebugBase.eventsWithHash,
    missingTimestampCount: _txEvidenceDebugBase.totalRawEvents - _txEvidenceDebugBase.eventsWithTimestamp,
    skippedReasons: _txSkippedReasons,
    providerErrorSamples: _txProviderErrors.slice(0, 3),
  }
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
  const _zerionSucceeded = _zerionValueUsable || _zerionPositionsUsable
  if (process.env.NODE_ENV !== 'production') {
    console.log('[wallet-diag] route=/api/wallet deepScan=', deepScan, 'requestedChain=', requestedChain, 'zerionValueUsable=', _zerionValueUsable, 'zerionPositionsUsable=', _zerionPositionsUsable, 'moralisHoldingsUsable=', _moralisHoldingsUsable, 'goldrushBalancesSkipped=', _goldrushBalancesSkipped, 'goldrushEventsReturned=', grEvents.length, 'pnlSource=', pnlSource, 'providerUsed=', providerUsed, 'totalMs=', Date.now() - startedAt)
  }

  const alchemyBaseUsed = Boolean(ALCHEMY_BASE_KEY)
  const walletProviderRouting = {
    primaryProviders: [
      ...(ZERION_KEY ? ['zerion'] : []),
      ...(GOLDRUSH_KEY ? ['goldrush'] : []),
      ...(process.env.MORALIS_API_KEY ? ['moralis'] : []),
    ],
    alchemyUsed: alchemyBaseUsed,
    alchemyMethods: alchemyBaseUsed
      ? ['alchemy_getAssetTransfers', 'eth_getTransactionCount']
      : [],
    alchemyChainsUsed: [
      ...(useEthAlchemy ? ['eth'] : []),
      ...(alchemyBaseUsed ? ['base'] : []),
    ],
    alchemyReason: useEthAlchemy
      ? 'first_tx_both_chains_nonce_eth_plus_base_behavior'
      : 'base_first_tx_nonce_and_behavior_only',
    skippedAlchemyChains: useEthAlchemy ? [] : (ALCHEMY_ETH_KEY ? ['eth'] : []),
    pageLoadTriggered: false,
    zerionSucceeded: _zerionValueUsable || _zerionPositionsUsable,
    goldrushBalancesSkipped: _goldrushBalancesSkipped,
    deepScan,
  }

  const hasHistory = estimatedPnl.status !== 'unavailable'
  const snapshotTtlMs = hasHistory ? SNAPSHOT_HISTORY_TTL_MS : SNAPSHOT_TTL_MS
  const snapshot: WalletSnapshot = {
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
    pnlSource: pnlSourcePublic,
    pnlCoverageReason,
    hiddenDustCount,
    unpricedHoldingsCount,
    walletBehavior,
    estimatedPnl,
    walletEvidenceSummary,
    dataFreshness: 'live',
    cacheAgeSeconds: null,
    _diagnostics: {
      providers: {
        zerion: { configured: Boolean(ZERION_KEY), attempted: true, succeeded: _zerionValueUsable || _zerionPositionsUsable },
        goldrush: {
          configured: goldrushConfigured,
          balancesAttempted: !_goldrushBalancesSkipped && goldrushConfigured,
          transactionsAttempted: activityRequested && goldrushConfigured,
          transfersAttempted: activityRequested && goldrushConfigured,
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
          transferArrayCount: (grBase.diag as GoldrushHistoryDiag | undefined)?.transferArrayCount ?? 0,
        },
        alchemy: {
          configured: alchemyConfigured,
          behaviorAttempted: alchemyConfigured,
          transfersReturned: behaviorTxCount,
          reason: behaviorRes.status === 'fulfilled' ? '' : 'Behavior check unavailable from current checks.',
        },
        moralis: {
          configured: Boolean(process.env.MORALIS_API_KEY),
          attempted: [..._moralisByChain.values()].some((r) => r.attempted),
          usable: [..._moralisByChain.values()].some((r) => r.usable),
          holdingsReturned: [..._moralisByChain.values()].reduce((n, r) => n + r.holdings.length, 0),
          cacheHit: [..._moralisByChain.values()].some((r) => r.cacheHit),
          reason: [..._moralisByChain.values()].map((r) => r.reason).find(Boolean) || '',
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
      snapshotCache: {
        memoryHit: false, persistentHit: false, providerFetchNeeded: true,
        refreshBypassedCache: refresh, cacheAgeSeconds: null, cacheTtlSeconds: snapshotTtlMs / 1000,
      },
      providerFallback: {
        primaryAttempted: _grPrimaryAttempted,
        primaryUsable: _grPrimaryUsable,
        fallbackAttempted: [..._moralisByChain.values()].some((r) => r.attempted),
        fallbackUsed: _moralisUsed,
        tertiaryAttempted: _grPrimaryAttempted,
        tertiaryUsed: !_moralisUsed && _grPrimaryUsable,
        fallbackReason: _preFallbackReason,
        cacheHit: [..._moralisByChain.values()].some((r) => r.cacheHit),
        reason: _moralisUsed
          ? 'moralis_holdings_used'
          : holdings.length > 0
          ? 'primary_ok'
          : 'all_providers_empty',
      },
      moralisUsage: {
        attempted: [..._moralisByChain.values()].some((r) => r.attempted),
        endpointNames: ['erc20_holdings'],
        requestedChain: activeChains[0] ?? requestedChain,
        callCount: [..._moralisByChain.values()].filter((r) => r.attempted).length,
        cacheHit: [..._moralisByChain.values()].some((r) => r.cacheHit),
        deduped: false,
        durationMs: Date.now() - startedAt,
        skippedReason: [..._moralisByChain.values()].length === 0 ? 'fallback_not_needed' : null,
      },
      providerFlow: {
        chainMode,
        supportedChains: supportedMoralisChains,
        minChainValueUsd,
        discoveredChains,
        activeChains,
        skippedDustChains,
        maxChainsBasicScan,
        moralisChainsAttempted: [..._moralisByChain.entries()].filter(([,r]) => r.attempted).map(([c]) => c),
        moralisCallCount: [..._moralisByChain.values()].filter((r) => r.attempted).length,
        cacheHits: [..._moralisByChain.values()].filter((r) => r.cacheHit).length,
        dedupedCalls: 0,
        partialFailures: [..._moralisByChain.values()].filter((r) => r.attempted && !r.usable).length,
        goldrushAttempted: _grPrimaryAttempted,
        goldrushSkippedReason: _grPrimaryAttempted ? null : (_moralisUsed ? 'moralis_holdings_available' : 'not_required'),
      },
      chainUsage: {
        requestedChain,
        chainMode,
        activeChains,
        alchemyChainsAttempted: [
          ...(useEthAlchemy ? ['eth'] : []),
          'base',
        ],
        skippedChains: supportedMoralisChains.filter((c) => !activeChains.includes(c)),
        reason: chainMode === 'all_supported' && !deepScan
          ? 'all_supported_requires_deep_scan; reverted to discovered or fallback chains'
          : activeChains.length > 0
          ? 'active_chain_gating_applied'
          : 'fallback_base_eth',
      },
      walletProviderRouting,
      walletTxEvidenceDebug: _txEvidenceDebug,
    },
  }
  if (/^0x[0-9a-fA-F]{40}$/i.test(addrNorm)) snapshotMemCache.set(cacheKey, { snapshot, cachedAt: Date.now(), ttlMs: snapshotTtlMs })
  return snapshot
}
