import { createClient } from '@supabase/supabase-js'
import {
  OUTCOME_POLICY, classifyOutcome, displayableCurrentPrice, numberOrNull, pendingUnavailableReasons,
  percentChange, validPriceOrNull, type TrackedOutcome,
} from '../tokenOutcomes'
import { dexScreenerOutcomeMarketProvider, geckoTerminalMarketProvider, outcomeTokenAddressEquals } from './clarkMarketDataProviders'
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
const OUTCOME_ID_RE = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i
export function quoteMatches(q: ClarkMarketQuote | null, chain: string, address: string): q is ClarkMarketQuote {
  const expectedChain = chainAlias(chain)
  const expectedChainId = chainIdBySlug[expectedChain ?? '']
  return !!q && chainAlias(q.chain) === expectedChain && (q.chainId == null || expectedChainId == null || q.chainId === expectedChainId)
    && outcomeTokenAddressEquals(expectedChain, q.address, expectedChain === 'solana' ? address : address.toLowerCase())
}
const quoteIsFresh = (quote: ClarkMarketQuote, now: number) => Number.isFinite(quote.fetchedAt) && now - quote.fetchedAt >= 0 && now - quote.fetchedAt <= OUTCOME_POLICY.priceStaleMs
const usableQuote = (quote: ClarkMarketQuote | null, chain: string, address: string, now = Date.now()): quote is ClarkMarketQuote =>
  quoteMatches(quote, chain, address) && validPriceOrNull(quote.priceUsd) != null && quoteIsFresh(quote, now)

export type ResolveOutcomeQuoteProviders = {
  dex: typeof dexScreenerOutcomeMarketProvider
  gecko: typeof geckoTerminalMarketProvider
}
export async function resolveOutcomeQuote(
  chain: string,
  address: string,
  providers: ResolveOutcomeQuoteProviders = { dex: dexScreenerOutcomeMarketProvider, gecko: geckoTerminalMarketProvider },
  opts?: { force?: boolean; now?: number },
): Promise<ClarkMarketQuote | null> {
  const now = opts?.now ?? Date.now()
  const normalizedChain = chainAlias(chain) ?? chain
  const normalizedAddress = normalizedChain === 'solana' ? address : address.toLowerCase()
  const key = `outcomeMarket:v3:${normalizedChain}:${normalizedAddress}`
  if (!opts?.force) {
    const cached = await getTokenCache<ClarkMarketQuote>(key)
    if (usableQuote(cached, normalizedChain, normalizedAddress, now)) return cached
  }
  const dex = await providers.dex(normalizedAddress, normalizedChain)
  let quote = (dex?.matches ?? []).find(q => usableQuote(q, normalizedChain, normalizedAddress, now)) ?? null
  if (!quote) {
    const gecko = await providers.gecko(normalizedAddress, normalizedChain)
    if (usableQuote(gecko, normalizedChain, normalizedAddress, now)) quote = gecko
  }
  if (quote) await setTokenCache(key, quote, Math.ceil(OUTCOME_POLICY.priceStaleMs / 1000))
  return quote
}

export function sanitizeTrackedOutcome(row: TrackedOutcome, now = Date.now()): TrackedOutcome {
  const baselinePrice = validPriceOrNull(row.baseline_price_usd)
  const currentPrice = displayableCurrentPrice({ ...row, baseline_price_usd: baselinePrice }, now)
  const proof = row.after_evidence_json
  const result = classifyOutcome({ price: baselinePrice, liquidity: numberOrNull(row.baseline_liquidity_usd) }, {
    price: currentPrice, liquidity: numberOrNull(row.current_liquidity_usd), verifiedTradingBlocked: proof?.verifiedTradingBlocked === true,
  })
  const pending = currentPrice == null && result.status === 'unavailable'
  return {
    ...row, baseline_price_usd: baselinePrice, current_price_usd: currentPrice,
    price_change_pct: percentChange(baselinePrice, currentPrice),
    outcome_status: result.status, outcome_confidence: result.confidence,
    outcome_reasons_json: pending ? pendingUnavailableReasons() : row.outcome_reasons_json,
  }
}

function retainPreviousObservation(row: TrackedOutcome, now: number): number | null {
  return displayableCurrentPrice(row, now)
}

