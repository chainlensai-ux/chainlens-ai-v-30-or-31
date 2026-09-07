export const COINPAPRIKA_HARD_MAX_CALLS = 130
const DAY_SECONDS = 86_400
const POSITIVE_TTL_MS = 6 * 60 * 60 * 1000
const NEGATIVE_TTL_MS = 15 * 60 * 1000

export type CoinPaprikaIdentity = {
  chainId: string
  contractAddress: string
  coinPaprikaId: string | null
  platform: string | null
  identityStatus: 'verified' | 'rejected'
  identityReason: string
}

export type CoinPaprikaRequirement = {
  chainId: string
  contractAddress: string
  symbol?: string | null
  timestamp: string
  lotCount: number
  lotsCompletedIfResolved: number
  sidesCompleted: number
  coverageGain: number
  notionalUsd: number
  hasRealTradeEvidence: boolean
  canCompleteClosedLot: boolean
  dustNonEconomic?: boolean
  airdropOnly?: boolean
  distributionOnly?: boolean
  ordinaryTransferOnly?: boolean
  spamSuppressed?: boolean
  hasAcceptedEvidence?: boolean
  strongerSourcesExhausted: boolean
}

export type CoinPaprikaHistoricalEvidence = {
  source: 'coinpaprika_historical'
  coinPaprikaId: string
  interval: '1d'
  requestedTimestamp: string
  resolvedTimestamp: string
  priceUsd: number
  identityProof: CoinPaprikaIdentity
  timeDistance: number
  evidenceStatus: 'partial_unverified'
}

export type CoinPaprikaAuditExample = {
  chainId: string; tokenAddress: string; symbol: string | null; coinPaprikaId: string | null
  lotCount: number; expectedLotsCompleted: number; identityStatus: 'verified' | 'rejected' | 'not_attempted'
  requestMade: boolean; priceResolved: boolean; lotsCompleted: number; dropStage: string | null; dropReason: string | null
}

export type CoinPaprikaHistoricalAudit = {
  enabled: boolean; disabledReason?: string
  budgetMax: number; callsAttempted: number; callsSucceeded: number; callsFailed: number
  rawCandidates: number; dustFiltered: number; spamFiltered: number; airdropFiltered: number
  nonTradeFiltered: number; strongerEvidenceFiltered: number; noIdentityMatchFiltered: number
  eligibleRequirements: number; uniqueRequestsAfterDedupe: number; candidatesRanked: number
  identityResolved: number; identityRejected: number; pricesResolved: number; pricesApplied: number
  lotsCompleted: number; coverageBefore: number; coverageAfter: number
  stoppedBecauseNoCandidates: boolean; stoppedBecauseGateReached: boolean; stoppedBecauseBudget: boolean
  failuresByReason: Record<string, number>; examples: CoinPaprikaAuditExample[]
}

type FetchLike = typeof fetch
type Cached<T> = { expiresAt: number; value: T }
const identityCache = new Map<string, Cached<CoinPaprikaIdentity>>()
const priceCache = new Map<string, Cached<CoinPaprikaHistoricalEvidence | null>>()
const inFlight = new Map<string, Promise<unknown>>()

export function coinPaprikaPlatformForChain(chainId: string): string | null {
  const chain = chainId.toLowerCase()
  if (chain === '1' || chain === 'eth' || chain === 'ethereum' || chain === 'eth-mainnet') return 'eth-ethereum'
  if (chain === '8453' || chain === 'base' || chain === 'base-mainnet') return 'base-base'
  return null
}

export function isCoinPaprikaEligible(r: CoinPaprikaRequirement): { eligible: boolean; reason: string | null } {
  if (r.dustNonEconomic) return { eligible: false, reason: 'dust_non_economic' }
  if (r.spamSuppressed) return { eligible: false, reason: 'spam_suppressed' }
  if (r.airdropOnly) return { eligible: false, reason: 'airdrop_only' }
  if (r.distributionOnly) return { eligible: false, reason: 'distribution_only' }
  if (r.ordinaryTransferOnly) return { eligible: false, reason: 'ordinary_transfer_only' }
  if (!r.hasRealTradeEvidence) return { eligible: false, reason: 'no_real_trade_evidence' }
  if (!r.canCompleteClosedLot || r.lotsCompletedIfResolved < 1) return { eligible: false, reason: 'cannot_complete_closed_lot' }
  if (!coinPaprikaPlatformForChain(r.chainId) || !/^0x[a-fA-F0-9]{40}$/.test(r.contractAddress)) return { eligible: false, reason: 'missing_chain_or_contract' }
  if (r.hasAcceptedEvidence) return { eligible: false, reason: 'accepted_evidence_exists' }
  if (!r.strongerSourcesExhausted) return { eligible: false, reason: 'stronger_sources_not_exhausted' }
  return { eligible: true, reason: null }
}

