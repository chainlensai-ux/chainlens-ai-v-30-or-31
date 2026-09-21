/** Outcome policy, not a second token risk engine. Missing numbers stay missing. */
export const OUTCOME_POLICY = {
  minRisk: 50, pumpedPct: 50, dumpedPct: -50, catastrophicLiquidityPct: -99,
  minimumBaselineLiquidity: 10_000,
  // Rug-proof lookback stays 15 minutes so a later honeypot confirmation is not weakened.
  staleMs: 15 * 60_000,
  // Live outcome prices: short enough that a bad first tick cannot sit on the Track page.
  priceStaleMs: 3 * 60_000,
  refreshBatch: 4,
  /**
   * Open-receipt live lookup interval. 20s stays inside the 10 POSTs/min outcome limiter
   * (3 live ticks + open GET + occasional list refresh) and DexScreener/Gecko 7s budgets.
   * Never used for the Track list.
   */
  receiptLiveRefreshMs: 20_000,
  /** Coalesce overlapping live ticks for the same chain+contract. */
  receiptLiveQuoteReuseMs: 15_000,
  /**
   * Track-page live batch cadence. One POST carries at most refreshBatch ids, so 20s is 3 POSTs/min
   * for the list. An open receipt adds 3 more. That is 6/10 of the outcome limiter, leaving headroom
   * for a manual refresh. Larger lists share this fixed budget by rotating; they are not fetched faster.
   */
  pageLiveRefreshMs: 20_000,
  /** First card-live batch after the saved list is on screen, before the repeating interval. */
  pageLiveFirstDelayMs: 1_500,
  /**
   * Wall-clock budget for one live POST of up to four ids. Sequential Dex+Gecko timeouts are 14s
   * each; finishing by 40s stays inside the 55s client abort and the 60s route maxDuration.
   */
  pageLiveBatchBudgetMs: 40_000,
  postLimiterMax: 10,
  postLimiterWindowMs: 60_000,

  limits: { free: 5, pro: 50, elite: 200 },
} as const
export const OUTCOME_LOCK_COPY = 'Outcome tracking unlocks for higher-risk scans so ChainLens can measure whether the warning was justified.'
export type OutcomeStatus = 'watching' | 'pumped' | 'dumped' | 'rugged' | 'unavailable'
export type Outcome = { status: OutcomeStatus; confidence: 'low' | 'medium' | 'high'; reasons: string[] }
export type ScanSnapshot = {
  snapshotVersion: 2; riskScoreDirection: 'higher_is_riskier';
  userId: string; chain: string; tokenAddress: string; tokenSymbol: string; tokenName: string;
  scanId: string; scannedAt: string; baselinePriceUsd: number | null; baselineLiquidityUsd: number | null;
  baselineMarketCapUsd: number | null; baselineRiskScore: number; baselineVerdict: string; baselineConfidence: string | null;
  baselineRiskReasons: unknown; baselineSecuritySignals: unknown; baselineLpSignals: unknown;
  baselineHolderSignals: unknown; baselineDevSignals: unknown; baselineMarketQualitySignals: unknown;
  baselineOwnershipSignals: unknown;
}
export type TrackedOutcome = {
  id: string; user_id: string; chain: string; token_address: string; scan_id: string; tracked_at: string;
  baseline_price_usd: number | null; baseline_liquidity_usd: number | null; baseline_market_cap_usd: number | null;
  baseline_risk_score: number; baseline_verdict: string; baseline_snapshot_json: ScanSnapshot;
  current_price_usd: number | null; current_liquidity_usd: number | null;
  current_market_cap_usd?: number | null;
  price_change_pct: number | null; liquidity_change_pct: number | null;
  outcome_status: OutcomeStatus; outcome_confidence: Outcome['confidence']; outcome_reasons_json: string[];
  last_checked_at: string | null; market_source: string | null;
  after_evidence_json?: import('./tokenOutcomeProof').OutcomeProof | null;
  market_observation_json?: MarketObservationProof | null;
  baseline_risk_semantics?: 'canonical' | 'legacy_unverified';
}
export type MarketObservationProof = {
  version: 1; chain: string; tokenAddress: string; provider: string; fetchedAt: string; priceUsd: number;
  identityMatched: true; selectedPoolAddress: string | null; selectedBaseTokenAddress: string; selectedQuoteTokenAddress: string | null;
  /** Provider market-cap field from the same identity-matched quote. Never FDV. */
  marketCapUsd?: number | null;
}
export function numberOrNull(value: unknown): number | null {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) && n >= 0 ? n : null
}
/** Market price observations must be strictly positive. Provider gaps and malformed zeroes are unknown, not economic zero. */
export function validPriceOrNull(value: unknown): number | null {
  const valueAsNumber = numberOrNull(value)
  return valueAsNumber != null && valueAsNumber > 0 ? valueAsNumber : null
}
/** Accept a provider number or numeric string; never coerce missing/zero/NaN into a real price. */
export function parsePositiveUsd(value: unknown): number | null {
  if (typeof value === 'number') return validPriceOrNull(value)
  if (typeof value === 'string' && value.trim() !== '') return validPriceOrNull(Number(value.trim()))
  return null
}
/** Market cap must come from a provider market-cap field. FDV/liquidity/volume/TVL are not substitutes. */
export function verifiedMarketCapOrNull(marketCapUsd: unknown, fdvUsd?: unknown): number | null {
  void fdvUsd
  return validPriceOrNull(marketCapUsd)
}
export function canTrackOutcome(score: unknown): score is number {
  return typeof score === 'number' && Number.isFinite(score) && score >= OUTCOME_POLICY.minRisk && score <= 100
}
export function percentChange(baseline: number | null, current: number | null): number | null {
  const validBaseline = validPriceOrNull(baseline)
  const validCurrent = validPriceOrNull(current)
  if (validBaseline == null || validCurrent == null) return null
  const result = ((validCurrent - validBaseline) / validBaseline) * 100
  return Number.isFinite(result) ? result : null
}
/** Displayed -100.0% means the current price is dust relative to baseline, not a 25% drawdown. */
export function isEffectivelyZeroRelativeToBaseline(baseline: number | null, current: number | null): boolean {
  const change = percentChange(baseline, current)
  return change != null && change <= -99.95
}
export function observationCheckedAtMs(row: { last_checked_at?: string | null }): number | null {
  if (!row.last_checked_at) return null
  const ms = Date.parse(row.last_checked_at)
  return Number.isFinite(ms) ? ms : null
}
export function observationIsFresh(row: { last_checked_at?: string | null }, now = Date.now()): boolean {
  const checked = observationCheckedAtMs(row)
  return checked != null && now - checked >= 0 && now - checked <= OUTCOME_POLICY.priceStaleMs
}
export function observationIsSourced(row: { market_source?: string | null }): boolean {
  return typeof row.market_source === 'string' && row.market_source.trim() !== ''
}
export function outcomeFreshnessLabel(checkedAt: string | null | undefined, now: number, failed = false, updating = false): string {
  if (updating) return 'Updating…'
  const ms = observationCheckedAtMs({ last_checked_at: checkedAt })
  if (ms == null) return failed ? 'Latest refresh failed' : 'Not checked yet'
  const seconds = Math.max(0, Math.floor((now - ms) / 1000))
  const age = seconds < 60 ? `${seconds}s ago` : `${Math.max(1, Math.floor(seconds / 60))}m ago`
  if (failed) return `Latest refresh failed · last verified ${age}`
  if (!observationIsFresh({ last_checked_at: checkedAt }, now)) return `Last verified ${age}`
  return `Updated ${age}`
}
const OUTCOME_ID_RE = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i
export function liveOutcomeRequestIds(ids: unknown, fallbackId?: unknown): string[] {
  const raw = Array.isArray(ids) ? ids : typeof fallbackId === 'string' ? [fallbackId] : []
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of raw) {
    if (typeof value !== 'string' || !OUTCOME_ID_RE.test(value) || seen.has(value)) continue
    seen.add(value)
    out.push(value)
    if (out.length >= OUTCOME_POLICY.refreshBatch) break
  }
  return out
}
/**
 * Rotate through displayed receipts in batches of at most four. The open receipt is owned by the
 * 20s modal loop and is skipped here so it is not live-fetched twice.
 */
