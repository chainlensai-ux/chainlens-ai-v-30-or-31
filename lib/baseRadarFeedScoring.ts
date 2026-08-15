export type RadarFeedSimulationStatus = 'passed' | 'open_check' | string | null | undefined
export type RadarFeedRiskLabel = 'VERY LOW' | 'LOW' | 'MODERATE' | 'WATCHLIST' | 'STRONGER'

export interface RadarFeedScoreInput {
  baseScore: number
  liquidityUsd?: number | null
  volume24h?: number | null
  ageMinutes?: number | null
  simulationStatus?: RadarFeedSimulationStatus
  buyTax?: number | null
  sellTax?: number | null
  honeypotPresent?: boolean
  valuationVerified?: boolean
  valuationUsd?: number | null
  lpLockBurnConfirmed?: boolean
  lpModel?: string | null
  strongProtection?: boolean
  activeOwner?: boolean
  top10?: number | null
  top20?: number | null
  highHolderConcentration?: boolean
  majorControlOrHolderOrLpRedFlag?: boolean
  simulationReason?: string | null
  missingSocials?: boolean
  // HOLDER-EVIDENCE-CLARITY, DISCLOSED (reported: the drawer's top severity tier could be reached
  // even when holder evidence was only a minimum count ("100+", not exact) or top-holder
  // concentration was never resolved — both are real evidence gaps, not full verification. When
  // true, this caps the score below the top tier ('STRONGER', score>=75); optional and only ever
  // set by callers that have real holderEvidence (see lib/baseRadarHolderEvidence.ts) — omitting it
  // leaves scoring unchanged for existing callers.
  holderEvidenceUnverified?: boolean
}


function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)))
}

function saneValuation(input: RadarFeedScoreInput): boolean {
  return Boolean(input.valuationVerified) || (typeof input.valuationUsd === 'number' && Number.isFinite(input.valuationUsd) && input.valuationUsd >= 1_000 && input.valuationUsd <= 1_000_000_000)
}

export function getRadarFeedRiskLabel(score: number): RadarFeedRiskLabel {
  if (score >= 75) return 'STRONGER'
  if (score >= 60) return 'WATCHLIST'
  if (score >= 40) return 'MODERATE'
  if (score >= 25) return 'LOW'
  return 'VERY LOW'
}

export function getRadarFeedStatusFromScore(score: number): 'HOT' | 'WATCH' | 'EARLY' | 'UNVERIFIED' | 'RISKY' | 'DEAD' {
  if (score >= 75) return 'HOT'
  if (score >= 60) return 'WATCH'
  if (score >= 40) return 'UNVERIFIED'
  if (score >= 25) return 'RISKY'
  return 'DEAD'
}

