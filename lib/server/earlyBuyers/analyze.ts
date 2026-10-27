import { buildTokenScanCacheKey } from '../../tokenScannerChainStrictness'
import { LP_LOCK_BURN_REGISTRY } from '../lpLockBurnIntel'
import { decodeFunctionResult, encodeFunctionData, type Hex } from 'viem'
import { getTokenCache, setTokenCache } from '../cache/tokenCache'
import { createEarlyBuyerRpc, EarlyBuyerRpcError, type EarlyBuyerRpc } from './rpc'
import { discoverLaunches, type PoolCandidate } from './launch'
import { readEarlyWindow } from './window'
import { classifyEarlyBuyers, isAddress } from './classify'
import { readEarlyBuyerEvidenceWithSource, windowIsFinalized, writeEarlyBuyerEvidence, type EarlyBuyerEvidenceSource } from './store'
import { reserveEarlyBuyerHoldings } from './limits'
import { compareBalanceToObservedReceipts, EARLY_BUYER_WINDOW_SCOPE, rawPct, type CurrentHoldingsSnapshot, type EarlyBuyer, type EarlyBuyerChain, type EarlyBuyerIntel, type HoldingsRefreshStatus, type SupplyExposure } from './types'

const ID = /^0x[0-9a-f]{64}$/i
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const
const MULTICALL3_ABI = [{ type: 'function', name: 'aggregate3', stateMutability: 'view', inputs: [{ name: 'calls', type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'allowFailure', type: 'bool' }, { name: 'callData', type: 'bytes' }] }], outputs: [{ name: 'returnData', type: 'tuple[]', components: [{ name: 'success', type: 'bool' }, { name: 'returnData', type: 'bytes' }] }] }] as const
const asInt = (s: unknown): number | null => typeof s === 'string' && /^0x[0-9a-f]+$/i.test(s) ? Number(BigInt(s)) : null
const asTime = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isFinite(t) ? t : null }
  return null
}

type ScanSnapshot = { selectedPool?: { address?: string; dex?: string; model?: string; createdAt?: string }; pools?: Array<{ address?: string; dex?: string; model?: string }>; pairs?: Array<{ attributes?: { address?: string; pool_created_at?: string } }>; devIntel?: { deployerAddress?: string }; lpControllerIntel?: { controller?: string } }

async function poolCandidates(chain: EarlyBuyerChain, token: string, fetchImpl: typeof fetch): Promise<{ candidates: PoolCandidate[]; deployer: string | null; infrastructure: string[]; coverageReasons: string[] }> {
  const scan = await getTokenCache<ScanSnapshot>(buildTokenScanCacheKey(chain, chain === 'base' ? 8453 : 1, token))
  const found: PoolCandidate[] = []
  const coverageReasons: string[] = []
  const add = (address: unknown, dex: unknown, createdAt: unknown) => {
    if (typeof address !== 'string' || (!isAddress(address) && !ID.test(address)) || typeof dex !== 'string') return
    const old = found.find((p) => p.address.toLowerCase() === address.toLowerCase())
    if (old) { old.createdAt ??= asTime(createdAt); if (!/v[234]|slipstream|aerodrome/i.test(old.dex)) old.dex = dex; return }
    found.push({ address: address.toLowerCase(), dex, createdAt: asTime(createdAt) })
  }
  const modelDex = (dex?: string, model?: string) => model && /uniswap/i.test(dex ?? '') && /concentrated|v3/i.test(model) ? 'uniswap v3' : model && /uniswap/i.test(dex ?? '') && /v2|erc20_lp/i.test(model) ? 'uniswap v2' : dex
  add(scan?.selectedPool?.address, modelDex(scan?.selectedPool?.dex, scan?.selectedPool?.model), scan?.selectedPool?.createdAt ?? scan?.pairs?.[0]?.attributes?.pool_created_at)
  for (const pool of scan?.pools ?? []) add(pool.address, modelDex(pool.dex, pool.model), null)
  // The full exact-chain response is considered for launch ordering. Ranking by current
  // liquidity would discard migrated or drained original pools.
  {
    try {
      const response = await fetchImpl(`https://api.dexscreener.com/latest/dex/tokens/${token}`, { signal: AbortSignal.timeout(4_000), cache: 'no-store' })
      if (response.ok) {
        const payload = await response.json() as { pairs?: Array<{ chainId?: string; pairAddress?: string; dexId?: string; labels?: string[]; pairCreatedAt?: number; liquidity?: { usd?: number } }> }
        const slug = chain === 'eth' ? 'ethereum' : 'base'
        const rows = (payload.pairs ?? []).filter((p) => p.chainId === slug).sort((a, b) => (a.pairCreatedAt ?? Infinity) - (b.pairCreatedAt ?? Infinity))
        if (rows.length > 50) coverageReasons.push('dex_pool_response_cap_50')
        for (const row of rows.slice(0, 50)) {
          add(row.pairAddress, `${row.dexId ?? ''} ${(row.labels ?? []).join(' ')}`, row.pairCreatedAt)
        }
      } else coverageReasons.push(`dex_pool_http_${response.status}`)
    } catch { coverageReasons.push('dex_pool_lookup_unavailable') }
  }
  return { candidates: found.sort((a, b) => (a.createdAt ?? Infinity) - (b.createdAt ?? Infinity)), deployer: isAddress(scan?.devIntel?.deployerAddress) ? scan!.devIntel!.deployerAddress! : null, infrastructure: [...LP_LOCK_BURN_REGISTRY.lockersByChain[chain], ...(isAddress(scan?.lpControllerIntel?.controller) ? [scan!.lpControllerIntel!.controller!] : [])], coverageReasons }
}