export function nextTrackedOutcomeLiveBatch(ids: string[], cursor = 0, skipId?: string | null, batchSize = OUTCOME_POLICY.refreshBatch): { ids: string[]; cursor: number } {
  const ring = ids.filter(id => typeof id === 'string' && id.length > 0 && id !== skipId)
  if (!ring.length || batchSize <= 0) return { ids: [], cursor: 0 }
  const size = Math.min(batchSize, ring.length)
  const start = ((cursor % ring.length) + ring.length) % ring.length
  const batch: string[] = []
  for (let i = 0; i < size; i++) batch.push(ring[(start + i) % ring.length]!)
  return { ids: batch, cursor: (start + size) % ring.length }
}
export function pageLiveBudget(visibleCount: number, receiptOpen = false) {
  const interval = OUTCOME_POLICY.pageLiveRefreshMs
  const pagePostsPerMinute = OUTCOME_POLICY.postLimiterWindowMs / interval
  const receiptPostsPerMinute = receiptOpen ? OUTCOME_POLICY.postLimiterWindowMs / OUTCOME_POLICY.receiptLiveRefreshMs : 0
  const tokensPerMinute = pagePostsPerMinute * OUTCOME_POLICY.refreshBatch
  const cycleMs = visibleCount <= 0 ? 0 : Math.ceil(visibleCount / OUTCOME_POLICY.refreshBatch) * interval
  return {
    intervalMs: interval,
    batchSize: OUTCOME_POLICY.refreshBatch,
    pagePostsPerMinute,
    receiptPostsPerMinute,
    totalPostsPerMinute: pagePostsPerMinute + receiptPostsPerMinute,
    tokensPerMinute,
    worstCaseProviderCallsPerMinute: (tokensPerMinute + receiptPostsPerMinute) * 2,
    cycleMs,
    batchBudgetMs: OUTCOME_POLICY.pageLiveBatchBudgetMs,
  }
}
/**
 * A persisted current price may be shown only when it is a real positive number.
 * Legacy rows without versioned identity proof stay pending until an exact-identity refresh.
 * Once proven, the last valid observation remains usable when a later provider request fails.
 */