export function applyBaseRadarScoreCaps(input: RadarFeedScoreInput): { score: number; cap: number | null; caps: string[]; riskLabel: RadarFeedRiskLabel } {
  const caps: Array<{ cap: number; reason: string }> = []
  const liquidity = input.liquidityUsd ?? null
  const missingTaxEvidence = !input.honeypotPresent || input.buyTax == null || input.sellTax == null
  const simulationUnconfirmed = input.simulationStatus !== 'passed' || missingTaxEvidence
  const youngTimeout = simulationUnconfirmed && input.ageMinutes != null && input.ageMinutes < 15
  const erc20LpNeedsProof = input.lpModel == null || input.lpModel === 'erc20_lp_token' || input.lpModel === 'open_check'
  const lpBurnMissing = erc20LpNeedsProof && !input.lpLockBurnConfirmed && !input.strongProtection

  // TOKEN-SAVER: only the two critical evidence categories we actually track
  // (LP/burn proof, simulation) should drive the hard fallback. One missing
  // category gets its own, less punishing cap so partial evidence still
  // produces a real score; the 49 floor only applies when BOTH are missing.
  const criticalMissingCount = (lpBurnMissing ? 1 : 0) + (simulationUnconfirmed ? 1 : 0)
  if (process.env.NODE_ENV !== 'production') {
    console.debug('[baseRadarFeedScoring] critical evidence check', {
      lpBurnMissing, simulationUnconfirmed, criticalMissingCount,
      missingFields: [lpBurnMissing ? 'lpLockBurnProof' : null, simulationUnconfirmed ? 'simulationStatus' : null].filter(Boolean),
    })
  }

  // CONTINUOUS-TIER FIX, DISCLOSED (reported: many different tokens all showing the identical
  // "RADAR STATUS 53"): liquidityTier/volumeTier used to be 3-flat-bucket step functions (0 /
  // $25K-$100K / $100K+), so ANY two tokens whose liquidity and volume both happened to land in the
  // same bucket — a $54K-liquidity/$752-volume token and a $54K-liquidity/$853-volume token, say —
  // got the exact same scaledCap and therefore the exact same final score, even though their real
  // metrics weren't identical. This was the same class of bug already fixed twice for the fully-flat
  // 49 and 64 caps, just one step more granular (3 buckets instead of 1) and still coarse enough to
  // collide constantly on the feed's typical microcap range. Replaced with a smooth linear ramp
  // across the same overall range each tier used before (liquidity 0 at ~$5K rising to 10 at
  // $150K; volume 0 at ~$500 rising to 5 at $150K) — same direction and rough scale, but now two
  // tokens only score identically when their real liquidity/volume genuinely are (near-)identical,
  // not just "in the same bucket."
  //
  // SATURATION-CEILING FIX, DISCLOSED (same bug class, reported again on Robinhood — see the sibling
  // fix in lib/baseRadarDisplayModel.ts's baseScore() for the full diagnosis): $150K was still low
  // enough that tokens with $100K-$8.9M liquidity all hit the same maxed-out tier, same as
  // baseScore's own bonuses did. Widened the ramp's upper bound (liquidity $150K -> $2M, volume
  // $150K -> $1M) so the cap itself keeps differentiating real tokens across a realistic range
  // instead of flattening everything above the old, too-low ceiling. Same 0-10/0-5 magnitude and
  // floor behavior below the new ceiling.
  const liquidityTier = liquidity != null ? Math.max(0, Math.min(10, ((liquidity - 5_000) / 1_995_000) * 10)) : 0
  const volumeTier = Math.max(0, Math.min(5, (((input.volume24h ?? 0) - 500) / 999_500) * 5))
  const scaledCapFor = (base: number, max: number) => Math.min(max, base + liquidityTier + volumeTier)

  if (criticalMissingCount >= 2) {
    // FLAT-CAP FIX, DISCLOSED (all-radar-scores-stuck-at-49 bug): this used to be a single flat
    // `cap: 49` for every token with both critical categories missing — but that's the near-
    // universal state for any pool under ~15-30 minutes old (simulation takes time to run, LP
    // lock/burn proof takes time to resolve), so almost every fresh token in the feed hit this
    // exact branch and, since their pre-cap penalizedScore was consistently well above 49 (see
    // baseScore's own header on why it tends to saturate high), landed on the literal same score:
    // 49, regardless of how different their real liquidity/volume actually were. Scaled the cap by
    // liquidity/volume tier instead — still meaningfully below the 64/74/79 tiers reserved for
    // better-evidenced tokens (this remains a real ceiling, not a way around the "both critical
    // categories missing" penalty), but restores differentiation between, say, a $200k-liquidity/
    // $600k-volume fresh pool and a $16k-liquidity/$5k-volume one, instead of collapsing both to
    // the same number.
    caps.push({ cap: scaledCapFor(44, 64), reason: 'LP/burn proof and simulation evidence are both missing.' })
  } else if (simulationUnconfirmed) {
    // FLAT-CAP FIX, DISCLOSED (all-radar-scores-stuck-at-64 bug, sibling of the fix above): this
    // branch was still a flat `cap: 74` — since the base radar feed never fetches LP lock/burn
    // enrichment (see enrichToken()'s own comment in app/terminal/base-radar/page.tsx), almost
    // every feed token that HAS a confirmed simulation still falls into the sibling
    // `lpBurnMissing` branch below, but tokens whose simulation itself is still pending land here
    // and were likewise flattened to one number. Scaled the same way, one tier up from the
    // dual-missing branch.
    caps.push({ cap: scaledCapFor(54, 74), reason: 'Simulation or tax evidence is not confirmed.' })
  } else if (lpBurnMissing) {
    // FLAT-CAP FIX, DISCLOSED (all-radar-scores-stuck-at-64 bug): reported directly — every card in
    // the live feed showed the identical "RADAR STATUS 64" regardless of wildly different liquidity
    // ($17K vs $447K) and volume. Root cause: LP lock/burn proof is never fetched at feed level
    // (only the on-demand drawer scan can resolve it), so `lpBurnMissing` is true for essentially
    // every feed token, and this was a flat `cap: 64` with no scaling at all — the single most
    // common branch in the whole scorer, collapsing nearly the entire feed to one score. Scaled by
    // the same liquidity/volume tiers as its sibling branches.
    caps.push({ cap: scaledCapFor(48, 64), reason: 'ERC20 LP lock/burn proof is missing.' })
  }
  if (youngTimeout) caps.push({ cap: 59, reason: 'New token with unresolved simulation.' })
  if (input.activeOwner && (input.highHolderConcentration || (input.top10 != null && input.top10 > 70) || (input.top20 != null && input.top20 > 90))) caps.push({ cap: 59, reason: 'Active owner/admin with high holder concentration.' })
  if (input.top10 != null && input.top10 > 70) caps.push({ cap: 59, reason: 'Top 10 holders exceed 70%.' })
  if (input.top20 != null && input.top20 > 90) caps.push({ cap: 49, reason: 'Top 20 holders exceed 90%.' })
  if (liquidity != null && liquidity < 5_000) caps.push({ cap: 39, reason: 'Liquidity below $5k.' })
  if (liquidity != null && liquidity < 500) caps.push({ cap: 24, reason: 'Liquidity below $500.' })

  const highScoreAllowed = input.simulationStatus === 'passed'
    && !missingTaxEvidence
    && saneValuation(input)
    && liquidity != null && liquidity >= 5_000
    && !input.majorControlOrHolderOrLpRedFlag
    && !(input.top10 != null && input.top10 > 70)
    && !(input.top20 != null && input.top20 > 90)
    && !lpBurnMissing

  if (!highScoreAllowed) caps.push({ cap: 79, reason: '80+ requires confirmed simulation, sane valuation, liquidity, and no major red flags.' })
  // Rule: minimum-count holder evidence or unresolved concentration must never reach the top severity
  // tier (score>=75, 'STRONGER') — cap just under it so WATCHLIST (score>=60) remains reachable.
  if (input.holderEvidenceUnverified) caps.push({ cap: 74, reason: 'Holder evidence is not fully verified — exact count or concentration is unresolved.' })

  let penalties = 0
  const reason = String(input.simulationReason ?? '')
  if (input.simulationStatus !== 'passed') {
    if (reason === 'timeout_after_retry') penalties += 12
    else if (reason === 'unsupported_pool_model') penalties += 8
    else penalties += 6
  }
  if (missingTaxEvidence) penalties += 10
  if (input.ageMinutes != null) {
    if (input.ageMinutes < 5) penalties += 10
    else if (input.ageMinutes < 15) penalties += 6
  }
  if (liquidity != null) {
    if (liquidity < 500) penalties += 30
    else if (liquidity < 5_000) penalties += 18
  }
  if (input.top10 != null && input.top10 > 70) penalties += 15
  if (input.top20 != null && input.top20 > 90) penalties += 18
  if (input.activeOwner) penalties += 10
  if (input.missingSocials) penalties += 4
  if (lpBurnMissing) penalties += 15

  const confidenceBoost = input.valuationVerified ? 3 : 0
  const cap = caps.length ? Math.min(...caps.map(c => c.cap)) : null
  const penalizedScore = input.baseScore - penalties + confidenceBoost
  const score = clampScore(cap == null ? penalizedScore : Math.min(penalizedScore, cap))
  const activeCapReasons = caps.filter(c => cap == null || c.cap === cap).map(c => c.reason)
  // TOKEN-SAVER: log why a cap won so a fallback score is traceable to its evidence gap
  // rather than looking like a stuck/hardcoded value.
  if (process.env.NODE_ENV !== 'production' && cap != null) {
    console.debug('[baseRadarFeedScoring] cap applied', { baseScore: input.baseScore, cap, score, reasons: activeCapReasons })
  }
  return { score, cap, caps: activeCapReasons, riskLabel: getRadarFeedRiskLabel(score) }
}
