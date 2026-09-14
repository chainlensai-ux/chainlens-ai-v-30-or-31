'use client'
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabaseClient'
import type { TrackedOutcome } from '@/lib/tokenOutcomes'
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
  const refreshAction = useRef<(() => Promise<void>) | null>(null)
  useEffect(() => {
    if (!selected) return
    let cancelled = false
    void outcomeRequest('GET', undefined, selected).then(data => { if (!cancelled) setReceipt(data.outcome) }).catch(e => { if (!cancelled) setReceiptError(e instanceof Error ? e.message : 'Receipt unavailable.') })
    return () => { cancelled = true }
  }, [selected])
  function openReceipt(id: string) { setReceipt(null); setReceiptError(''); setSelected(id) }
  useEffect(() => {
    let disposed = false
    let generation = 0
    let currentUser: string | null = null
    async function load(refresh: boolean, version: number) {
      const valid = () => !disposed && generation === version
      if (valid()) { setError(''); if (refresh) setRefreshing(true) }
      try {
        if (refresh) await outcomeRequest('POST', { action: 'refresh' })
        const data = await outcomeRequest('GET')
        if (valid()) { setRows(data.outcomes); setLimit(data.limit) }
        return true
      } catch (e) { if (valid()) setError(e instanceof Error ? e.message : 'Unable to load outcomes.'); return false }
      finally { if (valid()) { setLoading(false); setRefreshing(false) } }
    }
    refreshAction.current = async () => { await load(true, generation) }
    function changeUser(userId: string | null) {
      if (disposed || (generation > 0 && currentUser === userId)) return
      currentUser = userId
      const version = ++generation
      setSignedIn(!!userId)
      setRows([]); setSelected(null); setReceipt(null); setLimit(null); setLoading(true)
      if (!userId) { setLoading(false); setRefreshing(false); setError('Sign in to view your private outcomes.'); return }
      // Show saved receipts first. Then a single bounded stale refresh, never an interval.
      void load(false, version).then(loaded => { if (loaded && !disposed && version === generation) return load(true, version) })
    }
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => { changeUser(session?.user.id ?? null) })
    void supabase.auth.getSession().then(({ data }) => { if (!disposed && generation === 0) changeUser(data.session?.user.id ?? null) })
    return () => { disposed = true; listener.subscription.unsubscribe(); refreshAction.current = null }
  }, [])
  const active = rows.find(row => row.id === selected)
  return <main className={styles.page}>
    <header className={styles.header}><div><span className={styles.eyebrow}>Evidence, measured over time</span><h1>Track</h1><p>The original risk call. What happened next. Private to your account.</p><p>{limit == null ? 'Outcome receipts' : `${rows.length} / ${limit} outcomes tracked`}</p></div><button className={styles.button} disabled={loading || refreshing || !signedIn} onClick={() => void refreshAction.current?.()}>{refreshing ? 'Checking stale outcomes…' : 'Refresh outcomes'}</button></header>
    <p className={styles.muted}>Watchlist follows tokens. Track preserves a scan and measures its outcome. Refresh checks up to four stale receipts; observations are cached for 15 minutes.</p>
    {error && <div role="alert" className={styles.notice}>{error} <button className={styles.button} onClick={() => void refreshAction.current?.()} disabled={refreshing}>Retry</button></div>}
    {loading ? <div className={styles.grid} aria-busy="true" aria-label="Loading outcomes">{[1,2,3].map(i => <div key={i} className={styles.skeleton}>Loading outcome receipt…</div>)}</div> : rows.length > 0 ? <div className={styles.grid}>{rows.map(row => <OutcomeCard key={row.id} row={row} onOpen={() => openReceipt(row.id)} />)}</div> : !error && <section className={styles.empty}><h2>No outcome receipts yet</h2><p className={styles.muted}>Scan a token with a Risk Score of 50 or higher, then select Track Outcome to freeze its evidence.</p><Link href="/terminal/token-scanner" className={styles.button}>Open Token Scanner →</Link></section>}
    {active && <OutcomeReceipt row={receipt?.id === active.id ? receipt : active} loadingEvidence={!receipt && !receiptError} evidenceError={receiptError} onClose={() => setSelected(null)} />}
  </main>
}
