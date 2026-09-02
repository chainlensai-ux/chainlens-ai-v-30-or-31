import { encodeAbiParameters, decodeAbiParameters } from 'viem'
import { getRobinhoodRpcUrl, ROBINHOOD_CHAIN_ID } from './robinhoodChainConfig'
import { SCANHOOD_HONEYPOT_INIT_BYTECODE } from './robinhoodHoneypotSimBytecode'
import { logRpcCall } from './rpcDebug'
import { auditGlobalAlchemyCall } from './globalRpcAudit'
import type { RobinhoodHoneypotSimStatus, RobinhoodTradingSimulationAudit } from '../tradingSimulation'

export const ROBINHOOD_HONEYPOT_CHAIN_ID = ROBINHOOD_CHAIN_ID
export const ROBINHOOD_SIM_WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'
export const ROBINHOOD_SIM_V2_ROUTER = '0x89e5db8b5aa49aa85ac63f691524311aeb649eba'
export const ROBINHOOD_SIM_V2_FACTORY = '0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f'
export const ROBINHOOD_SIM_V3_ROUTER = '0xcaf681a66d020601342297493863e78c959e5cb2'
export const ROBINHOOD_SIM_V3_FACTORY = '0x1f7d7550b1b028f7571e69a784071f0205fd2efa'
export const ROBINHOOD_SIM_FROM = '0x0000000000000000000000000000000000000001'
export const ROBINHOOD_SIM_AMOUNT_IN_WEI = BigInt('10000000000000000') // 0.01 ETH
export const ROBINHOOD_SIM_TIMEOUT_MS = 8_000
export const ROBINHOOD_SIM_CACHE_TTL_MS = 10 * 60_000
const V3_FEE_TIERS = [10000, 3000, 500, 100] as const

export type RobinhoodHoneypotStatus = RobinhoodHoneypotSimStatus
export type { RobinhoodTradingSimulationAudit }

export type RobinhoodHoneypotSimResult = {
  chainId: typeof ROBINHOOD_HONEYPOT_CHAIN_ID
  tokenAddress: string
  attempted: boolean
  supported: boolean
  sellable: boolean | null
  honeypotStatus: RobinhoodHoneypotStatus
  buyTaxPct: number | null
  sellTaxPct: number | null
  simulationRouter: string | null
  simulationPair: string | null
  amountIn: string
  buySucceeded: boolean | null
  sellSucceeded: boolean | null
  failureReason: string | null
  rawProviderError: string | null
}

export type RobinhoodHoneypotSimInput = {
  chainId: number
  tokenAddress: string
  poolAddress: string | null
  poolType?: string | null
  skipCache?: boolean
  nowMs?: number
  rpcFetch?: typeof fetch
  rpcUrl?: string | null
}

type Venue = { isV3: boolean; fee: number; router: string; pair: string }

type CacheEntry = { at: number; result: RobinhoodHoneypotSimResult; audit: RobinhoodTradingSimulationAudit }
const simCache = new Map<string, CacheEntry>()

export function buildRobinhoodHoneypotCacheKey(chainId: number, tokenAddress: string, poolAddress: string | null): string {
  return `rh-honeypot:${chainId}:${tokenAddress.toLowerCase()}:${(poolAddress ?? 'none').toLowerCase()}`
}

export function isRobinhoodHoneypotCacheKeyValid(
  cached: { chainId: number; tokenAddress: string; poolAddress: string | null },
  selected: { chainId: number; tokenAddress: string; poolAddress: string | null },
): boolean {
  if (cached.chainId !== selected.chainId) return false
  if (cached.chainId !== ROBINHOOD_HONEYPOT_CHAIN_ID) return false
  if (selected.chainId !== ROBINHOOD_HONEYPOT_CHAIN_ID) return false
  if (cached.tokenAddress.toLowerCase() !== selected.tokenAddress.toLowerCase()) return false
  return (cached.poolAddress ?? '').toLowerCase() === (selected.poolAddress ?? '').toLowerCase()
}

