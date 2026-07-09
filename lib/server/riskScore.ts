// Deterministic product-level Token Risk Score (0-100).
// Pure function: reads already-derived evidence fields from the token scanner
// response and produces a score + breakdown. Higher score = lower risk.
// No I/O, no randomness, no time-based branching — same input always
// produces the same output.

export type RiskLabel = 'extreme' | 'high' | 'moderate' | 'low' | 'very_low'

export interface RiskScoreSectionResult {
  score: number
  max: number
  components: Record<string, number>
  reasons: string[]
}

export interface RiskScoreResult {
  riskScore: number
  riskLabel: RiskLabel
  riskBreakdown: {
    marketMaturity: RiskScoreSectionResult
    liquiditySafety: RiskScoreSectionResult
    contractSafety: RiskScoreSectionResult
    behavioralRisk: RiskScoreSectionResult
    total: number
  }
}

export interface RiskScoreInput {
  marketCapUsd?: number | null
  fdvUsd?: number | null
  displayMarketValue?: number | null
  displayMarketValueLabel?: string | null
  displayMarketValueConfidence?: string | null
  valuationContext?: {
    primaryValuationUsd?: number | null
    primaryValuationLabel?: string | null
    primaryValuationStatus?: string | null
    marketCapStatus?: string | null
  } | null

  liquidityUsd?: number | null

  holderDistribution?: {
    top1?: number | null
    top5?: number | null
    top10?: number | null
  } | null

  lpControl?: {
    status?: string | null
    displayLpModel?: string | null
    lockStatus?: string | null
    burnStatus?: string | null
    proofStatus?: string | null
    lpController?: string | null
    lpControllerType?: string | null
  } | null
  lpLockStatus?: string | null
  lpProofApplicability?: string | null
  lpProofStatus?: string | null
  lpModelProof?: {
    model?: string | null
    standardLockApplies?: boolean | null
  } | null
  lpMigrationProof?: {
    status?: string | null
  } | null

  contractFlags?: {
    mint?: { status?: string | null } | null
    blacklist?: { status?: string | null } | null
    pause?: { status?: string | null } | null
  } | null
  honeypot?: {
    buyTax?: number | null
    sellTax?: number | null
    transferTax?: number | null
    // CONFIRMED-HONEYPOT WIRING FIX, DISCLOSED (token-scanner audit): this field did not exist here
    // at all before — only buyTax/sellTax/transferTax were read, so a confirmed can't-sell honeypot
    // (lib/server/honeypotSecurity.ts's own `honeypot: boolean` verdict) with low/no displayed tax
    // contributed ZERO penalty to the risk score's "critical flags" section. See scoreContractSafety
    // and calculateTokenRiskScore below for how this is now used.
    isHoneypot?: boolean | null
  } | null
  sourceVerified?: boolean | null

  deployerProfile?: {
    status?: string | null
    clusterRisk?: string | null
  } | null

  sniperActivity?: {
    status?: string | null
  } | null
  holderIntelligence?: {
    earlyBuyerConcentration?: string | null
  } | null

