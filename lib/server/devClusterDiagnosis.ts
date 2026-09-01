// TOKEN SCANNER DEV MAP / CLUSTER DIAGNOSIS — SERVER, DISCLOSED.
//
// Overlay for Token Scanner Dev Map + Cluster Wallets. Fills gaps with:
// cache → GoldRush → Alchemy (skip 400/unsupported, never retry) → Blockscout/explorer.
// Never fakes a deployer or linked wallet. Never treats a skipped Alchemy graph as "0 mapped".

import { RPC } from '@/lib/rpc'
import { getRobinhoodRpcUrl, ROBINHOOD_CHAIN_EXPLORER_URL } from '@/lib/server/robinhoodChainConfig'
import { getTokenCache, setTokenCache } from '@/lib/server/cache/tokenCache'
import {
  alchemyShouldSkipAndNotRetry,
  buildDevClusterCacheKey,
  classifyAlchemyRpcError,
  clusterSupplyFromHolders,
  creatorInTopHoldersFromRows,
  deriveHolderConcentrationFromTransfers,
  emptyAlchemyRpcHealth,
  emptyDevClusterDiagnosisAudit,
  finalizeDevClusterStatuses,
  isDevClusterCacheHitValid,
  isUsableDevClusterWallet,
  linkedWalletsFromTransfers,
  normalizeDevClusterAddress,
  separateFactoryAndOrigin,
  type AlchemyRpcHealth,
  type DevClusterChainSlug,
  type DevClusterDiagnosisAudit,
  type DevClusterHolderRow,
  type DevClusterLinkedWallet,
  type DevClusterTransfer,
  type DevMapStatus,
  type LinkedWalletGraphStatus,
  type ProviderRowsHealth,
} from '@/lib/devClusterDiagnosis'

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>

export interface DevClusterExistingEvidence {
  deployerAddress?: string | null
  deployerStatus?: string | null
  creationTxHash?: string | null
  originDiscoveryAttempted?: boolean
  holders?: DevClusterHolderRow[]
  holderPercentsAvailable?: boolean
  linkedWallets?: DevClusterLinkedWallet[]
  linkedGraphStatus?: 'ok' | 'none_found' | 'limited_check' | 'skipped' | null
  linkedGraphReason?: string | null
  transfers?: DevClusterTransfer[]
  totalSupplyRaw?: string | null
}

export interface ResolveDevClusterInput {
  chainSlug: DevClusterChainSlug
  chainId: number
  tokenAddress: string
  existing?: DevClusterExistingEvidence
  fetchImpl?: FetchImpl
  skipNetwork?: boolean
  goldrushKey?: string | null
  alchemyRpcUrl?: string | null
  cacheGet?: (key: string) => Promise<unknown>
  cacheSet?: (key: string, value: unknown, ttlSeconds: number) => Promise<void>
}

export interface DevClusterDiagnosisResult {
  audit: DevClusterDiagnosisAudit
  originAddress: string | null
  factoryAddress: string | null
  deployerAddress: string | null
  creationTxHash: string | null
  deployerConfidence: 'high' | 'medium' | 'low'
  deployerStatus: 'confirmed' | 'possible_match' | 'not_confirmed'
  linkedWallets: DevClusterLinkedWallet[]
  graphRan: boolean
  holders: DevClusterHolderRow[]
  holdersSource: DevClusterDiagnosisAudit['holderResolution']['holdersSource']
  top1Pct: number | null
  top10Pct: number | null
  top20Pct: number | null
  creatorInTopHolders: boolean | null
  clusterSupplyPercent: number | null
  finalDevMapStatus: DevMapStatus
  finalClusterStatus: DevMapStatus
  finalReason: string
}

const GOLDRUSH_HOST = 'api.covalenthq.com'
const TIMEOUT_MS = 7_000
const CACHE_TTL_SECONDS = 300

const GOLDRUSH_SLUGS: Record<DevClusterChainSlug, string[]> = {
  eth: ['eth-mainnet', '1'],
  base: ['base-mainnet', '8453'],
  bnb: ['bsc-mainnet', '56'],
  polygon: ['matic-mainnet', '137'],
  robinhood: ['robinhood-mainnet', '4663'],
}

const BLOCKSCOUT_BASE: Record<DevClusterChainSlug, string | null> = {
  eth: 'https://eth.blockscout.com',
  base: 'https://base.blockscout.com',
  bnb: 'https://bsc.blockscout.com',
  polygon: 'https://polygon.blockscout.com',
  robinhood: ROBINHOOD_CHAIN_EXPLORER_URL,
}

const ETHERSCAN_V2 = 'https://api.etherscan.io/v2/api'

type HttpJson = { ok: boolean; status: number; json: unknown; error: string | null }

