import { createClient } from '@supabase/supabase-js'
import { OUTCOME_POLICY, classifyOutcome, numberOrNull, percentChange, type TrackedOutcome } from '../tokenOutcomes'
import { dexScreenerMarketProvider, geckoTerminalMarketProvider } from './clarkMarketDataProviders'
import type { ClarkMarketQuote } from './clarkMarketData'
import { getTokenCache, setTokenCache } from './cache/tokenCache'
import { afterScanProof } from '../tokenOutcomeProof'
import { buildTokenScanCacheKey } from '../tokenScannerChainStrictness'
import type { EvmChainSlug } from '../tokenScannerChainStrictness'

export function outcomeDb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Outcome storage is not configured.')
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}
const chainAlias = (c: string | null) => c === 'ethereum' ? 'eth' : c === 'bsc' ? 'bnb' : c
export function quoteMatches(q: ClarkMarketQuote | null, chain: string, address: string): q is ClarkMarketQuote {
  return !!q && chainAlias(q.chain) === chain && (chain === 'solana' ? q.address === address : q.address?.toLowerCase() === address.toLowerCase())
}
export async function resolveOutcomeQuote(chain: string, address: string, providers = { dex: dexScreenerMarketProvider, gecko: geckoTerminalMarketProvider }): Promise<ClarkMarketQuote | null> {
  const key = `outcomeMarket:v1:${chain}:${address}`
  const cached = await getTokenCache<ClarkMarketQuote>(key)
  if (quoteMatches(cached, chain, address) && Date.now() - cached.fetchedAt < OUTCOME_POLICY.staleMs) return cached
  const dex = await providers.dex(address, chain)
  let quote = (dex?.matches ?? []).find(q => quoteMatches(q, chain, address) && (q.priceUsd ?? 0) > 0) ?? null
  if (!quote) {
    const gecko = await providers.gecko(address, chain)
    if (quoteMatches(gecko, chain, address)) quote = gecko
  }
  if (quote) await setTokenCache(key, quote, OUTCOME_POLICY.staleMs / 1000)
  return quote
}
export async function refreshOutcomes(userId: string) {
  const db = outcomeDb()
  const stale = new Date(Date.now() - OUTCOME_POLICY.staleMs).toISOString()
  const lease = new Date(Date.now() - 60_000).toISOString()
  const { data, error } = await db.from('tracked_token_outcomes').select('*').eq('user_id', userId)
    .or(`last_checked_at.is.null,last_checked_at.lt.${stale}`)
    .or(`refresh_claimed_at.is.null,refresh_claimed_at.lt.${lease}`)
    .order('last_checked_at', { ascending: true, nullsFirst: true }).limit(OUTCOME_POLICY.refreshBatch)
  if (error) throw new Error('Outcome storage unavailable. Check the tracked-token-outcomes migration.')
  await Promise.all(((data ?? []) as TrackedOutcome[]).map(async row => {
    const claimedAt = new Date().toISOString()
    // Conditional DB lease avoids duplicate provider work across server instances and tabs.
    const claim = await db.from('tracked_token_outcomes').update({ refresh_claimed_at: claimedAt }).eq('id', row.id).eq('user_id', userId)
      .or(`last_checked_at.is.null,last_checked_at.lt.${stale}`)
      .or(`refresh_claimed_at.is.null,refresh_claimed_at.lt.${lease}`).select('id')
    if (claim.error || !claim.data?.length) return
    const quote = await resolveOutcomeQuote(row.chain, row.token_address).catch(() => null)
    const price = numberOrNull(quote?.priceUsd)
    const liquidity = numberOrNull(quote?.liquidityUsd)
    const chainId = ({ base: 8453, eth: 1, bnb: 56, robinhood: 4663 } as Record<string, number>)[row.chain]
    const laterScan = chainId ? await getTokenCache<Record<string, unknown>>(buildTokenScanCacheKey(row.chain as EvmChainSlug, chainId, row.token_address)) : null
    const proof = afterScanProof(row, laterScan) ?? row.after_evidence_json ?? null
    const result = classifyOutcome({ price: row.baseline_price_usd, liquidity: row.baseline_liquidity_usd }, { price, liquidity, verifiedTradingBlocked: proof?.verifiedTradingBlocked === true })
    // No extra expensive token scan. Existing fresh server cache can corroborate a later honeypot.
    // Aggregate market reserves alone never become burn/drain/pool-death evidence.
    const update = await db.from('tracked_token_outcomes').update({
      current_price_usd: price && price > 0 ? price : null, current_liquidity_usd: liquidity,
      price_change_pct: price && price > 0 ? percentChange(row.baseline_price_usd, price) : null,
      liquidity_change_pct: null, outcome_status: result.status, outcome_confidence: result.confidence,
      outcome_reasons_json: proof ? [proof.reason, ...(!quote ? ['Current market price unavailable.'] : [])] : quote ? result.reasons : ['Market providers returned no usable chain-matched quote. Retry after the refresh window.'],
      after_evidence_json: proof,
      market_source: quote?.provider ?? null, last_checked_at: new Date().toISOString(), refresh_claimed_at: null,
    }).eq('id', row.id).eq('user_id', userId).eq('refresh_claimed_at', claimedAt)
    if (update.error) throw new Error('Unable to save the latest outcome observation.')
  }))
}
