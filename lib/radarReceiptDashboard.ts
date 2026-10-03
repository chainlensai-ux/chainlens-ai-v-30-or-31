// lib/radarReceiptDashboard.ts — the visual CORTEX receipt's view-model (Base Radar + Robinhood Radar).
//
// Pure presentation over evidence ProjectOverviewDrawer ALREADY computes (LP proof, simulation, socials,
// ownership, holder concentration, linked-wallet cluster, evidence gaps). It never invents a value and
// never upgrades a gap: anything not positively evidenced is 'unknown' or 'unavailable', never
// 'confirmed'. Tested in tests/radar-receipt-dashboard.test.ts.

export type ReceiptStatus = 'confirmed' | 'warning' | 'unavailable' | 'unknown' | 'loading'
export type ReceiptTone = 'mint' | 'amber' | 'risk' | 'neutral'

export type ReceiptCheck = { id: string; label: string; value: string; status: ReceiptStatus; chip: string | null }
export type ReceiptFinding = { id: string; title: string; status: ReceiptStatus; summary: string; metric: string | null }
export type ReceiptAction = { id: 'scanner' | 'verify_lp' | 'watch_holders' | 'watchlist' | 'explorer'; title: string; caption: string; emphasis: boolean }

export type ReceiptDashboardInput = {
  enrichmentLoading: boolean
  score: number
  verdictLabel: string
  verdictTone: 'mint' | 'amber' | 'risk'
  evidenceQualityLabel: string
  evidenceQualityTone: 'mint' | 'amber' | 'risk'
  openCheckCount: number
  riskFactCount: number
  mainConcern: string
  positiveSignal: string | null
  liquidityUsdLabel: string | null
  lp: {
    applicability: string | null
    lockStatus: string | null
    proofStatus: string | null
    burnProofLabel: string | null
    controlStatus: string | null
    secondaryTeamControlled: boolean
  }
  simulation: { status: string | null; reason: string | null; isHoneypot: boolean | null; buyTax: number | null; sellTax: number | null }
  socials: { status: string | null; linkCount: number }
  ownership: { status: string | null }
  deployerKnown: boolean
  holders: { concentrationStatus: string | null; concentrationRisk: string; top10Pct: number | null }
  cluster: { confirmed: boolean | null; linkedWallets: number | null; supplyPct: number | null }
}

export type ReceiptDashboard = {
  heroChips: Array<{ label: string; status: ReceiptStatus }>
  summary: {
    score: { value: number; label: string; tone: ReceiptTone }
    confidence: { label: string; tone: ReceiptTone; confirmed: number; warning: number; unresolved: number }
    openChecks: { count: number; riskFacts: number }
    mainConcern: { text: string; tone: ReceiptTone }
  }
  findings: ReceiptFinding[]
  checks: ReceiptCheck[]
  actions: ReceiptAction[]
}

const pct = (v: number | null) => (v == null || !Number.isFinite(v) ? null : `${v >= 10 ? v.toFixed(0) : v.toFixed(1)}%`)
const RANK: Record<ReceiptStatus, number> = { warning: 4, unknown: 2, unavailable: 2, loading: 1, confirmed: 0 }
function worst(...statuses: ReceiptStatus[]): ReceiptStatus {
  return statuses.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'confirmed' as ReceiptStatus)
}
const SIM_UNSUPPORTED = new Set(['unsupported_pool_model', 'provider_unavailable'])

