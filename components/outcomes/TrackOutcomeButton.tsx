'use client'
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabaseClient'
import { canTrackOutcome, OUTCOME_LOCK_COPY, OUTCOME_POLICY } from '@/lib/tokenOutcomes'

export async function outcomeRequest(method: 'GET' | 'POST', body?: unknown, outcomeId?: string) {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new Error('Sign in to track outcomes.')
  const res = await fetch(`/api/token-outcomes${outcomeId ? `?id=${encodeURIComponent(outcomeId)}` : ''}`, { method, cache: 'no-store', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(55_000) })
  const json = await res.json().catch(() => null)
  if (!res.ok || !json) throw new Error(json?.error || 'Outcome request failed. Please retry.')
  return json
}

// LOCK ICON, DISCLOSED (Track Outcome CTA polish task): pure presentation, no gating logic.
function LockIcon({ size = 12, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <rect x="5" y="11" width="14" height="9" rx="2.2" stroke={color} strokeWidth="2" />
      <path d="M8 11V7.5a4 4 0 0 1 8 0V11" stroke={color} strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

// WHY-LOCKED TOOLTIP, DISCLOSED (Track Outcome CTA polish task): pure presentation over the SAME
// `score` this button was already passed and the SAME `OUTCOME_POLICY.minRisk` the eligibility
// check below already gates on — never a second threshold, never a second score. Rendered by
// TrackOutcomeButton only, never a standalone/duplicate tracking surface.
function WhyLockedTooltip({ score }: { score?: number }) {
  return (
    <div
      role="tooltip"
      style={{
        position: 'absolute', top: 'calc(100% + 8px)', left: 0, zIndex: 30,
        width: 'min(268px, 84vw)', padding: '12px 14px', borderRadius: 12,
        background: 'linear-gradient(160deg,#0d1a18,#081210)',
        border: '1px solid #2d615b', boxShadow: '0 18px 40px rgba(0,0,0,0.5)',
      }}
    >
      <p style={{ margin: '0 0 6px', fontSize: 11, fontWeight: 800, color: '#e7f7f1' }}>Why is this locked?</p>
      <p style={{ margin: '0 0 9px', fontSize: 11, color: '#c3d3ce', lineHeight: 1.55 }}>
        Track Outcome is available for higher-risk scans ({OUTCOME_POLICY.minRisk}+) so ChainLens can measure what happened after the warning.
      </p>
      <p style={{ margin: 0, fontSize: 10, color: '#7A8A9E', lineHeight: 1.5, paddingTop: 8, borderTop: '1px solid rgba(45,97,91,0.4)' }}>
        {typeof score === 'number'
          ? `This token scored ${score}/100, so tracking is locked for this scan.`
          : 'This scan has no risk score yet, so tracking is locked for this scan.'}
      </p>
    </div>
  )
}

export default function TrackOutcomeButton({ score, receipt }: { score?: number; receipt?: string | null }) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [saved, setSaved] = useState(false)
  // TOOLTIP STATE, DISCLOSED, ADDITIVE: presentation-only — never read by save()/eligibility.
  const [tooltipOpen, setTooltipOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const eligible = canTrackOutcome(score)

  // CLICK-OUTSIDE CLOSE, DISCLOSED: closes the tooltip on a mobile tap elsewhere — mirrors the
  // same pattern already used by this codebase's other hand-rolled tooltips.
  useEffect(() => {
    if (!tooltipOpen) return
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setTooltipOpen(false)
    }
    document.addEventListener('click', onDocClick)
    return () => document.removeEventListener('click', onDocClick)
  }, [tooltipOpen])

  async function save() {
    if (busy || saved || !eligible) return
    if (!receipt) { setMessage('Tracking proof unavailable. Rescan while signed in; if this persists, outcome storage needs configuration.'); return }
    setBusy(true); setMessage('')
    try { const result = await outcomeRequest('POST', { receipt }); setSaved(true); setMessage(result.duplicate ? 'Already tracking this scan.' : 'Original scan saved.') }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to save outcome.') }
    finally { setBusy(false) }
  }

  return (
    <div style={{ marginTop: 12 }} ref={wrapRef}>
      <div style={{ position: 'relative', display: 'block' }}>
        <span
          tabIndex={!eligible ? 0 : undefined}
          aria-label={!eligible ? OUTCOME_LOCK_COPY : undefined}
          title={!eligible ? OUTCOME_LOCK_COPY : 'Freeze this scan and measure what happens next.'}
          onMouseEnter={() => { if (!eligible) setTooltipOpen(true) }}
          onMouseLeave={() => { if (!eligible) setTooltipOpen(false) }}
          onClick={() => { if (!eligible) setTooltipOpen((o) => !o) }}
          onFocus={() => { if (!eligible) setTooltipOpen(true) }}
          onBlur={() => { if (!eligible) setTooltipOpen(false) }}
          style={{ display: 'block' }}
        >
          <button
            type="button"
            // DISABLED-ATTRIBUTE FIX, DISCLOSED: a native `disabled` button never dispatches (or
            // bubbles) a click/tap at all, which would silently break the mobile-tap tooltip this
            // task requires — a tap on a truly `disabled` button reaches nothing, not even the
            // wrapping <span> above. Locked is now `aria-disabled` (visually and semantically still
            // disabled) instead, with `save()`'s own existing `if (... || !eligible) return` guard
            // (unchanged, above) as the real, unconditional safety net — a locked tap can toggle the
            // tooltip but can never call the tracking API. The eligible path's `disabled`
            // (busy/saved) is completely unchanged.
            disabled={eligible && (busy || saved)}
            aria-disabled={!eligible || busy || saved}
            onClick={save}
            aria-busy={busy}
            style={!eligible ? {
              width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 3,
              padding: '11px 16px', borderRadius: 10, cursor: 'not-allowed',
              background: 'linear-gradient(160deg, rgba(20,34,32,0.75), #0c1614)',
              border: '1px solid #23413c',
              boxShadow: '0 0 0 1px rgba(83,243,195,0.05) inset, 0 4px 16px rgba(0,0,0,0.3)',
            } : {
              width: '100%', padding: '12px 16px', borderRadius: 10, border: '1px solid #2d615b',
              background: '#102624', color: '#53F3C3',
              cursor: !busy && !saved ? 'pointer' : 'default',
            }}
          >
            {!eligible ? (
              <>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 700, color: '#8fa8a0' }}>
                  <LockIcon size={12} color="#6f8a82" />
                  Track Outcome
                </span>
                <span style={{ fontSize: 10, color: '#546d66', letterSpacing: '0.02em' }}>
                  Unlocks at {OUTCOME_POLICY.minRisk}+ risk
                </span>
              </>
            ) : (
              busy ? 'Saving outcome…' : saved ? 'Outcome tracked' : 'Track Outcome'
            )}
          </button>
        </span>
        {!eligible && tooltipOpen && <WhyLockedTooltip score={score} />}
      </div>
      {!eligible && (
        <p style={{ margin: '6px 0 0', fontSize: 10, color: '#546d66' }}>
          Available for higher-risk scans ({OUTCOME_POLICY.minRisk}+)
        </p>
      )}
      {message && <p role="status" style={{ fontSize: 12, color: '#a9b7c8' }}>{message} {saved && <Link href="/terminal/track" style={{ color: '#53F3C3' }}>Open Track →</Link>}</p>}
    </div>
  )
}