export function displayableCurrentPrice(row: {
  chain?: string
  token_address?: string
  baseline_price_usd?: number | null
  current_price_usd?: number | null
  last_checked_at?: string | null
  market_source?: string | null
  market_observation_json?: MarketObservationProof | null
}, now = Date.now()): number | null {
  void now
  const current = validPriceOrNull(row.current_price_usd)
  if (current == null) return null
  const proof = row.market_observation_json
  if (!proof || proof.version !== 1 || proof.identityMatched !== true || validPriceOrNull(proof.priceUsd) !== current) return null
  if (!row.chain || !row.token_address || proof.chain !== row.chain) return null
  const same = row.chain === 'solana' ? proof.tokenAddress === row.token_address : proof.tokenAddress.toLowerCase() === row.token_address.toLowerCase()
  return same && observationIsSourced(row) ? current : null
}
/** Identity-proven price may display even when market cap is missing. Never derived from FDV. */
export function displayableCurrentMarketCap(row: {
  chain?: string
  token_address?: string
  current_price_usd?: number | null
  last_checked_at?: string | null
  market_source?: string | null
  market_observation_json?: MarketObservationProof | null
}, now = Date.now()): number | null {
  if (displayableCurrentPrice(row, now) == null) return null
  return verifiedMarketCapOrNull(row.market_observation_json?.marketCapUsd)
}
export function frozenBaselineMarketCapUsd(row: {
  baseline_market_cap_usd?: number | null
  baseline_snapshot_json?: { baselineMarketCapUsd?: number | null }
}): number | null {
  return validPriceOrNull(row.baseline_market_cap_usd) ?? validPriceOrNull(row.baseline_snapshot_json?.baselineMarketCapUsd)
}
/** Price vs market-cap implied-supply divergence beyond this is not the same token. */
export const BASELINE_PRICE_MCAP_MAX_DIVERGENCE = 100
function outcomeTokenAddressEqualsLocal(chain: string, left: string, right: string): boolean {
  return chain === 'solana' ? left === right : left.toLowerCase() === right.toLowerCase()
}
/**
 * Freeze a scan price only when it can be the priced token. Quote-side identity fails closed.
 * Unknown identity still fails when price × circulating supply contradicts the frozen market cap
 * by orders of magnitude. Never invents a replacement price.
 */