export function rankCoinPaprikaRequirements(requirements: CoinPaprikaRequirement[]): CoinPaprikaRequirement[] {
  const score = (r: CoinPaprikaRequirement) => r.lotsCompletedIfResolved * 1e9 + r.sidesCompleted * 1e7 + r.coverageGain * 1e5 + Math.min(r.notionalUsd, 100_000)
  return [...requirements].sort((a, b) => score(b) - score(a) || a.contractAddress.localeCompare(b.contractAddress) || a.timestamp.localeCompare(b.timestamp))
}

function failure(audit: CoinPaprikaHistoricalAudit, reason: string) {
  audit.failuresByReason[reason] = (audit.failuresByReason[reason] ?? 0) + 1
}

function config() {
  const apiKey = process.env.COINPAPRIKA_API_KEY?.trim()
  const baseUrl = (process.env.COINPAPRIKA_API_BASE_URL?.trim() || 'https://api-pro.coinpaprika.com/v1').replace(/\/$/, '')
  const configuredMax = Number.parseInt(process.env.COINPAPRIKA_MAX_CALLS_PER_SCAN || '130', 10)
  return { apiKey, baseUrl, max: Math.min(COINPAPRIKA_HARD_MAX_CALLS, Number.isFinite(configuredMax) && configuredMax >= 0 ? configuredMax : COINPAPRIKA_HARD_MAX_CALLS) }
}

async function singleflight<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key) as Promise<T> | undefined
  if (existing) return existing
  const pending = operation().finally(() => inFlight.delete(key))
  inFlight.set(key, pending)
  return pending
}

