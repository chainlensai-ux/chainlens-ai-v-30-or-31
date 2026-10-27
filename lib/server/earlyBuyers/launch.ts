import { toEventSelector } from 'viem'
import { ONCHAIN_POOL_CHAINS } from '../../pricing/onchainPoolSource'
import { V4_INITIALIZE_TOPIC0 } from '../../v4SwapCandles'
import { MODIFY_LIQUIDITY_TOPIC0 } from '../uniswapV4BaseRpc'
import { AERODROME_CLASSIC_FACTORY, AERODROME_SLIPSTREAM_FACTORY } from '../../../src/modules/receiptSwapDecoder/poolValidator'
import type { EarlyBuyerChain } from './types'
import type { EarlyBuyerRpc } from './rpc'
import { EarlyBuyerRpcError } from './rpc'
import { isAddress } from './classify'

export type PoolCandidate = { address: string; dex: string; createdAt: number | null }
export type LaunchProof = {
  status: 'verified' | 'estimated' | 'unsupported_launch_venue' | 'unavailable'
  block: number | null
  pool: string | null
  creationTx: string | null
  liquidityTx: string | null
  protocol: 'v2' | 'v3' | 'v4' | 'aerodrome_v2' | 'slipstream' | null
}
type RpcLog = { address?: string; topics?: string[]; data?: string; blockNumber?: string; transactionHash?: string; removed?: boolean }
type Block = { number?: string; timestamp?: string }
const ADDR = /^0x[0-9a-f]{40}$/i
const POOL_ID = /^0x[0-9a-f]{64}$/i
const hex = (n: number) => `0x${Math.floor(n).toString(16)}`
const asInt = (s: unknown): number | null => typeof s === 'string' && /^0x[0-9a-f]+$/i.test(s) ? Number(BigInt(s)) : null
const addressTopic = (s: string) => `0x${'0'.repeat(24)}${s.slice(2).toLowerCase()}`
const topicAddress = (s: string | undefined): string | null => typeof s === 'string' && /^0x[0-9a-f]{64}$/i.test(s) ? `0x${s.slice(-40).toLowerCase()}` : null
const wordAddress = (data: string | undefined, word: number): string | null => typeof data === 'string' && data.length >= 2 + 64 * (word + 1) ? topicAddress(`0x${data.slice(2 + 64 * word, 2 + 64 * (word + 1))}`) : null

const PAIR_CREATED = toEventSelector('PairCreated(address,address,address,uint256)')
const POOL_CREATED = toEventSelector('PoolCreated(address,address,uint24,int24,address)')
// ABI confirmed by the existing Aerodrome Base factory contracts: classic IPoolFactory and
// the source-verified Slipstream CLFactory. These are not inferred from symbol or DEX label.
const AERO_POOL_CREATED = toEventSelector('PoolCreated(address,address,bool,address,uint256)')
const SLIPSTREAM_POOL_CREATED = toEventSelector('PoolCreated(address,address,int24,address)')
const MINT_V2 = toEventSelector('Mint(address,uint256,uint256)')
const MINT_V3 = toEventSelector('Mint(address,address,int24,int24,uint128,uint256,uint256)')

function protocolFor(dex: string, address: string): LaunchProof['protocol'] {
  if (POOL_ID.test(address)) return /uniswap/i.test(dex) ? 'v4' : null
  if (/slipstream/i.test(dex)) return 'slipstream'
  if (/aerodrome/i.test(dex)) return 'aerodrome_v2'
  if (/uniswap.*v3|uniswap_v3/i.test(dex)) return 'v3'
  if (/uniswap.*v2|uniswap_v2/i.test(dex)) return 'v2'
  return null
}

