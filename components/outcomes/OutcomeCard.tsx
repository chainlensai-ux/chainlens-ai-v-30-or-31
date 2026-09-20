'use client'
import { useEffect, useRef, useState } from 'react'
import {
  comparableOutcomeBaselinePrice, frozenBaselineMarketCapUsd, hypothetical, observationCheckedAtMs, observationIsFresh, OUTCOME_POLICY,
  percentChange, shareOutcome, validPriceOrNull, type TrackedOutcome,
} from '@/lib/tokenOutcomes'
import { outcomeRequest } from '@/components/outcomes/TrackOutcomeButton'
import styles from './outcomes.module.css'

const PENDING_PRICE = 'Current price unavailable — Outcome pending'
const CARD_PENDING_PRICE = 'Price unavailable'
const UNVERIFIED_BASELINE = 'Original scan price could not be verified. Live market data is available, but historical price performance cannot be calculated.'
const pct = (n: number | null) => n == null ? 'Unavailable' : `${n > 0 ? '+' : ''}${n.toFixed(1)}%`
const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
const compactUsd = (n: number | null, unavailable = 'Unavailable') => {
  if (n == null) return unavailable
  if (n >= 1) return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumSignificantDigits: 6 })
}
const date = (value: string | null) => value ? new Date(value).toLocaleString() : 'Not checked yet'
const shortDate = (value: string | null) => value ? new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'Unknown'
const label = (value: string) => value.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ')
const shortAddress = (address: string) => address.length < 12 ? address : `${address.slice(0, 6)}…${address.slice(-4)}`
const statusLabel = (row: TrackedOutcome) => row.price_change_pct == null && row.outcome_status === 'unavailable' ? 'outcome pending' : row.outcome_status
function liveStatusLabel(checkedAt: string | null, now: number, failed: boolean, updating: boolean): string {
  if (updating) return 'Updating…'
  const ms = observationCheckedAtMs({ last_checked_at: checkedAt })
  if (ms == null) return failed ? 'Latest refresh failed' : 'Not checked yet'
  const seconds = Math.max(0, Math.floor((now - ms) / 1000))
  const age = seconds < 60 ? `${seconds}s ago` : `${Math.max(1, Math.floor(seconds / 60))}m ago`
  if (failed) return `Latest refresh failed · last verified ${age}`
  if (!observationIsFresh({ last_checked_at: checkedAt }, now)) return `Last verified ${age}`
  return `Updated ${age}`
}

