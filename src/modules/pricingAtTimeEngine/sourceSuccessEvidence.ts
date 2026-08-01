// MODULE — pricingAtTimeEngine: deterministic per-source success evidence.
//
// GOAL, DISCLOSED: production baseline with the completion-yield scheduler enabled — verified lots
// 30/216 (13.89%), 210 requirements selected, 66 resolved, 145 unresolved; native 53 selected but
// only 4 priced (49 provider misses); GeckoTerminal still returning 429; many Base DEX paths
// returning no_pool/blockResolutionFailure. The scheduler's structural completion yield is correct
// but UNDISCOUNTED: it happily spends a scarce slot on a requirement whose only viable source has
// already proven, repeatedly and with a typed reason, that it cannot answer for that asset class.
// This module supplies the missing term — a real, source-specific probability that a dispatch will
// actually come back with a price.
//
// EVIDENCE IS OBSERVED, NEVER INVENTED, DISCLOSED. Every number here comes from a typed outcome the
// pricing router ALREADY produced (PriceAttemptDetail — {source, ok, reason}) at a call that already
// happened. This module makes NO provider call of its own, ever, and adds none: it is a passive
// ledger plus a pure estimator. A (chain, token, source) combination this process has never observed
// contributes nothing and falls back to an explicit, deterministic prior — never to a guess dressed
// up as a measurement.
//
// ORDER-INDEPENDENCE, DISCLOSED (this task's explicit "no asynchronous ordering dependence"
// constraint): every estimate is a pure function of COUNTS (attempts/successes/typed-reason
// tallies), never of the order in which those outcomes arrived, and never of any wall-clock or
// promise-resolution timing. Two processes that observe the same multiset of outcomes in different
// interleavings produce byte-identical probabilities. Callers that need a stable view across an
// async pass take one `snapshotSourceSuccessEvidence()` up front and pass that immutable value
// around, rather than reading the live ledger mid-flight.
//
// NEVER LEARNS FROM PnL, DISCLOSED (this task's explicit "no learning from public PnL values"
// constraint): nothing recorded here is derived from a realized/unrealized PnL number, a USD value,
// a price magnitude, or any public output. The ONLY inputs are (a) which source was asked, (b)
// whether it answered at all, and (c) the typed reason it gave when it did not.

import type { SupportedChain } from '../providerFetchWindow/types'

// The real source identifiers the pricing router already emits on PriceAttemptDetail, plus
// 'alchemy' for the separate Alchemy historical range source (which carries its own typed failure
// reasons — token_not_found / temporal_distance_exceeded — in its own audit record).
export type PricingSourceName =
  | 'goldrush'
  | 'dexscreener'
  | 'geckoterminal'
  | 'coingecko'
  | 'base_dex'
  | 'alchemy'

// The real asset classes this pipeline already distinguishes everywhere else (see quoteLegPricing's
// isVerifiedStablecoinAddress / isNativePseudoAddress / isCanonicalWethAddress). 'other' is the
// honest default — never a guess at a token's quality, just "not one of the two verified classes".
export type PricingAssetClass = 'native' | 'stable' | 'other'

// Mirrors SchedulerRequirement's own `missingSide`: which side of a structural lot this requirement
// would resolve. 'unranked' is a requirement not tied to any structural lot at all.
export type PricingRequirementType = 'entry' | 'exit' | 'both' | 'unranked'

export type PricingAttemptOutcome = {
  chain: SupportedChain
  token: string
  source: PricingSourceName
  assetClass: PricingAssetClass
  requirementType: PricingRequirementType
  ok: boolean
  // The source's own typed reason when ok === false. null when the source succeeded, or when it
  // failed without giving a typed reason (recorded honestly as "no reason given", never invented).
  reason: string | null
}