async function httpGet(fetchImpl: FetchImpl, url: string, headers?: Record<string, string>): Promise<HttpJson> {
  try {
    const res = await fetchImpl(url, {
      cache: 'no-store',
      headers: { accept: 'application/json', ...(headers ?? {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return { ok: false, status: res.status, json: null, error: `http_${res.status}` }
    const json = await res.json().catch(() => null)
    if (json == null) return { ok: false, status: res.status, json: null, error: 'invalid_json' }
    return { ok: true, status: res.status, json, error: null }
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    return { ok: false, status: 0, json: null, error: timedOut ? 'timeout' : 'network_error' }
  }
}

function goldrushItems(json: unknown): unknown[] {
  const rec = json as { data?: { items?: unknown[] }; items?: unknown[] } | null
  if (Array.isArray(rec?.data?.items)) return rec!.data!.items as unknown[]
  if (Array.isArray(rec?.items)) return rec!.items as unknown[]
  return []
}

function asAddr(value: unknown): string | null {
  if (typeof value === 'string') return normalizeDevClusterAddress(value)
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>
    return normalizeDevClusterAddress(rec.hash ?? rec.address ?? rec.address_hash ?? null)
  }
  return null
}

function goldrushTransfers(json: unknown, tokenAddress: string): DevClusterTransfer[] {
  const out: DevClusterTransfer[] = []
  for (const item of goldrushItems(json)) {
    const rec = item as Record<string, unknown>
    const from = asAddr(rec.from_address ?? rec.from)
    const to = asAddr(rec.to_address ?? rec.to)
    if (!from && !to) continue
    out.push({
      from,
      to,
      amountRaw: rec.value != null ? String(rec.value) : rec.delta != null ? String(rec.delta) : null,
      txHash: typeof rec.tx_hash === 'string' ? rec.tx_hash : typeof rec.transaction_hash === 'string' ? rec.transaction_hash : null,
      timestamp: typeof rec.block_signed_at === 'string' ? rec.block_signed_at : null,
      category: 'erc20',
      asset: 'token',
    })
  }
  return out.filter((t) => isUsableDevClusterWallet(t.from, tokenAddress) || isUsableDevClusterWallet(t.to, tokenAddress))
}

function goldrushHolders(json: unknown, tokenAddress: string): { rows: DevClusterHolderRow[]; totalSupplyRaw: string | null } {
  const rows: DevClusterHolderRow[] = []
  let totalSupplyRaw: string | null = null
  for (const [i, item] of goldrushItems(json).entries()) {
    const rec = item as Record<string, unknown>
    const address = asAddr(rec.address ?? rec.holder_address ?? rec.wallet_address)
    if (!isUsableDevClusterWallet(address, tokenAddress)) continue
    const balance = rec.balance != null ? String(rec.balance) : null
    if (!totalSupplyRaw && rec.total_supply != null) totalSupplyRaw = String(rec.total_supply)
    let percent: number | null = null
    const rawPct = rec.share ?? rec.percentage ?? rec.percent ?? rec.percent_of_supply
    if (typeof rawPct === 'number' && Number.isFinite(rawPct)) percent = rawPct > 1 && rawPct <= 100 ? rawPct : rawPct <= 1 ? rawPct * 100 : null
    if (percent == null && balance && totalSupplyRaw && /^\d+$/.test(balance) && /^\d+$/.test(totalSupplyRaw) && BigInt(totalSupplyRaw) > BigInt(0)) {
      percent = Number((BigInt(balance) * BigInt(10000)) / BigInt(totalSupplyRaw)) / 100
    }
    rows.push({ address, percent: percent != null && Number.isFinite(percent) ? percent : null, balanceRaw: balance, rank: i + 1 })
  }
  return { rows, totalSupplyRaw }
}

function blockscoutHolders(json: unknown, tokenAddress: string): DevClusterHolderRow[] {
  const items = Array.isArray((json as { items?: unknown[] } | null)?.items) ? (json as { items: unknown[] }).items : []
  const rows: DevClusterHolderRow[] = []
  for (const [i, item] of items.entries()) {
    const rec = item as Record<string, unknown>
    const address = asAddr(rec.address)
    if (!isUsableDevClusterWallet(address, tokenAddress)) continue
    const value = rec.value != null ? String(rec.value) : rec.balance != null ? String(rec.balance) : null
    const tokenObj = rec.token && typeof rec.token === 'object' ? rec.token as Record<string, unknown> : null
    const total = tokenObj?.total_supply != null ? String(tokenObj.total_supply) : null
    let percent: number | null = null
    if (value && total && /^\d+$/.test(value) && /^\d+$/.test(total) && BigInt(total) > BigInt(0)) {
      percent = Number((BigInt(value) * BigInt(10000)) / BigInt(total)) / 100
    }
    rows.push({ address, percent: percent != null && Number.isFinite(percent) ? percent : null, balanceRaw: value, rank: i + 1 })
  }
  return rows
}

function blockscoutTransfers(json: unknown, tokenAddress: string): DevClusterTransfer[] {
  const items = Array.isArray((json as { items?: unknown[] } | null)?.items) ? (json as { items: unknown[] }).items : []
  const out: DevClusterTransfer[] = []
  for (const item of items) {
    const rec = item as Record<string, unknown>
    const from = asAddr(rec.from)
    const to = asAddr(rec.to)
    const total = rec.total && typeof rec.total === 'object' ? (rec.total as Record<string, unknown>).value : rec.total
    out.push({
      from,
      to,
      amountRaw: total != null ? String(total) : null,
      txHash: typeof rec.tx_hash === 'string' ? rec.tx_hash : typeof rec.transaction_hash === 'string' ? rec.transaction_hash : null,
      timestamp: typeof rec.timestamp === 'string' ? rec.timestamp : null,
      category: 'erc20',
      asset: 'token',
    })
  }
  return out.filter((t) => isUsableDevClusterWallet(t.from, tokenAddress) || isUsableDevClusterWallet(t.to, tokenAddress))
}

function alchemyTransfers(result: unknown, tokenAddress: string): DevClusterTransfer[] {
  const transfers = Array.isArray((result as { transfers?: unknown[] } | null)?.transfers)
    ? (result as { transfers: unknown[] }).transfers
    : Array.isArray(result) ? result : []
  const out: DevClusterTransfer[] = []
  for (const item of transfers) {
    const rec = item as Record<string, unknown>
    const meta = rec.metadata && typeof rec.metadata === 'object' ? rec.metadata as Record<string, unknown> : null
    out.push({
      from: asAddr(rec.from),
      to: asAddr(rec.to),
      amountRaw: rec.value != null ? String(rec.value) : rec.rawContract && typeof rec.rawContract === 'object'
        ? String((rec.rawContract as Record<string, unknown>).value ?? '')
        : null,
      txHash: typeof rec.hash === 'string' ? rec.hash : null,
      timestamp: typeof meta?.blockTimestamp === 'string' ? meta.blockTimestamp : null,
      category: typeof rec.category === 'string' ? rec.category : 'erc20',
      asset: typeof rec.asset === 'string' ? rec.asset : 'token',
    })
  }
  return out.filter((t) => isUsableDevClusterWallet(t.from, tokenAddress) || isUsableDevClusterWallet(t.to, tokenAddress))
}

function applyHolderPercentsFromSupply(rows: DevClusterHolderRow[], totalSupplyRaw: string | null): DevClusterHolderRow[] {
  if (!totalSupplyRaw || !/^\d+$/.test(totalSupplyRaw) || BigInt(totalSupplyRaw) <= BigInt(0)) return rows
  const supply = BigInt(totalSupplyRaw)
  return rows.map((row, i) => {
    if (row.percent != null) return row
    if (!row.balanceRaw || !/^\d+$/.test(row.balanceRaw)) return row
    const pct = Number((BigInt(row.balanceRaw) * BigInt(10000)) / supply) / 100
    return { ...row, percent: Number.isFinite(pct) ? pct : null, rank: row.rank ?? i + 1 }
  })
}

function sumTop(rows: DevClusterHolderRow[], n: number): number | null {
  const usable = rows.filter((r) => r.percent != null && Number.isFinite(r.percent)).slice(0, n)
  if (usable.length === 0) return null
  return Math.round(usable.reduce((acc, r) => acc + (r.percent as number), 0) * 100) / 100
}

function defaultAlchemyUrl(chainSlug: DevClusterChainSlug): string | null {
  if (chainSlug === 'robinhood') return getRobinhoodRpcUrl()
  const url = RPC[chainSlug as keyof typeof RPC]
  return typeof url === 'string' && url.length > 0 ? url : null
}

function mergeHealth(target: ProviderRowsHealth, next: Partial<ProviderRowsHealth>): void {
  if (next.attempted) target.attempted = true
  if (next.ok) target.ok = true
  if (typeof next.rowsReturned === 'number') target.rowsReturned += next.rowsReturned
  if (next.errorMessage && !target.ok) target.errorMessage = next.errorMessage
  if (target.ok) target.health = 'healthy'
  else if (target.attempted) target.health = next.health ?? 'failed'
}

export async function resolveDevClusterDiagnosis(input: ResolveDevClusterInput): Promise<DevClusterDiagnosisResult> {
  const tokenAddress = String(input.tokenAddress).toLowerCase()
  const chainId = input.chainId
  const chainSlug = input.chainSlug
  const fetchImpl = input.fetchImpl ?? fetch
  const audit = emptyDevClusterDiagnosisAudit(chainId, chainSlug, tokenAddress)
  const cacheKey = buildDevClusterCacheKey(chainId, tokenAddress)
  audit.providerHealth.supabaseCache.key = cacheKey

  const existing = input.existing ?? {}
  let originAddress = normalizeDevClusterAddress(existing.deployerAddress ?? null)
  let factoryAddress: string | null = null
  let creationTxHash = typeof existing.creationTxHash === 'string' ? existing.creationTxHash : null
  let holders: DevClusterHolderRow[] = (existing.holders ?? []).filter((h) => isUsableDevClusterWallet(h.address, tokenAddress))
  let transfers: DevClusterTransfer[] = existing.transfers ?? []
  let linkedWallets: DevClusterLinkedWallet[] = existing.linkedWallets ?? []
  let holdersSource: DevClusterDiagnosisAudit['holderResolution']['holdersSource'] = holders.length > 0 ? 'existing' : 'none'
  let linkedSource: DevClusterDiagnosisAudit['linkedWalletGraph']['linkedWalletsSource'] = linkedWallets.length > 0 ? 'existing' : 'none'
  const sourcesTried: string[] = []
  const holderSourcesTried: string[] = []

  const existingGraphRan = existing.linkedGraphStatus === 'ok' || existing.linkedGraphStatus === 'none_found'
  let graphStatus: LinkedWalletGraphStatus = existingGraphRan
    ? (linkedWallets.length > 0 ? 'ran_found' : 'ran_none')
    : 'not_run'

  const cacheGet = input.cacheGet ?? ((key: string) => getTokenCache(key))
  const cacheSet = input.cacheSet ?? ((key: string, value: unknown, ttl: number) => setTokenCache(key, value, ttl))

  if (!input.skipNetwork) {
    try {
      const cached = await cacheGet(cacheKey) as { chainId: number; tokenAddress: string; result?: DevClusterDiagnosisResult } | null
      if (cached && isDevClusterCacheHitValid(cached, { chainId, tokenAddress })) {
        audit.providerHealth.supabaseCache.hit = true
        audit.providerHealth.supabaseCache.chainMatched = true
        if (cached.result) {
          // Cache can fill gaps only — live existing evidence still wins when it is stronger.
          if (!originAddress && cached.result.originAddress) originAddress = cached.result.originAddress
          if (!factoryAddress && cached.result.factoryAddress) factoryAddress = cached.result.factoryAddress
          if (!creationTxHash && cached.result.creationTxHash) creationTxHash = cached.result.creationTxHash
          if (holders.length === 0 && cached.result.holders.length > 0) {
            holders = cached.result.holders
            holdersSource = cached.result.holdersSource
          }
          if (linkedWallets.length === 0 && cached.result.linkedWallets.length > 0) {
            linkedWallets = cached.result.linkedWallets
            linkedSource = cached.result.linkedWallets.length ? 'existing' : linkedSource
            graphStatus = cached.result.graphRan ? (cached.result.linkedWallets.length > 0 ? 'ran_found' : 'ran_none') : graphStatus
          }
        }
      } else if (cached && !isDevClusterCacheHitValid(cached, { chainId, tokenAddress })) {
        audit.providerHealth.supabaseCache.hit = false
        audit.providerHealth.supabaseCache.chainMatched = false
      }
    } catch { /* cache miss */ }
  }

  const goldrushKey = input.goldrushKey ?? process.env.GOLDRUSH_API_KEY ?? process.env.COVALENT_API_KEY ?? null
  const needsCreator = !originAddress
  const needsHolders = holders.length === 0 || holders.every((h) => h.percent == null)
  const needsGraph = !existingGraphRan && linkedWallets.length === 0

  // ── GoldRush first ──────────────────────────────────────────────────────
  if (!input.skipNetwork && goldrushKey && (needsCreator || needsHolders || needsGraph)) {
    const slugs = GOLDRUSH_SLUGS[chainSlug] ?? [chainSlug]
    let goldrushOk = false
    let goldrushRows = 0
    let goldrushError: string | null = null
    for (const slug of slugs) {
      const auth = { Authorization: `Bearer ${goldrushKey}` }
      if (needsHolders) {
        holderSourcesTried.push('goldrush')
        const res = await httpGet(fetchImpl, `https://${GOLDRUSH_HOST}/v1/${slug}/tokens/${tokenAddress}/token_holders_v2/?key=${encodeURIComponent(goldrushKey)}&page-size=50`, auth)
        if (res.ok) {
        const parsed = goldrushHolders(res.json, tokenAddress)
          const rows = applyHolderPercentsFromSupply(parsed.rows, parsed.totalSupplyRaw ?? input.existing?.totalSupplyRaw ?? null)
          goldrushRows += rows.length
          if (rows.length > 0) {
            holders = rows
            holdersSource = 'goldrush'
            goldrushOk = true
          }
        } else {
          goldrushError = res.error
          if (res.status === 404) continue
        }
      }
      if (needsCreator || needsGraph) {
        sourcesTried.push('goldrush_transfers')
        const res = await httpGet(fetchImpl, `https://${GOLDRUSH_HOST}/v1/${slug}/tokens/${tokenAddress}/transfers_v2/?key=${encodeURIComponent(goldrushKey)}&page-size=50`, auth)
        if (res.ok) {
          const rows = goldrushTransfers(res.json, tokenAddress)
          goldrushRows += rows.length
          if (rows.length > 0) {
            transfers = transfers.concat(rows)
            goldrushOk = true
          }
        } else {
          goldrushError = goldrushError ?? res.error
          if (res.status === 404) continue
        }
      }
      if (needsCreator) {
        sourcesTried.push('goldrush_transactions')
        const res = await httpGet(fetchImpl, `https://${GOLDRUSH_HOST}/v1/${slug}/address/${tokenAddress}/transactions_v2/?key=${encodeURIComponent(goldrushKey)}&page-size=5&block-signed-at-asc=true&no-logs=true`, auth)
        if (res.ok) {
          const items = goldrushItems(res.json) as Array<Record<string, unknown>>
          goldrushRows += items.length
          const creation = items.find((t) => t.successful !== false && (t.to_address == null || t.to_address === ''))
          const from = asAddr(creation?.from_address ?? items[0]?.from_address)
          if (from && isUsableDevClusterWallet(from, tokenAddress)) {
            originAddress = from
            creationTxHash = typeof creation?.tx_hash === 'string' ? creation.tx_hash : creationTxHash
            goldrushOk = true
            sourcesTried.push('goldrush_creation_tx')
          }
        } else {
          goldrushError = goldrushError ?? res.error
        }
      }
      if (goldrushOk) break
    }
    mergeHealth(audit.providerHealth.goldrush, {
      attempted: true,
      ok: goldrushOk,
      rowsReturned: goldrushRows,
      errorMessage: goldrushOk ? null : goldrushError,
      health: goldrushOk ? 'healthy' : (goldrushError === 'http_404' ? 'unsupported' : 'failed'),
    })
  } else if (!goldrushKey) {
    audit.providerHealth.goldrush.health = 'not_attempted'
    audit.providerHealth.goldrush.errorMessage = 'no_api_key'
  }

  // ── Alchemy: skip 400 / unsupported, never retry the same call ──────────
  const alchemyUrl = input.alchemyRpcUrl ?? defaultAlchemyUrl(chainSlug)
  let alchemyHealth: AlchemyRpcHealth = emptyAlchemyRpcHealth()
  if (!input.skipNetwork && alchemyUrl && ((needsCreator && !originAddress) || needsGraph || (needsHolders && holders.length === 0))) {
    const alchemyCall = async (method: string, params: unknown[]): Promise<{ result: unknown; health: AlchemyRpcHealth }> => {
      try {
        const res = await fetchImpl(alchemyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          cache: 'no-store',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })
        const json = await res.json().catch(() => null) as { result?: unknown; error?: { code?: unknown; message?: unknown } } | null
        if (!res.ok || json?.error) {
          const health = classifyAlchemyRpcError({
            httpStatus: res.status,
            jsonError: json?.error ?? null,
            message: typeof json?.error?.message === 'string' ? json.error.message : `http_${res.status}`,
          })
          return { result: null, health }
        }
        return {
          result: json?.result ?? null,
          health: { ...emptyAlchemyRpcHealth(), attempted: true, ok: true, health: 'healthy' },
        }
      } catch (err) {
        const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
        return { result: null, health: classifyAlchemyRpcError({ timedOut, message: err instanceof Error ? err.message : 'network_error' }) }
      }
    }

    sourcesTried.push('alchemy_getAssetTransfers')
    const first = await alchemyCall('alchemy_getAssetTransfers', [{
      fromBlock: '0x0',
      toBlock: 'latest',
      category: ['erc20'],
      contractAddresses: [tokenAddress],
      order: 'asc',
      maxCount: '0x32',
      withMetadata: true,
    }])
    alchemyHealth = first.health
    if (first.health.ok) {
      const rows = alchemyTransfers(first.result, tokenAddress)
      if (rows.length > 0) transfers = transfers.concat(rows)
      if (!originAddress) {
        const mintTo = rows.find((t) => t.from === '0x0000000000000000000000000000000000000000' && isUsableDevClusterWallet(t.to, tokenAddress))
        const earliest = mintTo ?? rows.find((t) => isUsableDevClusterWallet(t.from, tokenAddress))
        if (earliest) {
          originAddress = (mintTo?.to ?? earliest.from) as string
          creationTxHash = earliest.txHash ?? creationTxHash
          sourcesTried.push('alchemy_earliest_transfer')
        }
      }
    } else if (alchemyShouldSkipAndNotRetry(first.health)) {
      // Do not retry the same Alchemy call. Fall through to Blockscout.
      alchemyHealth.skipped = true
    }
  } else if (!alchemyUrl) {
    alchemyHealth = {
      ...emptyAlchemyRpcHealth(),
      attempted: false,
      skipped: true,
      skipReason: 'rpc_not_configured',
      health: 'not_attempted',
      errorMessage: 'Alchemy RPC not configured',
    }
  }
  audit.providerHealth.alchemyRpc = alchemyHealth

  // ── Blockscout / explorer creator + holders + transfers ─────────────────
  const bsBase = BLOCKSCOUT_BASE[chainSlug]
  if (!input.skipNetwork && bsBase && (!originAddress || holders.length === 0 || (!existingGraphRan && linkedWallets.length === 0))) {
    let bsOk = false
    let bsRows = 0
    let bsError: string | null = null
    const key = process.env.BLOCKSCOUT_API_KEY
    const withKey = (url: string) => key ? `${url}${url.includes('?') ? '&' : '?'}apikey=${encodeURIComponent(key)}` : url

    if (!originAddress) {
      sourcesTried.push('blockscout_creator')
      const addrRes = await httpGet(fetchImpl, withKey(`${bsBase.replace(/\/$/, '')}/api/v2/addresses/${tokenAddress}`))
      if (addrRes.ok) {
        const rec = addrRes.json as { creator_address_hash?: string | null; creation_tx_hash?: string | null; is_contract?: boolean }
        const creator = normalizeDevClusterAddress(rec.creator_address_hash ?? null)
        creationTxHash = rec.creation_tx_hash ?? creationTxHash
        let creatorIsContract: boolean | null = null
        let txFrom: string | null = null
        if (creator) {
          const creatorRes = await httpGet(fetchImpl, withKey(`${bsBase.replace(/\/$/, '')}/api/v2/addresses/${creator}`))
          if (creatorRes.ok) {
            const c = creatorRes.json as { is_contract?: boolean }
            creatorIsContract = Boolean(c.is_contract)
          }
        }
        if (creationTxHash) {
          const txRes = await httpGet(fetchImpl, withKey(`${bsBase.replace(/\/$/, '')}/api/v2/transactions/${creationTxHash}`))
          if (txRes.ok) {
            const tx = txRes.json as { from?: { hash?: string }; from_address_hash?: string }
            txFrom = asAddr(tx.from) ?? normalizeDevClusterAddress(tx.from_address_hash ?? null)
          }
        }
        const split = separateFactoryAndOrigin({
          creatorAddress: creator,
          creatorIsContract,
          creationTxFrom: txFrom,
          tokenAddress,
        })
        factoryAddress = split.factoryAddress
        originAddress = split.originAddress ?? originAddress
        if (originAddress || factoryAddress) {
          bsOk = true
          bsRows += 1
          sourcesTried.push('blockscout_creation_record')
        }
      } else {
        bsError = addrRes.error
      }
    }

    if (holders.length === 0) {
      holderSourcesTried.push('blockscout')
      const holdRes = await httpGet(fetchImpl, withKey(`${bsBase.replace(/\/$/, '')}/api/v2/tokens/${tokenAddress}/holders?items_count=50`))
      if (holdRes.ok) {
        const rows = applyHolderPercentsFromSupply(blockscoutHolders(holdRes.json, tokenAddress), input.existing?.totalSupplyRaw ?? null)
        bsRows += rows.length
        if (rows.length > 0) {
          holders = rows
          holdersSource = 'blockscout'
          bsOk = true
        }
      } else {
        bsError = bsError ?? holdRes.error
      }
    }

    if (!existingGraphRan && linkedWallets.length === 0) {
      const txRes = await httpGet(fetchImpl, withKey(`${bsBase.replace(/\/$/, '')}/api/v2/tokens/${tokenAddress}/transfers?items_count=50`))
      if (txRes.ok) {
        const rows = blockscoutTransfers(txRes.json, tokenAddress)
        bsRows += rows.length
        if (rows.length > 0) {
          transfers = transfers.concat(rows)
          bsOk = true
        }
      } else {
        bsError = bsError ?? txRes.error
      }
    }

    mergeHealth(audit.providerHealth.blockscout, {
      attempted: true,
      ok: bsOk,
      rowsReturned: bsRows,
      errorMessage: bsOk ? null : bsError,
      health: bsOk ? 'healthy' : 'failed',
    })
  } else if (!bsBase) {
    audit.providerHealth.blockscout.health = 'unsupported'
    audit.providerHealth.blockscout.errorMessage = 'no_blockscout_endpoint'
  }

  // Explorer V2 creation lookup (ETH/Base/BNB) when Blockscout didn't resolve origin.
  if (!input.skipNetwork && !originAddress && (chainSlug === 'eth' || chainSlug === 'base' || chainSlug === 'bnb')) {
    const apiKey = chainSlug === 'base'
      ? (process.env.BASESCAN_API_KEY || process.env.ETHERSCAN_API_KEY)
      : process.env.ETHERSCAN_API_KEY
    if (apiKey) {
      sourcesTried.push('explorer_creation_lookup')
      const chainParam = chainSlug === 'eth' ? 1 : chainSlug === 'base' ? 8453 : 56
      const url = chainSlug === 'base'
        ? `https://api.basescan.org/api?module=contract&action=getcontractcreation&contractaddresses=${tokenAddress}&apikey=${apiKey}`
        : `${ETHERSCAN_V2}?chainid=${chainParam}&module=contract&action=getcontractcreation&contractaddresses=${tokenAddress}&apikey=${apiKey}`
      const res = await httpGet(fetchImpl, url)
      if (res.ok) {
        const json = res.json as { status?: string; result?: Array<{ contractCreator?: string; txHash?: string }> }
        const creator = normalizeDevClusterAddress(json?.result?.[0]?.contractCreator ?? null)
        if (json.status === '1' && isUsableDevClusterWallet(creator, tokenAddress)) {
          originAddress = creator
          creationTxHash = json.result?.[0]?.txHash ?? creationTxHash
        }
      }
    }
  }

  // If holders still missing, reconstruct concentration from transfers (partial, never fake 0).
  if ((holders.length === 0 || holders.every((h) => h.percent == null)) && transfers.length > 0) {
    holderSourcesTried.push('transfer_derived')
    const derived = deriveHolderConcentrationFromTransfers(transfers, tokenAddress, input.existing?.totalSupplyRaw ?? null)
    if (derived) {
      holders = derived.rows
      holdersSource = 'transfer_derived'
    }
  }

  // Linked wallet graph from transfers — only mark ran when we actually searched transfers.
  const graphAttempted = existingGraphRan || transfers.length > 0 || audit.providerHealth.goldrush.attempted || audit.providerHealth.blockscout.attempted || alchemyHealth.ok
  const graphBlockedByAlchemySkip = !existingGraphRan && transfers.length === 0 && alchemyHealth.skipped && !audit.providerHealth.goldrush.ok && !audit.providerHealth.blockscout.ok

  if (originAddress && (needsGraph || linkedWallets.length === 0) && transfers.length > 0) {
    const built = linkedWalletsFromTransfers({
      transfers,
      originAddress,
      tokenAddress,
      topHolderAddresses: holders.map((h) => h.address),
    })
    if (built.wallets.length > 0) {
      linkedWallets = built.wallets
      linkedSource = holdersSource === 'goldrush' || audit.providerHealth.goldrush.ok
        ? 'goldrush'
        : alchemyHealth.ok
          ? 'alchemy'
          : audit.providerHealth.blockscout.ok
            ? 'blockscout'
            : 'goldrush'
      graphStatus = 'ran_found'
      audit.linkedWalletGraph.firstReceiversChecked = built.firstReceiversChecked
      audit.linkedWalletGraph.deployerFundersChecked = built.deployerFundersChecked
      audit.linkedWalletGraph.repeatedWalletsChecked = built.repeatedWalletsChecked
    } else if (graphAttempted && !graphBlockedByAlchemySkip) {
      graphStatus = 'ran_none'
      audit.linkedWalletGraph.firstReceiversChecked = built.firstReceiversChecked
      audit.linkedWalletGraph.deployerFundersChecked = built.deployerFundersChecked
    }
  } else if (existingGraphRan) {
    graphStatus = linkedWallets.length > 0 ? 'ran_found' : 'ran_none'
  } else if (graphBlockedByAlchemySkip || (!graphAttempted && linkedWallets.length === 0)) {
    graphStatus = 'not_run'
  } else if (transfers.length === 0 && (audit.providerHealth.goldrush.attempted || audit.providerHealth.blockscout.attempted) && !alchemyHealth.skipped) {
    graphStatus = 'ran_none'
  } else {
    graphStatus = 'not_run'
  }

  const holdersWithPct = holders.filter((h) => h.percent != null)
  const top1Pct = sumTop(holdersWithPct, 1)
  const top10Pct = sumTop(holdersWithPct, 10)
  const top20Pct = sumTop(holdersWithPct, 20)
  const creatorInTop = creatorInTopHoldersFromRows(holdersWithPct, originAddress)
  const clusterSupply = clusterSupplyFromHolders(holdersWithPct, originAddress, linkedWallets)

  const originConfidence: 'high' | 'medium' | 'low' = originAddress
    ? (sourcesTried.includes('blockscout_creation_record') || sourcesTried.includes('explorer_creation_lookup') || sourcesTried.includes('goldrush_creation_tx')
      ? 'high'
      : 'medium')
    : 'low'
  if (existing.deployerStatus === 'confirmed' && originAddress) {
    // Keep high confidence when Token Scanner already confirmed origin.
  }

  audit.deployerResolution = {
    attempted: Boolean(existing.originDiscoveryAttempted) || sourcesTried.length > 0 || Boolean(originAddress),
    sourcesTried: [...new Set(sourcesTried)],
    contractCreatorFound: Boolean(originAddress) && (sourcesTried.includes('blockscout_creation_record') || sourcesTried.includes('explorer_creation_lookup') || sourcesTried.includes('goldrush_creation_tx') || existing.deployerStatus === 'confirmed'),
    creationTxHash,
    factoryDetected: Boolean(factoryAddress),
    factoryAddress,
    deployerAddress: originAddress,
    originWallet: originAddress,
    confidence: existing.deployerStatus === 'confirmed' ? 'high' : originConfidence,
    failureReason: originAddress
      ? null
      : (alchemyHealth.billingDisabled
        ? 'Alchemy billing disabled'
        : alchemyHealth.rateLimited
          ? 'Alchemy rate limited'
          : alchemyHealth.timeout
            ? 'Alchemy timeout'
            : 'Needs creator tx evidence'),
  }
  audit.holderResolution = {
    attempted: holders.length > 0 || holderSourcesTried.length > 0 || Boolean(existing.holders),
    sourcesTried: [...new Set(holderSourcesTried.length > 0 ? holderSourcesTried : (holders.length > 0 ? [holdersSource] : []))],
    holderRowsReturned: holders.length,
    top1Pct,
    top10Pct,
    top20Pct,
    creatorInTopHolders: creatorInTop,
    holdersSource,
    failureReason: holders.length > 0 ? null : 'Needs holder evidence',
  }

  let graphFailure: string | null = null
  if (graphStatus === 'not_run') {
    if (alchemyHealth.billingDisabled) graphFailure = 'Alchemy billing disabled'
    else if (alchemyHealth.rateLimited) graphFailure = 'Alchemy rate limited'
    else if (alchemyHealth.timeout) graphFailure = 'Alchemy timeout'
    else if (alchemyHealth.skipReason === 'invalid_param') graphFailure = 'Alchemy invalid param — skipped'
    else if (alchemyHealth.skipReason === 'chain_not_supported') graphFailure = 'Alchemy chain not supported'
    else if (alchemyHealth.skipReason === 'rpc_not_configured') graphFailure = 'Alchemy RPC not configured'
    else if (holders.length === 0) graphFailure = 'Needs holder evidence'
    else if (!originAddress) graphFailure = 'Needs creator tx evidence'
    else graphFailure = 'Needs transfer evidence'
  }

  audit.linkedWalletGraph = {
    ...audit.linkedWalletGraph,
    attempted: graphStatus === 'ran_found' || graphStatus === 'ran_none',
    fundingGraphAttempted: transfers.some((t) => t.category === 'external'),
    tokenTransferGraphAttempted: transfers.length > 0,
    walletsMapped: graphStatus === 'not_run' ? null : linkedWallets.length,
    linkedWalletSupplyPct: clusterSupply,
    confidence: graphStatus === 'ran_found' ? (linkedWallets.some((w) => w.confidence === 'high') ? 'high' : 'medium') : 'low',
    graphStatus,
    failureReason: graphFailure,
    linkedWalletsSource: linkedSource,
  }

  const finals = finalizeDevClusterStatuses(audit)
  audit.finalDevMapStatus = finals.finalDevMapStatus
  audit.finalClusterStatus = finals.finalClusterStatus
  audit.finalReason = finals.finalReason

  const result: DevClusterDiagnosisResult = {
    audit,
    originAddress,
    factoryAddress,
    deployerAddress: originAddress,
    creationTxHash,
    deployerConfidence: audit.deployerResolution.confidence,
    deployerStatus: !originAddress ? 'not_confirmed' : audit.deployerResolution.confidence === 'high' ? 'confirmed' : 'possible_match',
    linkedWallets: graphStatus === 'ran_found' ? linkedWallets : [],
    graphRan: graphStatus === 'ran_found' || graphStatus === 'ran_none',
    holders,
    holdersSource,
    top1Pct,
    top10Pct,
    top20Pct,
    creatorInTopHolders: creatorInTop,
    clusterSupplyPercent: clusterSupply,
    finalDevMapStatus: audit.finalDevMapStatus,
    finalClusterStatus: audit.finalClusterStatus,
    finalReason: audit.finalReason,
  }

  if (!input.skipNetwork && (originAddress || holders.length > 0 || result.graphRan)) {
    try {
      await cacheSet(cacheKey, { chainId, tokenAddress, result }, CACHE_TTL_SECONDS)
    } catch { /* fail open */ }
  }

  return result
}