/** Structured nested evidence, not new AI prose. No evidence value is recomputed. */
function Evidence({ value }: { value: unknown }) {
  if (value == null) return <p className={styles.muted}>Not recorded in this scan.</p>
  if (typeof value !== 'object') return <span>{typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value)}</span>
  if (Array.isArray(value)) return value.length ? <ul className={styles.evidenceList}>{value.map((v, i) => <li key={i}><Evidence value={v} /></li>)}</ul> : <p className={styles.muted}>No entries recorded.</p>
  return <dl className={styles.evidenceFields}>{Object.entries(value).map(([key, v]) => <div key={key}><dt>{label(key)}</dt><dd><Evidence value={v} /></dd></div>)}</dl>
}
export function OutcomeCard({ row, onOpen, onDelete }: { row: TrackedOutcome; onOpen: () => void; onDelete: () => void }) {
  const snapshot = row.baseline_snapshot_json
  const risk = row.baseline_risk_semantics === 'legacy_unverified' ? 'Legacy score unavailable' : `${row.baseline_risk_score}/100`
  return <article className={styles.card} onClick={onOpen} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onOpen() }} role="button" tabIndex={0} aria-label={`Open outcome receipt for ${snapshot.tokenSymbol || snapshot.tokenName}`}>
    <div className={styles.spread}><span className={styles.chain}>{row.chain}</span><span className={styles.status} data-status={row.outcome_status}>{statusLabel(row)}</span></div>
    <h2>{snapshot.tokenSymbol || snapshot.tokenName || 'Token outcome'}</h2>
    <p className={styles.muted}>{snapshot.tokenName}</p>
    <p className={styles.address} title={row.token_address}>{row.token_address}</p>
    <div className={styles.metrics}><div><span>Original risk</span><strong>{risk}</strong><p>{row.baseline_risk_semantics === 'legacy_unverified' ? 'Legacy Solana score direction was not versioned. Rescan for a canonical receipt.' : row.baseline_verdict}</p></div><div><span>Since scan</span><strong className={`${styles.change} ${row.price_change_pct == null ? styles.pendingPrice : ''}`} data-negative={(row.price_change_pct ?? 0) < 0} data-neutral={row.price_change_pct == null}>{row.price_change_pct == null ? CARD_PENDING_PRICE : pct(row.price_change_pct)}</strong><p>{row.price_change_pct == null ? 'Outcome pending' : `${row.outcome_confidence} confidence`}</p></div></div>
    <footer className={styles.cardFooter}><span className={styles.trackedAt}>Tracked {date(row.tracked_at)}</span><div className={styles.cardActions}><button type="button" className={styles.delete} onClick={e => { e.stopPropagation(); if (confirm('Delete this private outcome receipt?')) onDelete() }} aria-label="Delete outcome receipt">Delete</button><span className={styles.viewReceipt}>View receipt ↗</span></div></footer>
  </article>
}
export function OutcomeReceipt({ row, onClose, onLiveUpdate, loadingEvidence = false, evidenceError = '' }: {
  row: TrackedOutcome; onClose: () => void; onLiveUpdate?: (row: TrackedOutcome) => void
  loadingEvidence?: boolean; evidenceError?: string
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const rowRef = useRef(row)
  const liveUpdateRef = useRef(onLiveUpdate)
  const inFlight = useRef(false)
  const backoffUntil = useRef(0)
  const backoffMs = useRef<number>(OUTCOME_POLICY.receiptLiveRefreshMs)
  const [updating, setUpdating] = useState(false)
  const [refreshFailed, setRefreshFailed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => { rowRef.current = row }, [row])
  useEffect(() => { liveUpdateRef.current = onLiveUpdate }, [onLiveUpdate])
  useEffect(() => { const el = dialog.current; el?.showModal(); return () => { el?.close() } }, [])
  useEffect(() => {
    let cancelled = false
    async function refreshLive() {
      if (cancelled || inFlight.current || Date.now() < backoffUntil.current) return
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      inFlight.current = true
      setUpdating(true)
      const previousChecked = rowRef.current.last_checked_at
      try {
        const result = await outcomeRequest('POST', { action: 'live', ids: [row.id] })
        if (cancelled) return
        const updated = (result.outcome as TrackedOutcome | undefined)
          ?? (Array.isArray(result.outcomes) ? (result.outcomes as TrackedOutcome[]).find(item => item.id === row.id) : undefined)
        if (updated) {
          liveUpdateRef.current?.(updated)
          setRefreshFailed(updated.last_checked_at === previousChecked)
          backoffMs.current = OUTCOME_POLICY.receiptLiveRefreshMs
        } else {
          setRefreshFailed(true)
        }
      } catch (error) {
        if (cancelled) return
        setRefreshFailed(true)
        const status = error && typeof error === 'object' && 'status' in error ? (error as { status?: number }).status : undefined
        const wait = status === 429 ? 60_000 : Math.min(backoffMs.current * 2, 60_000)
        backoffMs.current = wait
        backoffUntil.current = Date.now() + wait
      } finally {
        inFlight.current = false
        if (!cancelled) setUpdating(false)
      }
    }
    void refreshLive()
    const poll = window.setInterval(() => { void refreshLive() }, OUTCOME_POLICY.receiptLiveRefreshMs)
    const clock = window.setInterval(() => setNowMs(Date.now()), 1_000)
    function onVis() { if (document.visibilityState === 'visible') void refreshLive() }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      cancelled = true
      window.clearInterval(poll)
      window.clearInterval(clock)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [row.id])
  const snapshot = row.baseline_snapshot_json
  const currentPrice = validPriceOrNull(row.current_price_usd)
  const comparableBaseline = comparableOutcomeBaselinePrice(row)
  const h = hypothetical(comparableBaseline, currentPrice)
  const originalCap = frozenBaselineMarketCapUsd(row)
  const currentCap = validPriceOrNull(row.current_market_cap_usd)
  const capChange = percentChange(originalCap, currentCap)
  const priceChange = row.price_change_pct
  const comparisonUnavailable = currentPrice != null && priceChange == null
  const groups = [
    ['LP / liquidity', snapshot.baselineLpSignals], ['Ownership / contract control', snapshot.baselineOwnershipSignals],
    ['Holder concentration', snapshot.baselineHolderSignals], ['Dev / deployer', snapshot.baselineDevSignals],
    ['Security / honeypot / taxes', snapshot.baselineSecuritySignals], ['Market quality', snapshot.baselineMarketQualitySignals],
  ] as const
  function copyAddress() {
    void navigator.clipboard?.writeText(row.token_address).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_400)
    }).catch(() => undefined)
  }
  return <dialog ref={dialog} className={styles.dialog} onCancel={onClose} onClose={onClose} onClick={e => { if (e.target === e.currentTarget) onClose() }} aria-labelledby="outcome-receipt-title">
    <div className={styles.receipt}>
      <header className={styles.receiptHead}>
        <div className={styles.receiptHeadCopy}>
          <span className={styles.eyebrow}>ChainLens · Outcome receipt</span>
          <h2 id="outcome-receipt-title">{snapshot.tokenSymbol || snapshot.tokenName || 'Token'} <span className={styles.chain}>{row.chain}</span></h2>
          <div className={styles.identityRow}>
            <p className={styles.address} title={row.token_address}>{shortAddress(row.token_address)}</p>
            <button type="button" className={styles.copy} onClick={copyAddress} aria-label="Copy contract address">{copied ? 'Copied' : 'Copy'}</button>
          </div>
          <p className={styles.receiptMeta}>{row.baseline_risk_semantics === 'legacy_unverified' ? 'Legacy score unavailable · Rescan required' : `${snapshot.baselineRiskScore}/100 · ${snapshot.baselineVerdict}`} · Scanned {shortDate(snapshot.scannedAt)}</p>
        </div>
        <button autoFocus className={styles.close} onClick={onClose} aria-label="Close receipt">×</button>
      </header>
      <div className={styles.receiptBody}>
        <section className={styles.liveMarket} aria-live="polite">
          <div className={styles.liveHead}>
            <span className={styles.eyebrow}>Live market</span>
            <span className={styles.liveStamp}><span className={`${styles.liveDot} ${updating ? styles.liveDotUpdating : ''}`} aria-hidden="true" />{liveStatusLabel(row.last_checked_at, nowMs, refreshFailed, updating)}</span>
          </div>
          <div className={styles.liveGrid}>
            <div><span>Current market cap</span><strong className={currentCap == null ? styles.pendingMetric : undefined}>{currentCap == null ? 'Market cap unavailable' : compactUsd(currentCap)}</strong></div>
            <div><span>Current price</span><strong className={currentPrice == null ? styles.pendingMetric : undefined}>{currentPrice == null ? 'Price unavailable' : compactUsd(currentPrice)}</strong></div>
            <div><span>Price since scan</span><strong className={`${styles.change} ${priceChange == null ? styles.pendingMetric : ''}`} data-negative={priceChange != null && priceChange < 0} data-neutral={priceChange == null}>{priceChange == null ? '—' : pct(priceChange)}</strong></div>
            <div><span>Market cap since scan</span><strong className={`${styles.change} ${capChange == null ? styles.pendingMetric : ''}`} data-negative={capChange != null && capChange < 0} data-neutral={capChange == null}>{capChange == null ? '—' : pct(capChange)}</strong></div>
          </div>
          <p className={styles.muted}>Original market cap {compactUsd(originalCap, 'unavailable')} · Frozen at scan, not rewritten by live ticks.</p>
        </section>
        <section className={styles.outcomePanel}>
          <span className={styles.eyebrow}>Outcome</span>
          {priceChange == null ? (
            <p className={styles.compactNote}>{comparisonUnavailable ? UNVERIFIED_BASELINE : PENDING_PRICE}</p>
          ) : (
            <div className={styles.outcomeRow}>
              <span className={styles.status} data-status={row.outcome_status}>{row.outcome_status} · {row.outcome_confidence} confidence</span>
              <strong className={styles.change} data-negative={priceChange < 0}>{pct(priceChange)}</strong>
            </div>
          )}
        </section>
        <section className={styles.math}>
          <p>Hypothetical $1,000 at the scan price</p>
          {h ? (
            <>
              <strong>{money(h.value)} remaining</strong>
              <div className={styles.spread}><span>Hypothetical PnL</span><b className={styles.change} data-negative={h.pnl < 0}>{money(h.pnl)}</b></div>
              <div className={styles.spread}><span>Potential loss avoided</span><b>{money(h.potentialLossAvoided)}</b></div>
            </>
          ) : (
            <p className={styles.compactNote}>Hypothetical performance unavailable until a verified original scan price exists.</p>
          )}
          <small>Illustration only. Not an actual purchase or saving. Excludes fees, slippage and ability to sell.</small>
        </section>
        {loadingEvidence ? <p role="status">Loading frozen evidence…</p> : evidenceError ? <p role="alert">{evidenceError} Close and reopen this receipt to retry.</p> : <details className={styles.why}><summary>Original scan evidence</summary><h3>What ChainLens saw at scan time</h3>
          <details><summary>Original risk reasons</summary><Evidence value={snapshot.baselineRiskReasons} /></details>
          {groups.map(([name, evidence]) => <details key={name}><summary>{name}</summary><Evidence value={evidence} /></details>)}
        </details>}
        <section className={styles.after}><h3>What happened afterward</h3><ul>{row.outcome_reasons_json.map((reason, i) => <li key={i}>{reason}</li>)}</ul><p>Latest liquidity: {row.current_liquidity_usd == null ? 'Unavailable' : money(row.current_liquidity_usd)}</p><p className={styles.muted}>Liquidity change is withheld when pool and aggregate measurements may differ. Live market observations do not verify deployer activity or sellability.</p><p className={styles.muted}>Checked {date(row.last_checked_at)} · {row.market_source || 'Source unavailable'}</p></section>
        <a className={styles.button} href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(shareOutcome(row))}`} target="_blank" rel="noopener noreferrer">Share on X ↗</a>
        <p className={styles.muted}>Private receipt. Sharing opens editable text only; no account or private receipt link is included.</p>
      </div>
    </div>
  </dialog>
}
