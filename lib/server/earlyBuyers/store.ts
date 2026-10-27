import { createServiceRoleClient } from '../../supabase/userSettings'
import { getTokenCache, setTokenCache } from '../cache/tokenCache'
import { EARLY_BUYER_WINDOW_SCOPE, type EarlyBuyerChain, type EarlyBuyerIntel } from './types'

export const EARLY_BUYER_VERSION = 2
const ADDRESS = /^0x[0-9a-f]{40}$/
const POOL = /^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const HASH = /^0x[0-9a-f]{64}$/
const durableKey = (chain: EarlyBuyerChain, token: string) => `early-buyers:verified:v${EARLY_BUYER_VERSION}:${chain}:${token}`
const provisionalKey = (chain: EarlyBuyerChain, token: string) => `early-buyers:provisional:v${EARLY_BUYER_VERSION}:${chain}:${token}`

export function windowIsFinalized(endBlock: number | null, finalizedBlock: number | null): boolean {
  return endBlock != null && finalizedBlock != null && Number.isSafeInteger(endBlock) && Number.isSafeInteger(finalizedBlock) && endBlock < finalizedBlock
}

function validShape(chain: EarlyBuyerChain, token: string, v: EarlyBuyerIntel): boolean {
  if (!ADDRESS.test(token) || !v || typeof v !== 'object' || !v.launch || !v.window || !v.coverage || !v.budget) return false
  if (v.coverage.scope !== EARLY_BUYER_WINDOW_SCOPE) return false
  if (!Array.isArray(v.buyers) || !Array.isArray(v.groups) || !Array.isArray(v.launchDistributions) || !Array.isArray(v.window.pools) || !Array.isArray(v.coverage.reasons)) return false
  if (v.launch.pool != null && !POOL.test(v.launch.pool)) return false
  if (v.launch.creationTx != null && !HASH.test(v.launch.creationTx)) return false
  if (v.launch.liquidityTx != null && !HASH.test(v.launch.liquidityTx)) return false
  if (v.window.pools.some((pool) => !POOL.test(pool))) return false
  if (v.buyers.some((b) => !ADDRESS.test(b.wallet) || !/^\d+$/.test(b.boughtRaw) || !Array.isArray(b.transactions) || b.transactions.some((h) => !HASH.test(h)))) return false
  if (v.groups.some((g) => !Array.isArray(g.wallets) || !Array.isArray(g.transactions) || g.wallets.some((w) => !ADDRESS.test(w)) || g.transactions.some((h) => !HASH.test(h)))) return false
  if (!Number.isSafeInteger(v.budget.calls) || v.budget.calls < 0 || v.budget.calls > 60 || !Number.isFinite(v.budget.cu) || v.budget.cu < 0 || v.budget.cu > 2_000) return false
  if (v.discovery && (!Array.isArray(v.discovery.candidates) || v.discovery.candidates.some((c) => !POOL.test(c.pool)))) return false
  return chain === 'base' || chain === 'eth'
}

/** Same later-pool rule as discoverLaunches. Verified rows never block. A non-verified row blocks unless it is strictly after the first verified row in both index and timestamp. */
function nonVerifiedCandidateBlocks(candidates: NonNullable<EarlyBuyerIntel['discovery']>['candidates'], index: number): boolean {
  const candidate = candidates[index]
  if (!candidate || candidate.outcome === 'verified' || candidate.reason === 'created_after_verified_launch') return false
  const firstVerified = candidates.findIndex((item) => item.outcome === 'verified')
  const verifiedAt = firstVerified >= 0 ? candidates[firstVerified].createdAt : null
  if (firstVerified < 0 || verifiedAt == null || candidate.createdAt == null) return true
  return !(index > firstVerified && candidate.createdAt > verifiedAt)
}