function empty(status: EarlyBuyerIntel['status'], reason: string, rpc?: EarlyBuyerRpc): EarlyBuyerIntel {
  return { status, evidenceStatus: status, holdingsStatus: 'unavailable', launch: { status: status === 'unsupported_launch_venue' ? status : 'unavailable', block: null, pool: null, creationTx: null, liquidityTx: null }, window: { startBlock: null, endBlock: null, pools: [], buysObserved: 0 }, buyers: [], groups: [], sameBlockCount: 0, launchDistributions: [], coverage: { capped: status === 'partial', reasons: [reason], provisional: true, scope: EARLY_BUYER_WINDOW_SCOPE }, budget: { calls: rpc?.budget.callsUsed() ?? 0, cu: rpc?.budget.estimatedCuUsed() ?? 0 } }
}

// Multicall3 reads its own block number and timestamp, and the token's totalSupply, in the same
// eth_call as the balances, so every current value is from one block at no extra RPC call.
const MULTICALL3_BLOCK_NUMBER = '0x42cbb15c' as const // getBlockNumber()
const MULTICALL3_BLOCK_TIMESTAMP = '0x0f28c97d' as const // getCurrentBlockTimestamp()
const TOTAL_SUPPLY = '0x18160ddd' as const // totalSupply()
const WORD = /^0x[0-9a-f]{64}$/i

function supplyExposure(buyers: EarlyBuyer[], holdingsStatus: HoldingsRefreshStatus, totalSupply: bigint | null, blockNumber: number | null, shared: ReadonlySet<string>): SupplyExposure {
  const excludedSharedRecipients = buyers.map((b) => b.wallet).filter((w) => shared.has(w)).sort()
  const unavailable = (reason: string): SupplyExposure => ({ status: 'unavailable', reason, blockNumber, totalSupplyRaw: totalSupply?.toString() ?? null, observedHeldRaw: null, observedPct: null, ordinaryHeldRaw: null, ordinaryPct: null, walletsIncluded: 0, excludedSharedRecipients })
  if (buyers.length === 0) return unavailable('no_observed_recipients')
  // Every observed recipient's balance is required; a partial sum would understate exposure.
  if (holdingsStatus !== 'available' || buyers.some((b) => b.heldRaw == null)) return unavailable('holdings_incomplete')
  if (totalSupply == null) return unavailable('total_supply_unavailable')
  if (totalSupply <= BigInt(0)) return unavailable('total_supply_zero')
  if (new Set(buyers.map((b) => b.wallet.toLowerCase())).size !== buyers.length) return unavailable('duplicate_recipients')
  const observed = buyers.reduce((sum, b) => sum + BigInt(b.heldRaw!), BigInt(0))
  if (observed > totalSupply) return unavailable('balances_exceed_total_supply')
  const ordinary = buyers.filter((b) => !shared.has(b.wallet)).reduce((sum, b) => sum + BigInt(b.heldRaw!), BigInt(0))
  return { status: 'available', reason: null, blockNumber, totalSupplyRaw: totalSupply.toString(), observedHeldRaw: observed.toString(), observedPct: rawPct(observed, totalSupply, 4), ordinaryHeldRaw: ordinary.toString(), ordinaryPct: rawPct(ordinary, totalSupply, 4), walletsIncluded: buyers.length, excludedSharedRecipients }
}