export function clearRobinhoodHoneypotSimCache(): void {
  simCache.clear()
}

export function extractRobinhoodSimRevert(errorLike: unknown): string | null {
  const tryParse = (s: string): unknown => {
    try { return JSON.parse(s) } catch { return null }
  }
  const asObj = (v: unknown): Record<string, unknown> | null =>
    v && typeof v === 'object' ? v as Record<string, unknown> : null
  const hexIn = (s: string): string | null => {
    const m = s.match(/0x[0-9a-fA-F]{64,}/)
    return m ? m[0] : null
  }

  const root = asObj(errorLike) ?? {}
  const nestedError = asObj(root.error) ?? asObj(root.data) ?? {}
  const bodyParsed = typeof root.body === 'string' ? asObj(tryParse(root.body)) : null
  const bodyError = asObj(bodyParsed?.error)

  const candidates: unknown[] = [
    nestedError.data,
    root.data,
    bodyError?.data,
    root.message,
    nestedError.message,
    (nestedError as { data?: unknown }).data,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && /^0x[0-9a-fA-F]+$/.test(c)) return c
    if (typeof c === 'string') {
      const found = hexIn(c)
      if (found) return found
    }
    const inner = asObj(c)
    if (inner && typeof inner.data === 'string' && /^0x[0-9a-fA-F]+$/.test(inner.data)) return inner.data
    if (inner && typeof inner.data === 'string') {
      const found = hexIn(inner.data)
      if (found) return found
    }
  }
  if (typeof errorLike === 'string') return hexIn(errorLike)
  return null
}

export function decodeRobinhoodSimRevert(hex: string): {
  tokenGot: bigint
  canSell: number
  wethBack: bigint
  wethIn: bigint
} | null {
  if (!hex || hex.length < 66) return null
  const tryDecode = (data: `0x${string}`) => {
    const [tokenGot, canSell, wethBack, wethIn] = decodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }],
      data,
    )
    return { tokenGot, canSell: Number(canSell), wethBack, wethIn }
  }
  try {
    return tryDecode(hex as `0x${string}`)
  } catch {
    if (hex.length >= 10) {
      try { return tryDecode(`0x${hex.slice(10)}` as `0x${string}`) } catch { return null }
    }
    return null
  }
}

function checksum(addr: string): `0x${string}` {
  return addr as `0x${string}`
}

function isEvmAddress(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value)
}

export function robinhoodPoolTypeIsV4(poolType: string | null | undefined): boolean {
  const t = String(poolType ?? '').toLowerCase()
  return t === 'v4' || t.includes('uniswap_v4') || t.includes('uniswap-v4')
}

export function robinhoodPoolTypeIsConcentrated(poolType: string | null | undefined): boolean {
  const t = String(poolType ?? '').toLowerCase()
  return t === 'v3' || t === 'concentrated' || t.includes('v3')
}

export function robinhoodSimToHpStatus(
  status: RobinhoodHoneypotStatus,
): 'confirmed' | 'unavailable' | 'failed' | 'not_supported' | 'timeout' {
  if (status === 'unsupported') return 'not_supported'
  if (status === 'timeout') return 'timeout'
  if (status === 'unavailable') return 'unavailable'
  return 'confirmed'
}

function emptyResult(partial: Partial<RobinhoodHoneypotSimResult> & Pick<RobinhoodHoneypotSimResult, 'tokenAddress' | 'honeypotStatus'>): RobinhoodHoneypotSimResult {
  return {
    chainId: ROBINHOOD_HONEYPOT_CHAIN_ID,
    attempted: false,
    supported: false,
    sellable: null,
    buyTaxPct: null,
    sellTaxPct: null,
    simulationRouter: null,
    simulationPair: null,
    amountIn: ROBINHOOD_SIM_AMOUNT_IN_WEI.toString(),
    buySucceeded: null,
    sellSucceeded: null,
    failureReason: null,
    rawProviderError: null,
    ...partial,
  }
}

