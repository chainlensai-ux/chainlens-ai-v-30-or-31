import { createClient } from '@supabase/supabase-js'
import { OUTCOME_POLICY, classifyOutcome, numberOrNull, percentChange, validPriceOrNull, type TrackedOutcome } from '../tokenOutcomes'
import { dexScreenerOutcomeMarketProvider, geckoTerminalMarketProvider } from './clarkMarketDataProviders'
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
const chainIdBySlug: Record<string, number> = { base: 8453, eth: 1, bnb: 56, robinhood: 4663 }
export function quoteMatches(q: ClarkMarketQuote | null, chain: string, address: string): q is ClarkMarketQuote {
  const expectedChain = chainAlias(chain)
  const expectedChainId = chainIdBySlug[expectedChain ?? '']
  return !!q && chainAlias(q.chain) === expectedChain && (q.chainId == null || expectedChainId == null || q.chainId === expectedChainId)
    && (expectedChain === 'solana' ? q.address === address : q.address?.toLowerCase() === address.toLowerCase())
}
const usableQuote = (quote: ClarkMarketQuote | null, chain: string, address: string): quote is ClarkMarketQuote => quoteMatches(quote, chain, address) && validPriceOrNull(quote.priceUsd) != null
export async function resolveOutcomeQuote(chain: string, address: string, providers = { dex: dexScreenerOutcomeMarketProvider, gecko: geckoTerminalMarketProvider }): Promise<ClarkMarketQuote | null> {
  const normalizedChain = chainAlias(chain) ?? chain
  const normalizedAddress = normalizedChain === 'solana' ? address : address.toLowerCase()
  const key = `outcomeMarket:v2:${normalizedChain}:${normalizedAddress}`
  const cached = await getTokenCache<ClarkMarketQuote>(key)
  if (usableQuote(cached, normalizedChain, normalizedAddress) && Date.now() - cached.fetchedAt < OUTCOME_POLICY.staleMs) return cached
  const dex = await providers.dex(normalizedAddress, normalizedChain)
  let quote = (dex?.matches ?? []).find(q => usableQuote(q, normalizedChain, normalizedAddress)) ?? null
  if (!quote) {
    const gecko = await providers.gecko(normalizedAddress, normalizedChain)
    if (usableQuote(gecko, normalizedChain, normalizedAddress)) quote = gecko
  }
  if (quote) await setTokenCache(key, quote, OUTCOME_POLICY.staleMs / 1000)
  return quote
}

export function sanitizeTrackedOutcome(row: TrackedOutcome): TrackedOutcome {
  const baselinePrice = validPriceOrNull(row.baseline_price_usd)
  const currentPrice = validPriceOrNull(row.current_price_usd)
  const proof = row.after_evidence_json
  const result = classifyOutcome({ price: baselinePrice, liquidity: numberOrNull(row.baseline_liquidity_usd) }, {
    price: currentPrice, liquidity: numberOrNull(row.current_liquidity_usd), verifiedTradingBlocked: proof?.verifiedTradingBlocked === true,
  })
  return { ...row, baseline_price_usd: baselinePrice, current_price_usd: currentPrice,
    price_change_pct: percentChange(baselinePrice, currentPrice), outcome_status: result.status,
    outcome_confidence: result.confidence, outcome_reasons_json: currentPrice == null && result.status === 'unavailable'
      ? ['Current market price unavailable. Outcome pending; no loss is inferred from missing data.'] : row.outcome_reasons_json }
}

export function buildOutcomeRefreshUpdate(row: TrackedOutcome, quote: ClarkMarketQuote | null, proof: TrackedOutcome['after_evidence_json'], checkedAt = new Date().toISOString()) {
  const observedPrice = usableQuote(quote, row.chain, row.token_address) ? validPriceOrNull(quote.priceUsd) : null
  const previousPrice = validPriceOrNull(row.current_price_usd)
  const price = observedPrice ?? previousPrice
  const liquidity = observedPrice != null ? numberOrNull(quote?.liquidityUsd) : numberOrNull(row.current_liquidity_usd)
  const result = classifyOutcome({ price: validPriceOrNull(row.baseline_price_usd), liquidity: numberOrNull(row.baseline_liquidity_usd) }, {
    price, liquidity, verifiedTradingBlocked: proof?.verifiedTradingBlocked === true,
  })
  const refreshFailed = observedPrice == null
  return {
    current_price_usd: price, current_liquidity_usd: liquidity,
    price_change_pct: percentChange(validPriceOrNull(row.baseline_price_usd), price), liquidity_change_pct: null,
    outcome_status: result.status, outcome_confidence: result.confidence,
    outcome_reasons_json: refreshFailed
      ? previousPrice != null
        ? ['Latest refresh returned no usable chain-and-contract-matched price. Retaining the previous verified observation.']
        : proof ? [proof.reason, 'Current market price unavailable. Outcome pending.'] : ['Market providers returned no usable chain-and-contract-matched price. Outcome pending.']
      : proof ? [proof.reason, ...result.reasons] : result.reasons,
    after_evidence_json: proof, market_source: observedPrice != null ? quote?.provider ?? null : row.market_source,
    last_checked_at: observedPrice != null ? checkedAt : row.last_checked_at, refresh_claimed_at: null,
  }
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
    const chainId = chainIdBySlug[row.chain]
    const laterScan = chainId ? await getTokenCache<Record<string, unknown>>(buildTokenScanCacheKey(row.chain as EvmChainSlug, chainId, row.token_address)) : null
    const proof = afterScanProof(row, laterScan) ?? row.after_evidence_json ?? null
    // No extra expensive token scan. Existing fresh server cache can corroborate a later honeypot.
    // Aggregate market reserves alone never become burn/drain/pool-death evidence.
    const update = await db.from('tracked_token_outcomes').update(buildOutcomeRefreshUpdate(row, quote, proof))
      .eq('id', row.id).eq('user_id', userId).eq('refresh_claimed_at', claimedAt)
    if (update.error) throw new Error('Unable to save the latest outcome observation.')
  }))
}
