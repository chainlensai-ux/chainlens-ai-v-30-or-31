/** Outcome policy, not a second token risk engine. Missing numbers stay missing. */
export const OUTCOME_POLICY = {
  minRisk: 50, pumpedPct: 50, dumpedPct: -50, catastrophicLiquidityPct: -99,
  minimumBaselineLiquidity: 10_000,
  // Rug-proof lookback stays 15 minutes so a later honeypot confirmation is not weakened.
  staleMs: 15 * 60_000,
  // Live outcome prices: short enough that a bad first tick cannot sit on the Track page.
  priceStaleMs: 3 * 60_000,
  refreshBatch: 4,
  /** Open-receipt live lookup interval. Bounded; never used for the Track list. */
  receiptLiveRefreshMs: 45_000,
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
/**
 * Keep frozen GET evidence, but prefer a same-request identity-proven list observation when
 * storage could not persist `market_observation_json`. Never copies an unproven listed price.
 */
export function mergeListedOutcomeObservation(full: TrackedOutcome, listed?: TrackedOutcome | null): TrackedOutcome {
  if (!listed || listed.id !== full.id) return full
  if (displayableCurrentPrice(listed) == null) return full
  const fullChecked = observationCheckedAtMs(full)
  const listedChecked = observationCheckedAtMs(listed)
  if (displayableCurrentPrice(full) != null && fullChecked != null && listedChecked != null && listedChecked < fullChecked) return full
  return {
    ...full,
    current_price_usd: listed.current_price_usd,
    current_liquidity_usd: listed.current_liquidity_usd ?? full.current_liquidity_usd,
    current_market_cap_usd: listed.current_market_cap_usd ?? full.current_market_cap_usd,
    price_change_pct: listed.price_change_pct,
    liquidity_change_pct: listed.liquidity_change_pct,
    market_source: listed.market_source,
    market_observation_json: listed.market_observation_json ?? full.market_observation_json,
    last_checked_at: listed.last_checked_at ?? full.last_checked_at,
    outcome_status: listed.outcome_status,
    outcome_confidence: listed.outcome_confidence,
    outcome_reasons_json: listed.outcome_reasons_json,
  }
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