function auditFrom(result: RobinhoodHoneypotSimResult, poolAddress: string | null, cacheHit: boolean): RobinhoodTradingSimulationAudit {
  return {
    chainId: result.chainId,
    tokenAddress: result.tokenAddress,
    poolAddress,
    provider: 'alchemy_robinhood_rpc',
    scanhoodLogicUsed: true,
    ethCallAttempted: result.attempted,
    buySucceeded: result.buySucceeded,
    sellSucceeded: result.sellSucceeded,
    buyTaxPct: result.buyTaxPct,
    sellTaxPct: result.sellTaxPct,
    sellable: result.sellable,
    finalStatus: result.honeypotStatus,
    failureReason: result.failureReason,
    cacheHit,
    // CANONICAL-SELECTED-POOL AUDIT, DISCLOSED: this module only ever sees the ALREADY-canonical
    // pool address its caller resolved (see app/api/token/route.ts) — it has no visibility into
    // the separate market/LP candidates that fed that canonicalization, so those three fields
    // default here and are filled in by the caller, which does have that context. simulationAttempted/
    // finalReason are plain aliases of ethCallAttempted/failureReason for the audit shape's own
    // naming; simulationModuleLoaded is always true — this is a static import, never a runtime-
    // conditional dynamic load, so there is no "module failed to load" failure mode to report
    // honestly other than true. envReady reflects the one real environment gate this module
    // itself checks: whether a Robinhood RPC URL resolved at all.
    selectedPoolFromMarket: null,
    selectedPoolFromLp: null,
    canonicalSelectedPool: poolAddress,
    selectedPoolAddress: poolAddress,
    selectedPoolDex: null,
    selectedPoolChainOk: poolAddress != null,
    simulationAttempted: result.attempted,
    simulationModuleLoaded: true,
    envReady: result.failureReason !== 'Robinhood RPC is not configured',
    finalReason: result.failureReason,
  }
}

function pack(result: RobinhoodHoneypotSimResult, poolAddress: string | null, cacheHit: boolean) {
  return { result, audit: auditFrom(result, poolAddress, cacheHit) }
}

function pctLoss(out: bigint, expected: bigint): number | null {
  if (expected <= BigInt(0)) return null
  const loss = Number(expected - out) / Number(expected) * 100
  if (!Number.isFinite(loss)) return null
  return Math.max(0, Math.round(loss * 10) / 10)
}

function roundTripLossPct(wethBack: bigint, wethIn: bigint): number | null {
  if (wethIn <= BigInt(0)) return 100
  const loss = (1 - Number(wethBack) / Number(wethIn)) * 100
  if (!Number.isFinite(loss)) return null
  return Math.max(0, Math.round(loss * 10) / 10)
}

async function rpcCall(
  rpcUrl: string,
  method: string,
  params: unknown[],
  rpcFetch: typeof fetch,
  timeoutMs = ROBINHOOD_SIM_TIMEOUT_MS,
): Promise<{ ok: true; result: unknown } | { ok: false; timeout: boolean; error: string; revertHex: string | null }> {
  logRpcCall({ route: 'robinhoodHoneypotSimulation', chain: 'robinhood', method })
  if (rpcUrl.includes('g.alchemy.com')) {
    auditGlobalAlchemyCall(method, { chain: 'robinhood', route: 'robinhoodHoneypotSimulation' })
  }
  try {
    const res = await rpcFetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'chainlens-robinhood-sim/1.0' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const json = await res.json().catch(() => null) as { result?: unknown; error?: unknown } | null
    if (json?.error) {
      return {
        ok: false,
        timeout: false,
        error: typeof json.error === 'object' && json.error && 'message' in json.error
          ? String((json.error as { message?: unknown }).message ?? 'rpc_error')
          : 'rpc_error',
        revertHex: extractRobinhoodSimRevert(json.error),
      }
    }
    if (!res.ok) {
      return { ok: false, timeout: false, error: `http_${res.status}`, revertHex: null }
    }
    return { ok: true, result: json?.result ?? null }
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    return {
      ok: false,
      timeout: timedOut,
      error: timedOut ? 'timeout' : (err instanceof Error ? err.message : 'network_error'),
      revertHex: extractRobinhoodSimRevert(err),
    }
  }
}