async function nearestBlock(rpc: EarlyBuyerRpc, chain: EarlyBuyerChain, timestampMs: number, cache: Map<number, Block>): Promise<number | null> {
  // Closed bracket over headers this request actually read. Base and Ethereum timestamps are
  // non-decreasing; a nominal block time is only the first-step hint before a lower anchor exists.
  // Return the first block at or after the target only when that header was read and the previous
  // block was read strictly earlier (genesis has no previous block). Any missing header, inverted
  // clock, or unclosed bracket fails closed. Never return an unread or interpolated block number.
  const read = async (spec: number | 'latest'): Promise<Block | null> => {
    if (spec === 'latest') {
      const cachedLatest = cache.get(-1)
      if (cachedLatest) return cachedLatest
    } else {
      const hit = cache.get(spec)
      if (hit) return hit
    }
    const block = await rpc.call<Block>('eth_getBlockByNumber', [spec === 'latest' ? 'latest' : hex(spec), false])
    const number = asInt(block?.number)
    if (number == null || asInt(block?.timestamp) == null) return null
    cache.set(number, block)
    if (spec === 'latest') cache.set(-1, block)
    return block
  }
  const latest = await read('latest')
  if (!latest) return null
  const latestNo = asInt(latest.number)!, latestTs = asInt(latest.timestamp)!
  if (!Number.isSafeInteger(latestNo) || timestampMs > latestTs * 1000) return null
  let lowExclusive = -1
  let lowTs: number | null = null
  let highInclusive = latestNo
  let highTs = latestTs * 1000
  const nominalMs = chain === 'base' ? 2_000 : 12_000
  const paceNo = latestNo
  const paceTs = latestTs * 1000
  for (let probe = 0; probe < 12 && highInclusive - lowExclusive > 1; probe++) {
    const gapBlocks = highInclusive - lowExclusive
    const measuredMs = paceNo > highInclusive && paceTs > highTs ? (paceTs - highTs) / (paceNo - highInclusive) : null
    const span = lowTs != null ? highTs - lowTs : measuredMs != null && measuredMs > 0 ? measuredMs * gapBlocks : gapBlocks * nominalMs
    const dt = highTs - timestampMs
    // Nominal time is only the opening guess. After two real headers, pace is measured from
    // them. An anchor exactly on the target steps to the previous block so a short tie resolves
    // to the first block at that timestamp; a tie wider than the probe cap fails closed.
    const guess = dt === 0
      ? highInclusive - 1
      : span <= 0 || dt < 0
        ? Math.floor((lowExclusive + highInclusive) / 2)
        : highInclusive - Math.round((dt * gapBlocks) / span)
    const mid = Math.min(highInclusive - 1, Math.max(lowExclusive + 1, guess))
    const block = await read(mid)
    const ts = block ? asInt(block.timestamp) : null
    const number = block ? asInt(block.number) : null
    if (ts == null || number == null || number <= lowExclusive || number > highInclusive) return null
    const ms = ts * 1000
    if ((lowTs != null && ms < lowTs) || ms > highTs) return null
    if (number === mid && ms >= timestampMs) { highInclusive = number; highTs = ms }
    else if (number === mid) { lowExclusive = number; lowTs = ms }
    else if (ms >= timestampMs && number - 1 > lowExclusive) { highInclusive = number; highTs = ms }
    else if (ms < timestampMs && number + 1 < highInclusive) { lowExclusive = number; lowTs = ms }
    else return null
    if (lowTs != null && lowTs >= highTs) return null
  }
  if (highInclusive - lowExclusive !== 1) return null
  const provenHigh = asInt(cache.get(highInclusive)?.timestamp)
  if (provenHigh == null || provenHigh * 1000 < timestampMs) return null
  if (lowExclusive >= 0) {
    const provenLow = asInt(cache.get(lowExclusive)?.timestamp)
    if (provenLow == null || provenLow * 1000 >= timestampMs) return null
  }
  return highInclusive
}

function creationMatches(log: RpcLog, protocol: NonNullable<LaunchProof['protocol']>, pool: string, token: string): boolean {
  if (log.removed || !Array.isArray(log.topics)) return false
  if (protocol === 'v4') return log.topics[0]?.toLowerCase() === V4_INITIALIZE_TOPIC0 && log.topics[1]?.toLowerCase() === pool.toLowerCase() && [topicAddress(log.topics[2]), topicAddress(log.topics[3])].includes(token)
  const token0 = topicAddress(log.topics[1]), token1 = topicAddress(log.topics[2])
  if (token0 !== token && token1 !== token) return false
  if (protocol === 'v2') return log.topics[0]?.toLowerCase() === PAIR_CREATED && wordAddress(log.data, 0) === pool
  if (protocol === 'v3') return log.topics[0]?.toLowerCase() === POOL_CREATED && wordAddress(log.data, 1) === pool
  if (protocol === 'aerodrome_v2') return log.topics[0]?.toLowerCase() === AERO_POOL_CREATED && wordAddress(log.data, 0) === pool
  if (protocol === 'slipstream') return log.topics[0]?.toLowerCase() === SLIPSTREAM_POOL_CREATED && wordAddress(log.data, 0) === pool
  return false
}

export type LaunchDiscovery = {
  primary: LaunchProof
  pools: LaunchProof[]
  incompleteReason: string | null
  earliestDiscoveredPool: string | null
  earliestVerifiedPool: string | null
  candidates: Array<{ pool: string; createdAt: number | null; outcome: 'verified' | 'estimated' | 'skipped' | 'unresolved' | 'excluded'; reason: string }>
  complete: boolean
}

