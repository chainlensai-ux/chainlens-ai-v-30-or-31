'use client'
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabaseClient'
import { OUTCOME_POLICY, mergeListedOutcomeObservation, type TrackedOutcome } from '@/lib/tokenOutcomes'
import { outcomeRequest } from '@/components/outcomes/TrackOutcomeButton'
import { OutcomeCard, OutcomeReceipt } from '@/components/outcomes/OutcomeCard'
import styles from '@/components/outcomes/outcomes.module.css'

const PRICE_CACHE_MINUTES = Math.round(OUTCOME_POLICY.priceStaleMs / 60_000)

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
  const refreshAction = useRef<((force?: boolean) => Promise<void>) | null>(null)
  const visibleIds = useRef<string[]>([])
  const rowsRef = useRef<TrackedOutcome[]>([])
  useEffect(() => { rowsRef.current = rows }, [rows])
  useEffect(() => {
    if (!selected) return
    let cancelled = false
    void outcomeRequest('GET', undefined, selected).then(data => {
      if (!cancelled && data.outcome) setReceipt(mergeListedOutcomeObservation(data.outcome as TrackedOutcome, rowsRef.current.find(row => row.id === selected)))
    }).catch(e => { if (!cancelled) setReceiptError(e instanceof Error ? e.message : 'Receipt unavailable.') })
    return () => { cancelled = true }
  }, [selected])
  function openReceipt(id: string) { setReceipt(null); setReceiptError(''); setSelected(id) }
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
              setRows(outcomes)
              if (typeof result.limit === 'number') setLimit(result.limit)
              setReceipt(prev => prev ? mergeListedOutcomeObservation(prev, outcomes.find(row => row.id === prev.id)) : prev)
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
          setRows(outcomes); setLimit(data.limit)
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
      setRows([]); setSelected(null); setReceipt(null); setLimit(null); setLoading(true)
      visibleIds.current = []
      if (!userId) { setLoading(false); setRefreshing(false); setError('Sign in to view your private outcomes.'); return }
      // Show saved receipts first. Then a single bounded stale refresh, never an interval.
      void load(false, version).then(loaded => { if (loaded && !disposed && version === generation) return load(true, version, false) })
    }
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => { changeUser(session?.user.id ?? null) })
    void supabase.auth.getSession().then(({ data }) => { if (!disposed && generation === 0) changeUser(data.session?.user.id ?? null) })
    return () => { disposed = true; listener.subscription.unsubscribe(); refreshAction.current = null }
  }, [])
  const active = rows.find(row => row.id === selected)
  async function deleteOutcome(id: string) {
    try { await outcomeRequest('DELETE', undefined, id); setRows(current => current.filter(row => row.id !== id)); visibleIds.current = visibleIds.current.filter(value => value !== id); if (selected === id) setSelected(null) }
    catch (e) { setError(e instanceof Error ? e.message : 'Unable to delete outcome.') }
  }
  return <main className={styles.page}>
    <header className={styles.header}><div><span className={styles.eyebrow}>Evidence, measured over time</span><h1>Track</h1><p>The original risk call. What happened next. Private to your account.</p><p>{limit == null ? 'Outcome receipts' : `${rows.length} / ${limit} outcomes tracked`}</p></div><button className={styles.button} disabled={loading || refreshing || !signedIn} onClick={() => void refreshAction.current?.(true)}>{refreshing ? 'Checking stale outcomes…' : 'Refresh outcomes'}</button></header>
    <p className={styles.muted}>Watchlist follows tokens. Track preserves a scan and measures its outcome. Page load refreshes stale receipts. Manual refresh re-checks up to {OUTCOME_POLICY.refreshBatch} visible receipts even if they were cached. Live prices are reused for {PRICE_CACHE_MINUTES} minutes.</p>
    {error && <div role="alert" className={styles.notice}>{error} <button className={styles.button} onClick={() => void refreshAction.current?.(true)} disabled={refreshing}>Retry</button></div>}
    {loading ? <div className={styles.grid} aria-busy="true" aria-label="Loading outcomes">{[1,2,3].map(i => <div key={i} className={styles.skeleton}>Loading outcome receipt…</div>)}</div> : rows.length > 0 ? <div className={styles.grid}>{rows.map(row => <OutcomeCard key={row.id} row={row} onOpen={() => openReceipt(row.id)} onDelete={() => void deleteOutcome(row.id)} />)}</div> : !error && <section className={styles.empty}><h2>No outcome receipts yet</h2><p className={styles.muted}>Scan a token with a Risk Score of 50 or higher, then select Track Outcome to freeze its evidence.</p><Link href="/terminal/token-scanner" className={styles.button}>Open Token Scanner →</Link></section>}
    {active && <OutcomeReceipt row={receipt?.id === active.id ? receipt : active} loadingEvidence={!receipt && !receiptError} evidenceError={receiptError} onClose={() => setSelected(null)} />}
  </main>
}