function hexAddress(word: string | null | undefined): string | null {
  if (typeof word !== 'string') return null
  const hex = word.startsWith('0x') ? word.slice(2) : word
  if (hex.length < 40) return null
  const addr = `0x${hex.slice(-40)}`
  if (!isEvmAddress(addr)) return null
  if (addr.toLowerCase() === '0x0000000000000000000000000000000000000000') return null
  return addr.toLowerCase()
}

async function detectV3Fee(
  rpcUrl: string,
  token: string,
  poolAddress: string,
  rpcFetch: typeof fetch,
): Promise<number | null> {
  const factory = ROBINHOOD_SIM_V3_FACTORY
  for (const fee of V3_FEE_TIERS) {
    const data = encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }],
      [checksum(token), checksum(ROBINHOOD_SIM_WETH), fee],
    )
    // getPool(address,address,uint24) selector 0x1698ee82
    const call = await rpcCall(rpcUrl, 'eth_call', [{ to: factory, data: `0x1698ee82${data.slice(2)}` }, 'latest'], rpcFetch, 4_000)
    if (!call.ok || typeof call.result !== 'string') continue
    const found = hexAddress(call.result)
    if (found && found === poolAddress.toLowerCase()) return fee
  }
  return 3000
}

async function resolveVenue(
  rpcUrl: string,
  token: string,
  poolAddress: string,
  poolType: string | null | undefined,
  rpcFetch: typeof fetch,
): Promise<Venue | { unsupported: string }> {
  if (robinhoodPoolTypeIsV4(poolType)) {
    return { unsupported: 'Uniswap V4 pool cannot be buy/sell simulated on this path' }
  }
  const isV3Hint = robinhoodPoolTypeIsConcentrated(poolType)
  const isV2Hint = String(poolType ?? '').toLowerCase() === 'v2'

  if (isV2Hint) {
    return { isV3: false, fee: 0, router: ROBINHOOD_SIM_V2_ROUTER, pair: poolAddress }
  }
  if (isV3Hint) {
    const fee = await detectV3Fee(rpcUrl, token, poolAddress, rpcFetch)
    return { isV3: true, fee: fee ?? 3000, router: ROBINHOOD_SIM_V3_ROUTER, pair: poolAddress }
  }

  // Unknown pool type: ScanHood factory lookup only to choose V2 vs V3, still using ChainLens pool.
  const pairData = encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }],
    [checksum(token), checksum(ROBINHOOD_SIM_WETH)],
  )
  const pairCall = await rpcCall(
    rpcUrl,
    'eth_call',
    [{ to: ROBINHOOD_SIM_V2_FACTORY, data: `0xe6a43905${pairData.slice(2)}` }, 'latest'],
    rpcFetch,
    4_000,
  )
  if (pairCall.ok && hexAddress(typeof pairCall.result === 'string' ? pairCall.result : null)) {
    return { isV3: false, fee: 0, router: ROBINHOOD_SIM_V2_ROUTER, pair: poolAddress }
  }
  const fee = await detectV3Fee(rpcUrl, token, poolAddress, rpcFetch)
  if (fee != null) {
    return { isV3: true, fee, router: ROBINHOOD_SIM_V3_ROUTER, pair: poolAddress }
  }
  return { unsupported: 'No WETH V2/V3 venue for the selected Robinhood pool' }
}

function encodeConstructorData(token: string, venue: Venue): `0x${string}` {
  const args = encodeAbiParameters(
    [
      { type: 'address' },
      { type: 'address' },
      { type: 'address' },
      { type: 'address' },
      { type: 'bool' },
      { type: 'uint24' },
    ],
    [
      checksum(ROBINHOOD_SIM_WETH),
      checksum(token),
      checksum(ROBINHOOD_SIM_V2_ROUTER),
      checksum(ROBINHOOD_SIM_V3_ROUTER),
      venue.isV3,
      venue.fee,
    ],
  )
  return `${SCANHOOD_HONEYPOT_INIT_BYTECODE}${args.slice(2)}` as `0x${string}`
}

