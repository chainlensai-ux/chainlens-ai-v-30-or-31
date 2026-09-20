import { createClient } from '@supabase/supabase-js'
import {
  OUTCOME_POLICY, classifyOutcome, comparableOutcomeBaselinePrice, displayableCurrentMarketCap, displayableCurrentPrice, incomparableBaselineReasons, numberOrNull, observationCheckedAtMs, pendingUnavailableReasons,
  percentChange, validPriceOrNull, verifiedMarketCapOrNull, type TrackedOutcome,
  type MarketObservationProof,
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
/** Compact list columns that exist since the original tracked_token_outcomes migration. */
export const OUTCOME_LIST_COLUMNS = 'id,chain,token_address,scan_id,tracked_at,baseline_price_usd,baseline_liquidity_usd,baseline_market_cap_usd,baseline_risk_score,baseline_verdict,current_price_usd,current_liquidity_usd,price_change_pct,liquidity_change_pct,outcome_status,outcome_confidence,outcome_reasons_json,last_checked_at,market_source,after_evidence_json,baseline_snapshot_json->tokenSymbol,baseline_snapshot_json->tokenName,baseline_snapshot_json->scannedAt,baseline_snapshot_json->snapshotVersion'
/** Optional identity-proof column from 20260918. Never required to list existing receipts. */
export const OUTCOME_LIST_COLUMNS_WITH_OBSERVATION = 'id,chain,token_address,scan_id,tracked_at,baseline_price_usd,baseline_liquidity_usd,baseline_market_cap_usd,baseline_risk_score,baseline_verdict,current_price_usd,current_liquidity_usd,price_change_pct,liquidity_change_pct,outcome_status,outcome_confidence,outcome_reasons_json,last_checked_at,market_source,market_observation_json,after_evidence_json,baseline_snapshot_json->tokenSymbol,baseline_snapshot_json->tokenName,baseline_snapshot_json->scannedAt,baseline_snapshot_json->snapshotVersion'

export type OutcomeStorageError = { code?: string | null; message?: string | null; details?: string | null; hint?: string | null }
export function isMissingOutcomeColumnError(error: OutcomeStorageError | null | undefined, column = 'market_observation_json'): boolean {
  if (!error) return false
  const code = String(error.code ?? '')
  if (code === 'PGRST204' || code === '42703') return true
  const text = `${error.message ?? ''} ${error.details ?? ''} ${error.hint ?? ''}`.toLowerCase()
  return text.includes(column.toLowerCase()) && /does not exist|could not find|schema cache/.test(text)
}
export function isMissingOutcomeTableError(error: OutcomeStorageError | null | undefined): boolean {
  if (!error) return false
  const code = String(error.code ?? '')
  const text = `${error.message ?? ''} ${error.details ?? ''}`.toLowerCase()
  return code === '42P01' || code === 'PGRST205' || (text.includes('tracked_token_outcomes') && /does not exist|could not find the table|schema cache/.test(text))
}
export function sanitizeOutcomeStorageError(error: unknown): { code: string; message: string } {
  if (error && typeof error === 'object' && ('code' in error || 'message' in error)) {
    const row = error as OutcomeStorageError
    const message = String(row.message ?? 'storage_unavailable').replace(/https?:\/\/\S+/gi, '[redacted]').replace(/eyJ[\w.-]{20,}/g, '[redacted]').slice(0, 180)
    if (isMissingOutcomeTableError(row) || isMissingOutcomeColumnError(row)) return { code: 'storage_schema', message }
    return { code: String(row.code ?? 'storage_unavailable'), message }
  }
  if (error instanceof Error) {
    const message = error.message.replace(/https?:\/\/\S+/gi, '[redacted]').slice(0, 180)
    return { code: message.includes('not configured') ? 'storage_unconfigured' : 'storage_unavailable', message }
  }
  return { code: 'storage_unavailable', message: 'unknown' }
}
export function logOutcomeStorageError(stage: string, error: unknown) {
  console.warn('[token-outcomes]', { stage, ...sanitizeOutcomeStorageError(error) })
}

export function quoteMatches(q: ClarkMarketQuote | null, chain: string, address: string): q is ClarkMarketQuote {
  const expectedChain = chainAlias(chain)
  const expectedChainId = chainIdBySlug[expectedChain ?? '']
  const expectedAddress = expectedChain === 'solana' ? address : address.toLowerCase()
  return !!q && chainAlias(q.chain) === expectedChain && (q.chainId == null || expectedChainId == null || q.chainId === expectedChainId)
    && outcomeTokenAddressEquals(expectedChain, q.address, expectedAddress)
    && !!q.marketIdentity && outcomeTokenAddressEquals(expectedChain, q.marketIdentity.baseTokenAddress, expectedAddress)
}

/** A quote stamped during this refresh (fetchedAt slightly after frozen `now`) is live, not stale. */
export function quoteIsFreshForOutcome(quote: Pick<ClarkMarketQuote, 'fetchedAt'>, now: number): boolean {
  if (!Number.isFinite(quote.fetchedAt)) return false
  const ageMs = now - quote.fetchedAt
  if (ageMs > OUTCOME_POLICY.priceStaleMs) return false
  if (ageMs < -60_000) return false
  return true
}
const usableQuote = (quote: ClarkMarketQuote | null, chain: string, address: string, now = Date.now()): quote is ClarkMarketQuote =>
  quoteMatches(quote, chain, address) && validPriceOrNull(quote.priceUsd) != null && quoteIsFreshForOutcome(quote, now)

export type OutcomeRefreshForensic = {
  trackedOutcomeId: string
  chain: string
  mint: string
  baselinePrice: number | null
  previousCurrentPrice: number | null
  refreshForced: boolean
  cacheHit: boolean
  fetchAttempted: boolean
  provider: string | null
  candidatePrices: number[]
  selectedPairOrPool: string | null
  selectedBaseMint: string | null
  selectedQuoteMint: string | null
  identityMatched: boolean
  fetchedCurrentPrice: number | null
  fetchedAt: number | null
  persistedCurrentPrice: number | null
  persistedLastCheckedAt: string | null
  rereadCurrentPrice: number | null
  computedPercentChange: number | null
  rejectionReason: string | null
}

export type ResolveOutcomeQuoteProviders = {
  dex: typeof dexScreenerOutcomeMarketProvider
  gecko: typeof geckoTerminalMarketProvider
}
export type ResolveOutcomeQuoteResult = {
  quote: ClarkMarketQuote | null
  cacheHit: boolean
  fetchAttempted: boolean
  candidatePrices: number[]
  selectedPairOrPool: string | null
  selectedBaseMint: string | null
  selectedQuoteMint: string | null
  identityMatched: boolean
  fetchedCurrentPrice: number | null
  fetchedAt: number | null
  rejectionReason: string | null
}

export async function resolveOutcomeQuoteDetailed(
  chain: string,
  address: string,
  providers: ResolveOutcomeQuoteProviders = { dex: dexScreenerOutcomeMarketProvider, gecko: geckoTerminalMarketProvider },
  opts?: { force?: boolean; now?: number },
): Promise<ResolveOutcomeQuoteResult> {
  const now = opts?.now ?? Date.now()
  const normalizedChain = chainAlias(chain) ?? chain
  const normalizedAddress = normalizedChain === 'solana' ? address : address.toLowerCase()
  const key = `outcomeMarket:v4:${normalizedChain}:${normalizedAddress}`
  const empty: ResolveOutcomeQuoteResult = {
    quote: null, cacheHit: false, fetchAttempted: false, candidatePrices: [],
    selectedPairOrPool: null, selectedBaseMint: null, selectedQuoteMint: null,
    identityMatched: false, fetchedCurrentPrice: null, fetchedAt: null, rejectionReason: null,
  }
  if (!opts?.force) {
    const cached = await getTokenCache<ClarkMarketQuote>(key).catch(() => null)
    if (usableQuote(cached, normalizedChain, normalizedAddress, now)) {
      return {
        ...empty, quote: cached, cacheHit: true, identityMatched: true,
        selectedBaseMint: cached.address,
        candidatePrices: validPriceOrNull(cached.priceUsd) != null ? [cached.priceUsd as number] : [],
        fetchedCurrentPrice: validPriceOrNull(cached.priceUsd),
        fetchedAt: cached.fetchedAt,
      }
    }
  }
  empty.fetchAttempted = true
  let dex: Awaited<ReturnType<ResolveOutcomeQuoteProviders['dex']>> = null
  try { dex = await providers.dex(normalizedAddress, normalizedChain) } catch { dex = null }
  const dexCandidates = dex?.candidatePairs ?? []
  empty.candidatePrices = dexCandidates.map(c => c.priceUsd).filter((n): n is number => n != null)
  const identityFromDex = (dex?.matches ?? []).find(q => quoteMatches(q, normalizedChain, normalizedAddress)) ?? null
  empty.identityMatched = !!identityFromDex
    || dexCandidates.some(c => outcomeTokenAddressEquals(normalizedChain, c.baseMint, normalizedAddress))
  let quote = (dex?.matches ?? []).find(q => usableQuote(q, normalizedChain, normalizedAddress, now)) ?? null
  if (quote) {
    const selected = dexCandidates.find(c =>
      c.priceUsd === quote!.priceUsd && outcomeTokenAddressEquals(normalizedChain, c.baseMint, normalizedAddress),
    ) ?? dexCandidates[0] ?? null
    empty.identityMatched = true
    empty.selectedPairOrPool = selected?.pairAddress ?? selected?.dexId ?? null
    empty.selectedBaseMint = selected?.baseMint ?? quote.address
    empty.selectedQuoteMint = selected?.quoteMint ?? null
    empty.fetchedCurrentPrice = validPriceOrNull(quote.priceUsd)
    empty.fetchedAt = quote.fetchedAt
  } else if (empty.identityMatched) {
    empty.fetchedCurrentPrice = validPriceOrNull(identityFromDex?.priceUsd) ?? empty.candidatePrices[0] ?? null
    empty.fetchedAt = identityFromDex?.fetchedAt ?? null
    empty.rejectionReason = identityFromDex && validPriceOrNull(identityFromDex.priceUsd) != null
      ? (quoteIsFreshForOutcome(identityFromDex, now) ? 'dex_quote_rejected' : 'quote_not_fresh')
      : 'dex_quote_not_positive'
  } else if (dex && (dex.matches?.length || dexCandidates.length)) {
    empty.rejectionReason = 'dex_identity_mismatch'
  }
  if (!quote) {
    let gecko: ClarkMarketQuote | null = null
    try { gecko = await providers.gecko(normalizedAddress, normalizedChain) } catch { gecko = null }
    const geckoPrice = gecko ? validPriceOrNull(gecko.priceUsd) : null
    if (geckoPrice != null) empty.candidatePrices.push(geckoPrice)
    const geckoUsable = !!gecko && quoteMatches(gecko, normalizedChain, normalizedAddress) && geckoPrice != null && quoteIsFreshForOutcome(gecko, now)
    if (gecko && geckoUsable) {
      quote = gecko
      empty.identityMatched = true
      empty.selectedBaseMint = gecko.address
      empty.selectedPairOrPool = 'geckoterminal'
      empty.fetchedCurrentPrice = geckoPrice
      empty.fetchedAt = gecko.fetchedAt
      empty.rejectionReason = null
    } else if (gecko) {
      if (empty.fetchedCurrentPrice == null) empty.fetchedCurrentPrice = geckoPrice
      if (empty.fetchedAt == null) empty.fetchedAt = gecko.fetchedAt
      empty.rejectionReason = quoteMatches(gecko, normalizedChain, normalizedAddress)
        ? 'gecko_quote_not_fresh'
        : (empty.rejectionReason ?? 'gecko_identity_mismatch')
    } else if (!empty.rejectionReason) {
      empty.rejectionReason = 'no_identity_matched_market_quote'
    }
  }
  if (quote) {
    await setTokenCache(key, quote, Math.ceil(OUTCOME_POLICY.priceStaleMs / 1000)).catch(() => undefined)
    empty.rejectionReason = null
  }
  return { ...empty, quote }
}

export async function resolveOutcomeQuote(
  chain: string,
  address: string,
  providers: ResolveOutcomeQuoteProviders = { dex: dexScreenerOutcomeMarketProvider, gecko: geckoTerminalMarketProvider },
  opts?: { force?: boolean; now?: number },
): Promise<ClarkMarketQuote | null> {
  return (await resolveOutcomeQuoteDetailed(chain, address, providers, opts)).quote
}

const liveQuoteFlights = new Map<string, Promise<ResolveOutcomeQuoteResult>>()
const liveQuoteRecent = new Map<string, { at: number; result: ResolveOutcomeQuoteResult }>()
function liveQuoteKey(chain: string, address: string) {
  const normalizedChain = chainAlias(chain) ?? chain
  return `${normalizedChain}:${normalizedChain === 'solana' ? address : address.toLowerCase()}`
}
export function __resetLiveOutcomeQuoteForTest() {
  liveQuoteFlights.clear()
  liveQuoteRecent.clear()
}

/**
 * Live-receipt quote: identity-matched Dex/Gecko only. Coalesces in-flight lookups and reuses a
 * quote younger than receiptLiveQuoteReuseMs so overlapping ticks do not triple provider calls.
 */
export async function resolveLiveOutcomeQuoteDetailed(
  chain: string,
  address: string,
  providers: ResolveOutcomeQuoteProviders = { dex: dexScreenerOutcomeMarketProvider, gecko: geckoTerminalMarketProvider },
  opts?: { now?: number },
): Promise<ResolveOutcomeQuoteResult> {
  const now = opts?.now ?? Date.now()
  const key = liveQuoteKey(chain, address)
  const recent = liveQuoteRecent.get(key)
  if (recent && now - recent.at >= 0 && now - recent.at <= OUTCOME_POLICY.receiptLiveQuoteReuseMs && recent.result.quote) {
    return { ...recent.result, cacheHit: true, fetchAttempted: false }
  }
  const existing = liveQuoteFlights.get(key)
  if (existing) return existing
  const pending = resolveOutcomeQuoteDetailed(chain, address, providers, { force: true, now })
    .then(result => {
      liveQuoteRecent.set(key, { at: now, result })
      return result
    })
    .finally(() => { if (liveQuoteFlights.get(key) === pending) liveQuoteFlights.delete(key) })
  liveQuoteFlights.set(key, pending)
  return pending
}


export function hydrateTrackedOutcomeListRow(row: Record<string, unknown>, now = Date.now()): TrackedOutcome {
  return sanitizeTrackedOutcome({
    ...row,
    baseline_snapshot_json: {
      tokenSymbol: typeof row.tokenSymbol === 'string' ? row.tokenSymbol : '',
      tokenName: typeof row.tokenName === 'string' ? row.tokenName : '',
      scannedAt: typeof row.scannedAt === 'string' ? row.scannedAt : row.tracked_at,
      snapshotVersion: row.snapshotVersion,
      baselineRiskScore: row.baseline_risk_score, baselineVerdict: row.baseline_verdict,
    },
  } as unknown as TrackedOutcome, now)
}

export async function listTrackedOutcomes(userId: string, now = Date.now(), db: ReturnType<typeof outcomeDb> = outcomeDb()): Promise<TrackedOutcome[]> {
  const read = (columns: string) => db.from('tracked_token_outcomes').select(columns).eq('user_id', userId).order('tracked_at', { ascending: false }).limit(OUTCOME_POLICY.limits.elite)
  let { data, error } = await read(OUTCOME_LIST_COLUMNS_WITH_OBSERVATION)
  if (error && isMissingOutcomeColumnError(error, 'market_observation_json')) {
    logOutcomeStorageError('list_optional_column', error)
    ;({ data, error } = await read(OUTCOME_LIST_COLUMNS))
  }
  if (error) {
    logOutcomeStorageError('list', error)
    throw new Error(isMissingOutcomeTableError(error)
      ? 'Outcome storage unavailable. The tracked-token-outcomes migration must be applied.'
      : 'Outcome storage unavailable. Check the tracked-token-outcomes migration.')
  }
  return ((data ?? []) as unknown as Record<string, unknown>[]).map(row => hydrateTrackedOutcomeListRow({ ...row }, now))
}

export function sanitizeTrackedOutcome(row: TrackedOutcome, now = Date.now()): TrackedOutcome {
  const baselinePrice = validPriceOrNull(row.baseline_price_usd)
  const currentPrice = displayableCurrentPrice({ ...row, baseline_price_usd: baselinePrice }, now)
  const comparableBaseline = comparableOutcomeBaselinePrice({ ...row, baseline_price_usd: baselinePrice, current_price_usd: currentPrice }, now)
  const proof = row.after_evidence_json
  const result = classifyOutcome({ price: comparableBaseline, liquidity: numberOrNull(row.baseline_liquidity_usd) }, {
    price: currentPrice, liquidity: numberOrNull(row.current_liquidity_usd), verifiedTradingBlocked: proof?.verifiedTradingBlocked === true,
  })
  const pendingCurrent = currentPrice == null && result.status === 'unavailable'
  const pendingBaseline = comparableBaseline == null && currentPrice != null && result.status === 'unavailable'
  const snapshotVersion = row.baseline_snapshot_json?.snapshotVersion
  const legacySolana = row.chain === 'solana' && snapshotVersion !== 2
  return {
    ...row, baseline_price_usd: baselinePrice, current_price_usd: currentPrice,
    current_market_cap_usd: displayableCurrentMarketCap({ ...row, current_price_usd: currentPrice }, now),
    price_change_pct: percentChange(comparableBaseline, currentPrice),
    outcome_status: result.status, outcome_confidence: result.confidence,
    outcome_reasons_json: pendingCurrent ? pendingUnavailableReasons() : pendingBaseline ? incomparableBaselineReasons() : row.outcome_reasons_json,
    baseline_risk_semantics: legacySolana ? 'legacy_unverified' : 'canonical',
  }
}

function retainPreviousObservation(row: TrackedOutcome, now: number): number | null {
  return displayableCurrentPrice(row, now)
}

export function buildOutcomeRefreshUpdate(row: TrackedOutcome, quote: ClarkMarketQuote | null, proof: TrackedOutcome['after_evidence_json'], checkedAt = new Date().toISOString(), now = Date.parse(checkedAt) || Date.now()) {
  const observedPrice = usableQuote(quote, row.chain, row.token_address, now) ? validPriceOrNull(quote.priceUsd) : null
  const previousPrice = retainPreviousObservation(row, now)
  const price = observedPrice ?? previousPrice
  const liquidity = observedPrice != null ? numberOrNull(quote?.liquidityUsd) : numberOrNull(row.current_liquidity_usd)
  const refreshFailed = observedPrice == null
  const marketObservation: MarketObservationProof | null = observedPrice != null && quote?.marketIdentity ? {
    version: 1, chain: row.chain, tokenAddress: row.chain === 'solana' ? row.token_address : row.token_address.toLowerCase(),
    provider: quote.provider, fetchedAt: checkedAt, priceUsd: observedPrice, identityMatched: true,
    selectedPoolAddress: quote.marketIdentity.selectedPoolAddress,
    selectedBaseTokenAddress: quote.marketIdentity.baseTokenAddress,
    selectedQuoteTokenAddress: quote.marketIdentity.quoteTokenAddress,
    marketCapUsd: verifiedMarketCapOrNull(quote.marketCapUsd, quote.fdvUsd),
  } : row.market_observation_json ?? null
  const comparableBaseline = comparableOutcomeBaselinePrice({
    ...row, current_price_usd: price, last_checked_at: observedPrice != null ? checkedAt : row.last_checked_at,
    market_source: observedPrice != null ? quote?.provider ?? null : (price != null ? row.market_source : null),
    market_observation_json: marketObservation,
  }, now)
  const result = classifyOutcome({ price: comparableBaseline, liquidity: numberOrNull(row.baseline_liquidity_usd) }, {
    price, liquidity, verifiedTradingBlocked: proof?.verifiedTradingBlocked === true,
  })
  const pendingCurrent = price == null && result.status === 'unavailable'
  const pendingBaseline = comparableBaseline == null && price != null && result.status === 'unavailable'
  return {
    current_price_usd: price, current_liquidity_usd: liquidity,
    price_change_pct: percentChange(comparableBaseline, price), liquidity_change_pct: null,
    outcome_status: result.status, outcome_confidence: result.confidence,
    outcome_reasons_json: pendingCurrent ? (proof ? [proof.reason, ...pendingUnavailableReasons()] : pendingUnavailableReasons())
      : pendingBaseline ? incomparableBaselineReasons()
      : refreshFailed && previousPrice != null
        ? ['Latest refresh returned no usable chain-and-contract-matched price. Retaining the previous verified observation.']
        : proof ? [proof.reason, ...result.reasons] : result.reasons,
    after_evidence_json: proof, market_source: observedPrice != null ? quote?.provider ?? null : (price != null ? row.market_source : null),
    market_observation_json: marketObservation,
    last_checked_at: observedPrice != null ? checkedAt : row.last_checked_at, refresh_claimed_at: null,
  }
}

function logOutcomeRefreshForensic(forensic: OutcomeRefreshForensic) {
  // Keep warn: next.config strips console.log from production but leaves warn for ops forensics.
  console.warn('[outcome-refresh-forensic]', forensic)
}

export function omitOptionalObservationColumn<T extends Record<string, unknown>>(update: T): Omit<T, 'market_observation_json'> {
  const rest = { ...update }
  delete rest.market_observation_json
  return rest
}

export async function persistOutcomeRefreshUpdate(
  db: ReturnType<typeof outcomeDb>,
  rowId: string,
  userId: string,
  claimedAt: string,
  update: Record<string, unknown>,
) {
  const write = (payload: Record<string, unknown>) => db.from('tracked_token_outcomes').update(payload)
    .eq('id', rowId).eq('user_id', userId).eq('refresh_claimed_at', claimedAt).select('current_price_usd,last_checked_at,price_change_pct')
  let written = await write(update)
  if (written.error && isMissingOutcomeColumnError(written.error, 'market_observation_json')) {
    logOutcomeStorageError('refresh_optional_column', written.error)
    written = await write(omitOptionalObservationColumn(update))
  }
  return written
}

/** Unproven or stale observations must refresh even if last_checked was just bumped without identity proof. */
export function outcomeNeedsRefresh(row: TrackedOutcome, now = Date.now(), force = false): boolean {
  if (force) return true
  if (displayableCurrentPrice(row, now) == null) return true
  if (row.price_change_pct != null && row.price_change_pct <= -99.95) return true
  const checked = observationCheckedAtMs(row)
  if (checked == null) return true
  return now - checked > OUTCOME_POLICY.priceStaleMs
}

/** Same-request identity proof. Used when production cannot persist `market_observation_json`. */
export function applyRefreshObservationOverlay(
  listed: TrackedOutcome[],
  overlays: Map<string, ReturnType<typeof buildOutcomeRefreshUpdate>>,
  now = Date.now(),
): TrackedOutcome[] {
  if (!overlays.size) return listed
  return listed.map(row => {
    const update = overlays.get(row.id)
    if (!update) return row
    return sanitizeTrackedOutcome({
      ...row,
      current_price_usd: update.current_price_usd,
      current_liquidity_usd: update.current_liquidity_usd,
      market_source: update.market_source,
      market_observation_json: update.market_observation_json ?? row.market_observation_json,
      last_checked_at: update.last_checked_at ?? row.last_checked_at,
      after_evidence_json: update.after_evidence_json ?? row.after_evidence_json,
    }, now)
  })
}

export type RefreshOutcomesOptions = { force?: boolean; ids?: string[]; now?: number }
export async function refreshOutcomes(userId: string, opts: RefreshOutcomesOptions = {}, db: ReturnType<typeof outcomeDb> = outcomeDb()): Promise<TrackedOutcome[]> {
  const now = opts.now ?? Date.now()
  const stale = new Date(now - OUTCOME_POLICY.priceStaleMs).toISOString()
  const lease = new Date(now - 60_000).toISOString()
  const ids = (opts.ids ?? []).filter(id => OUTCOME_ID_RE.test(id)).slice(0, OUTCOME_POLICY.refreshBatch)
  const freshnessOr = `last_checked_at.is.null,last_checked_at.lt.${stale},price_change_pct.lte.-99.95,market_observation_json.is.null`
  const leaseOr = `refresh_claimed_at.is.null,refresh_claimed_at.lt.${lease}`
  const runSelect = (includeFreshness: boolean) => {
    let query = db.from('tracked_token_outcomes').select('*').eq('user_id', userId)
    if (ids.length) query = query.in('id', ids)
    if (includeFreshness) query = query.or(freshnessOr)
    if (opts.force !== true) query = query.or(leaseOr)
    return query.order('last_checked_at', { ascending: true, nullsFirst: true }).limit(OUTCOME_POLICY.refreshBatch)
  }
  let includeFreshness = opts.force !== true
  let { data, error } = await runSelect(includeFreshness)
  if (error && includeFreshness && isMissingOutcomeColumnError(error, 'market_observation_json')) {
    logOutcomeStorageError('refresh_optional_column', error)
    includeFreshness = false
    ;({ data, error } = await runSelect(false))
  }
  if (error) throw new Error('Outcome storage unavailable. Check the tracked-token-outcomes migration.')
  const overlays = new Map<string, ReturnType<typeof buildOutcomeRefreshUpdate>>()
  const resolutions = new Map<string, Promise<Awaited<ReturnType<typeof resolveOutcomeQuoteDetailed>>>>()
  await Promise.all(((data ?? []) as TrackedOutcome[]).filter(row => outcomeNeedsRefresh(row, now, opts.force === true)).map(async row => {
    const claimedAt = new Date(now).toISOString()
    let claimQuery = db.from('tracked_token_outcomes').update({ refresh_claimed_at: claimedAt }).eq('id', row.id).eq('user_id', userId)
    if (includeFreshness) claimQuery = claimQuery.or(freshnessOr)
    if (opts.force !== true) claimQuery = claimQuery.or(leaseOr)
    const claim = await claimQuery.select('id')
    if (claim.error || !claim.data?.length) return
    const identityKey = `${row.chain}:${row.chain === 'solana' ? row.token_address : row.token_address.toLowerCase()}`
    let resolution = resolutions.get(identityKey)
    if (!resolution) { resolution = resolveOutcomeQuoteDetailed(row.chain, row.token_address, undefined, { force: opts.force === true, now }); resolutions.set(identityKey, resolution) }
    const resolved = await resolution.catch(() => null)
    const quote = resolved?.quote ?? null
    const chainId = chainIdBySlug[row.chain]
    const laterScan = chainId ? await getTokenCache<Record<string, unknown>>(buildTokenScanCacheKey(row.chain as EvmChainSlug, chainId, row.token_address)) : null
    const proof = afterScanProof(row, laterScan, now) ?? row.after_evidence_json ?? null
    const checkedAt = new Date(now).toISOString()
    const update = buildOutcomeRefreshUpdate(row, quote, proof, checkedAt, now)
    const written = await persistOutcomeRefreshUpdate(db, row.id, userId, claimedAt, update)
    const persisted = written.data?.[0] as { current_price_usd?: number | null; last_checked_at?: string | null; price_change_pct?: number | null } | undefined
    overlays.set(row.id, update)
    const reread = sanitizeTrackedOutcome({
      ...row,
      current_price_usd: persisted?.current_price_usd ?? update.current_price_usd,
      current_liquidity_usd: update.current_liquidity_usd,
      market_source: update.market_source,
      market_observation_json: update.market_observation_json ?? row.market_observation_json,
      last_checked_at: persisted?.last_checked_at ?? update.last_checked_at,
    }, now)
    logOutcomeRefreshForensic({
      trackedOutcomeId: row.id,
      chain: row.chain,
      mint: row.token_address,
      baselinePrice: validPriceOrNull(row.baseline_price_usd),
      previousCurrentPrice: displayableCurrentPrice(row, now),
      refreshForced: opts.force === true,
      cacheHit: resolved?.cacheHit ?? false,
      fetchAttempted: resolved?.fetchAttempted ?? false,
      provider: quote?.provider ?? null,
      candidatePrices: resolved?.candidatePrices ?? [],
      selectedPairOrPool: resolved?.selectedPairOrPool ?? null,
      selectedBaseMint: resolved?.selectedBaseMint ?? null,
      selectedQuoteMint: resolved?.selectedQuoteMint ?? null,
      identityMatched: resolved?.identityMatched ?? false,
      fetchedCurrentPrice: resolved?.fetchedCurrentPrice ?? validPriceOrNull(quote?.priceUsd),
      fetchedAt: resolved?.fetchedAt ?? quote?.fetchedAt ?? null,
      persistedCurrentPrice: persisted?.current_price_usd ?? null,
      persistedLastCheckedAt: persisted?.last_checked_at ?? null,
      rereadCurrentPrice: reread.current_price_usd,
      computedPercentChange: reread.price_change_pct,
      rejectionReason: written.error ? 'db_write_failed' : (resolved?.rejectionReason ?? (quote && update.current_price_usd == null ? 'accepted_quote_not_persisted' : null)),
    })
    if (written.error) throw new Error('Unable to save the latest outcome observation.')
  }))
  return applyRefreshObservationOverlay(await listTrackedOutcomes(userId, now, db), overlays, now)
}

export async function persistLiveOutcomeUpdate(
  db: ReturnType<typeof outcomeDb>,
  rowId: string,
  userId: string,
  update: Record<string, unknown>,
) {
  const write = (payload: Record<string, unknown>) => db.from('tracked_token_outcomes').update(payload)
    .eq('id', rowId).eq('user_id', userId).select('current_price_usd,last_checked_at,price_change_pct')
  let written = await write(update)
  if (written.error && isMissingOutcomeColumnError(written.error, 'market_observation_json')) {
    logOutcomeStorageError('live_optional_column', written.error)
    written = await write(omitOptionalObservationColumn(update))
  }
  return written
}

/**
 * Open-receipt price tick. One identity-matched quote, no Token Scanner, no rug proof, no full list.
 * Frozen baseline columns are never written. Previous verified observation is retained on provider miss.
 */
export async function refreshLiveOutcome(
  userId: string,
  id: string,
  opts: { now?: number; providers?: ResolveOutcomeQuoteProviders } = {},
  db: ReturnType<typeof outcomeDb> = outcomeDb(),
): Promise<TrackedOutcome | null> {
  if (!OUTCOME_ID_RE.test(id)) return null
  const now = opts.now ?? Date.now()
  const { data, error } = await db.from('tracked_token_outcomes').select('*').eq('user_id', userId).eq('id', id).maybeSingle()
  if (error) {
    logOutcomeStorageError('live', error)
    throw new Error(isMissingOutcomeTableError(error)
      ? 'Outcome storage unavailable. The tracked-token-outcomes migration must be applied.'
      : 'Outcome storage unavailable. Check the tracked-token-outcomes migration.')
  }
  if (!data) return null
  const row = data as TrackedOutcome
  const resolved = await resolveLiveOutcomeQuoteDetailed(row.chain, row.token_address, opts.providers, { now }).catch(() => null)
  const quote = resolved?.quote ?? null
  const quoteTime = quote?.fetchedAt
  const checkedAt = new Date(quoteTime != null && Number.isFinite(quoteTime) ? quoteTime : now).toISOString()
  const update = buildOutcomeRefreshUpdate(row, quote, row.after_evidence_json ?? null, checkedAt, now)
  const written = await persistLiveOutcomeUpdate(db, row.id, userId, update)
  if (written.error) throw new Error('Unable to save the latest outcome observation.')
  const persisted = written.data?.[0] as { current_price_usd?: number | null; last_checked_at?: string | null } | undefined
  return sanitizeTrackedOutcome({
    ...row,
    current_price_usd: persisted?.current_price_usd ?? update.current_price_usd,
    current_liquidity_usd: update.current_liquidity_usd,
    price_change_pct: update.price_change_pct,
    outcome_status: update.outcome_status,
    outcome_confidence: update.outcome_confidence,
    outcome_reasons_json: update.outcome_reasons_json,
    market_source: update.market_source,
    market_observation_json: update.market_observation_json ?? row.market_observation_json,
    last_checked_at: persisted?.last_checked_at ?? update.last_checked_at,
    after_evidence_json: row.after_evidence_json ?? null,
  }, now)
}