  supplyControl?: {
    clusterInfluence?: {
      clusterRiskScore?: number | null
      clusterRiskLabel?: string | null
    } | null
  } | null
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

// ------------------------------
// SECTION 1 — MARKET MATURITY (0-30)
// ------------------------------
function scoreMarketMaturity(input: RiskScoreInput): RiskScoreSectionResult {
  const reasons: string[] = []
  const components: Record<string, number> = {}

  // --- Market cap (0-10) ---
  let marketCapValue: number | null = null
  let usedFdvFallback = false

  if (
    input.displayMarketValue != null &&
    input.displayMarketValueLabel === 'Market Cap'
  ) {
    marketCapValue = input.displayMarketValue
  } else if (input.marketCapUsd != null) {
    marketCapValue = input.marketCapUsd
  } else if (
    input.valuationContext?.primaryValuationUsd != null &&
    (input.valuationContext.primaryValuationLabel === 'Market Cap' ||
      input.valuationContext.primaryValuationStatus === 'verified_mc' ||
      input.valuationContext.marketCapStatus === 'verified')
  ) {
    marketCapValue = input.valuationContext.primaryValuationUsd
  } else if (input.fdvUsd != null) {
    marketCapValue = input.fdvUsd
    usedFdvFallback = true
  } else if (
    input.displayMarketValue != null &&
    input.displayMarketValueLabel === 'FDV'
  ) {
    marketCapValue = input.displayMarketValue
    usedFdvFallback = true
  }

  let marketCapScore: number
  if (marketCapValue == null) {
    marketCapScore = 0
    reasons.push('market_cap_unavailable')
  } else {
    if (marketCapValue < 1_000_000) marketCapScore = 0
    else if (marketCapValue < 10_000_000) marketCapScore = 3
    else if (marketCapValue < 100_000_000) marketCapScore = 6
    else if (marketCapValue < 500_000_000) marketCapScore = 8
    else marketCapScore = 10

    if (usedFdvFallback) {
      reasons.push('market_cap_derived_from_fdv_low_confidence')
    }
  }
  components.marketCap = marketCapScore

  // --- Liquidity depth (0-10) ---
  const liquidityUsd = input.liquidityUsd ?? null
  let liquidityScore: number
  if (liquidityUsd == null) {
    liquidityScore = 0
    reasons.push('liquidity_depth_unavailable')
  } else if (liquidityUsd < 50_000) liquidityScore = 0
  else if (liquidityUsd < 200_000) liquidityScore = 3
  else if (liquidityUsd < 1_000_000) liquidityScore = 6
  else if (liquidityUsd < 5_000_000) liquidityScore = 8
  else liquidityScore = 10
  components.liquidityDepth = liquidityScore

  // --- Holder distribution (0-10) ---
  const top1 = input.holderDistribution?.top1 ?? null
  const top5 = input.holderDistribution?.top5 ?? null
  const top10 = input.holderDistribution?.top10 ?? null

  // MISSING-DATA CONSISTENCY FIX, DISCLOSED (token-scanner audit): previously scored 3/10 (a
  // middling default) when holder distribution is unavailable — inconsistent with every other
  // "unknown" case in this file (e.g. liquidityScore just above scores 0, not a partial-credit
  // average, when liquidityUsd is null). Missing holder data isn't evidence of moderate safety; it's
  // an absence of evidence, so this now scores 0 like the rest of the file's unknown-data handling.
  let holderScore: number
  if (top1 == null && top5 == null && top10 == null) {
    holderScore = 0
    reasons.push('holder_distribution_unavailable')
  } else if (top1 != null && top1 > 50) {
    holderScore = 0
    reasons.push('top_holder_owns_over_50_percent')
  } else if (top5 != null && top5 > 70) {
    holderScore = 2
    reasons.push('top5_holders_own_over_70_percent')
  } else if (top10 != null && top10 > 80) {
    holderScore = 4
    reasons.push('top10_holders_own_over_80_percent')
  } else if (top10 != null && top10 < 40) {
    holderScore = 10
    reasons.push('top10_holders_under_40_percent')
  } else if (top10 != null && top10 < 60) {
    holderScore = 7
    reasons.push('top10_holders_under_60_percent')
  } else {
    holderScore = 5
    reasons.push('moderate_holder_concentration')
  }
  components.holderDistribution = holderScore

  const score = clamp(marketCapScore + liquidityScore + holderScore, 0, 30)
  return { score, max: 30, components, reasons }
}

// ------------------------------
// SECTION 2 — LIQUIDITY SAFETY (0-30)
// ------------------------------
function scoreLiquiditySafety(input: RiskScoreInput): RiskScoreSectionResult {
  const reasons: string[] = []
  const components: Record<string, number> = {}

  const lpControl = input.lpControl ?? null
  const status = lpControl?.status ?? null
  const lockStatus = lpControl?.lockStatus ?? input.lpLockStatus ?? null
  const burnStatus = lpControl?.burnStatus ?? null
  const proofStatus = lpControl?.proofStatus ?? input.lpProofStatus ?? null
  const controllerType = lpControl?.lpControllerType ?? null
  const controller = lpControl?.lpController ?? null

  const burnConfirmed =
    status === 'burned' || burnStatus === 'burned' || input.lpLockStatus === 'burned'
  const lockConfirmed = lockStatus === 'locked' || input.lpLockStatus === 'locked'
  const teamControlled = status === 'team_controlled' || controllerType === 'wallet'
  const displayLpModel = lpControl?.displayLpModel ?? null
  const lpModel = input.lpModelProof?.model ?? null
  const standardLockApplies = input.lpModelProof?.standardLockApplies ?? null
  const protocolOrConcentrated =
    status === 'protocol' ||
    status === 'concentrated_liquidity' ||
    displayLpModel === 'concentrated_liquidity' ||
    lpModel === 'concentrated' ||
    standardLockApplies === false
  const controllerUnknown =
    controllerType == null || controllerType === 'unknown' || controller == null

  // --- LP Lock or Burn (0-15) ---
  let lockBurnScore: number
  if (burnConfirmed) {
    lockBurnScore = 15
    reasons.push('lp_burn_confirmed')
  } else if (lockConfirmed) {
    // Lock confirmed but duration evidence is not available in current scanner
    // output — treat as the longer-duration tier rather than penalize a
    // confirmed lock as if it were unproven.
    lockBurnScore = 12
    reasons.push('lp_lock_confirmed')
  } else if (teamControlled) {
    lockBurnScore = 0
    reasons.push('lp_controlled_by_wallet_no_lock_or_burn_proof')
  } else if (protocolOrConcentrated) {
    // V3/V4/protocol-position pools do not expose a standard ERC-20 LP controller
    // to lock or burn. Keep the same conservative score as an unproven controller,
    // but report the model accurately instead of implying a failed V2-style proof.
    lockBurnScore = 0
    reasons.push('lp_position_verification_required')
    reasons.push('standard_lp_lock_not_applicable')
  } else if (controllerUnknown) {
    // An unresolved/unknown LP controller is an open risk, not a safety signal — it
    // must not score better than a confirmed wallet-controlled LP with no lock/burn
    // proof (lockBurnScore 0 above).
    lockBurnScore = 0
    reasons.push('lp_controller_unknown_no_lock_or_burn_proof')
  } else if (proofStatus === 'open_check' || proofStatus === 'missing' || proofStatus === 'partial') {
    lockBurnScore = 5
    reasons.push('lp_lock_burn_proof_incomplete')
  } else {
    lockBurnScore = 5
    reasons.push('lp_lock_burn_status_low_confidence_default')
  }
  components.lpLockOrBurn = lockBurnScore

  // --- LP model applicability (0-5) ---
  let lpModelScore: number
  if (displayLpModel === 'erc20_lp_token') {
    lpModelScore = 5
    reasons.push('lp_model_erc20_lp_token')
  } else if (
    displayLpModel === 'concentrated_liquidity' ||
    status === 'concentrated_liquidity' ||
    lpModel === 'concentrated'
  ) {
    lpModelScore = 3
    reasons.push('lp_model_concentrated_liquidity')
  } else if (status === 'protocol' || displayLpModel === 'protocol_or_gauge') {
    lpModelScore = 3
    reasons.push('lp_model_protocol_pool')
  } else {
    lpModelScore = 2
    reasons.push('lp_model_unknown_or_unclassified')
  }
  components.lpModelApplicability = lpModelScore

  // --- LP controller risk (0-10) ---
  let controllerScore: number
  if (
    burnConfirmed ||
    lockConfirmed ||
    controllerType === 'burn' ||
    controllerType === 'lockContract'
  ) {
    controllerScore = 10
    reasons.push('lp_controller_burn_or_lock_confirmed')
  } else if (teamControlled) {
    controllerScore = 0
    reasons.push('lp_controller_team_wallet_no_lock')
  } else if (controllerType === 'contract') {
    controllerScore = 5
    reasons.push('lp_controller_contract_lock_burn_unproven')
  } else if (protocolOrConcentrated) {
    controllerScore = 6
    reasons.push('lp_controller_standard_lock_not_applicable')
  } else {
    // controllerUnknown (or any other unresolved state): an unresolved controller
    // is not a safer state than a confirmed wallet-controlled LP (controllerScore 0
    // above) — never award more safety points just because the controller is unknown.
    controllerScore = 0
    reasons.push('lp_controller_unknown')
  }
  components.lpControllerRisk = controllerScore

  const score = clamp(lockBurnScore + lpModelScore + controllerScore, 0, 30)
  return { score, max: 30, components, reasons }
}

// ------------------------------
// SECTION 3 — CONTRACT SAFETY (0-20)
// ------------------------------
function scoreContractSafety(input: RiskScoreInput): RiskScoreSectionResult {
  const reasons: string[] = []
  const components: Record<string, number> = {}

  // --- Verified source code (0-5) ---
  let sourceScore: number
  if (input.sourceVerified === true) {
    sourceScore = 5
    reasons.push('source_code_verified')
  } else {
    sourceScore = 0
    reasons.push('source_verification_unavailable')
  }
  components.verifiedSource = sourceScore

  // --- Critical flags (0-10) ---
  let criticalScore = 10
  const flagDetected = (status?: string | null) => status === 'verified' || status === 'possible'

  if (flagDetected(input.contractFlags?.mint?.status)) {
    criticalScore -= 5
    reasons.push('mint_function_detected')
  }
  if (flagDetected(input.contractFlags?.blacklist?.status)) {
    criticalScore -= 5
    reasons.push('blacklist_function_detected')
  }
  if (flagDetected(input.contractFlags?.pause?.status)) {
    criticalScore -= 5
    reasons.push('trading_pause_detected')
  }
  const buyTax = input.honeypot?.buyTax ?? null
  const sellTax = input.honeypot?.sellTax ?? null
  const transferTax = input.honeypot?.transferTax ?? null
  if (
    (buyTax != null && buyTax > 10) ||
    (sellTax != null && sellTax > 10) ||
    (transferTax != null && transferTax > 10)
  ) {
    criticalScore -= 5
    reasons.push('transfer_tax_above_10_percent')
  }
  // CONFIRMED-HONEYPOT FIX, DISCLOSED (token-scanner audit): a confirmed can't-sell verdict is the
  // single most severe finding this scanner can produce — zeroes this section outright rather than
  // the flat -5 used for the other flags, since a confirmed honeypot makes every other positive
  // signal (market cap, liquidity depth, deployer reputation) irrelevant to whether the holder can
  // ever sell at all. See calculateTokenRiskScore below for the additional hard cap this also
  // triggers on the overall label, so this can't be diluted back up by unrelated section scores.
  if (input.honeypot?.isHoneypot === true) {
    criticalScore = 0
    reasons.push('confirmed_honeypot')
  }
  criticalScore = clamp(criticalScore, 0, 10)
  components.criticalFlags = criticalScore

  // --- Deployer reputation (0-5) ---
  let deployerScore: number
  if (input.deployerProfile?.status === 'verified') {
    deployerScore = 5
    reasons.push('deployer_confirmed')
  } else {
    deployerScore = 0
    reasons.push('deployer_unknown_or_unconfirmed')
  }
  components.deployerReputation = deployerScore

  const score = clamp(sourceScore + criticalScore + deployerScore, 0, 20)
  return { score, max: 20, components, reasons }
}

// ------------------------------
// SECTION 4 — BEHAVIORAL RISK (0-20)
// ------------------------------
function scoreBehavioralRisk(input: RiskScoreInput): RiskScoreSectionResult {
  const reasons: string[] = []
  const components: Record<string, number> = {}

  // --- Early buyer concentration (0-10) ---
  const sniperStatus = input.sniperActivity?.status ?? null
  const earlyBuyerConcentration = input.holderIntelligence?.earlyBuyerConcentration ?? null

  let sniperScore: number
  if (sniperStatus === 'high' || earlyBuyerConcentration === 'high') {
    sniperScore = 0
    reasons.push('high_early_buyer_concentration')
  } else if (
    sniperStatus == null &&
    (earlyBuyerConcentration == null || earlyBuyerConcentration === 'inferred')
  ) {
    sniperScore = 5
    reasons.push('early_buyer_evidence_missing')
  } else if (sniperStatus === 'low_signal' || earlyBuyerConcentration === 'low') {
    sniperScore = 10
    reasons.push('organic_early_buyer_pattern')
  } else {
    sniperScore = 5
    reasons.push('moderate_early_buyer_signal')
  }
  components.earlyBuyerConcentration = sniperScore

  // --- Dev wallet behavior (0-5) ---
  const clusterRisk = input.deployerProfile?.clusterRisk ?? null
  let devWalletScore: number
  if (clusterRisk === 'flagged') {
    devWalletScore = 0
    reasons.push('dev_wallet_flagged_dumping_or_suspicious')
  } else if (clusterRisk === 'clean') {
    devWalletScore = 5
    reasons.push('dev_wallet_no_confirmed_dumping')
  } else {
    devWalletScore = 3
    reasons.push('dev_wallet_evidence_missing')
  }
  components.devWalletBehavior = devWalletScore

  // --- Cluster risk (0-5) ---
  const clusterRiskLabel = input.supplyControl?.clusterInfluence?.clusterRiskLabel ?? null
  let clusterScore: number
  if (clusterRiskLabel === 'critical' || clusterRiskLabel === 'high') {
    clusterScore = 0
    reasons.push('confirmed_high_risk_cluster')
  } else if (clusterRiskLabel === 'low') {
    clusterScore = 5
    reasons.push('no_significant_cluster_links')
  } else {
    clusterScore = 3
    reasons.push('cluster_evidence_missing_or_partial')
  }
  components.clusterRisk = clusterScore

  const score = clamp(sniperScore + devWalletScore + clusterScore, 0, 20)
  return { score, max: 20, components, reasons }
}

function riskLabelFromScore(score: number): RiskLabel {
  if (score <= 20) return 'extreme'
  if (score <= 40) return 'high'
  if (score <= 60) return 'moderate'
  if (score <= 80) return 'low'
  return 'very_low'
}

// HARD-CAP FIX, DISCLOSED (token-scanner audit): previously the additive total let a confirmed
// critical flag (mint/blacklist/pause/honeypot) get diluted by unrelated positive signals elsewhere
// — e.g. a token with a confirmed mint function could still land in "moderate"/"low" risk if
// liquidity depth and holder distribution looked fine, because that flag only ever cost 5-10 of the
// 100 total points. A single confirmed critical flag is a real "can rug/drain/trap holders" signal
// that no amount of liquidity depth or market cap should be able to outweigh, so this forces the
// worst possible label when any of the following hold, regardless of the additive total:
//   - a confirmed honeypot (can't sell at all), or
//   - all three of mint + blacklist + pause are flagged together (contractSafety's own
//     criticalScore already reached 0 — this checks the specific all-three case explicitly rather
//     than inferring it from criticalScore alone, since criticalScore can also reach 0 purely from
//     the transfer-tax check, which is real but not in the same severity class).
function hasHardCriticalFlag(input: RiskScoreInput): boolean {
  if (input.honeypot?.isHoneypot === true) return true
  const flagDetected = (status?: string | null) => status === 'verified' || status === 'possible'
  return (
    flagDetected(input.contractFlags?.mint?.status) &&
    flagDetected(input.contractFlags?.blacklist?.status) &&
    flagDetected(input.contractFlags?.pause?.status)
  )
}

export function calculateTokenRiskScore(input: RiskScoreInput): RiskScoreResult {
  const marketMaturity = scoreMarketMaturity(input)
  const liquiditySafety = scoreLiquiditySafety(input)
  const contractSafety = scoreContractSafety(input)
  const behavioralRisk = scoreBehavioralRisk(input)

  const total = clamp(
    marketMaturity.score + liquiditySafety.score + contractSafety.score + behavioralRisk.score,
    0,
    100,
  )
  const hardCapped = hasHardCriticalFlag(input)
  const riskScore = hardCapped ? Math.min(Math.round(total), 15) : Math.round(total)

  return {
    riskScore,
    riskLabel: hardCapped ? 'extreme' : riskLabelFromScore(riskScore),
    riskBreakdown: {
      marketMaturity,
      liquiditySafety,
      contractSafety,
      behavioralRisk,
      total: riskScore,
    },
  }
}