export function freezeableBaselinePriceUsd(args: {
  priceUsd: unknown
  marketCapUsd?: unknown
  circulatingSupply?: unknown
  chain?: string
  tokenAddress?: string
  pricedBaseTokenAddress?: unknown
}): number | null {
  const price = validPriceOrNull(args.priceUsd)
  if (price == null) return null
  const chain = typeof args.chain === 'string' ? args.chain : ''
  const token = typeof args.tokenAddress === 'string' ? args.tokenAddress : ''
  const base = typeof args.pricedBaseTokenAddress === 'string' ? args.pricedBaseTokenAddress : ''
  if (base && token) {
    return outcomeTokenAddressEqualsLocal(chain, base, token) ? price : null
  }
  const mcap = validPriceOrNull(args.marketCapUsd)
  const supply = validPriceOrNull(args.circulatingSupply)
  if (mcap != null && supply != null && supply > 0) {
    const implied = price * supply
    const divergence = implied / mcap
    if (!Number.isFinite(divergence) || divergence >= BASELINE_PRICE_MCAP_MAX_DIVERGENCE || divergence <= 1 / BASELINE_PRICE_MCAP_MAX_DIVERGENCE) return null
  }
  return price
}
/**
 * A stored baseline may be shown as the original price, but percent/PnL may use it only when it
 * is economically the same series as the frozen market cap and the identity-matched current quote.
 * Never rewrites the frozen columns and never derives a replacement original price.
 */