export async function discoverLaunches(rpc: EarlyBuyerRpc, chain: EarlyBuyerChain, tokenInput: string, candidates: PoolCandidate[]): Promise<LaunchDiscovery> {
  const token = tokenInput.toLowerCase()
  const unsupported: LaunchProof = { status: 'unsupported_launch_venue', block: null, pool: null, creationTx: null, liquidityTx: null, protocol: null }
  if (!isAddress(token)) return { primary: { ...unsupported, status: 'unavailable' }, pools: [], incompleteReason: 'invalid_token', earliestDiscoveredPool: null, earliestVerifiedPool: null, candidates: [], complete: false }
  const configs = ONCHAIN_POOL_CHAINS[chain === 'base' ? 8453 : 1]
  let best: LaunchProof | null = null
  let bestCreationBlock = Infinity
  let estimated: LaunchProof | null = null
  const provenPools: LaunchProof[] = []
  const diagnostics: LaunchDiscovery['candidates'] = []
  const blockCache = new Map<number, Block>()
  const ordered = [...candidates].sort((a, b) => (a.createdAt ?? Infinity) - (b.createdAt ?? Infinity) || a.address.localeCompare(b.address))
  for (const [index, candidate] of ordered.entries()) {
    const pool = candidate.address.toLowerCase()
    const record = (outcome: LaunchDiscovery['candidates'][number]['outcome'], reason: string) => diagnostics.push({ pool, createdAt: candidate.createdAt, outcome, reason })
    if (index >= 3) { record('skipped', 'pool_candidate_cap_3'); continue }
    try {
    const protocol = protocolFor(candidate.dex, pool)
    if (!protocol || (!ADDR.test(pool) && !POOL_ID.test(pool))) { record('excluded', 'launch_venue_not_supported_by_v1'); continue }
    if (chain !== 'base' && (protocol === 'aerodrome_v2' || protocol === 'slipstream')) { record('excluded', 'venue_not_on_chain'); continue }
    if (candidate.createdAt == null || !Number.isFinite(candidate.createdAt)) { record('unresolved', 'pool_creation_timestamp_unavailable'); continue }
    const near = await nearestBlock(rpc, chain, candidate.createdAt, blockCache)
    if (near == null) { record('unresolved', 'historical_block_unavailable'); continue }
    const fallback: LaunchProof = { status: 'estimated', block: near, pool, creationTx: null, liquidityTx: null, protocol }
    if (!estimated || near < (estimated.block ?? Infinity)) estimated = fallback
    const factory = protocol === 'v2' ? configs.v2Factory : protocol === 'v3' ? configs.v3Factory : protocol === 'aerodrome_v2' ? AERODROME_CLASSIC_FACTORY : protocol === 'slipstream' ? AERODROME_SLIPSTREAM_FACTORY : configs.v4PoolManager
    const topic0 = protocol === 'v2' ? PAIR_CREATED : protocol === 'v3' ? POOL_CREATED : protocol === 'aerodrome_v2' ? AERO_POOL_CREATED : protocol === 'slipstream' ? SLIPSTREAM_POOL_CREATED : V4_INITIALIZE_TOPIC0
    const filters = protocol === 'v4'
      ? [[topic0, pool]]
      : [[topic0, addressTopic(token)], [topic0, null, addressTopic(token)]]
    const creation: RpcLog[] = []
    for (const topics of filters) {
      for (const radius of [8, 64]) {
        const rows = await rpc.call<RpcLog[]>('eth_getLogs', [{ address: factory, fromBlock: hex(Math.max(0, near - radius)), toBlock: hex(near + radius), topics }])
        const matching = rows.filter((row) => creationMatches(row, protocol, pool, token))
        creation.push(...matching)
        if (matching.length > 0) break
      }
      if (creation.length > 0) break
    }
    creation.sort((a, b) => (asInt(a.blockNumber) ?? Infinity) - (asInt(b.blockNumber) ?? Infinity))
    const first = creation[0]
    if (!first) { record('estimated', 'factory_creation_event_not_found_in_bounded_range'); continue }
    const creationBlock = asInt(first.blockNumber)
    if (creationBlock == null || !/^0x[0-9a-f]{64}$/i.test(first.transactionHash ?? '')) { record('unresolved', 'factory_creation_evidence_malformed'); continue }
    const mintTopic = protocol === 'v2' || protocol === 'aerodrome_v2' ? MINT_V2 : protocol === 'v3' || protocol === 'slipstream' ? MINT_V3 : MODIFY_LIQUIDITY_TOPIC0
    const mintFilter = protocol === 'v4' ? [mintTopic, pool] : [mintTopic]
    const mintRows: RpcLog[] = []
    for (const length of [8, 64]) {
      mintRows.push(...await rpc.call<RpcLog[]>('eth_getLogs', [{ address: protocol === 'v4' ? factory : pool, fromBlock: hex(creationBlock), toBlock: hex(creationBlock + length), topics: mintFilter }]))
      if (mintRows.length > 0) break
    }
    mintRows.sort((a, b) => (asInt(a.blockNumber) ?? Infinity) - (asInt(b.blockNumber) ?? Infinity))
    const firstMint = mintRows.find((row) => {
      if (row.removed || row.topics?.[0]?.toLowerCase() !== mintTopic.toLowerCase() || (protocol === 'v4' && row.topics?.[1]?.toLowerCase() !== pool) || asInt(row.blockNumber) == null) return false
      if (protocol !== 'v4') return true
      // V4 liquidityDelta is the third unindexed word (int256); negative/zero is not an add.
      const word = row.data?.slice(2 + 64 * 2, 2 + 64 * 3)
      return Boolean(word && /^[0-9a-f]{64}$/i.test(word) && BigInt(`0x${word}`) > BigInt(0) && BigInt(`0x${word}`) < (BigInt(1) << BigInt(255)))
    })
    if (!firstMint || !/^0x[0-9a-f]{64}$/i.test(firstMint.transactionHash ?? '')) { record('unresolved', 'first_liquidity_event_unverified'); continue }
    const proof: LaunchProof = { status: 'verified', block: asInt(firstMint.blockNumber), pool, creationTx: first.transactionHash ?? null, liquidityTx: firstMint.transactionHash ?? null, protocol }
    if (estimated?.pool === pool) estimated = null
    provenPools.push(proof)
    record('verified', 'factory_creation_and_first_liquidity_events_verified')
    if (creationBlock < bestCreationBlock) { best = proof; bestCreationBlock = creationBlock }
    } catch (error) {
      record('unresolved', error instanceof EarlyBuyerRpcError ? error.reason : 'launch_discovery_failed')
      for (const remaining of ordered.slice(index + 1)) diagnostics.push({ pool: remaining.address.toLowerCase(), createdAt: remaining.createdAt, outcome: 'skipped', reason: 'prior_provider_failure' })
      break
    }
  }
  // A non-verified candidate blocks unless it is proven later than the earliest verified pool.
  // A DexScreener timestamp is proof only when it is strictly later. A missing timestamp is not.
  // Bytecode absent at the verified launch block proves the pool did not exist yet, so it is not
  // an earlier pool and does not need its own launch verification. Bytecode present, an equal
  // time, or an unchecked pool still blocks.
  if (best?.status === 'verified' && best.block != null) {
    for (const candidate of diagnostics) {
      if (candidate.outcome === 'verified' || candidate.createdAt != null || candidate.reason === 'created_after_verified_launch') continue
      try {
        const code = await rpc.call<string>('eth_getCode', [candidate.pool, hex(best.block)])
        if (code === '0x' || code === '0x0') candidate.reason = 'created_after_verified_launch'
      } catch { break }
    }
  }
  const firstVerified = diagnostics.findIndex((candidate) => candidate.outcome === 'verified')
  const verifiedAt = firstVerified >= 0 ? diagnostics[firstVerified].createdAt : null
  const blocking = diagnostics.filter((candidate, index) => {
    if (candidate.outcome === 'verified' || candidate.reason === 'created_after_verified_launch') return false
    if (firstVerified < 0 || verifiedAt == null || candidate.createdAt == null) return true
    return !(index > firstVerified && candidate.createdAt > verifiedAt)
  })
  const complete = firstVerified >= 0 && blocking.length === 0 && diagnostics.length === ordered.length
  const incompleteReason = complete ? null : [...new Set(blocking.map((candidate) => candidate.reason))].join(',') || 'launch_discovery_incomplete'
  const allExcluded = diagnostics.length > 0 && diagnostics.every((candidate) => candidate.outcome === 'excluded')
  const primary = best ?? estimated ?? { ...unsupported, status: allExcluded ? 'unsupported_launch_venue' as const : 'unavailable' as const }
  return { primary, pools: provenPools, incompleteReason, earliestDiscoveredPool: ordered[0]?.address.toLowerCase() ?? null, earliestVerifiedPool: best?.pool ?? null, candidates: diagnostics, complete }
}

export async function discoverLaunch(rpc: EarlyBuyerRpc, chain: EarlyBuyerChain, tokenInput: string, candidates: PoolCandidate[]): Promise<LaunchProof> {
  return (await discoverLaunches(rpc, chain, tokenInput, candidates)).primary
}