// HARD-FAILURE REASONS, DISCLOSED: typed outcomes that mean "this source structurally cannot serve
// this asset", as distinct from a transient miss. Repeated hard failures drive the estimated success
// probability toward zero far faster than an untyped null does, because they are real evidence about
// the asset/source pair rather than noise. These are exactly the reasons named in this task's spec.
export const HARD_FAILURE_REASONS: ReadonlySet<string> = new Set([
  'no_pool',
  'token_not_found',
  'blockResolutionFailure',
  'temporal_distance_exceeded',
])

// PERMANENT-SKIP REASONS, DISCLOSED: a strict SUBSET of the hard failures above. `token_not_found`
// means the provider positively asserted the asset does not exist for it — retrying is not a gamble
// with poor odds, it is a call that cannot succeed. Requirements whose only evidence is
// token_not_found (or a live permanent negative-cache entry, supplied separately by the caller) are
// SKIPPED outright, never merely discounted. `no_pool` / `blockResolutionFailure` /
// `temporal_distance_exceeded` are deliberately NOT in this set: each is genuinely
// timestamp-or-venue specific and can legitimately differ for the same token at another time.
export const PERMANENT_SKIP_REASONS: ReadonlySet<string> = new Set(['token_not_found'])

// DETERMINISTIC FALLBACK PRIOR, DISCLOSED (this task's explicit "deterministic fallback probability
// for unseen requirements"). A requirement about which this process has observed literally nothing
// is neither optimistically assumed to work nor pessimistically written off — it gets this single,
// fixed, disclosed value. Chosen as a deliberately middling figure so that an unseen requirement
// ranks BELOW a source/asset pair with real demonstrated success and ABOVE one with real
// demonstrated failure, which is exactly the ordering evidence should produce.
export const DEFAULT_UNSEEN_SUCCESS_PROBABILITY = 0.5

// SHRINKAGE STRENGTH, DISCLOSED: each specificity level's estimate is smoothed toward the next
// broader level's estimate with this much pseudo-weight, so a single observation never swings an
// estimate to 0 or 1. Equivalent to a Beta prior centred on the broader estimate. Higher = more
// conservative; this value means it takes several consistent observations at a level before that
// level's own rate dominates its parent's.
export const SHRINKAGE_STRENGTH = 4

// HARD-FAILURE WEIGHT, DISCLOSED: a typed hard failure counts as this many ordinary failures when
// estimating. This is the concrete mechanism behind "repeated hard failures strongly reduce
// priority" — three typed no_pool responses depress an estimate much harder than three untyped
// nulls, because they are much stronger evidence. Never applied to a success (a success is a
// success, weight 1, always).
export const HARD_FAILURE_WEIGHT = 3

type LevelCounts = {
  attempts: number
  successes: number
  hardFailures: number
}

// PER-PROCESS LEDGER, DISCLOSED — module-level, exactly like every other per-scan/per-process
// provider-state store in this codebase (goldrushPriceSource's negative cache,
// alchemyHistoricalPriceSource's per-scan counters, pricingAtTimeAdapter's pricingRouteLog).
const levelCounts = new Map<string, LevelCounts>()
const reasonCountsByAsset = new Map<string, Map<string, number>>()
const permanentlyMissingAssets = new Set<string>()

// DELTA LEDGER, DISCLOSED — see sourceSuccessEvidencePersistence.ts. `levelCounts` above is the
// EFFECTIVE view (persisted baseline + everything observed in this process); `deltaCounts` is only
// what THIS process observed itself. Persisting the delta rather than the effective total is what
// makes concurrent flushes from several workers additive instead of mutually clobbering — a worker
// that wrote back its loaded baseline would re-count observations another worker had already
// stored.
const deltaCounts = new Map<string, LevelCounts>()
// Real observations made by this process, counted once each (not once per specificity level).
let recordedThisProcess = 0

export function resetSourceSuccessEvidence(): void {
  levelCounts.clear()
  reasonCountsByAsset.clear()
  permanentlyMissingAssets.clear()
  deltaCounts.clear()
  recordedThisProcess = 0
}