export async function hydrateHoldings(rpc: EarlyBuyerRpc, token: string, intel: EarlyBuyerIntel, now: () => number = Date.now): Promise<EarlyBuyerIntel> {
  const buyers = intel.buyers.map((b) => ({ ...b }))
  if (buyers.length > 50) { intel.coverage.capped = true; intel.coverage.reasons.push('holdings_wallet_cap_50') }
  const slice = buyers.slice(0, 50)
  let snapshot: CurrentHoldingsSnapshot | undefined
  let totalSupply: bigint | null = null
  if (slice.length > 0) {
    try {
      const calls = [
        ...slice.map((buyer) => ({ target: token as Hex, allowFailure: true, callData: `0x70a08231${buyer.wallet.slice(2).padStart(64, '0')}` as Hex })),
        { target: MULTICALL3 as Hex, allowFailure: true, callData: MULTICALL3_BLOCK_NUMBER as Hex },
        { target: MULTICALL3 as Hex, allowFailure: true, callData: MULTICALL3_BLOCK_TIMESTAMP as Hex },
        { target: token as Hex, allowFailure: true, callData: TOTAL_SUPPLY as Hex },
      ]
      const encoded = encodeFunctionData({ abi: MULTICALL3_ABI, functionName: 'aggregate3', args: [calls] })
      const raw = await rpc.call<Hex>('eth_call', [{ to: MULTICALL3, data: encoded }, 'latest'])
      const rows = decodeFunctionResult({ abi: MULTICALL3_ABI, functionName: 'aggregate3', data: raw })
      if (rows.length !== calls.length) throw new Error('multicall_length_mismatch')
      for (let i = 0; i < slice.length; i++) {
        const result = rows[i]
        if (result.success && WORD.test(result.returnData)) slice[i].heldRaw = BigInt(result.returnData).toString()
      }
      const word = (i: number) => rows[i].success && WORD.test(rows[i].returnData) ? BigInt(rows[i].returnData) : null
      const block = word(slice.length), time = word(slice.length + 1)
      totalSupply = word(slice.length + 2)
      snapshot = { blockNumber: block != null && block <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(block) : null, blockTimestampSec: time != null && time <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(time) : null, readAtMs: now(), source: 'live', cacheAgeSec: 0, walletsRead: slice.filter((b) => b.heldRaw != null).length, walletsObserved: buyers.length }
      if (slice.some((b) => b.heldRaw == null)) intel.coverage.reasons.push('some_holdings_unpriced')
    } catch { intel.coverage.reasons.push('holdings_unavailable') }
  }
  const allHeld = buyers.every((b) => b.heldRaw != null)
  const heldTotal = allHeld ? buyers.reduce((sum, b) => sum + BigInt(b.heldRaw!), BigInt(0)) : BigInt(0)
  const holdingsStatus: HoldingsRefreshStatus = intel.coverage.reasons.includes('holdings_unavailable') ? 'failed' : buyers.some((b) => b.heldRaw == null) ? 'partial' : buyers.length > 0 ? 'available' : 'unavailable'
  const shared = new Set(intel.deliveryGraph?.sharedRecipients.map((r) => r.wallet) ?? [])
  const compared = buyers.map((b) => b.heldRaw != null ? { ...b, balanceComparison: compareBalanceToObservedReceipts(b.boughtRaw, b.heldRaw) } : b)
  return {
    ...intel,
    evidenceStatus: intel.evidenceStatus ?? intel.status,
    holdingsStatus,
    buyers: compared,
    groups: intel.groups.map((g) => ({ ...g, heldWithinEarlySetPct: allHeld && heldTotal > BigInt(0) ? Number(buyers.filter((b) => g.wallets.includes(b.wallet)).reduce((sum, b) => sum + BigInt(b.heldRaw!), BigInt(0)) * BigInt(10000) / heldTotal) / 100 : null })),
    ...(snapshot ? { currentHoldings: snapshot, supplyExposure: supplyExposure(buyers, holdingsStatus, totalSupply, snapshot.blockNumber, shared) } : {}),
  }
}

/** A cached holdings read keeps its original block and read time; only its age changes. */
function servedFromCache(holding: EarlyBuyerIntel, now: number): EarlyBuyerIntel['currentHoldings'] {
  const h = holding.currentHoldings
  return h ? { ...h, source: 'cache', cacheAgeSec: Math.max(0, Math.floor((now - h.readAtMs) / 1000)) } : undefined
}

