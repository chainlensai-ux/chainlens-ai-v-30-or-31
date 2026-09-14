'use client'
import { useEffect, useRef } from 'react'
import { hypothetical, shareOutcome, type TrackedOutcome } from '@/lib/tokenOutcomes'
import styles from './outcomes.module.css'

const pct = (n: number | null) => n == null ? 'Unavailable' : `${n > 0 ? '+' : ''}${n.toFixed(1)}%`
const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
const date = (value: string | null) => value ? new Date(value).toLocaleString() : 'Not checked yet'
const label = (value: string) => value.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ')

/** Structured nested evidence, not new AI prose. No evidence value is recomputed. */
function Evidence({ value }: { value: unknown }) {
  if (value == null) return <p className={styles.muted}>Not recorded in this scan.</p>
  if (typeof value !== 'object') return <span>{typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value)}</span>
  if (Array.isArray(value)) return value.length ? <ul className={styles.evidenceList}>{value.map((v, i) => <li key={i}><Evidence value={v} /></li>)}</ul> : <p className={styles.muted}>No entries recorded.</p>
  return <dl className={styles.evidenceFields}>{Object.entries(value).map(([key, v]) => <div key={key}><dt>{label(key)}</dt><dd><Evidence value={v} /></dd></div>)}</dl>
}
export function OutcomeCard({ row, onOpen }: { row: TrackedOutcome; onOpen: () => void }) {
  const snapshot = row.baseline_snapshot_json
  return <button className={styles.card} onClick={onOpen} aria-label={`Open outcome receipt for ${snapshot.tokenSymbol || snapshot.tokenName}`}>
    <div className={styles.spread}><span className={styles.chain}>{row.chain}</span><span className={styles.status} data-status={row.outcome_status}>{row.outcome_status}</span></div>
    <h2>{snapshot.tokenSymbol || snapshot.tokenName || 'Token outcome'}</h2>
    <p className={styles.muted}>{snapshot.tokenName}</p>
    <p className={styles.address} title={row.token_address}>{row.token_address}</p>
    <div className={styles.metrics}><div><span>Original risk</span><strong>{row.baseline_risk_score}<small>/100</small></strong><p>{row.baseline_verdict}</p></div><div><span>Since scan</span><strong className={styles.change} data-negative={(row.price_change_pct ?? 0) < 0}>{pct(row.price_change_pct)}</strong><p>{row.outcome_confidence} confidence</p></div></div>
    <footer><span>Tracked {date(row.tracked_at)}</span><span className={styles.accent}>View receipt ↗</span></footer>
  </button>
}
export function OutcomeReceipt({ row, onClose, loadingEvidence = false, evidenceError = '' }: { row: TrackedOutcome; onClose: () => void; loadingEvidence?: boolean; evidenceError?: string }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { const el = dialog.current; el?.showModal(); return () => { el?.close() } }, [])
  const snapshot = row.baseline_snapshot_json
  const h = hypothetical(row.baseline_price_usd, row.current_price_usd)
  const groups = [
    ['LP / liquidity', snapshot.baselineLpSignals], ['Ownership / contract control', snapshot.baselineOwnershipSignals],
    ['Holder concentration', snapshot.baselineHolderSignals], ['Dev / deployer', snapshot.baselineDevSignals],
    ['Security / honeypot / taxes', snapshot.baselineSecuritySignals], ['Market quality', snapshot.baselineMarketQualitySignals],
  ] as const
  return <dialog ref={dialog} className={styles.dialog} onCancel={onClose} onClose={onClose} onClick={e => { if (e.target === e.currentTarget) onClose() }} aria-labelledby="outcome-receipt-title">
    <div className={styles.receipt}>
      <div className={styles.spread}><span className={styles.eyebrow}>ChainLens · Outcome receipt</span><button autoFocus className={styles.close} onClick={onClose} aria-label="Close receipt">×</button></div>
      <h2 id="outcome-receipt-title">{snapshot.tokenSymbol || snapshot.tokenName || 'Token'} <span className={styles.chain}>{row.chain}</span></h2>
      <p className={styles.address}>{row.token_address}</p>
      <p>ChainLens scanned this token at <strong>{snapshot.baselineRiskScore}/100 · {snapshot.baselineVerdict}</strong></p>
      <p className={styles.muted}>Scanned {date(snapshot.scannedAt)} · Tracked {date(row.tracked_at)}</p>
      <div className={styles.receiptHero}><span>Since scan</span><strong className={styles.change} data-negative={(row.price_change_pct ?? 0) < 0}>{pct(row.price_change_pct)}</strong><span className={styles.status} data-status={row.outcome_status}>{row.outcome_status} · {row.outcome_confidence} confidence</span></div>
      <div className={styles.math}><p>If you had bought $1,000 at the scan price…</p><strong>{h ? `${money(h.value)} remaining` : 'Hypothetical value unavailable'}</strong><div className={styles.spread}><span>Hypothetical PnL</span><b>{h ? money(h.pnl) : 'Unavailable'}</b></div><div className={styles.spread}><span>Potential loss avoided</span><b>{h ? money(h.potentialLossAvoided) : 'Unavailable'}</b></div><small>Illustration only. Not an actual purchase or saving. Excludes fees, slippage and ability to sell.</small></div>
      {loadingEvidence ? <p role="status">Loading frozen evidence…</p> : evidenceError ? <p role="alert">{evidenceError} Close and reopen this receipt to retry.</p> : <details className={styles.why}><summary>Why? See the frozen scan evidence</summary><h3>What ChainLens saw at scan time</h3>
        <details><summary>Original risk reasons</summary><Evidence value={snapshot.baselineRiskReasons} /></details>
        {groups.map(([name, evidence]) => <details key={name}><summary>{name}</summary><Evidence value={evidence} /></details>)}
      </details>}
      <section className={styles.after}><h3>What happened afterward</h3><ul>{row.outcome_reasons_json.map((reason, i) => <li key={i}>{reason}</li>)}</ul><p>Latest liquidity: {row.current_liquidity_usd == null ? 'Unavailable' : money(row.current_liquidity_usd)}</p><p className={styles.muted}>Liquidity change is withheld when pool and aggregate measurements may differ. Live market observations do not verify deployer activity or sellability.</p><p className={styles.muted}>Checked {date(row.last_checked_at)} · {row.market_source || 'Source unavailable'}</p></section>
      <a className={styles.button} href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(shareOutcome(row))}`} target="_blank" rel="noopener noreferrer">Share on X ↗</a>
      <p className={styles.muted}>Private receipt. Sharing opens editable text only; no account or private receipt link is included.</p>
    </div>
  </dialog>
}