// Seeds the effective ledger with counts loaded from durable storage. NEVER touches `deltaCounts`:
// loaded evidence has already been persisted by whichever worker observed it, and must not be
// written back. Additive, so a load arriving after some local recording (or a second load) merges
// rather than replaces.
export function seedPersistedEvidence(
  loaded: ReadonlyMap<string, { attempts: number; successes: number; hardFailures: number }>,
): void {
  for (const [key, counts] of loaded) {
    const existing = levelCounts.get(key) ?? { attempts: 0, successes: 0, hardFailures: 0 }
    levelCounts.set(key, {
      attempts: existing.attempts + counts.attempts,
      successes: existing.successes + counts.successes,
      hardFailures: existing.hardFailures + counts.hardFailures,
    })
  }
}

// The counts observed by THIS process since the last reset — exactly what a flush should persist.
export function snapshotEvidenceDelta(): ReadonlyMap<string, LevelCounts> {
  const copy = new Map<string, LevelCounts>()
  for (const [k, v] of deltaCounts) copy.set(k, { ...v })
  return copy
}

export function evidenceRecordedThisProcess(): number {
  return recordedThisProcess
}

export function assetEvidenceKey(chain: string, token: string): string {
  return `${chain}:${token.toLowerCase()}`
}

// SPECIFICITY LADDER, DISCLOSED: strictly narrowing, broadest first. An estimate starts at the fixed
// prior and is shrunk successively through every level that has real observations, so a narrow level
// with plenty of evidence dominates, a narrow level with one observation barely moves the needle,
// and a narrow level with no observations is skipped entirely rather than fabricated.
function levelKeys(o: {
  chain: SupportedChain
  token: string
  source: PricingSourceName
  assetClass: PricingAssetClass
  requirementType: PricingRequirementType
}): string[] {
  return [
    `s=${o.source}`,
    `s=${o.source}|c=${o.assetClass}`,
    `s=${o.source}|c=${o.assetClass}|r=${o.requirementType}`,
    `s=${o.source}|ch=${o.chain}|c=${o.assetClass}|r=${o.requirementType}`,
    `s=${o.source}|ch=${o.chain}|t=${o.token.toLowerCase()}`,
  ]
}

// Records one real, already-completed provider attempt. Never triggers a call; never retries;
// purely additive bookkeeping over an outcome that has already happened.
export function recordPricingAttemptOutcome(outcome: PricingAttemptOutcome): void {
  const isHard = outcome.reason !== null && HARD_FAILURE_REASONS.has(outcome.reason)
  recordedThisProcess += 1
  for (const key of levelKeys(outcome)) {
    for (const store of [levelCounts, deltaCounts]) {
      const counts = store.get(key) ?? { attempts: 0, successes: 0, hardFailures: 0 }
      counts.attempts += 1
      if (outcome.ok) counts.successes += 1
      else if (isHard) counts.hardFailures += 1
      store.set(key, counts)
    }
  }

  const assetKey = assetEvidenceKey(outcome.chain, outcome.token)
  if (outcome.reason !== null && !outcome.ok) {
    const perAsset = reasonCountsByAsset.get(assetKey) ?? new Map<string, number>()
    perAsset.set(outcome.reason, (perAsset.get(outcome.reason) ?? 0) + 1)
    reasonCountsByAsset.set(assetKey, perAsset)
    // PROVIDER-SPECIFIC, DISCLOSED (this task's explicit "token_not_found remains provider-specific"
    // requirement): recorded per (chain, token, SOURCE). GeckoTerminal asserting a token does not
    // exist says nothing about whether GoldRush knows it — treating one provider's assertion as
    // global would permanently blind the scheduler to assets another provider can price perfectly
    // well. An asset is only ever hard-skipped when EVERY source on its real route has independently
    // asserted it (see isPermanentlyMissingAsset).
    if (PERMANENT_SKIP_REASONS.has(outcome.reason)) {
      permanentlyMissingAssets.add(`${assetKey}:${outcome.source}`)
    }
  }
}