export function comparableOutcomeBaselinePrice(row: {
  chain?: string
  token_address?: string
  baseline_price_usd?: number | null
  baseline_market_cap_usd?: number | null
  baseline_snapshot_json?: { baselinePriceUsd?: number | null; baselineMarketCapUsd?: number | null }
  current_price_usd?: number | null
  current_market_cap_usd?: number | null
  last_checked_at?: string | null
  market_source?: string | null
  market_observation_json?: MarketObservationProof | null
}, now = Date.now()): number | null {
  const baseline = validPriceOrNull(row.baseline_price_usd) ?? validPriceOrNull(row.baseline_snapshot_json?.baselinePriceUsd)
  if (baseline == null) return null
  const originalCap = frozenBaselineMarketCapUsd(row)
  const current = displayableCurrentPrice(row, now)
  const currentCap = displayableCurrentMarketCap(row, now)
  if (originalCap != null && current != null && currentCap != null) {
    const priceRatio = current / baseline
    const mcapRatio = currentCap / originalCap
    if (!(priceRatio > 0) || !(mcapRatio > 0)) return null
    const divergence = priceRatio / mcapRatio
    if (!Number.isFinite(divergence) || divergence >= BASELINE_PRICE_MCAP_MAX_DIVERGENCE || divergence <= 1 / BASELINE_PRICE_MCAP_MAX_DIVERGENCE) return null
  }
  return baseline
}
export function pendingUnavailableReasons(): string[] {
  return ['Current price unavailable — Outcome pending']
}
export function incomparableBaselineReasons(): string[] {
  return ['Original scan price is not a verified price of this token — Outcome pending']
}
export function hypothetical(baseline: number | null, current: number | null) {
  const change = percentChange(baseline, current)
  // A zero market quote is not reliable execution evidence. Do not present a fake total loss.
  if (change == null || current === 0) return null
  const validBaseline = validPriceOrNull(baseline)
  const validCurrent = validPriceOrNull(current)
  if (validBaseline == null || validCurrent == null) return null
  const value = 1000 * (validCurrent / validBaseline)
  if (!Number.isFinite(value)) return null
  return { value, pnl: value - 1000, potentialLossAvoided: Math.max(0, 1000 - value) }
}
export function outcomeHypothetical(row: Parameters<typeof comparableOutcomeBaselinePrice>[0], now = Date.now()) {
  return hypothetical(comparableOutcomeBaselinePrice(row, now), displayableCurrentPrice(row, now))
}
export type AfterEvidence = {
  price: number | null; liquidity: number | null;
  /** Only fresh independently verified facts may enter these fields, never baseline warnings. */
  verifiedDeployerDrain?: boolean; verifiedTradingBlocked?: boolean;
  comparableLiquidity?: boolean; verifiedPoolDead?: boolean;
  /** Separate positive evidence; a provider's missing/malformed numeric zero never sets this. */
  verifiedEconomicZero?: boolean;
}
export function classifyOutcome(baseline: { price: number | null; liquidity: number | null }, now: AfterEvidence): Outcome {
  const price = percentChange(baseline.price, now.price)
  const liquidity = percentChange(baseline.liquidity, now.liquidity)
  const strong: string[] = []
  if (now.verifiedDeployerDrain) strong.push('Verified deployer drain after the scan.')
  if (now.verifiedTradingBlocked) strong.push('Verified trading became blocked after the scan.')
  // Aggregate reserves and individual pools are NOT comparable. A missing pair is NOT a dead pool.
  if (now.comparableLiquidity && now.verifiedPoolDead && (baseline.liquidity ?? 0) >= OUTCOME_POLICY.minimumBaselineLiquidity && liquidity != null && liquidity <= OUTCOME_POLICY.catastrophicLiquidityPct) strong.push('Comparable liquidity collapsed at least 99% and pool death was independently verified.')
  if (strong.length) return { status: 'rugged', confidence: 'high', reasons: strong }
  if (now.verifiedEconomicZero) return { status: 'dumped', confidence: 'high', reasons: ['Independent evidence confirmed effectively zero current economic value. No rug inferred without separate rug proof.'] }
  if (price == null) return { status: 'unavailable', confidence: 'low', reasons: ['Valid baseline and current prices are required; no outcome inferred from missing data.'] }
  if (price >= OUTCOME_POLICY.pumpedPct) return { status: 'pumped', confidence: 'medium', reasons: ['Price increased at least 50% since the scan. Market estimate, not executable returns.'] }
  if (price <= OUTCOME_POLICY.dumpedPct) return { status: 'dumped', confidence: 'medium', reasons: ['Price fell at least 50% since the scan. No verified rug evidence.'] }
  return { status: 'watching', confidence: 'medium', reasons: ['Price remains within the ±50% outcome window. No verified rug evidence.'] }
}
export function snapshotHasFrozenEvidence(snapshot: TrackedOutcome['baseline_snapshot_json'] | null | undefined): boolean {
  return typeof snapshot?.scanId === 'string' && snapshot.scanId.length > 0
}
/**
 * One canonical view for cards and receipts. Percent, class and hypothetical all use the same
 * comparable baseline + identity-proven current price. Risk-score versioning is separate.
 */
