import { OUTCOME_POLICY, comparableOutcomeBaselinePrice, frozenBaselineMarketCapUsd, numberOrNull, type TrackedOutcome } from './tokenOutcomes'

export type TrackTransfer = {
  txHash: string; walletAddress: string; observedAt: string; source: string
  relationship: 'deployer' | 'verified_linked_wallet'; verified: true
  /** Explicit supply percentage only; never derived from transfer count or holder movements. */
  supplyPct?: number
}
export type TrackSnapshot = {
  observedAt: string
  priceUsd: number | null; marketCapUsd: number | null; liquidityUsd: number | null
  top10Pct: number | null; riskScore: number | null
  /** Exact measurement identity: e.g. pool:<chain>:<address>:usd-reserves. Missing is not compatible. */
  liquidityBasis?: string | null; holderBasis?: string | null; riskMethodologyVersion?: string | null
  deployerActivity: TrackTransfer[] | null
  source?: string; outcome?: string; verifiedRug?: boolean
  scannerObservedAt?: string
}
export type TrackEventType = 'scan_created' | 'price_change' | 'market_cap_change' | 'liquidity_change' | 'holder_concentration_change' | 'deployer_transfer' | 'outcome_change'
export type TrackEvent = {
  id: string; type: TrackEventType; observedAt: string; originalValue?: number | string
  currentValue?: number | string; delta?: number; unit?: '%' | 'pp'
  confidence: 'medium' | 'high'; evidenceStatus: 'verified'; txHash?: string
  walletAddress?: string; source?: string; description: string
  tone: 'positive' | 'negative' | 'caution' | 'neutral'; critical: boolean
}
export type TrackOriginal = TrackSnapshot & { id: string }
export type TrackComparison = {
  key: 'riskScore' | 'liquidityUsd' | 'top10Pct' | 'deployerActivity'
  label: string; original: number | null; current: number | null
  delta: number | null; unit?: '%' | 'pp'; compatible: boolean; reason?: string
}
export type TrackIntelligenceState = { version: 1; snapshot: TrackSnapshot; events: TrackEvent[] }
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const percent = (before: number | null, after: number | null) => {
  const delta = before != null && before > 0 && after != null ? (after - before) / before * 100 : null
  return delta != null && Number.isFinite(delta) ? delta : null
}
const same = (a?: string | null, b?: string | null) => !!a && a === b
const validTime = (s: string) => Number.isFinite(Date.parse(s))
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' ? v as Record<string, unknown> : {}
const text = (v: unknown) => typeof v === 'string' && v.length > 0 ? v : null
const boundedPct = (v: unknown) => finite(v) != null && Number(v) <= 100 ? Number(v) : null