// An immutable, deterministic view of the ledger. Callers take ONE of these before an async pass and
// use it throughout, so nothing they compute can depend on when a concurrent attempt happened to
// land — see this file's own ORDER-INDEPENDENCE header.
export type SourceSuccessEvidence = {
  levelCounts: ReadonlyMap<string, LevelCounts>
  reasonCountsByAsset: ReadonlyMap<string, ReadonlyMap<string, number>>
  permanentlyMissingAssets: ReadonlySet<string>
  totalObservations: number
}

export function snapshotSourceSuccessEvidence(): SourceSuccessEvidence {
  const copiedLevels = new Map<string, LevelCounts>()
  for (const [k, v] of levelCounts) copiedLevels.set(k, { ...v })
  const copiedReasons = new Map<string, ReadonlyMap<string, number>>()
  for (const [k, v] of reasonCountsByAsset) copiedReasons.set(k, new Map(v))
  return {
    levelCounts: copiedLevels,
    reasonCountsByAsset: copiedReasons,
    permanentlyMissingAssets: new Set(permanentlyMissingAssets),
    // Summed over the BROADEST level only (`s=<source>`, the keys with no `|`), so each real
    // attempt counts exactly once rather than once per specificity level it was recorded at.
    totalObservations: [...copiedLevels.entries()]
      .filter(([k]) => !k.includes('|'))
      .reduce((sum, [, v]) => sum + v.attempts, 0),
  }
}

// An empty, fully-valid evidence snapshot — every requirement scored against it receives exactly
// DEFAULT_UNSEEN_SUCCESS_PROBABILITY. Used by tests and by any caller that wants the unweighted
// baseline behaviour without special-casing a null.
export function emptySourceSuccessEvidence(): SourceSuccessEvidence {
  return { levelCounts: new Map(), reasonCountsByAsset: new Map(), permanentlyMissingAssets: new Set(), totalObservations: 0 }
}

// PURE, DETERMINISTIC. The estimated probability that `source` returns a usable price for this exact
// (chain, token, assetClass, requirementType). A pure function of the snapshot's counts — same
// counts in, same number out, on every machine, in every interleaving.
export function estimateSourceSuccessProbability(
  evidence: SourceSuccessEvidence,
  target: {
    chain: SupportedChain
    token: string
    source: PricingSourceName
    assetClass: PricingAssetClass
    requirementType: PricingRequirementType
  },
): number {
  let estimate = DEFAULT_UNSEEN_SUCCESS_PROBABILITY
  for (const key of levelKeys(target)) {
    const counts = evidence.levelCounts.get(key)
    if (!counts || counts.attempts === 0) continue
    // Hard failures are counted with extra weight on the FAILURE side only — the effective trial
    // count grows alongside them so the rate stays a genuine proportion, never an artificial
    // sub-zero value.
    const extraFailureWeight = counts.hardFailures * (HARD_FAILURE_WEIGHT - 1)
    const effectiveAttempts = counts.attempts + extraFailureWeight
    estimate = (counts.successes + SHRINKAGE_STRENGTH * estimate) / (effectiveAttempts + SHRINKAGE_STRENGTH)
  }
  // Clamped defensively; the arithmetic above cannot leave [0,1] for non-negative counts, but a
  // probability escaping that range must never propagate into a ranking score.
  return Math.min(1, Math.max(0, estimate))
}

// Real, observed typed failure reasons for this exact asset — used to report WHY a requirement was
// discounted, never to invent a reason that was not actually returned by a provider.
export function observedFailureReasonsForAsset(
  evidence: SourceSuccessEvidence,
  chain: string,
  token: string,
): ReadonlyMap<string, number> {
  return evidence.reasonCountsByAsset.get(assetEvidenceKey(chain, token)) ?? new Map()
}

// True only when a specific provider has POSITIVELY asserted this asset does not exist for it (see
// PERMANENT_SKIP_REASONS) — not merely "we have not managed to price it yet".
export function isPermanentlyMissingForSource(
  evidence: SourceSuccessEvidence,
  chain: string,
  token: string,
  source: PricingSourceName,
): boolean {
  return evidence.permanentlyMissingAssets.has(`${assetEvidenceKey(chain, token)}:${source}`)
}