export function buildOutcomeRefreshUpdate(row: TrackedOutcome, quote: ClarkMarketQuote | null, proof: TrackedOutcome['after_evidence_json'], checkedAt = new Date().toISOString(), now = Date.parse(checkedAt) || Date.now()) {
  const observedPrice = usableQuote(quote, row.chain, row.token_address, now) ? validPriceOrNull(quote.priceUsd) : null
  const previousPrice = retainPreviousObservation(row, now)
  // A newer valid observation always wins. An invalid/stale dust previous is never kept as -100%.
  const price = observedPrice ?? previousPrice
  const liquidity = observedPrice != null ? numberOrNull(quote?.liquidityUsd) : numberOrNull(row.current_liquidity_usd)
  const result = classifyOutcome({ price: validPriceOrNull(row.baseline_price_usd), liquidity: numberOrNull(row.baseline_liquidity_usd) }, {
    price, liquidity, verifiedTradingBlocked: proof?.verifiedTradingBlocked === true,
  })
  const refreshFailed = observedPrice == null
  const pending = price == null && result.status === 'unavailable'
  return {
    current_price_usd: price, current_liquidity_usd: liquidity,
    price_change_pct: percentChange(validPriceOrNull(row.baseline_price_usd), price), liquidity_change_pct: null,
    outcome_status: result.status, outcome_confidence: result.confidence,
    outcome_reasons_json: pending ? (proof ? [proof.reason, ...pendingUnavailableReasons()] : pendingUnavailableReasons())
      : refreshFailed && previousPrice != null
        ? ['Latest refresh returned no usable chain-and-contract-matched price. Retaining the previous verified observation.']
        : proof ? [proof.reason, ...result.reasons] : result.reasons,
    after_evidence_json: proof, market_source: observedPrice != null ? quote?.provider ?? null : (price != null ? row.market_source : null),
    last_checked_at: observedPrice != null ? checkedAt : row.last_checked_at, refresh_claimed_at: null,
  }
}

export type RefreshOutcomesOptions = { force?: boolean; ids?: string[]; now?: number }
export async function refreshOutcomes(userId: string, opts: RefreshOutcomesOptions = {}) {
  const db = outcomeDb()
  const now = opts.now ?? Date.now()
  const stale = new Date(now - OUTCOME_POLICY.priceStaleMs).toISOString()
  const lease = new Date(now - 60_000).toISOString()
  const ids = (opts.ids ?? []).filter(id => OUTCOME_ID_RE.test(id)).slice(0, OUTCOME_POLICY.refreshBatch)
  let query = db.from('tracked_token_outcomes').select('*').eq('user_id', userId)
  if (ids.length) query = query.in('id', ids)
  if (!opts.force) {
    // Re-check stale rows and any persisted -100%/dust observation so a bad tick cannot sit out the TTL.
    query = query.or(`last_checked_at.is.null,last_checked_at.lt.${stale},price_change_pct.lte.-99.95`)
  }
  const { data, error } = await query
    .or(`refresh_claimed_at.is.null,refresh_claimed_at.lt.${lease}`)
    .order('last_checked_at', { ascending: true, nullsFirst: true }).limit(OUTCOME_POLICY.refreshBatch)
  if (error) throw new Error('Outcome storage unavailable. Check the tracked-token-outcomes migration.')
  await Promise.all(((data ?? []) as TrackedOutcome[]).map(async row => {
    const claimedAt = new Date(now).toISOString()
    let claimQuery = db.from('tracked_token_outcomes').update({ refresh_claimed_at: claimedAt }).eq('id', row.id).eq('user_id', userId)
    if (!opts.force) claimQuery = claimQuery.or(`last_checked_at.is.null,last_checked_at.lt.${stale},price_change_pct.lte.-99.95`)
    const claim = await claimQuery.or(`refresh_claimed_at.is.null,refresh_claimed_at.lt.${lease}`).select('id')
    if (claim.error || !claim.data?.length) return
    const quote = await resolveOutcomeQuote(row.chain, row.token_address, undefined, { force: opts.force === true, now }).catch(() => null)
    const chainId = chainIdBySlug[row.chain]
    const laterScan = chainId ? await getTokenCache<Record<string, unknown>>(buildTokenScanCacheKey(row.chain as EvmChainSlug, chainId, row.token_address)) : null
    const proof = afterScanProof(row, laterScan, now) ?? row.after_evidence_json ?? null
    const update = await db.from('tracked_token_outcomes').update(buildOutcomeRefreshUpdate(row, quote, proof, new Date(now).toISOString(), now))
      .eq('id', row.id).eq('user_id', userId).eq('refresh_claimed_at', claimedAt)
    if (update.error) throw new Error('Unable to save the latest outcome observation.')
  }))
}