export async function resolveCoinPaprikaHistorical(
  requirements: CoinPaprikaRequirement[],
  options: { fetchImpl?: FetchLike; coverageBefore?: number; canonicalGateSatisfied?: boolean } = {},
): Promise<{ evidence: Map<string, CoinPaprikaHistoricalEvidence>; audit: CoinPaprikaHistoricalAudit }> {
  const cfg = config()
  const audit: CoinPaprikaHistoricalAudit = {
    enabled: Boolean(cfg.apiKey), budgetMax: cfg.max, callsAttempted: 0, callsSucceeded: 0, callsFailed: 0,
    rawCandidates: requirements.length, dustFiltered: 0, spamFiltered: 0, airdropFiltered: 0, nonTradeFiltered: 0,
    strongerEvidenceFiltered: 0, noIdentityMatchFiltered: 0, eligibleRequirements: 0, uniqueRequestsAfterDedupe: 0,
    candidatesRanked: 0, identityResolved: 0, identityRejected: 0, pricesResolved: 0, pricesApplied: 0,
    lotsCompleted: 0, coverageBefore: options.coverageBefore ?? 0, coverageAfter: options.coverageBefore ?? 0,
    stoppedBecauseNoCandidates: false, stoppedBecauseGateReached: false, stoppedBecauseBudget: false,
    failuresByReason: {}, examples: [],
  }
  const evidence = new Map<string, CoinPaprikaHistoricalEvidence>()
  if (!cfg.apiKey) { audit.disabledReason = 'COINPAPRIKA_API_KEY_not_configured'; audit.stoppedBecauseNoCandidates = true; return { evidence, audit } }
  if (options.canonicalGateSatisfied) { audit.stoppedBecauseGateReached = true; return { evidence, audit } }

  const eligible: CoinPaprikaRequirement[] = []
  for (const r of requirements) {
    const check = isCoinPaprikaEligible(r)
    if (check.eligible) eligible.push(r)
    else {
      if (check.reason === 'dust_non_economic') audit.dustFiltered++
      else if (check.reason === 'spam_suppressed') audit.spamFiltered++
      else if (check.reason === 'airdrop_only') audit.airdropFiltered++
      else if (check.reason?.startsWith('stronger') || check.reason === 'accepted_evidence_exists') audit.strongerEvidenceFiltered++
      else audit.nonTradeFiltered++
    }
  }
  audit.eligibleRequirements = eligible.length
  audit.stoppedBecauseNoCandidates = eligible.length === 0
  if (!eligible.length) return { evidence, audit }
  const ranked = rankCoinPaprikaRequirements(eligible)
  audit.candidatesRanked = ranked.length
  const fetcher = options.fetchImpl ?? fetch
  const seen = new Set<string>()

  const callJson = async (url: string): Promise<{ json: unknown | null; reason: string | null }> => {
    if (audit.callsAttempted >= cfg.max) { audit.stoppedBecauseBudget = true; return { json: null, reason: 'budget_exhausted' } }
    audit.callsAttempted++
    try {
      const response = await fetcher(url, { headers: { Authorization: `Bearer ${cfg.apiKey}` }, cache: 'no-store', signal: AbortSignal.timeout(6_000) })
      if (response.status === 404) { audit.callsFailed++; return { json: null, reason: 'not_found_404' } }
      if (response.status === 429) { audit.callsFailed++; return { json: null, reason: 'rate_limited_429' } }
      if (response.status >= 500) { audit.callsFailed++; return { json: null, reason: `server_${response.status}` } }
      if (!response.ok) { audit.callsFailed++; return { json: null, reason: `http_${response.status}` } }
      try { const json = await response.json(); audit.callsSucceeded++; return { json, reason: null } }
      catch { audit.callsFailed++; return { json: null, reason: 'invalid_json' } }
    } catch (error) {
      audit.callsFailed++
      return { json: null, reason: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network_error' }
    }
  }

  for (const r of ranked) {
    if (audit.stoppedBecauseBudget) break
    const platform = coinPaprikaPlatformForChain(r.chainId)!
    const address = r.contractAddress.toLowerCase()
    const identityKey = `${platform}:${address}`
    const cachedIdentity = identityCache.get(identityKey)
    let identity = cachedIdentity && cachedIdentity.expiresAt > Date.now() ? cachedIdentity.value : undefined
    let requestMade = false
    if (!identity) {
      identity = await singleflight(`identity:${identityKey}`, async () => {
        requestMade = true
        const result = await callJson(`${cfg.baseUrl}/contracts/${encodeURIComponent(platform)}/${encodeURIComponent(address)}`)
        if (result.reason) {
          failure(audit, result.reason)
          const rejected: CoinPaprikaIdentity = { chainId: r.chainId, contractAddress: address, coinPaprikaId: null, platform, identityStatus: 'rejected', identityReason: result.reason }
          if (result.reason === 'not_found_404') identityCache.set(identityKey, { value: rejected, expiresAt: Date.now() + NEGATIVE_TTL_MS })
          return rejected
        }
        const body = result.json as Record<string, unknown>
        // A 200 from CoinPaprika's contract-scoped route is itself the mapping proof. Some API
        // plans repeat platform/address in the body and some return only the coin record; when
        // repeated, both fields must still match exactly (fail closed on any disagreement).
        const returnedAddress = String(body.contract_address ?? body.address ?? address).toLowerCase()
        const returnedPlatform = String(body.platform_id ?? body.platform ?? platform)
        const id = typeof body.id === 'string' ? body.id : typeof (body.coin as Record<string, unknown> | undefined)?.id === 'string' ? String((body.coin as Record<string, unknown>).id) : null
        const verified = returnedAddress === address && returnedPlatform === platform && Boolean(id)
        const mapped: CoinPaprikaIdentity = { chainId: r.chainId, contractAddress: address, coinPaprikaId: verified ? id : null, platform, identityStatus: verified ? 'verified' : 'rejected', identityReason: verified ? 'exact_platform_and_contract_match' : 'identity_mismatch' }
        identityCache.set(identityKey, { value: mapped, expiresAt: Date.now() + (verified ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS) })
        return mapped
      })
    }
    if (identity.identityStatus !== 'verified' || !identity.coinPaprikaId) {
      audit.identityRejected++; audit.noIdentityMatchFiltered++; failure(audit, identity.identityReason)
      audit.examples.push({ chainId: r.chainId, tokenAddress: address, symbol: r.symbol ?? null, coinPaprikaId: null, lotCount: r.lotCount, expectedLotsCompleted: r.lotsCompletedIfResolved, identityStatus: 'rejected', requestMade, priceResolved: false, lotsCompleted: 0, dropStage: 'identity', dropReason: identity.identityReason })
      continue
    }
    audit.identityResolved++
    const requestedMs = Date.parse(r.timestamp)
    if (!Number.isFinite(requestedMs)) { failure(audit, 'invalid_requested_timestamp'); continue }
    const day = new Date(requestedMs).toISOString().slice(0, 10)
    const requirementKey = `${identity.coinPaprikaId}:${day}`
    if (seen.has(requirementKey)) continue
    seen.add(requirementKey); audit.uniqueRequestsAfterDedupe++
    const cachedPrice = priceCache.get(requirementKey)
    let priced = cachedPrice && cachedPrice.expiresAt > Date.now() ? cachedPrice.value : undefined
    if (priced === undefined) {
      priced = await singleflight(`price:${requirementKey}`, async () => {
        requestMade = true
        const end = new Date(requestedMs + DAY_SECONDS * 1000).toISOString().slice(0, 10)
        const result = await callJson(`${cfg.baseUrl}/coins/${encodeURIComponent(identity!.coinPaprikaId!)}/ohlcv/historical?start=${day}&end=${end}&interval=1d`)
        if (result.reason) { failure(audit, result.reason); return null }
        const rows = Array.isArray(result.json) ? result.json as Record<string, unknown>[] : []
        if (!rows.length) { failure(audit, 'empty_series'); priceCache.set(requirementKey, { value: null, expiresAt: Date.now() + NEGATIVE_TTL_MS }); return null }
        const row = rows[0]
        const resolvedTimestamp = String(row.time_open ?? row.time_close ?? '')
        const resolvedMs = Date.parse(resolvedTimestamp)
        const priceUsd = Number(row.close)
        const deltaSeconds = Math.abs(resolvedMs - requestedMs) / 1000
        if (!Number.isFinite(resolvedMs) || deltaSeconds > DAY_SECONDS) { failure(audit, 'timestamp_outside_daily_window'); return null }
        if (!Number.isFinite(priceUsd) || priceUsd <= 0) { failure(audit, 'invalid_price'); return null }
        const ev: CoinPaprikaHistoricalEvidence = { source: 'coinpaprika_historical', coinPaprikaId: identity!.coinPaprikaId!, interval: '1d', requestedTimestamp: r.timestamp, resolvedTimestamp, priceUsd, identityProof: identity!, timeDistance: deltaSeconds, evidenceStatus: 'partial_unverified' }
        priceCache.set(requirementKey, { value: ev, expiresAt: Date.now() + POSITIVE_TTL_MS })
        return ev
      })
    }
    if (priced) {
      evidence.set(requirementKey, priced); audit.pricesResolved++; audit.pricesApplied++
      // Daily CoinPaprika candles are intentionally partial/unverified under the canonical
      // Wallet Scanner policy. They may make an estimate inspectable, but cannot increase the
      // verified-lot numerator or claim that the 50% gate was crossed.
    }
    audit.examples.push({ chainId: r.chainId, tokenAddress: address, symbol: r.symbol ?? null, coinPaprikaId: identity.coinPaprikaId, lotCount: r.lotCount, expectedLotsCompleted: r.lotsCompletedIfResolved, identityStatus: 'verified', requestMade, priceResolved: Boolean(priced), lotsCompleted: 0, dropStage: priced ? 'evidence_quality' : 'price', dropReason: priced ? 'daily_candle_partial_unverified' : 'historical_price_unavailable' })
  }
  audit.examples = audit.examples.slice(0, 20)
  return { evidence, audit }
}

export function clearCoinPaprikaCachesForTests() { identityCache.clear(); priceCache.clear(); inFlight.clear() }