// An asset is only treated as permanently missing — i.e. skipped outright rather than discounted —
// when EVERY source on its real dispatch route has independently asserted token_not_found. One
// provider's assertion is real evidence about THAT provider, never about the asset as a whole.
export function isPermanentlyMissingAsset(
  evidence: SourceSuccessEvidence,
  chain: SupportedChain,
  token: string,
): boolean {
  const route = routeSourceOrderFor(chain)
  return route.every((source) => isPermanentlyMissingForSource(evidence, chain, token, source))
}

// ROUTE ORDER, DISCLOSED, SINGLE DEFINITION: the real per-chain source ordering the pricing router
// uses (src/pipeline/pricingAtTimeAdapter.ts imports this rather than keeping its own copy, so the
// probability model can never silently drift out of sync with the dispatch order it models).
export function routeSourceOrderFor(chain: SupportedChain): Array<'goldrush' | 'dexscreener' | 'geckoterminal'> {
  return chain === 'base'
    ? ['geckoterminal', 'dexscreener', 'goldrush']
    : ['goldrush', 'dexscreener', 'geckoterminal']
}

// ESTIMATED COST, DISCLOSED: relative compute-unit weights per source, used ONLY as the denominator
// of the yield-per-cost score. These are ordering weights, not billing figures — the one externally
// grounded value is Alchemy's (ESTIMATED_CU_PER_ALCHEMY_HISTORICAL_REQUEST = 40 in
// alchemyHistoricalPriceSource.ts); the rest are deliberately uniform because this codebase has no
// verified per-provider CU figures for them and will not invent differentiated ones.
export const ESTIMATED_CU_BY_SOURCE: Readonly<Record<PricingSourceName, number>> = {
  goldrush: 10,
  dexscreener: 10,
  geckoterminal: 10,
  coingecko: 10,
  base_dex: 10,
  alchemy: 40,
}

export type RouteSuccessEstimate = {
  // P(at least one source in the real dispatch order returns a usable price) — computed from the
  // per-source estimates as 1 - product(1 - p_i), the honest combination for "try each in turn until
  // one answers".
  probability: number
  // The FIRST source in the real dispatch order for this chain — what the requirement will actually
  // hit first, and how selectedBySource attributes it.
  primarySource: PricingSourceName
  perSource: Array<{ source: PricingSourceName; probability: number }>
  // Expected number of real provider attempts before one answers (or all are exhausted), and the
  // expected CU those attempts cost. Both are expectations over the per-source probabilities above,
  // so a requirement whose first source almost always answers is correctly costed as ~1 call, and
  // one whose sources all usually miss is correctly costed as the full chain.
  estimatedCalls: number
  estimatedCu: number
}

// PURE, DETERMINISTIC. Models the real router: try each source for this chain in the real order,
// stop at the first that answers.
export function estimateRouteSuccess(
  evidence: SourceSuccessEvidence,
  target: {
    chain: SupportedChain
    token: string
    assetClass: PricingAssetClass
    requirementType: PricingRequirementType
  },
): RouteSuccessEstimate {
  const order = routeSourceOrderFor(target.chain)
  const perSource = order.map((source) => ({
    source: source as PricingSourceName,
    probability: estimateSourceSuccessProbability(evidence, { ...target, source }),
  }))

  let reachProbability = 1
  let estimatedCalls = 0
  let estimatedCu = 0
  let missAllProbability = 1
  for (const { source, probability } of perSource) {
    estimatedCalls += reachProbability
    estimatedCu += reachProbability * ESTIMATED_CU_BY_SOURCE[source]
    missAllProbability *= 1 - probability
    reachProbability *= 1 - probability
  }

  return {
    probability: 1 - missAllProbability,
    primarySource: perSource[0].source,
    perSource,
    estimatedCalls,
    estimatedCu,
  }
}