/** Pure comparison: no clock, providers, mutation, or inferred rug/deployer proof. */
export function compareTrackReceipt(original: TrackOriginal, current: TrackSnapshot) {
  const events: TrackEvent[] = []
  const afterScan = validTime(current.observedAt) && Date.parse(current.observedAt) > Date.parse(original.observedAt)
  const comparisons: TrackComparison[] = [
    { key: 'riskScore', label: 'Risk Score', original: finite(original.riskScore), current: afterScan ? finite(current.riskScore) : null,
      delta: null, compatible: same(original.riskMethodologyVersion, current.riskMethodologyVersion),
      reason: original.riskMethodologyVersion && current.riskMethodologyVersion && original.riskMethodologyVersion !== current.riskMethodologyVersion
        ? 'Direct comparison unavailable — methodology changed' : 'Change unavailable — methodology not recorded' },
    { key: 'liquidityUsd', label: 'Liquidity', original: finite(original.liquidityUsd), current: afterScan ? finite(current.liquidityUsd) : null,
      delta: null, unit: '%', compatible: same(original.liquidityBasis, current.liquidityBasis), reason: 'Change unavailable — liquidity measurements not comparable' },
    { key: 'top10Pct', label: 'Top 10 Holders', original: boundedPct(original.top10Pct), current: afterScan ? boundedPct(current.top10Pct) : null,
      delta: null, unit: 'pp', compatible: same(original.holderBasis, current.holderBasis), reason: 'Change unavailable — holder denominator not comparable' },
    { key: 'deployerActivity', label: 'Dev Wallet', original: null, current: null, delta: null, compatible: false,
      reason: 'Activity coverage unavailable; no inactivity inferred' },
  ]
  for (const c of comparisons) {
    c.compatible = c.compatible && c.original != null && c.current != null
    if (c.compatible) {
      c.delta = c.unit === '%' ? percent(c.original, c.current) : c.current! - c.original!
      c.reason = undefined
    } else if (c.current == null && c.key !== 'deployerActivity') c.reason = 'Current evidence unavailable'
  }
  const add = (type: TrackEventType, state: string, detail: Omit<TrackEvent, 'id' | 'type' | 'observedAt' | 'confidence' | 'evidenceStatus' | 'source'>, at = current.observedAt, source = current.source) => {
    events.push({ id: `${original.id}:${type}:${state}`, type, observedAt: at, confidence: 'medium', evidenceStatus: 'verified', source, ...detail })
  }
  if (validTime(original.observedAt)) add('scan_created', 'original', { description: 'Original scan created', tone: 'neutral', critical: false }, original.observedAt, 'Frozen scan receipt')
  if (afterScan) {
    for (const [type, label, before, now] of [
      ['price_change', 'Price', original.priceUsd, current.priceUsd],
      ['market_cap_change', 'Market cap', original.marketCapUsd, current.marketCapUsd],
    ] as const) {
      const delta = percent(finite(before), finite(now))
      // Existing ±50% outcome window; market cap remains informational, never a risk conclusion.
      if (delta != null && (delta >= OUTCOME_POLICY.pumpedPct || delta <= OUTCOME_POLICY.dumpedPct)) {
        const step = Math.trunc(delta / OUTCOME_POLICY.pumpedPct)
        add(type, String(step), { originalValue: before!, currentValue: now!, delta, unit: '%',
          description: `${label} ${delta < 0 ? 'decreased' : 'increased'} ${Math.abs(delta).toFixed(1)}% since scan`, tone: 'neutral', critical: false })
      }
    }
    for (const c of comparisons) {
      const threshold = c.key === 'liquidityUsd' ? 10 : c.key === 'top10Pct' ? 3 : Infinity
      if (c.delta == null || Math.abs(c.delta) < threshold) continue
      const negative = c.key === 'liquidityUsd' ? c.delta < 0 : c.delta > 0
      add(c.key === 'liquidityUsd' ? 'liquidity_change' : 'holder_concentration_change', String(Math.trunc(c.delta / threshold)), {
        originalValue: c.original!, currentValue: c.current!, delta: c.delta, unit: c.unit,
        description: `${c.label} ${c.delta < 0 ? 'decreased' : 'increased'} ${Math.abs(c.delta).toFixed(1)}${c.unit === 'pp' ? ' pp' : '%'} since scan`,
        tone: negative ? 'negative' : 'positive', critical: false,
      }, c.key === 'top10Pct' ? current.scannerObservedAt ?? current.observedAt : current.observedAt)
    }
    const transfers = (current.deployerActivity ?? []).filter(t => t.verified === true &&
      ['deployer', 'verified_linked_wallet'].includes(t.relationship) && !!t.txHash && !!t.walletAddress && !!t.source &&
      validTime(t.observedAt) && Date.parse(t.observedAt) > Date.parse(original.observedAt) && Date.parse(t.observedAt) <= Date.parse(current.observedAt))
    const unique = [...new Map(transfers.map(t => [`${t.txHash}:${t.walletAddress}`, t])).values()]
    comparisons[3].current = current.deployerActivity == null ? null : unique.length
    for (const t of unique) add('deployer_transfer', `${t.txHash}:${t.walletAddress}`, {
      description: `Verified dev wallet transfer${boundedPct(t.supplyPct) != null ? ` · ${t.supplyPct}% of supply` : ''}`,
      txHash: t.txHash, walletAddress: t.walletAddress, tone: 'caution', critical: false,
    }, t.observedAt, t.source)
    if (current.outcome && current.outcome !== 'unavailable' && current.outcome !== original.outcome &&
      (current.outcome !== 'rugged' || current.verifiedRug === true)) {
      add('outcome_change', current.outcome, { originalValue: original.outcome, currentValue: current.outcome,
        description: `Outcome observed: ${current.outcome}`, tone: current.outcome === 'rugged' ? 'negative' : 'neutral', critical: current.outcome === 'rugged' })
    }
  }
  const changes = events.filter(e => !['scan_created', 'outcome_change', 'market_cap_change'].includes(e.type))
  return { changes, comparisons, timelineEvents: events, materialChangeCount: changes.length, criticalChangeCount: events.filter(e => e.critical).length }
}

/** First observation of each threshold band/transaction wins. No refresh timestamps in IDs. */
export function mergeTrackEvents(previous: readonly TrackEvent[], incoming: readonly TrackEvent[]): TrackEvent[] {
  const unique = new Map<string, TrackEvent>()
  for (const event of [...previous, ...incoming]) if (!unique.has(event.id)) unique.set(event.id, event)
  const sorted = [...unique.values()].sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt) || a.id.localeCompare(b.id))
  const scan = sorted.find(e => e.type === 'scan_created')
  return [...sorted.filter(e => e.type !== 'scan_created').slice(0, 99), ...(scan ? [scan] : [])]
}

