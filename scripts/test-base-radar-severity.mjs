/**
 * Test for the Base Radar severe-risk severity helpers
 * (lib/baseRadarSeverity.ts).
 *
 * Re-implements the pure scoring/labeling logic in plain JS (mirroring
 * lib/baseRadarSeverity.ts) so it can run without a TS loader, and exercises
 * the Verity-style severe-risk scenario plus a healthier regression token.
 *
 * Run: node scripts/test-base-radar-severity.mjs
 */

let passed = 0
let failed = 0

function assert(label, condition, got) {
  if (condition) {
    console.log(`  ✅ ${label}`)
    passed++
  } else {
    console.error(`  ❌ FAIL: ${label} — got: ${JSON.stringify(got)}`)
    failed++
  }
}

// ─── Mirrors lib/baseRadarSeverity.ts ──────────────────────────────────────

function normalizePairCreatedAt(value) {
  if (!value) return null
  const raw = typeof value === "string" ? value.trim() : value
  if (typeof raw === "number" || (typeof raw === "string" && /^\d+$/.test(raw))) {
    const n = Number(raw)
    const ms = n > 10_000_000_000 ? n : n * 1000
    const d = new Date(ms)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  if (typeof raw === "string") {
    const d = new Date(raw)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  return null
}

function ageLabelFromIso(iso) {
  if (!iso) return null
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return null
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

function extractLpControllerSharePercent(evidence) {
  if (!Array.isArray(evidence)) return null
  for (const key of ['owner_lp_share', 'top_share', 'locker_share', 'burn_share']) {
    const line = evidence.find((item) => item.toLowerCase().startsWith(`${key}=`))
    if (line) {
      const value = Number(line.split('=').slice(1).join('=').replace('%', ''))
      if (Number.isFinite(value)) return Math.round(value * 100) / 100
    }
  }
  return null
}

function getScoreSeverityLabel(score) {
  if (score >= 75) return 'STRONG SIGNAL'
  if (score >= 60) return 'WATCHLIST'
  if (score >= 40) return 'CAUTION'
  if (score >= 25) return 'HIGH WATCH'
  return 'EXTREME WATCH'
}

function creatorTopHolderDisplay(inTopHolders, creatorPercent) {
  if (inTopHolders === true) {
    if (creatorPercent != null && Number.isFinite(creatorPercent) && creatorPercent > 0) {
      return `Detected · ${creatorPercent.toFixed(1)}%`
    }
    return 'Detected, supply share open check'
  }
  if (inTopHolders === false) return 'Not confirmed'
  return 'Open Check'
}

function assessBaseRadarSeverity(input) {
  const lpControllerSharePercent = extractLpControllerSharePercent(input.lpControlEvidence)
  const isWalletTeamControlled = input.lpControlStatus === 'team_controlled'
  const activeOwner = input.ownershipStatus === 'active_owner'
  const smallOrNewPool = input.poolAgeMinutes == null || input.poolAgeMinutes <= 1440

  const caps = [
    { flag: 'LP wallet/team controlled with no verified lock or burn proof', matched: isWalletTeamControlled && !input.lockBurnConfirmed, cap: 45 },
    { flag: 'LP controller share is at least 90% with lock/burn proof open', matched: lpControllerSharePercent != null && lpControllerSharePercent >= 90 && !input.lockBurnConfirmed, cap: 35 },
    { flag: 'LP controller share is at least 99% with lock/burn proof open', matched: lpControllerSharePercent != null && lpControllerSharePercent >= 99 && !input.lockBurnConfirmed, cap: 30 },
    { flag: 'Top holder controls at least 50% of supply', matched: input.top1 != null && input.top1 >= 50, cap: 40 },
    { flag: 'Top holder controls at least 90% of supply', matched: input.top1 != null && input.top1 >= 90, cap: 25 },
    { flag: 'Top 10 holders control at least 95% of supply', matched: input.top10 != null && input.top10 >= 95, cap: 30 },
    { flag: 'Holder count is under 25', matched: input.holderCount != null && input.holderCount < 25, cap: 35 },
    { flag: 'Active owner/admin alongside wallet/team LP control', matched: activeOwner && isWalletTeamControlled, cap: 35 },
    { flag: 'Missing socials on a small or very new pool', matched: !input.hasSocials && smallOrNewPool, cap: 45 },
  ]

  const severeFlags = caps.filter((c) => c.matched).map((c) => c.flag)
  const flagCount = severeFlags.length
  const candidateCaps = caps.filter((c) => c.matched).map((c) => c.cap)
  if (flagCount >= 3) candidateCaps.push(30)
  if (flagCount >= 5) candidateCaps.push(25)

  const cap = candidateCaps.length ? Math.min(...candidateCaps) : null
  const effectiveScore = cap != null ? Math.min(input.baseScore, cap) : input.baseScore
  const severityLabel = getScoreSeverityLabel(effectiveScore)

  const evidenceGaps = []
  if (!input.lockBurnConfirmed) {
    evidenceGaps.push('LP lock proof is not verified.')
    evidenceGaps.push('LP burn proof is not verified.')
  }
  if (isWalletTeamControlled && input.lpController) {
    evidenceGaps.push('A single wallet controls the dominant share of the LP position.')
  }
  if (input.marketCapUsd == null && input.fdvUsd != null) {
    evidenceGaps.push('Market cap is unavailable; valuation context is FDV-only.')
  }
  if (input.poolAgeMinutes == null) {
    evidenceGaps.push('Pool age is unavailable or not normalized from current evidence.')
  }
  if (!input.hasSocials) {
    evidenceGaps.push('Project socials are missing from current evidence.')
  }
  if (input.holderCount != null && input.holderCount < 25) {
    evidenceGaps.push(`Holder count is very low (${input.holderCount}).`)
  }
  if ((input.top10 != null && input.top10 >= 95) || (input.top1 != null && input.top1 >= 90)) {
    evidenceGaps.push('Holder concentration is extreme based on indexed top-holder evidence.')
  }
  if (activeOwner) {
    evidenceGaps.push('Contract ownership is active (not renounced).')
  }

  const watchNext = []
  if (flagCount > 0) {
    if (isWalletTeamControlled) watchNext.push('Watch LP movement from controlling wallet.')
    watchNext.push('Watch top-holder wallets for large transfers.')
    if (!input.lockBurnConfirmed) watchNext.push('Verify lock/burn proof before trusting liquidity stability.')
    watchNext.push('Rescan after liquidity or holder changes.')
  }

  let cortexSevereLine = null
  if (flagCount >= 3) {
    cortexSevereLine = 'Market evidence is available and simulation passed, but the control profile is severe: '
      + 'a single wallet controls the detected LP position, no verified lock/burn proof was found, '
      + 'holder count is very low, and indexed supply is extremely concentrated. '
      + 'Treat as extreme watch until lock/burn and holder movement evidence improves.'
  }

  return { cap, effectiveScore, severityLabel, severeFlags, flagCount, evidenceGaps, watchNext, cortexSevereLine }
}

// ─── Section A: Verity-style severe-risk token ─────────────────────────────

console.log('Section A: Verity-style severe-risk token')

const verityInput = {
  baseScore: 70,
  lpControlStatus: 'team_controlled',
  lpController: '0x1111111111111111111111111111111111111111',
  lockBurnConfirmed: false,
  lpControlEvidence: ['top_holder=0x1111111111111111111111111111111111111111', 'owner_lp_share=100.00%'],
  top1: 96.9,
  top10: 99.99,
  holderCount: 8,
  ownershipStatus: 'active_owner',
  hasSocials: false,
  poolAgeMinutes: null,
  marketCapUsd: null,
  fdvUsd: 120_000,
}

const verity = assessBaseRadarSeverity(verityInput)

assert('score is capped to <= 30', verity.effectiveScore <= 30, verity.effectiveScore)
assert('score is in the ideal 20-25 range', verity.effectiveScore >= 20 && verity.effectiveScore <= 25, verity.effectiveScore)
assert('severity label is a severe label (EXTREME WATCH or HIGH WATCH)', verity.severityLabel === 'EXTREME WATCH' || verity.severityLabel === 'HIGH WATCH', verity.severityLabel)
assert('evidence gaps are not empty', verity.evidenceGaps.length > 0, verity.evidenceGaps)
assert('gaps mention LP lock proof', verity.evidenceGaps.some((g) => /lock proof/i.test(g)), verity.evidenceGaps)
assert('gaps mention LP burn proof', verity.evidenceGaps.some((g) => /burn proof/i.test(g)), verity.evidenceGaps)
assert('gaps mention dominant LP controller', verity.evidenceGaps.some((g) => /single wallet controls the dominant share of the LP/i.test(g)), verity.evidenceGaps)
assert('gaps mention FDV-only market cap', verity.evidenceGaps.some((g) => /FDV-only/i.test(g)), verity.evidenceGaps)
assert('gaps mention missing socials', verity.evidenceGaps.some((g) => /socials are missing/i.test(g)), verity.evidenceGaps)
assert('gaps mention very low holders', verity.evidenceGaps.some((g) => /very low \(8\)/i.test(g)), verity.evidenceGaps)
assert('gaps mention extreme concentration', verity.evidenceGaps.some((g) => /concentration is extreme/i.test(g)), verity.evidenceGaps)
assert('gaps mention active ownership', verity.evidenceGaps.some((g) => /ownership is active/i.test(g)), verity.evidenceGaps)
assert('watch next includes LP movement watch', verity.watchNext.some((w) => /watch lp movement from controlling wallet/i.test(w)), verity.watchNext)
assert('watch next includes top-holder watch', verity.watchNext.some((w) => /watch top-holder wallets/i.test(w)), verity.watchNext)
assert('watch next includes lock/burn verification', verity.watchNext.some((w) => /verify lock\/burn proof/i.test(w)), verity.watchNext)
assert('watch next includes rescan', verity.watchNext.some((w) => /rescan after liquidity/i.test(w)), verity.watchNext)
assert('cortex severe line is present for 3+ flags', typeof verity.cortexSevereLine === 'string' && verity.cortexSevereLine.includes('extreme watch'), verity.cortexSevereLine)
assert('5+ severe flags detected', verity.flagCount >= 5, verity.flagCount)

// numeric pairCreatedAt normalization
const numericPairCreatedAt = '1781350683000'
const normalized = normalizePairCreatedAt(numericPairCreatedAt)
assert('numeric pairCreatedAt normalizes to a valid ISO date', normalized !== null && !Number.isNaN(new Date(normalized).getTime()), normalized)
assert('age label is derived from normalized pairCreatedAt', ageLabelFromIso(normalized) !== null, ageLabelFromIso(normalized))

// creator display — never "Yes · 0.0%"
const creatorNotInTopHolders = creatorTopHolderDisplay(false, null)
const creatorDetectedNoShare = creatorTopHolderDisplay(true, null)
const creatorDetectedZeroShare = creatorTopHolderDisplay(true, 0)
assert('creatorInTopHolders=false -> "Not confirmed"', creatorNotInTopHolders === 'Not confirmed', creatorNotInTopHolders)
assert('creatorInTopHolders=true, percent null -> "Detected, supply share open check"', creatorDetectedNoShare === 'Detected, supply share open check', creatorDetectedNoShare)
assert('creatorInTopHolders=true, percent 0 -> "Detected, supply share open check"', creatorDetectedZeroShare === 'Detected, supply share open check', creatorDetectedZeroShare)
assert('creator display never renders "Yes · 0.0%"', ![creatorNotInTopHolders, creatorDetectedNoShare, creatorDetectedZeroShare].some((s) => s === 'Yes · 0.0%'), { creatorNotInTopHolders, creatorDetectedNoShare, creatorDetectedZeroShare })

// ─── Section B: Healthy token regression (no caps applied) ────────────────

console.log('\nSection B: Healthy token regression')

const healthyInput = {
  baseScore: 72,
  lpControlStatus: 'burned',
  lpController: null,
  lockBurnConfirmed: true,
  lpControlEvidence: ['burn_share=100.00%'],
  top1: 12,
  top10: 35,
  holderCount: 480,
  ownershipStatus: 'renounced',
  hasSocials: true,
  poolAgeMinutes: 240,
  marketCapUsd: 1_500_000,
  fdvUsd: 1_600_000,
}

const healthy = assessBaseRadarSeverity(healthyInput)

assert('no severe-risk cap applied', healthy.cap === null, healthy.cap)
assert('effective score equals base score', healthy.effectiveScore === healthyInput.baseScore, healthy.effectiveScore)
assert('severity label reflects healthy score (WATCHLIST)', healthy.severityLabel === 'WATCHLIST', healthy.severityLabel)
assert('no severe flags detected', healthy.flagCount === 0, healthy.flagCount)
assert('no cortex severe line for healthy token', healthy.cortexSevereLine === null, healthy.cortexSevereLine)

const healthyCreator = creatorTopHolderDisplay(true, 1.4)
assert('healthy creator display shows precise percent', healthyCreator === 'Detected · 1.4%', healthyCreator)

// ─── Summary ────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
