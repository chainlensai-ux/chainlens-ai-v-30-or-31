'use client'
import { useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabaseClient'
import { canTrackOutcome, OUTCOME_LOCK_COPY } from '@/lib/tokenOutcomes'

export async function outcomeRequest(method: 'GET' | 'POST', body?: unknown, outcomeId?: string) {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new Error('Sign in to track outcomes.')
  const res = await fetch(`/api/token-outcomes${outcomeId ? `?id=${encodeURIComponent(outcomeId)}` : ''}`, { method, cache: 'no-store', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(55_000) })
  const json = await res.json().catch(() => null)
  if (!res.ok || !json) throw new Error(json?.error || 'Outcome request failed. Please retry.')
  return json
}
export default function TrackOutcomeButton({ score, receipt }: { score?: number; receipt?: string | null }) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [saved, setSaved] = useState(false)
  const eligible = canTrackOutcome(score)
  async function save() {
    if (busy || saved || !eligible) return
    if (!receipt) { setMessage('Tracking proof unavailable. Rescan while signed in; if this persists, outcome storage needs configuration.'); return }
    setBusy(true); setMessage('')
    try { const result = await outcomeRequest('POST', { receipt }); setSaved(true); setMessage(result.duplicate ? 'Already tracking this scan.' : 'Original scan saved.') }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to save outcome.') }
    finally { setBusy(false) }
  }
  return <div style={{ marginTop: 12 }}>
    <span tabIndex={!eligible ? 0 : undefined} aria-label={!eligible ? OUTCOME_LOCK_COPY : undefined} title={!eligible ? OUTCOME_LOCK_COPY : 'Freeze this scan and measure what happens next.'} style={{ display: 'block' }}>
      <button type="button" disabled={!eligible || busy || saved} onClick={save} aria-busy={busy} style={{ width: '100%', padding: '12px 16px', borderRadius: 10, border: '1px solid #2d615b', background: '#102624', color: eligible ? '#53F3C3' : '#7A8A9E', cursor: eligible && !busy && !saved ? 'pointer' : 'default' }}>
        {!eligible ? 'Track Outcome · Locked' : busy ? 'Saving outcome…' : saved ? 'Outcome tracked' : 'Track Outcome'}
      </button>
    </span>
    {message && <p role="status" style={{ fontSize: 12, color: '#a9b7c8' }}>{message} {saved && <Link href="/terminal/track" style={{ color: '#53F3C3' }}>Open Track →</Link>}</p>}
  </div>
}
