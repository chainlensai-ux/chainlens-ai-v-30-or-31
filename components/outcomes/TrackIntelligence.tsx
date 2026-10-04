import { compareTrackReceipt, currentTrackSnapshot, mergeTrackEvents, originalTrackSnapshot, type TrackComparison } from '@/lib/trackIntelligence'
import type { TrackedOutcome } from '@/lib/tokenOutcomes'
import styles from './outcomes.module.css'

const value = (n: number | null, c: TrackComparison) => n == null ? 'Unavailable'
  : c.key === 'liquidityUsd' ? n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
  : c.key === 'top10Pct' ? `${n.toFixed(1)}%`
  : c.key === 'deployerActivity' ? `${n} verified transfers` : String(n)

export function TrackIntelligence({ row }: { row: TrackedOutcome }) {
  const snapshot = currentTrackSnapshot(row)
  const result = compareTrackReceipt(originalTrackSnapshot(row), snapshot)
  const timeline = mergeTrackEvents(row.market_observation_json?.trackIntelligence?.events ?? [], result.timelineEvents)
  return <>
    <section className={styles.trackSection} aria-label="Since scan">
      <h3>Since Scan</h3>
      <strong>{result.materialChangeCount ? `${result.materialChangeCount} important change${result.materialChangeCount === 1 ? '' : 's'}` : 'No material verified changes since scan'}</strong>
      {result.changes.length > 0 && <ul>{result.changes.map(e => <li key={e.id} data-tone={e.tone}>{e.description}</li>)}</ul>}
      <p className={styles.muted}>{snapshot.verifiedRug ? 'Verified post-scan trading restriction — see outcome evidence' : 'No verified rug event'}</p>
      <small className={styles.muted}>Only observed evidence is compared. Missing coverage does not prove inactivity or safety.</small>
    </section>
    <section className={styles.trackSection} aria-label="Scan vs Now">
      <h3>Scan vs Now</h3>
      <div className={styles.trackComparisons}>{result.comparisons.map(c => <div key={c.key}>
        <span className={styles.muted}>{c.label}</span>
        {c.compatible ? <strong>{value(c.original, c)} → {value(c.current, c)}</strong> : <>
          <strong>Current: {value(c.current, c)}</strong>
          {c.original != null && <small>Original: {value(c.original, c)}</small>}
        </>}
        {c.delta != null ? <small data-tone={c.delta === 0 ? 'neutral' : (c.key === 'liquidityUsd' ? c.delta < 0 : c.delta > 0) ? 'negative' : 'positive'}>
          {c.delta > 0 ? '+' : ''}{c.delta.toFixed(1)}{c.unit === 'pp' ? ' pp' : c.unit ?? ' points'}
        </small> : <small className={styles.muted}>{c.reason ?? 'Change unavailable'}</small>}
      </div>)}</div>
      {snapshot.scannerObservedAt && <p className={styles.muted}>Latest reused scanner evidence: {new Date(snapshot.scannerObservedAt).toLocaleString()}. Not rechecked by market ticks.</p>}
    </section>
    <section className={styles.trackSection} aria-label="What changed">
      <h3>What Changed</h3>
      <p className={styles.muted}>First observed threshold crossings, newest first. No events reconstructed between scans. Up to 99 changes retained.</p>
      <ol className={styles.trackTimeline}>{timeline.map(e => <li key={e.id} data-tone={e.tone}>
        <time dateTime={e.observedAt}>{new Date(e.observedAt).toLocaleString()}</time>
        <div>{e.description}<small className={styles.muted}>{e.source ?? 'Track evidence'} · {e.confidence} confidence{e.txHash ? ` · Tx ${e.txHash}` : ''}</small></div>
      </li>)}</ol>
    </section>
  </>
}
