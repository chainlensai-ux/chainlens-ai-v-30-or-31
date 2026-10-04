import { compareTrackReceipt, currentTrackSnapshot, mergeTrackEvents, originalTrackSnapshot, type TrackComparison } from '@/lib/trackIntelligence'
import type { TrackedOutcome } from '@/lib/tokenOutcomes'
import styles from './outcomes.module.css'

const value = (n: number | null, c: TrackComparison) => n == null ? '—'
  : c.key === 'liquidityUsd' ? n.toLocaleString('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 })
  : c.key === 'top10Pct' ? `${n.toFixed(1)}%` : String(n)
const deltaTone = (c: TrackComparison) => c.delta == null || c.delta === 0 ? 'neutral'
  : (c.key === 'liquidityUsd' ? c.delta < 0 : c.delta > 0) ? 'negative' : 'positive'
const statusCopy = (c: TrackComparison) => {
  if (c.current == null) return ['Current unavailable']
  if (c.reason === 'Direct comparison unavailable — methodology changed') return ['Delta unavailable', 'Methodology changed']
  if (c.original == null) return ['Delta unavailable', 'Original evidence unavailable']
  if (c.reason === 'Change unavailable — liquidity measurements not comparable') return ['Delta unavailable', 'Different or unrecorded liquidity basis']
  if (c.reason === 'Change unavailable — holder denominator not comparable') return ['Delta unavailable', 'Different or unrecorded holder basis']
  if (c.reason === 'Change unavailable — methodology not recorded') return ['Delta unavailable', 'Methodology not recorded']
  return [c.reason ?? 'Delta unavailable']
}
const timestamp = (at: string) => new Date(at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })

export function TrackIntelligence({ row }: { row: TrackedOutcome }) {
  const snapshot = currentTrackSnapshot(row)
  const result = compareTrackReceipt(originalTrackSnapshot(row), snapshot)
  const timeline = mergeTrackEvents(row.market_observation_json?.trackIntelligence?.events ?? [], result.timelineEvents)
  return <div className={styles.trackDashboard}>
    <section className={styles.trackSummary} aria-label="Since scan">
      <div className={styles.trackSummaryHead}><h3>Since Scan</h3>
        <strong className={styles.trackSummaryStatus}>{result.materialChangeCount ? `${result.materialChangeCount} important change${result.materialChangeCount === 1 ? '' : 's'}` : 'No material changes'}</strong>
      </div>
      {result.changes.length > 0 && <ul className={styles.trackChanges}>{result.changes.map(e => <li key={e.id} data-tone={e.tone}>
        <span aria-hidden="true">{e.delta == null ? '•' : e.delta < 0 ? '↓' : '↑'}</span>{e.description}
      </li>)}</ul>}
      <p className={styles.trackRiskNote}>{snapshot.verifiedRug ? 'Verified post-scan trading restriction — see outcome evidence' : 'No verified rug event observed'}</p>
      <footer className={styles.trackFootnote}>Only observed evidence is compared. Missing coverage does not prove inactivity or safety.</footer>
    </section>
    <section className={styles.trackSection} aria-label="Scan vs Now">
      <h3>Scan vs Now</h3>
      <div className={styles.trackComparisons}>{result.comparisons.map(c => <div className={styles.trackMetric} key={c.key} data-tone={deltaTone(c)}>
        <span className={styles.trackMetricLabel}>{c.key === 'top10Pct' ? 'Top 10' : c.label}</span>
        {c.key === 'deployerActivity' ? <>
          <strong className={styles.trackActivity}>{c.current == null || c.current === 0 ? 'No verified dev activity' : `${c.current} verified transfer${c.current === 1 ? '' : 's'}`}</strong>
          <small className={styles.trackMetricStatus}>Coverage incomplete</small>
        </> : <>
          <div className={styles.trackValues}>
            <span className={styles.trackOriginal} title={c.original == null ? 'Original unavailable' : `Original: ${c.original}`} aria-label={`Original: ${c.original == null ? 'unavailable' : value(c.original, c)}`}>{value(c.original, c)}</span>
            {c.compatible ? <span className={styles.trackArrow} aria-label="compared with">→</span> : <span className={styles.trackSeparator} aria-hidden="true" />}
            <strong title={c.current == null ? 'Current unavailable' : `Current: ${c.current}`} aria-label={`Current: ${c.current == null ? 'unavailable' : value(c.current, c)}`}>{value(c.current, c)}</strong>
          </div>
          {c.delta != null ? <small className={styles.trackDelta}>
            {c.delta > 0 ? '+' : ''}{c.delta.toFixed(1)}{c.unit === 'pp' ? ' pp' : c.unit ?? ' points'}
          </small> : <small className={styles.trackMetricStatus}>{statusCopy(c).map(line => <span key={line}>{line}</span>)}</small>}
        </>}
      </div>)}</div>
      <p className={styles.trackFootnote}>Scan value · latest value. Arrows appear only for comparable evidence.</p>
      {snapshot.scannerObservedAt && <p className={styles.trackFootnote}>Scanner evidence: {timestamp(snapshot.scannerObservedAt)}. Not rechecked by market ticks.</p>}
    </section>
    <section className={styles.trackSection} aria-label="What changed">
      <h3>What Changed</h3>
      {!timeline.some(e => e.type !== 'scan_created') && <p className={styles.trackEmpty}>No material post-scan events yet</p>}
      <ol className={styles.trackTimeline}>{timeline.map(e => <li key={e.id} data-tone={e.tone}>
        <span className={styles.trackEventDot} aria-hidden="true" />
        <time dateTime={e.observedAt}>{timestamp(e.observedAt)}</time>
        <div className={styles.trackEventTitle}>{e.description}</div>
        <small className={styles.trackEventSource}>{e.source ?? 'Track evidence'} · {e.confidence} confidence</small>
        {e.txHash && <details className={styles.trackTransaction}><summary>Transaction evidence</summary><span>{e.txHash}</span></details>}
      </li>)}</ol>
      <footer className={styles.trackFootnote}>First observed crossings · newest first · up to 99 changes. No events reconstructed between scans.</footer>
    </section>
  </div>
}