export function buildReceiptDashboard(i: ReceiptDashboardInput): ReceiptDashboard {
  const L = i.enrichmentLoading
  // ── Open-checks matrix: one row per fact, never a sentence ────────────────────────────────────
  const notApplicable = i.lp.applicability === 'not_applicable'
  const lockVerified = i.lp.lockStatus === 'locked' || i.lp.lockStatus === 'burned'
  const lockMissing = i.lp.lockStatus === 'unlocked' || i.lp.lockStatus === 'unverified' || i.lp.proofStatus === 'missing' || i.lp.proofStatus === 'partial'
  const lock: ReceiptCheck = L ? { id: 'lp_lock', label: 'LP lock', value: 'Checking', status: 'loading', chip: null }
    : notApplicable ? { id: 'lp_lock', label: 'LP lock', value: 'Not applicable', status: 'unavailable', chip: null }
      : lockVerified ? { id: 'lp_lock', label: 'LP lock', value: i.lp.lockStatus === 'burned' ? 'Burned' : 'Locked', status: 'confirmed', chip: null }
        : lockMissing ? { id: 'lp_lock', label: 'LP lock', value: 'Unverified', status: 'warning', chip: 'LP lock unverified' }
          : { id: 'lp_lock', label: 'LP lock', value: 'Unknown', status: 'unknown', chip: null }

  const burnLabel = (i.lp.burnProofLabel ?? '').trim()
  const burnConfirmed = i.lp.lockStatus === 'burned' || /^burn(ed)?\b|burn proof (confirmed|verified)/i.test(burnLabel)
  const burn: ReceiptCheck = L ? { id: 'lp_burn', label: 'LP burn', value: 'Checking', status: 'loading', chip: null }
    : notApplicable ? { id: 'lp_burn', label: 'LP burn', value: 'Not applicable', status: 'unavailable', chip: null }
      : burnConfirmed ? { id: 'lp_burn', label: 'LP burn', value: 'Burned', status: 'confirmed', chip: null }
        : lockVerified ? { id: 'lp_burn', label: 'LP burn', value: 'Not required (locked)', status: 'confirmed', chip: null }
          : lockMissing ? { id: 'lp_burn', label: 'LP burn', value: 'Unverified', status: 'warning', chip: null }
            : { id: 'lp_burn', label: 'LP burn', value: 'Unknown', status: 'unknown', chip: null }

  const control: ReceiptCheck = L ? { id: 'lp_control', label: 'LP control', value: 'Checking', status: 'loading', chip: null }
    : i.lp.secondaryTeamControlled || i.lp.controlStatus === 'team_controlled'
      ? { id: 'lp_control', label: 'LP control', value: 'Wallet-controlled', status: 'warning', chip: 'Wallet-controlled LP' }
      : i.lp.controlStatus === 'burned' || i.lp.controlStatus === 'locked'
        ? { id: 'lp_control', label: 'LP control', value: i.lp.controlStatus === 'burned' ? 'Burned' : 'Locked', status: 'confirmed', chip: null }
        // Pool-managed (V3/V4) liquidity is not proof of safety — a position owner can still withdraw.
        : i.lp.controlStatus === 'protocol' || i.lp.controlStatus === 'concentrated_liquidity'
          ? { id: 'lp_control', label: 'LP control', value: 'Pool-managed', status: 'unavailable', chip: null }
          : { id: 'lp_control', label: 'LP control', value: 'Unknown', status: 'unknown', chip: null }

  const simStatus = i.simulation.status
  const sim: ReceiptCheck = simStatus === 'passed'
    ? { id: 'simulation', label: 'Buy/sell simulation', value: 'Passed', status: 'confirmed', chip: null }
    : i.simulation.reason && SIM_UNSUPPORTED.has(i.simulation.reason)
      ? { id: 'simulation', label: 'Buy/sell simulation', value: 'Unsupported', status: 'unavailable', chip: 'Simulation unsupported' }
      : { id: 'simulation', label: 'Buy/sell simulation', value: 'Pending', status: 'unknown', chip: 'Simulation pending' }

  const taxKnown = simStatus === 'passed' && i.simulation.buyTax != null && i.simulation.sellTax != null
  const highTax = taxKnown && ((i.simulation.buyTax ?? 0) > 10 || (i.simulation.sellTax ?? 0) > 10)
  const honeypot: ReceiptCheck = i.simulation.isHoneypot === true
    ? { id: 'honeypot', label: 'Honeypot / tax', value: 'Honeypot detected', status: 'warning', chip: 'Honeypot detected' }
    : taxKnown && i.simulation.isHoneypot === false
      ? { id: 'honeypot', label: 'Honeypot / tax', value: `B ${i.simulation.buyTax!.toFixed(1)}% · S ${i.simulation.sellTax!.toFixed(1)}%`, status: highTax ? 'warning' : 'confirmed', chip: highTax ? 'High tax' : null }
      : { id: 'honeypot', label: 'Honeypot / tax', value: 'Unknown', status: 'unknown', chip: null }

  const socials: ReceiptCheck = L ? { id: 'socials', label: 'Social links', value: 'Checking', status: 'loading', chip: null }
    : i.socials.linkCount > 0 ? { id: 'socials', label: 'Social links', value: `${i.socials.linkCount} found`, status: 'confirmed', chip: null }
      : i.socials.status === 'checked_not_found' || i.socials.status === 'risk_fact'
        ? { id: 'socials', label: 'Social links', value: 'Missing', status: 'warning', chip: 'No socials' }
        : { id: 'socials', label: 'Social links', value: 'Unknown', status: 'unknown', chip: null }

  const ownership: ReceiptCheck = L ? { id: 'ownership', label: 'Owner / admin', value: 'Checking', status: 'loading', chip: null }
    : i.ownership.status === 'renounced' ? { id: 'ownership', label: 'Owner / admin', value: 'Renounced', status: 'confirmed', chip: null }
      : i.ownership.status === 'active_owner' ? { id: 'ownership', label: 'Owner / admin', value: 'Active owner', status: 'warning', chip: 'Active owner' }
        : { id: 'ownership', label: 'Owner / admin', value: 'Unknown', status: 'unknown', chip: null }

  const deployer: ReceiptCheck = L ? { id: 'deployer', label: 'Deployer', value: 'Checking', status: 'loading', chip: null }
    : i.deployerKnown ? { id: 'deployer', label: 'Deployer', value: 'Identified', status: 'confirmed', chip: null }
      : { id: 'deployer', label: 'Deployer', value: 'Unknown', status: 'unknown', chip: null }

  const concentrationHigh = i.holders.concentrationRisk === 'High' || i.holders.concentrationRisk === 'Extreme'
  const top10 = pct(i.holders.top10Pct)
  const holders: ReceiptCheck = L ? { id: 'holders', label: 'Holder concentration', value: 'Checking', status: 'loading', chip: null }
    : i.holders.concentrationStatus === 'unavailable' || top10 == null
      ? { id: 'holders', label: 'Holder concentration', value: 'Unavailable', status: 'unavailable', chip: null }
      : { id: 'holders', label: 'Holder concentration', value: `Top 10 · ${top10}`, status: concentrationHigh ? 'warning' : 'confirmed', chip: concentrationHigh ? `Top 10 hold ${top10}` : null }

  // A missing cluster link is "none confirmed in current evidence", not proof of absence → unknown.
  const linked = i.cluster.linkedWallets && i.cluster.linkedWallets > 0 ? i.cluster.linkedWallets : null
  const cluster: ReceiptCheck = L ? { id: 'cluster', label: 'Linked wallets', value: 'Checking', status: 'loading', chip: null }
    : i.cluster.confirmed
      ? { id: 'cluster', label: 'Linked wallets', value: linked ? `${linked} linked${pct(i.cluster.supplyPct) ? ` · ${pct(i.cluster.supplyPct)}` : ''}` : 'Cluster confirmed', status: 'warning', chip: linked ? `${linked} linked wallet${linked === 1 ? '' : 's'}` : 'Wallet cluster' }
      : { id: 'cluster', label: 'Linked wallets', value: 'None confirmed', status: 'unknown', chip: null }

  const checks = [lock, burn, control, sim, honeypot, socials, ownership, deployer, holders, cluster]

  // ── Hero chips: warnings first, then the most important open gaps; max 5, no duplicates ──────
  const chipped = checks.filter(c => c.chip)
  const heroChips: ReceiptDashboard['heroChips'] = [
    ...chipped.filter(c => c.status === 'warning'),
    ...chipped.filter(c => c.status !== 'warning'),
  ].map(c => ({ label: c.chip!, status: c.status }))
  if (i.positiveSignal) heroChips.push({ label: i.positiveSignal, status: 'confirmed' })
  const seen = new Set<string>()
  const dedupedChips = heroChips.filter(c => (seen.has(c.label) ? false : (seen.add(c.label), true))).slice(0, 5)

  // ── Findings: grouped, one line each ─────────────────────────────────────────────────────────
  const findings: ReceiptFinding[] = [
    {
      id: 'control', title: 'Holder & wallet control',
      status: worst(cluster.status, holders.status, ownership.status),
      summary: cluster.status === 'warning' ? `Linked-wallet cluster confirmed${pct(i.cluster.supplyPct) ? ` holding ${pct(i.cluster.supplyPct)}` : ''}.`
        : holders.status === 'warning' ? `Top 10 holders control ${top10} of supply.`
          : ownership.status === 'warning' ? 'An active owner/admin can still change the contract.'
            : L ? 'Checking holders, owner and linked wallets…'
              : holders.status === 'confirmed' ? `Top 10 hold ${top10}; no linked-wallet cluster confirmed.`
                : 'Holder and wallet-control evidence is incomplete.',
      metric: cluster.status === 'warning' ? cluster.value : holders.status !== 'loading' && holders.status !== 'unavailable' ? holders.value : null,
    },
    {
      id: 'liquidity', title: 'Liquidity safety',
      status: worst(lock.status, burn.status, control.status),
      summary: notApplicable ? 'Concentrated pool — standard LP lock/burn proof does not apply.'
        : control.status === 'warning' ? 'A wallet controls LP and no lock/burn proof was verified.'
          : lockVerified ? `LP is ${lock.value.toLowerCase()}.`
            : lock.status === 'warning' ? 'No verified lock or burn proof for the main pool.'
              : L ? 'Checking LP lock, burn and control…' : 'LP protection could not be determined.',
      metric: i.liquidityUsdLabel ? `${i.liquidityUsdLabel} liquidity` : null,
    },
    {
      id: 'trading', title: 'Trading safety',
      status: worst(sim.status, honeypot.status),
      summary: honeypot.status === 'warning' ? (i.simulation.isHoneypot ? 'Simulation flagged this token as a honeypot.' : 'Buy/sell tax is above 10%.')
        : sim.status === 'confirmed' ? 'Buy/sell simulation passed.'
          : sim.status === 'unavailable' ? 'Simulation is not supported for this pool yet.'
            : 'Buy/sell and tax simulation still pending.',
      metric: honeypot.status === 'confirmed' || honeypot.status === 'warning' ? honeypot.value : null,
    },
    {
      id: 'metadata', title: 'Project & metadata',
      status: worst(socials.status, deployer.status),
      summary: socials.status === 'warning' ? 'No website or social links in token metadata.'
        : socials.status === 'confirmed' ? `${i.socials.linkCount} public link${i.socials.linkCount === 1 ? '' : 's'} found${deployer.status === 'confirmed' ? '; deployer identified' : ''}.`
          : L ? 'Checking socials and deployer…' : 'Social and deployer evidence is incomplete.',
      metric: null,
    },
  ]

  // ── Actions: only what the evidence calls for, plus the always-available deep check ──────────
  const actions: ReceiptAction[] = []
  if (lock.status === 'warning' || control.status === 'warning') actions.push({ id: 'verify_lp', title: 'Verify lock / burn proof', caption: 'Deep LP check in Token Scanner', emphasis: true })
  if (holders.status === 'warning' || cluster.status === 'warning') actions.push({ id: 'watch_holders', title: 'Watch top-holder wallets', caption: 'Large transfers move this first', emphasis: actions.length === 0 })
  actions.push({ id: 'scanner', title: 'Open Token Scanner', caption: 'Full contract, LP and holder scan', emphasis: actions.length === 0 })
  actions.push({ id: 'watchlist', title: 'Add to Watchlist', caption: 'Keep this token on your radar', emphasis: false })

  const counted = checks.filter(c => c.status !== 'loading')
  const toneOf = (t: 'mint' | 'amber' | 'risk'): ReceiptTone => t
  return {
    heroChips: dedupedChips,
    summary: {
      score: { value: Math.max(0, Math.min(100, Math.round(i.score))), label: i.verdictLabel, tone: toneOf(i.verdictTone) },
      confidence: {
        label: i.evidenceQualityLabel, tone: toneOf(i.evidenceQualityTone),
        confirmed: counted.filter(c => c.status === 'confirmed').length,
        warning: counted.filter(c => c.status === 'warning').length,
        unresolved: counted.filter(c => c.status === 'unknown' || c.status === 'unavailable').length,
      },
      openChecks: { count: i.openCheckCount, riskFacts: i.riskFactCount },
      mainConcern: { text: i.mainConcern, tone: i.riskFactCount > 0 || checks.some(c => c.status === 'warning') ? 'risk' : 'amber' },
    },
    findings,
    checks,
    actions,
  }
}