export function originalTrackSnapshot(row: TrackedOutcome): TrackOriginal {
  const s = row.baseline_snapshot_json
  const meta = s.trackComparison
  return {
    id: row.id, observedAt: s.scannedAt, priceUsd: comparableOutcomeBaselinePrice(row),
    marketCapUsd: frozenBaselineMarketCapUsd(row), liquidityUsd: numberOrNull(row.baseline_liquidity_usd),
    top10Pct: boundedPct(object(s.baselineHolderSignals).top10), riskScore: row.baseline_risk_semantics === 'legacy_unverified' ? null : numberOrNull(s.baselineRiskScore),
    liquidityBasis: meta?.liquidityBasis, holderBasis: meta?.holderBasis, riskMethodologyVersion: meta?.riskMethodologyVersion,
    deployerActivity: null, outcome: 'watching',
  }
}

/** Adapt already accepted Track observations. Never promote frozen holder/dev signals to live evidence. */
export function currentTrackSnapshot(row: TrackedOutcome): TrackSnapshot {
  const p = row.market_observation_json
  const saved = p?.trackIntelligence?.snapshot
  const scannerFresh = saved?.scannerObservedAt && row.last_checked_at &&
    Date.parse(row.last_checked_at) - Date.parse(saved.scannerObservedAt) >= 0 &&
    Date.parse(row.last_checked_at) - Date.parse(saved.scannerObservedAt) <= OUTCOME_POLICY.staleMs
  return {
    observedAt: row.last_checked_at ?? '', priceUsd: numberOrNull(row.current_price_usd), marketCapUsd: numberOrNull(row.current_market_cap_usd ?? p?.marketCapUsd),
    liquidityUsd: numberOrNull(row.current_liquidity_usd), source: row.market_source ?? undefined,
    liquidityBasis: p?.selectedPoolAddress && ['dexscreener', 'geckoterminal'].includes(p.provider)
      ? `pool:${row.chain}:${row.chain === 'solana' ? p.selectedPoolAddress : p.selectedPoolAddress.toLowerCase()}:usd-reserves` : null,
    top10Pct: scannerFresh ? saved?.top10Pct ?? null : null, holderBasis: saved?.holderBasis,
    riskScore: scannerFresh ? saved?.riskScore ?? null : null, riskMethodologyVersion: saved?.riskMethodologyVersion,
    scannerObservedAt: saved?.scannerObservedAt, deployerActivity: saved?.deployerActivity ?? null,
    outcome: row.outcome_status, verifiedRug: row.after_evidence_json?.verifiedTradingBlocked === true,
  }
}

/** Reuse the already-read server scanner cache on manual/stale refresh, without fetching a new scan. */
export function enrichTrackSnapshot(row: TrackedOutcome, snapshot: TrackSnapshot, scan: Record<string, unknown> | null, now: number): TrackSnapshot {
  if (!scan || scan.chain !== row.chain || typeof scan.contract !== 'string' ||
    (row.chain === 'solana' ? scan.contract !== row.token_address : scan.contract.toLowerCase() !== row.token_address.toLowerCase()) ||
    typeof scan.scanRequestStartedAt !== 'number' || !Number.isFinite(scan.scanRequestStartedAt) || scan.scanRequestStartedAt <= Date.parse(row.baseline_snapshot_json.scannedAt) ||
    scan.scanRequestStartedAt > now || now - scan.scanRequestStartedAt > OUTCOME_POLICY.staleMs) return snapshot
  const holder = object(scan.holderDistribution)
  const dev = object(scan.devIntel)
  // This scanner field is populated from an explicit fromAddress=deployer token transfer query.
  // Only a confirmed creator with creation transaction proof qualifies; aggregated amounts are NOT
  // the amount of the linked wallet's first transaction, so deliberately omit supplyPct.
  const direct: TrackTransfer[] = dev.deployerStatus === 'confirmed' && text(dev.creationTxHash) && text(dev.deployerAddress) && Array.isArray(dev.linkedWallets)
    ? dev.linkedWallets.flatMap(raw => {
      const w = object(raw)
      return w.reason === 'token_supply_transfer' && text(w.txHash) && text(w.firstSeen)
        ? [{ txHash: String(w.txHash), walletAddress: String(dev.deployerAddress), observedAt: String(w.firstSeen),
          source: 'Token Scanner · direct deployer token transfer', relationship: 'deployer' as const, verified: true as const }]
        : []
    }) : []
  return { ...snapshot, scannerObservedAt: new Date(scan.scanRequestStartedAt).toISOString(),
    top10Pct: boundedPct(holder.top10), holderBasis: text(holder.denominator),
    riskScore: scan.riskScoreType === 'risk_score' && scan.riskScoreDirection === 'higher_is_riskier' ? boundedPct(scan.riskScore) : null,
    riskMethodologyVersion: text(scan.riskMethodologyVersion),
    deployerActivity: direct.length ? [...(snapshot.deployerActivity ?? []), ...direct].slice(-100) : snapshot.deployerActivity,
    // Ordinary holder transfers and graph edges do not establish deployer activity.
  }
}