async function quoteBuyTokens(
  rpcUrl: string,
  token: string,
  rpcFetch: typeof fetch,
): Promise<bigint | null> {
  const encoded = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'address[]' }],
    [ROBINHOOD_SIM_AMOUNT_IN_WEI, [checksum(ROBINHOOD_SIM_WETH), checksum(token)]],
  )
  const data = `0xd06ca61f${encoded.slice(2)}`
  const call = await rpcCall(rpcUrl, 'eth_call', [{ to: ROBINHOOD_SIM_V2_ROUTER, data }, 'latest'], rpcFetch, 4_000)
  if (!call.ok || typeof call.result !== 'string' || call.result.length < 130) return null
  try {
    const decoded = decodeAbiParameters([{ type: 'uint256[]' }], call.result as `0x${string}`)
    const amounts = decoded[0] as readonly bigint[]
    return amounts[1] ?? null
  } catch {
    return null
  }
}

export async function simulateRobinhoodHoneypot(
  input: RobinhoodHoneypotSimInput,
): Promise<{ result: RobinhoodHoneypotSimResult; audit: RobinhoodTradingSimulationAudit }> {
  const tokenAddress = (input.tokenAddress || '').toLowerCase()
  const poolAddress = input.poolAddress && isEvmAddress(input.poolAddress) ? input.poolAddress.toLowerCase() : null
  const rpcFetch = input.rpcFetch ?? fetch

  if (input.chainId !== ROBINHOOD_HONEYPOT_CHAIN_ID) {
    return pack(emptyResult({
      tokenAddress,
      honeypotStatus: 'unsupported',
      failureReason: 'Wrong chain — Robinhood honeypot simulation only runs on chainId 4663',
    }), poolAddress, false)
  }
  if (!isEvmAddress(tokenAddress)) {
    return pack(emptyResult({
      tokenAddress,
      honeypotStatus: 'unavailable',
      failureReason: 'Invalid token address',
    }), poolAddress, false)
  }
  if (!poolAddress) {
    return pack(emptyResult({
      tokenAddress,
      honeypotStatus: 'unsupported',
      failureReason: 'No selected Robinhood pool',
    }), poolAddress, false)
  }

  const cacheKey = buildRobinhoodHoneypotCacheKey(ROBINHOOD_HONEYPOT_CHAIN_ID, tokenAddress, poolAddress)
  const now = input.nowMs ?? Date.now()
  if (!input.skipCache) {
    const hit = simCache.get(cacheKey)
    if (
      hit
      && now - hit.at < ROBINHOOD_SIM_CACHE_TTL_MS
      && isRobinhoodHoneypotCacheKeyValid(
        { chainId: ROBINHOOD_HONEYPOT_CHAIN_ID, tokenAddress: hit.result.tokenAddress, poolAddress: hit.audit.poolAddress },
        { chainId: ROBINHOOD_HONEYPOT_CHAIN_ID, tokenAddress, poolAddress },
      )
    ) {
      return { result: hit.result, audit: { ...hit.audit, cacheHit: true } }
    }
  }

  const rpcUrl = input.rpcUrl ?? getRobinhoodRpcUrl()
  if (!rpcUrl) {
    return pack(emptyResult({
      tokenAddress,
      simulationPair: poolAddress,
      honeypotStatus: 'unavailable',
      failureReason: 'Robinhood RPC is not configured',
    }), poolAddress, false)
  }

  const venue = await resolveVenue(rpcUrl, tokenAddress, poolAddress, input.poolType, rpcFetch)
  if ('unsupported' in venue) {
    return pack(emptyResult({
      tokenAddress,
      simulationPair: poolAddress,
      honeypotStatus: 'unsupported',
      failureReason: venue.unsupported,
    }), poolAddress, false)
  }

  const data = encodeConstructorData(tokenAddress, venue)
  const tx = {
    from: ROBINHOOD_SIM_FROM,
    data,
    value: `0x${ROBINHOOD_SIM_AMOUNT_IN_WEI.toString(16)}`,
  }
  const stateOverride = {
    [ROBINHOOD_SIM_FROM]: { balance: '0x56BC75E2D63100000' }, // 100 ETH, never spent
  }

  let call = await rpcCall(rpcUrl, 'eth_call', [tx, 'latest', stateOverride], rpcFetch)
  if (!call.ok && !call.timeout && !call.revertHex) {
    // Some nodes reject the state-override arg; retry the ScanHood 2-arg form.
    call = await rpcCall(rpcUrl, 'eth_call', [tx, 'latest'], rpcFetch)
  }

  if (call.ok) {
    const result = emptyResult({
      tokenAddress,
      attempted: true,
      supported: true,
      simulationRouter: venue.router,
      simulationPair: venue.pair,
      honeypotStatus: 'unavailable',
      failureReason: 'Simulation did not revert with encoded buy/sell result',
      rawProviderError: typeof call.result === 'string' ? call.result.slice(0, 120) : 'unexpected_success',
    })
    return pack(result, poolAddress, false)
  }

  if (call.timeout) {
    const result = emptyResult({
      tokenAddress,
      attempted: true,
      supported: true,
      simulationRouter: venue.router,
      simulationPair: venue.pair,
      honeypotStatus: 'timeout',
      failureReason: 'Simulation timed out',
      rawProviderError: call.error,
    })
    return pack(result, poolAddress, false)
  }

  const decoded = call.revertHex ? decodeRobinhoodSimRevert(call.revertHex) : null
  if (!decoded) {
    const result = emptyResult({
      tokenAddress,
      attempted: true,
      supported: true,
      simulationRouter: venue.router,
      simulationPair: venue.pair,
      honeypotStatus: 'unavailable',
      failureReason: `RPC simulation failed: ${call.error}`,
      rawProviderError: call.error,
    })
    return pack(result, poolAddress, false)
  }

  const buySucceeded = decoded.tokenGot > BigInt(0)
  const sellSucceeded = decoded.canSell === 1 && decoded.wethBack > BigInt(0)
  const sellable = buySucceeded && sellSucceeded
  const honeypotStatus: RobinhoodHoneypotStatus = !buySucceeded
    ? 'blocked'
    : sellable
      ? 'sellable'
      : 'blocked'

  let buyTaxPct: number | null = null
  let sellTaxPct = sellable ? roundTripLossPct(decoded.wethBack, decoded.wethIn) : null
  if (!venue.isV3 && buySucceeded) {
    const expectedTokens = await quoteBuyTokens(rpcUrl, tokenAddress, rpcFetch)
    if (expectedTokens && expectedTokens > BigInt(0)) {
      buyTaxPct = pctLoss(decoded.tokenGot, expectedTokens)
      if (sellable && sellTaxPct != null && buyTaxPct != null) {
        sellTaxPct = Math.max(0, Math.round((sellTaxPct - buyTaxPct) * 10) / 10)
      }
    }
  }

  const result: RobinhoodHoneypotSimResult = {
    chainId: ROBINHOOD_HONEYPOT_CHAIN_ID,
    tokenAddress,
    attempted: true,
    supported: true,
    sellable,
    honeypotStatus,
    buyTaxPct,
    sellTaxPct,
    simulationRouter: venue.router,
    simulationPair: venue.pair,
    amountIn: ROBINHOOD_SIM_AMOUNT_IN_WEI.toString(),
    buySucceeded,
    sellSucceeded,
    failureReason: !buySucceeded
      ? 'Simulated buy failed'
      : !sellSucceeded
        ? 'Simulated sell failed'
        : null,
    rawProviderError: null,
  }
  const packed = pack(result, poolAddress, false)
  simCache.set(cacheKey, { at: now, result, audit: packed.audit })
  return packed
}