export function presentTrackedOutcome(row: TrackedOutcome, now = Date.now()): TrackedOutcome {
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
function copyFrozenSnapshot(preferred: TrackedOutcome, fallback: TrackedOutcome): TrackedOutcome {
  const snapshot = snapshotHasFrozenEvidence(preferred.baseline_snapshot_json) ? preferred.baseline_snapshot_json
    : snapshotHasFrozenEvidence(fallback.baseline_snapshot_json) ? fallback.baseline_snapshot_json
    : preferred.baseline_snapshot_json
  return {
    ...preferred,
    baseline_price_usd: validPriceOrNull(preferred.baseline_price_usd) ?? validPriceOrNull(fallback.baseline_price_usd),
    baseline_liquidity_usd: numberOrNull(preferred.baseline_liquidity_usd) ?? numberOrNull(fallback.baseline_liquidity_usd),
    baseline_market_cap_usd: validPriceOrNull(preferred.baseline_market_cap_usd) ?? validPriceOrNull(fallback.baseline_market_cap_usd),
    baseline_risk_score: preferred.baseline_risk_score ?? fallback.baseline_risk_score,
    baseline_verdict: preferred.baseline_verdict || fallback.baseline_verdict,
    baseline_snapshot_json: snapshot,
    scan_id: preferred.scan_id || fallback.scan_id,
  }
}
function observationFields(from: TrackedOutcome, onto: TrackedOutcome): TrackedOutcome {
  return {
    ...onto,
    current_price_usd: from.current_price_usd,
    current_liquidity_usd: from.current_liquidity_usd ?? onto.current_liquidity_usd,
    current_market_cap_usd: from.current_market_cap_usd ?? onto.current_market_cap_usd,
    price_change_pct: from.price_change_pct,
    liquidity_change_pct: from.liquidity_change_pct,
    market_source: from.market_source,
    market_observation_json: from.market_observation_json ?? onto.market_observation_json,
    last_checked_at: from.last_checked_at ?? onto.last_checked_at,
    outcome_status: from.outcome_status,
    outcome_confidence: from.outcome_confidence,
    outcome_reasons_json: from.outcome_reasons_json,
    after_evidence_json: from.after_evidence_json ?? onto.after_evidence_json,
  }
}
/**
 * Newer identity-proven observation wins. An older page-load or list refresh cannot roll back a
 * live tick. Frozen scan evidence is preserved from the more complete snapshot.
 */
export function adoptNewerOutcomeObservation(current: TrackedOutcome, incoming?: TrackedOutcome | null, now = Date.now()): TrackedOutcome {
  if (!incoming || incoming.id !== current.id) return presentTrackedOutcome(current, now)
  const frozen = snapshotHasFrozenEvidence(current.baseline_snapshot_json) ? copyFrozenSnapshot(current, incoming) : copyFrozenSnapshot(incoming, current)
  const incomingPrice = displayableCurrentPrice(incoming, now)
  const currentPrice = displayableCurrentPrice(current, now)
  const incomingChecked = observationCheckedAtMs(incoming)
  const currentChecked = observationCheckedAtMs(current)
  const incomingWins = incomingPrice != null && (
    currentPrice == null
    || currentChecked == null
    || (incomingChecked != null && incomingChecked > currentChecked)
  )
  const merged = incomingWins ? observationFields(incoming, frozen) : observationFields(current, frozen)
  return presentTrackedOutcome(merged, now)
}
export function mergeTrackedOutcomeRows(current: TrackedOutcome[], incoming: TrackedOutcome[], now = Date.now()): TrackedOutcome[] {
  const byId = new Map(current.map(row => [row.id, row]))
  return incoming.map(row => {
    const prev = byId.get(row.id)
    return prev ? adoptNewerOutcomeObservation(prev, row, now) : presentTrackedOutcome(row, now)
  })
}
/**
 * Keep frozen GET evidence, but prefer a newer identity-proven observation. Never copies an
 * unproven listed price and never lets an older response replace a newer live tick.
 */
export function mergeListedOutcomeObservation(full: TrackedOutcome, listed?: TrackedOutcome | null, now = Date.now()): TrackedOutcome {
  return adoptNewerOutcomeObservation(full, listed, now)
}
export function shareOutcome(row: TrackedOutcome): string {
  const s = row.baseline_snapshot_json
  const current = displayableCurrentPrice(row)
  const baseline = comparableOutcomeBaselinePrice(row)
  const h = hypothetical(baseline, current)
  const change = percentChange(baseline, current)
  const risk = row.baseline_risk_semantics === 'legacy_unverified' ? 'an unversioned legacy risk score (rescan required)' : `${s.baselineRiskScore}/100 risk`
  return `ChainLens flagged ${s.tokenSymbol || 'this token'} at ${risk}.\nSince the scan: ${change == null || !h ? 'price comparison unavailable' : `${change.toFixed(1)}%`}.\n${h ? `$1,000 at scan would be worth $${h.value.toFixed(2)} at the latest observed price (hypothetical).` : 'Hypothetical value unavailable.'}\nchainlensai.app`
}