export function canPersistFinalizedEvidence(v: EarlyBuyerIntel, finalized: boolean, chain: EarlyBuyerChain = 'base', token = `0x${'1'.repeat(40)}`): boolean {
  return finalized && validShape(chain, token.toLowerCase(), v) && v.status === 'verified' && v.launch.status === 'verified' &&
    v.launch.block != null && Number.isSafeInteger(v.launch.block) && v.launch.pool != null && v.launch.creationTx != null && v.launch.liquidityTx != null &&
    v.window.startBlock != null && v.window.endBlock != null && Number.isSafeInteger(v.window.startBlock) && Number.isSafeInteger(v.window.endBlock) &&
    v.window.startBlock >= v.launch.block && v.window.endBlock >= v.window.startBlock && v.window.pools.includes(v.launch.pool) &&
    v.coverage.scope === EARLY_BUYER_WINDOW_SCOPE && !v.coverage.capped && !v.coverage.provisional && v.coverage.reasons.length === 0 && v.discovery?.complete === true &&
    v.discovery.candidates.length > 0 && v.discovery.candidates.every((_, index, all) => !nonVerifiedCandidateBlocks(all, index)) &&
    v.discovery.earliestVerifiedPool === v.launch.pool
    && v.buyers.every((buyer) => buyer.purchaseProven === false && Array.isArray(buyer.evidence) && buyer.evidence.length > 0 && buyer.evidence.every((proof) =>
      proof.reason === 'pool_sourced_token_delivery_in_swap_transaction' && HASH.test(proof.txHash) && buyer.transactions.includes(proof.txHash) &&
      POOL.test(proof.pool) && v.window.pools.includes(proof.pool) && Number.isSafeInteger(proof.block) && proof.block >= v.window.startBlock! &&
      proof.block <= v.window.endBlock! && Number.isSafeInteger(proof.timestampSec) && proof.timestampSec! > 0))
}

export function validEarlyBuyerCacheEnvelope(value: unknown, chain: EarlyBuyerChain, token: string, durable: boolean): value is { intel: EarlyBuyerIntel } {
  if (!value || typeof value !== 'object') return false
  const row = value as { version?: unknown; chain?: unknown; token?: unknown; intel?: EarlyBuyerIntel }
  return row.version === EARLY_BUYER_VERSION && row.chain === chain && row.token === token && validShape(chain, token, row.intel!) &&
    (row.intel!.status !== 'verified' || canPersistFinalizedEvidence(row.intel!, true, chain, token)) &&
    (!durable || canPersistFinalizedEvidence(row.intel!, true, chain, token))
}

export async function readEarlyBuyerEvidence(chain: EarlyBuyerChain, tokenInput: string): Promise<EarlyBuyerIntel | null> {
  const token = tokenInput.toLowerCase()
  if (!ADDRESS.test(token)) return null
  const durable = await getTokenCache<unknown>(durableKey(chain, token))
  if (validEarlyBuyerCacheEnvelope(durable, chain, token, true)) return durable.intel
  const recent = await getTokenCache<unknown>(provisionalKey(chain, token))
  if (validEarlyBuyerCacheEnvelope(recent, chain, token, false)) return recent.intel
  const client = createServiceRoleClient()
  if (!client) return null
  try {
    const { data, error } = await client.from('token_launch_buyers').select('chain,token,pool,launch_block,status,evidence,version').eq('chain', chain).eq('token', token).maybeSingle()
    if (error || !data || data.version !== EARLY_BUYER_VERSION || data.chain !== chain || data.token !== token || !validShape(chain, token, data.evidence) ||
      data.pool !== data.evidence.launch.pool || data.launch_block !== data.evidence.launch.block || data.status !== 'verified' ||
      !canPersistFinalizedEvidence(data.evidence, true, chain, token)) return null
    await setTokenCache(durableKey(chain, token), { version: EARLY_BUYER_VERSION, chain, token, intel: data.evidence }, 86_400)
    return data.evidence
  } catch { return null }
}

export async function writeEarlyBuyerEvidence(chain: EarlyBuyerChain, tokenInput: string, intel: EarlyBuyerIntel, finalized: boolean): Promise<boolean> {
  const token = tokenInput.toLowerCase()
  if (!validShape(chain, token, intel)) return false
  const clean = { ...intel, coverage: { ...intel.coverage, reasons: [...intel.coverage.reasons] }, buyers: intel.buyers.map((b) => ({ ...b, heldRaw: null })), groups: intel.groups.map((g) => ({ ...g, heldWithinEarlySetPct: null })) }
  const record = { version: EARLY_BUYER_VERSION, chain, token, intel: clean }
  if (!canPersistFinalizedEvidence(clean, finalized, chain, token)) {
    // A verified label is only cacheable when it meets the durable contract. Partial and estimated rows may still be provisional.
    if (clean.status !== 'verified') await setTokenCache(provisionalKey(chain, token), record, 120)
    return false
  }
  const client = createServiceRoleClient()
  if (!client) { await setTokenCache(provisionalKey(chain, token), record, 120); return false }
  try {
    // Unique (chain,token) plus INSERT gives first-write-wins across workers.
    const { error } = await client.from('token_launch_buyers').insert({ chain, token, pool: clean.launch.pool, launch_block: clean.launch.block, window_end_block: clean.window.endBlock, status: clean.status, evidence: clean, version: EARLY_BUYER_VERSION })
    if (error) return false
    await setTokenCache(durableKey(chain, token), record, 86_400)
    return true
  } catch { await setTokenCache(provisionalKey(chain, token), record, 120); return false }
}