/** Where a response came from. Filled in by analyzeEarlyBuyers for request logging only; never changes the result. */
export type EarlyBuyerDiagnostics = {
  evidenceSource?: EarlyBuyerEvidenceSource | 'cold_scan' | 'none'
  holdingsSource?: 'cache' | 'live' | 'not_refreshed' | 'quota_rejected' | 'none'
}

export async function analyzeEarlyBuyers(chain: EarlyBuyerChain, token: string, options: { fetchImpl?: typeof fetch; rpc?: EarlyBuyerRpc; cachedOnly?: boolean; refreshHoldings?: boolean; diagnostics?: EarlyBuyerDiagnostics } = {}): Promise<EarlyBuyerIntel> {
  const diag = options.diagnostics ?? {}
  const stored = await readEarlyBuyerEvidenceWithSource(chain, token)
  const cached = stored?.intel ?? null
  if (stored) diag.evidenceSource = stored.source
  if (cached) {
    const evidenceStatus = cached.evidenceStatus ?? cached.status
    const holding = await getTokenCache<EarlyBuyerIntel>(`early-buyers:holdings:v3:${chain}:${token}`)
    if (holding && holding.launch.pool === cached.launch.pool && holding.launch.block === cached.launch.block && holding.buyers.length === cached.buyers.length && holding.buyers.every((buyer, i) => buyer.wallet === cached.buyers[i]?.wallet)) { diag.holdingsSource = 'cache'; return { ...holding, evidenceStatus: holding.evidenceStatus ?? evidenceStatus, holdingsStatus: holding.holdingsStatus ?? (holding.buyers.length > 0 && holding.buyers.every((buyer) => buyer.heldRaw != null) ? 'available' : 'unavailable'), currentHoldings: servedFromCache(holding, Date.now()), budget: { calls: 0, cu: 0 } } }
    if (!options.refreshHoldings || cached.buyers.length === 0) {
      diag.holdingsSource = cached.buyers.length > 0 ? 'not_refreshed' : 'none'
      return cached.buyers.length > 0 ? { ...cached, status: 'partial', evidenceStatus, holdingsStatus: 'unavailable', coverage: { ...cached.coverage, reasons: [...cached.coverage.reasons, 'current_holdings_not_refreshed'] }, budget: { calls: 0, cu: 0 } } : { ...cached, evidenceStatus, holdingsStatus: 'unavailable', budget: { calls: 0, cu: 0 } }
    }
    const reservation = await reserveEarlyBuyerHoldings(chain, token)
    if (!reservation.allowed) {
      diag.holdingsSource = 'quota_rejected'
      return { ...cached, status: 'partial', evidenceStatus, holdingsStatus: 'failed', coverage: { ...cached.coverage, reasons: [...cached.coverage.reasons, `holdings_${reservation.reason}`] }, budget: { calls: 0, cu: 0 } }
    }
    const holdingsRpc = options.rpc ?? createEarlyBuyerRpc(chain, options.fetchImpl ?? fetch, Date.now() + 10_000)
    try {
      const fresh = await hydrateHoldings(holdingsRpc, token, { ...cached, evidenceStatus, coverage: { ...cached.coverage, reasons: [...cached.coverage.reasons] } })
      fresh.budget = { calls: holdingsRpc.budget.callsUsed(), cu: holdingsRpc.budget.estimatedCuUsed() }
      if (fresh.coverage.capped || fresh.buyers.some((buyer) => buyer.heldRaw == null)) fresh.status = 'partial'
      diag.holdingsSource = 'live'
      await setTokenCache(`early-buyers:holdings:v3:${chain}:${token}`, fresh, 300)
      return fresh
    } finally { await reservation.settle(holdingsRpc.budget.estimatedCuUsed()) }
  }
  if (options.cachedOnly) { diag.evidenceSource = 'none'; return empty('unavailable', 'paid_analysis_required') }
  diag.evidenceSource = 'cold_scan'
  const fetchImpl = options.fetchImpl ?? fetch
  const rpc = options.rpc ?? createEarlyBuyerRpc(chain, fetchImpl)
  try {
    const { candidates, deployer, infrastructure, coverageReasons } = await poolCandidates(chain, token, fetchImpl)
    if (!candidates.length) return empty('unavailable', 'no_supported_pool_creation_evidence', rpc)
    const launchSearch = await discoverLaunches(rpc, chain, token, candidates)
    const launch = launchSearch.primary
    if (launch.status === 'unsupported_launch_venue') {
      const result = empty(coverageReasons.length ? 'unavailable' : 'unsupported_launch_venue', coverageReasons.length ? 'pool_discovery_incomplete' : 'launch_venue_not_verified_in_v1', rpc)
      result.discovery = { earliestDiscoveredPool: launchSearch.earliestDiscoveredPool, earliestVerifiedPool: null, candidates: launchSearch.candidates, complete: false }
      result.coverage.reasons.push(...coverageReasons)
      return result
    }
    if (launch.block == null || !launch.pool) {
      const result = empty('unavailable', 'launch_block_unavailable', rpc)
      result.discovery = { earliestDiscoveredPool: launchSearch.earliestDiscoveredPool, earliestVerifiedPool: launchSearch.earliestVerifiedPool, candidates: launchSearch.candidates, complete: false }
      result.coverage.reasons.push(...coverageReasons, ...(launchSearch.incompleteReason ? [launchSearch.incompleteReason] : []))
      return result
    }
    const window = await readEarlyWindow({ rpc, chain, token, launches: launch.status === 'verified' && launchSearch.pools.length > 0 ? launchSearch.pools : [launch], deployer, infrastructure })
    const classified = classifyEarlyBuyers(window.facts, launch.status === 'verified' && !launchSearch.incompleteReason)
    const finalBlock = await rpc.call<{ number?: string }>('eth_getBlockByNumber', ['finalized', false]).catch(() => null)
    const finalized = finalBlock ? asInt(finalBlock.number) : null
    const provisional = !windowIsFinalized(window.endBlock, finalized)
    const discoveryIncomplete = !launchSearch.complete || coverageReasons.length > 0
    const status: EarlyBuyerIntel['status'] = provisional || window.capped || discoveryIncomplete ? 'partial' : launch.status
    const intel: EarlyBuyerIntel = {
      status,
      launch: { status: launch.status, block: launch.block, pool: launch.pool, creationTx: launch.creationTx, liquidityTx: launch.liquidityTx },
      window: { startBlock: window.startBlock, endBlock: window.endBlock, pools: window.pools, buysObserved: window.facts.length, examined: window.examined },
      buyers: classified.buyers,
      groups: classified.groups,
      ...(classified.deliveryGraph ? { deliveryGraph: classified.deliveryGraph } : {}),
      sameBlockCount: classified.sameBlockCount,
      launchDistributions: window.distributions,
      coverage: { capped: window.capped || discoveryIncomplete, reasons: [...window.reasons, ...coverageReasons, ...(launchSearch.incompleteReason ? [launchSearch.incompleteReason] : []), ...(finalized == null ? ['finality_unavailable'] : []), ...(provisional ? ['window_not_finalized'] : [])], provisional, scope: EARLY_BUYER_WINDOW_SCOPE },
      evidenceStatus: status,
      budget: { calls: rpc.budget.callsUsed(), cu: rpc.budget.estimatedCuUsed(), externalRequests: 1, actualProviderCu: null, blockReceiptCalls: window.blockReceiptCalls, blockReceiptThroughputCu: window.blockReceiptThroughputCu },
      discovery: { earliestDiscoveredPool: launchSearch.earliestDiscoveredPool, earliestVerifiedPool: launchSearch.earliestVerifiedPool, candidates: launchSearch.candidates, complete: launchSearch.complete && coverageReasons.length === 0 },
    }
    await writeEarlyBuyerEvidence(chain, token, intel, !provisional)
    const withHoldings = await hydrateHoldings(rpc, token, intel)
    if (withHoldings.coverage.capped || withHoldings.buyers.some((buyer) => buyer.heldRaw == null)) withHoldings.status = 'partial'
    withHoldings.budget = { ...intel.budget, calls: rpc.budget.callsUsed(), cu: rpc.budget.estimatedCuUsed() }
    diag.holdingsSource = withHoldings.currentHoldings ? 'live' : 'none'
    await setTokenCache(`early-buyers:holdings:v3:${chain}:${token}`, withHoldings, 300)
    return withHoldings
  } catch (error) {
    const reason = error instanceof EarlyBuyerRpcError ? error.reason : 'analysis_failed'
    return empty(reason.includes('budget') || reason === 'deadline' ? 'partial' : 'unavailable', reason, rpc)
  }
}
