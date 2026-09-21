'use client'
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabaseClient'
import { OUTCOME_POLICY, adoptNewerOutcomeObservation, mergeTrackedOutcomeRows, nextTrackedOutcomeLiveBatch, snapshotHasFrozenEvidence, type TrackedOutcome } from '@/lib/tokenOutcomes'
import { outcomeRequest } from '@/components/outcomes/TrackOutcomeButton'
import { OutcomeCard, OutcomeReceipt } from '@/components/outcomes/OutcomeCard'
import styles from '@/components/outcomes/outcomes.module.css'

export default function TrackPage() {
  const [rows, setRows] = useState<TrackedOutcome[]>([])
  const [limit, setLimit] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<TrackedOutcome | null>(null)
  const [receiptError, setReceiptError] = useState('')
  const [signedIn, setSignedIn] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [updatingIds, setUpdatingIds] = useState<string[]>([])
  const [failedIds, setFailedIds] = useState<string[]>([])
  const refreshAction = useRef<((force?: boolean) => Promise<void>) | null>(null)
  const visibleIds = useRef<string[]>([])
  const rowsRef = useRef<TrackedOutcome[]>([])
  const receiptRef = useRef<TrackedOutcome | null>(null)
  const selectedRef = useRef<string | null>(null)
  function writeRows(updater: (current: TrackedOutcome[]) => TrackedOutcome[]) {
    setRows(current => {
      const next = updater(current)
      rowsRef.current = next
      return next
    })
  }
  function writeReceipt(updater: (prev: TrackedOutcome | null) => TrackedOutcome | null) {
    setReceipt(prev => {
      const next = updater(prev)
      receiptRef.current = next
      return next
    })
  }
  useEffect(() => { selectedRef.current = selected }, [selected])
  function applyLiveObservations(updated: TrackedOutcome[]) {
    if (!updated.length) return
    const byId = new Map(updated.map(row => [row.id, row]))
    writeRows(current => current.map(row => {
      const incoming = byId.get(row.id)
      return incoming ? adoptNewerOutcomeObservation(row, incoming) : row
    }))
    writeReceipt(prev => {
      if (!prev) return prev
      const incoming = byId.get(prev.id)
      return incoming ? adoptNewerOutcomeObservation(prev, incoming) : prev
    })
  }
  const applyLiveRef = useRef(applyLiveObservations)
  useEffect(() => { applyLiveRef.current = applyLiveObservations })
  useEffect(() => {
    if (!selected) return
    let cancelled = false
    void outcomeRequest('GET', undefined, selected).then(data => {
      if (cancelled || !data.outcome) return
      const full = data.outcome as TrackedOutcome
      const open = receiptRef.current?.id === selected ? receiptRef.current : rowsRef.current.find(row => row.id === selected)
      const canonical = adoptNewerOutcomeObservation(full, open)
      writeReceipt(() => canonical)
      writeRows(current => current.map(row => row.id === canonical.id ? adoptNewerOutcomeObservation(row, canonical) : row))
    }).catch(e => { if (!cancelled) setReceiptError(e instanceof Error ? e.message : 'Receipt unavailable.') })
    return () => { cancelled = true }
  }, [selected])
  function openReceipt(id: string) {
    const current = rowsRef.current.find(row => row.id === id) ?? null
    receiptRef.current = current
    setReceiptError('')
    setReceipt(current)
    setSelected(id)
  }
  function applyLiveObservation(updated: TrackedOutcome) {
    applyLiveObservations([updated])
  }
  useEffect(() => {
    if (!signedIn || loading) return
    let cancelled = false
    let inFlight = false
    let cursor = 0
    let backoffUntil = 0
    let backoffMs: number = OUTCOME_POLICY.pageLiveRefreshMs
    async function tick(force = false) {
      if (cancelled || inFlight) return
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      if (!force && Date.now() < backoffUntil) return
      const ids = rowsRef.current.map(row => row.id)
      const batch = nextTrackedOutcomeLiveBatch(ids, cursor, selectedRef.current)
      if (!batch.ids.length) return
      inFlight = true
      cursor = batch.cursor
      setUpdatingIds(batch.ids)
      try {
        const result = await outcomeRequest('POST', { action: 'live', ids: batch.ids })
        if (cancelled) return
        const outcomes = (Array.isArray(result.outcomes) ? result.outcomes : result.outcome ? [result.outcome] : []) as TrackedOutcome[]
        applyLiveRef.current(outcomes)
        const received = new Set(outcomes.map(row => row.id))
        const attempted = (Array.isArray(result.attempted) ? result.attempted as string[] : batch.ids).filter(id => batch.ids.includes(id))
        setFailedIds(current => {
          const kept = current.filter(id => !received.has(id) && !attempted.includes(id))
          const missed = attempted.filter(id => !received.has(id))
          return [...kept, ...missed]
        })
        backoffMs = OUTCOME_POLICY.pageLiveRefreshMs
      } catch (error) {
        if (cancelled) return
        setFailedIds(current => [...new Set([...current, ...batch.ids])])
        const status = error && typeof error === 'object' && 'status' in error ? (error as { status?: number }).status : undefined
        const wait = status === 429 ? 60_000 : Math.min(backoffMs * 2, 60_000)
        backoffMs = wait
        backoffUntil = Date.now() + wait
      } finally {
        inFlight = false
        if (!cancelled) setUpdatingIds(current => current.filter(id => !batch.ids.includes(id)))
      }
    }
    const start = window.setTimeout(() => { void tick(true) }, OUTCOME_POLICY.pageLiveFirstDelayMs)
    const poll = window.setInterval(() => { void tick() }, OUTCOME_POLICY.pageLiveRefreshMs)
    const clock = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      setNowMs(Date.now())
    }, 1_000)
    function onVis() {
      if (document.visibilityState !== 'visible') return
      setNowMs(Date.now())
      void tick(true)
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      cancelled = true
      window.clearTimeout(start)
      window.clearInterval(poll)
      window.clearInterval(clock)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [signedIn, loading])
  useEffect(() => {
    let disposed = false
    let generation = 0
    let currentUser: string | null = null
    async function load(refresh: boolean, version: number, force = false) {
      const valid = () => !disposed && generation === version
      if (valid()) { setError(''); if (refresh) setRefreshing(true) }
      try {
        if (refresh) {
          try {
            const result = await outcomeRequest('POST', { action: 'refresh', force, ...(visibleIds.current.length ? { ids: visibleIds.current } : {}) })
            if (valid() && Array.isArray(result.outcomes)) {
              const outcomes = result.outcomes as TrackedOutcome[]
              visibleIds.current = outcomes.map(row => row.id)
              writeRows(current => mergeTrackedOutcomeRows(current, outcomes))
              if (typeof result.limit === 'number') setLimit(result.limit)
              writeReceipt(prev => prev ? adoptNewerOutcomeObservation(prev, outcomes.find(row => row.id === prev.id)) : prev)
              return true
            }
          } catch {
            // A refresh write failure must not hide saved receipts. Fall through to GET.
          }
        }
        const data = await outcomeRequest('GET')
        if (valid()) {
          const outcomes = data.outcomes as TrackedOutcome[]
          visibleIds.current = outcomes.map(row => row.id)
          writeRows(current => mergeTrackedOutcomeRows(current, outcomes)); setLimit(data.limit)
        }
        return true
      } catch (e) { if (valid()) setError(e instanceof Error ? e.message : 'Unable to load outcomes.'); return false }
      finally { if (valid()) { setLoading(false); setRefreshing(false) } }
    }
    refreshAction.current = async (force = true) => { await load(true, generation, force) }
    function changeUser(userId: string | null) {
      if (disposed || (generation > 0 && currentUser === userId)) return
      currentUser = userId
      const version = ++generation
      setSignedIn(!!userId)
      rowsRef.current = []
      receiptRef.current = null
      setRows([]); setSelected(null); setReceipt(null); setLimit(null); setLoading(true)
      setUpdatingIds([]); setFailedIds([])
      visibleIds.current = []
      if (!userId) { setLoading(false); setRefreshing(false); setError('Sign in to view your private outcomes.'); return }
      // Show saved receipts first. Then a single bounded stale refresh. Card live ticks use a separate interval.
      void load(false, version).then(loaded => { if (loaded && !disposed && version === generation) return load(true, version, false) })
    }
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => { changeUser(session?.user.id ?? null) })
    void supabase.auth.getSession().then(({ data }) => { if (!disposed && generation === 0) changeUser(data.session?.user.id ?? null) })
    return () => { disposed = true; listener.subscription.unsubscribe(); refreshAction.current = null }
  }, [])
  const active = rows.find(row => row.id === selected)
  async function deleteOutcome(id: string) {
    try { await outcomeRequest('DELETE', undefined, id); writeRows(current => current.filter(row => row.id !== id)); visibleIds.current = visibleIds.current.filter(value => value !== id); if (selected === id) { setSelected(null); receiptRef.current = null; setReceipt(null) } }
    catch (e) { setError(e instanceof Error ? e.message : 'Unable to delete outcome.') }
  }
  const receiptRow = receipt?.id === active?.id ? receipt : active
  return <main className={styles.page}>
    <header className={styles.header}><div><span className={styles.eyebrow}>Evidence, measured over time</span><h1>Track</h1><p>The original risk call. What happened next. Private to your account.</p><p>{limit == null ? 'Outcome receipts' : `${rows.length} / ${limit} outcomes tracked`}</p></div><button className={styles.button} disabled={loading || refreshing || !signedIn} onClick={() => void refreshAction.current?.(true)}>{refreshing ? 'Checking stale outcomes…' : 'Refresh outcomes'}</button></header>
    <p className={styles.muted}>Watchlist follows tokens. Track preserves a scan and measures its outcome. While this page is open, cards refresh live in batches of {OUTCOME_POLICY.refreshBatch} about every {Math.round(OUTCOME_POLICY.pageLiveRefreshMs / 1000)} seconds. Opening a receipt looks up that token about every {Math.round(OUTCOME_POLICY.receiptLiveRefreshMs / 1000)} seconds and pauses the card tick for it. Manual refresh re-checks up to {OUTCOME_POLICY.refreshBatch} visible receipts even if they were cached. Polling stops when the tab is hidden.</p>
    {error && <div role="alert" className={styles.notice}>{error} <button className={styles.button} onClick={() => void refreshAction.current?.(true)} disabled={refreshing}>Retry</button></div>}
    {loading ? <div className={styles.grid} aria-busy="true" aria-label="Loading outcomes">{[1,2,3].map(i => <div key={i} className={styles.skeleton}>Loading outcome receipt…</div>)}</div> : rows.length > 0 ? <div className={styles.grid}>{rows.map(row => <OutcomeCard key={row.id} row={row} nowMs={nowMs} updating={updatingIds.includes(row.id)} refreshFailed={failedIds.includes(row.id)} onOpen={() => openReceipt(row.id)} onDelete={() => void deleteOutcome(row.id)} />)}</div> : !error && <section className={styles.empty}><h2>No outcome receipts yet</h2><p className={styles.muted}>Scan a token with a Risk Score of 50 or higher, then select Track Outcome to freeze its evidence.</p><Link href="/terminal/token-scanner" className={styles.button}>Open Token Scanner →</Link></section>}
    {active && <OutcomeReceipt row={receiptRow ?? active} loadingEvidence={!snapshotHasFrozenEvidence(receiptRow?.baseline_snapshot_json) && !receiptError} evidenceError={receiptError} onClose={() => setSelected(null)} onLiveUpdate={applyLiveObservation} />}
  </main>
}
