'use client'

// AFFILIATE DASHBOARD, DISCLOSED (requested: "sign up → get their link → start promoting → track
// their referrals/commissions", and "make sure that's executed already and works").
//
// THE GAP THIS FILLS: a referral code was already generated on application, but it was shown
// exactly ONCE — as un-copyable plain text in the apply success box — and was unrecoverable after
// a refresh, with no surface anywhere for an affiliate to see their own referrals or earnings.
// This page is the durable home for both: the link with a one-click copy, and the real numbers.
//
// EVERY NUMBER HERE IS REAL, DISCLOSED: each figure is served by /api/affiliate/me from rows the
// live attribution pipeline actually wrote (affiliate_commissions, crypto_payments, user_settings.
// referred_by_affiliate_id). Nothing is projected or estimated. Where a value could not be loaded
// the API returns null and this page shows an explicit "unavailable" state — never a 0, which
// would tell an ambassador they earned nothing when the truth is the number failed to load.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Navbar from '@/components/Navbar'
import { supabase } from '@/lib/supabaseClient'

type RecentRow = {
  plan: string | null
  paymentUsd: number
  commissionUsd: number
  status: 'paid' | 'pending'
  createdAt: string | null
  paidAt: string | null
}

type Stats =
  | { unavailable: true; reason: string }
  | {
      unavailable: false
      conversions: number
      earnedTotalUsd: number
      earnedPaidUsd: number
      earnedPendingUsd: number
      revenueGeneratedUsd: number
      recent: RecentRow[]
    }

type MeResponse =
  | { isAffiliate: false }
  | {
      isAffiliate: true
      referralCode: string
      referralLink: string
      status: string
      linkIsLive: boolean
      commissionRate: number | null
      appliedAt: string | null
      approvedAt: string | null
      referredAccounts: number | null
      attributedCheckouts: number | null
      stats: Stats
    }

const usd = (v: number) => `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const shortDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—')

export default function AffiliateDashboardPage() {
  const [data, setData] = useState<MeResponse | null>(null)
  // Starts true so the first render is already the loading state, without an effect having to set
  // it synchronously — see the note on the fetch effect below.
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [signedOut, setSignedOut] = useState(false)
  const [copied, setCopied] = useState(false)

  // Retry is driven by a counter rather than by calling the loader again directly: the fetch lives
  // entirely INSIDE the effect (an inline async IIFE, every setState behind an await and a
  // cancellation check), which is what keeps react-hooks/set-state-in-effect satisfied — a named
  // loader invoked from an effect trips it even when its writes are all post-await.
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (cancelled) return
        const token = session?.access_token
        if (!token) { setSignedOut(true); setLoading(false); return }
        const res = await fetch('/api/affiliate/me', { headers: { Authorization: `Bearer ${token}` } })
        const json = await res.json().catch(() => null)
        if (cancelled) return
        if (res.status === 401) { setSignedOut(true); setLoading(false); return }
        if (!res.ok) { setError(json?.error ?? 'Could not load your affiliate dashboard.'); setLoading(false); return }
        setData(json as MeResponse)
        setLoading(false)
      } catch {
        if (!cancelled) { setError('Network error — check your connection and try again.'); setLoading(false) }
      }
    })()
    return () => { cancelled = true }
  }, [reloadKey])

  // Runs from a click handler, not an effect, so synchronous state updates are correct here.
  function retry() {
    setLoading(true)
    setError(null)
    setReloadKey((k) => k + 1)
  }

  async function copyLink(link: string) {
    try {
      if (navigator?.clipboard?.writeText) await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch { /* clipboard access can be denied — the link stays selectable on screen either way */ }
  }

  const shell = (children: React.ReactNode) => (
    <>
      <style>{`
        .affd-page {
          min-height:100vh;
          background:
            radial-gradient(ellipse 1200px 700px at 8% -8%, rgba(139,92,246,.08) 0%, transparent 55%),
            radial-gradient(ellipse 900px 600px at 100% 6%, rgba(45,212,191,.06) 0%, transparent 55%),
            #05070f;
        }
        .affd-surface { background:rgba(255,255,255,.022); border:1px solid rgba(255,255,255,.07); border-radius:16px; }
        .affd-stat-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; }
        .affd-link-row { display:flex; gap:10px; align-items:stretch; }
        @media (max-width:820px) {
          .affd-stat-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
          .affd-link-row { flex-direction:column; }
          .affd-wrap { padding:28px 16px 90px !important; }
        }
      `}</style>
      <div className="affd-page">
        <Navbar />
        <div className="affd-wrap" style={{ maxWidth: '980px', margin: '0 auto', padding: '48px 32px 120px' }}>
          {children}
        </div>
      </div>
    </>
  )

  const heading = (
    <div style={{ marginBottom: '28px' }}>
      <p style={{ fontFamily: 'var(--font-plex-mono,monospace)', fontSize: '11px', fontWeight: 600, letterSpacing: '.16em', margin: '0 0 12px', color: '#5eead4', textTransform: 'uppercase' }}>
        Affiliate Dashboard
      </p>
      <h1 style={{ fontSize: '30px', fontWeight: 700, color: '#f8fafc', margin: 0, lineHeight: 1.2 }}>Your referral link &amp; earnings</h1>
    </div>
  )

  if (loading) return shell(<>{heading}<div className="affd-surface" style={{ padding: '32px' }}><p style={{ margin: 0, color: '#64748b', fontSize: '14px' }}>Loading your affiliate account…</p></div></>)

  if (signedOut) return shell(<>{heading}
    <div className="affd-surface" style={{ padding: '32px' }}>
      <p style={{ margin: '0 0 8px', color: '#e2e8f0', fontSize: '15px', fontWeight: 600 }}>Sign in to see your link</p>
      <p style={{ margin: '0 0 18px', color: '#7c8aa0', fontSize: '13.5px', lineHeight: 1.7 }}>
        Sign in with the same email address you used on your affiliate application, and your referral link and earnings will appear here.
      </p>
      <Link href="/login" style={{ display: 'inline-block', padding: '12px 24px', borderRadius: '11px', background: 'linear-gradient(135deg,#2DD4BF 0%,#8b5cf6 100%)', color: '#04060d', fontWeight: 700, fontSize: '14px', textDecoration: 'none' }}>Sign in →</Link>
    </div>
  </>)

  if (error) return shell(<>{heading}
    <div className="affd-surface" style={{ padding: '28px', borderColor: 'rgba(248,113,113,.22)', background: 'rgba(248,113,113,.05)' }}>
      <p style={{ margin: '0 0 14px', color: '#fca5a5', fontSize: '14px' }}>{error}</p>
      <button onClick={retry} style={{ padding: '10px 20px', borderRadius: '10px', border: '1px solid rgba(255,255,255,.14)', background: 'transparent', color: '#e2e8f0', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>Try again</button>
    </div>
  </>)

  // Signed in, but this email has no affiliate application — an ordinary state, not an error.
  if (!data || data.isAffiliate === false) return shell(<>{heading}
    <div className="affd-surface" style={{ padding: '32px' }}>
      <p style={{ margin: '0 0 8px', color: '#e2e8f0', fontSize: '15px', fontWeight: 600 }}>No affiliate account on this email</p>
      <p style={{ margin: '0 0 18px', color: '#7c8aa0', fontSize: '13.5px', lineHeight: 1.7 }}>
        We could not find an affiliate application for the email you are signed in with. If you applied using a different address, sign in with that one — otherwise you can apply now and your referral link is created straight away.
      </p>
      <Link href="/affiliate#apply" style={{ display: 'inline-block', padding: '12px 24px', borderRadius: '11px', background: 'linear-gradient(135deg,#2DD4BF 0%,#8b5cf6 100%)', color: '#04060d', fontWeight: 700, fontSize: '14px', textDecoration: 'none' }}>Join the affiliate program →</Link>
    </div>
  </>)

  const d = data
  const statusColor = d.status === 'approved' ? '#2dd4bf' : d.status === 'rejected' ? '#f87171' : '#fbbf24'
  const statusLabel = d.status === 'approved' ? 'Approved · link is live' : d.status === 'rejected' ? 'Not approved' : 'Pending review'

  const statCards: Array<{ label: string; value: string; sub?: string; accent: string }> = [
    { label: 'Referred accounts', value: d.referredAccounts == null ? 'Unavailable' : String(d.referredAccounts), sub: 'Signed-up users attributed to you', accent: '#7dd3fc' },
    { label: 'Paid conversions', value: d.stats.unavailable ? 'Unavailable' : String(d.stats.conversions), sub: 'Referrals that became paying subscribers', accent: '#a78bfa' },
    { label: 'Commission earned', value: d.stats.unavailable ? 'Unavailable' : usd(d.stats.earnedTotalUsd), sub: d.stats.unavailable ? undefined : `${usd(d.stats.earnedPaidUsd)} paid out so far`, accent: '#2dd4bf' },
    { label: 'Awaiting payout', value: d.stats.unavailable ? 'Unavailable' : usd(d.stats.earnedPendingUsd), sub: 'Paid manually each month', accent: '#fbbf24' },
  ]

  return shell(
    <>
      {heading}

      {/* ── The link itself — the headline of this page ─────────────────────────────────────── */}
      <div className="affd-surface" style={{ padding: '26px 28px', marginBottom: '14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '16px' }}>
          <span style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '.14em', color: '#94a3b8', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono,monospace)' }}>Your referral link</span>
          <span style={{ padding: '3px 11px', borderRadius: '999px', fontSize: '10.5px', fontWeight: 700, color: statusColor, background: `${statusColor}14`, border: `1px solid ${statusColor}44`, fontFamily: 'var(--font-plex-mono,monospace)' }}>{statusLabel}</span>
          {d.commissionRate != null && (
            <span style={{ padding: '3px 11px', borderRadius: '999px', fontSize: '10.5px', fontWeight: 700, color: '#5eead4', background: 'rgba(45,212,191,.08)', border: '1px solid rgba(45,212,191,.3)', fontFamily: 'var(--font-plex-mono,monospace)' }}>{Math.round(d.commissionRate * 100)}% recurring</span>
          )}
        </div>

        <div className="affd-link-row">
          <input
            readOnly
            value={d.referralLink}
            onFocus={(e) => e.currentTarget.select()}
            style={{ flex: 1, minWidth: 0, background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.09)', borderRadius: '10px', padding: '13px 15px', color: '#e2e8f0', fontSize: '14px', fontFamily: 'var(--font-plex-mono,monospace)', outline: 'none' }}
          />
          <button
            onClick={() => void copyLink(d.referralLink)}
            style={{ flexShrink: 0, padding: '13px 26px', borderRadius: '10px', border: 0, background: copied ? 'rgba(45,212,191,.16)' : 'linear-gradient(135deg,#2DD4BF 0%,#8b5cf6 100%)', color: copied ? '#5eead4' : '#04060d', fontSize: '13.5px', fontWeight: 700, cursor: 'pointer', transition: 'all .15s', whiteSpace: 'nowrap' }}
          >
            {copied ? '✓ Copied' : 'Copy link'}
          </button>
        </div>

        <p style={{ margin: '14px 0 0', color: '#7c8aa0', fontSize: '12.5px', lineHeight: 1.7 }}>
          Share this anywhere. Anyone who opens it is credited to you for <strong style={{ color: '#a3b4c5' }}>60 days</strong>, and you keep earning for as long as they stay subscribed — the first affiliate to refer a buyer keeps that buyer on every future payment.
        </p>

        {/* HONESTY GATE, DISCLOSED: /api/checkout/crypto only credits an affiliate whose status is
            'approved'. Telling a pending applicant to "start promoting immediately" without saying
            so would cost them real conversions silently, so the state is stated plainly here. */}
        {!d.linkIsLive && d.status !== 'rejected' && (
          <div style={{ marginTop: '16px', padding: '13px 15px', borderRadius: '11px', background: 'rgba(251,191,36,.05)', border: '1px solid rgba(251,191,36,.22)' }}>
            <p style={{ margin: 0, color: '#fcd34d', fontSize: '12.5px', lineHeight: 1.7 }}>
              <strong>Your link is not tracking yet.</strong> Applications are reviewed manually, and referrals are only credited once your account is approved — usually within 24–72 hours. The link above is permanently yours and will not change, so you can set up your content now, but conversions before approval will not be counted.
            </p>
          </div>
        )}
        {d.status === 'rejected' && (
          <div style={{ marginTop: '16px', padding: '13px 15px', borderRadius: '11px', background: 'rgba(248,113,113,.05)', border: '1px solid rgba(248,113,113,.22)' }}>
            <p style={{ margin: 0, color: '#fca5a5', fontSize: '12.5px', lineHeight: 1.7 }}>This application was not approved, so this link does not track referrals. Reach out if you believe this was a mistake.</p>
          </div>
        )}
      </div>

      {/* ── Tracking ──────────────────────────────────────────────────────────────────────── */}
      <div className="affd-stat-grid" style={{ marginBottom: '14px' }}>
        {statCards.map((c) => (
          <div key={c.label} className="affd-surface" style={{ padding: '18px 18px 16px' }}>
            <p style={{ margin: '0 0 8px', fontSize: '10px', fontWeight: 700, letterSpacing: '.12em', color: '#64748b', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono,monospace)' }}>{c.label}</p>
            <p style={{ margin: 0, fontSize: c.value === 'Unavailable' ? '15px' : '24px', fontWeight: 800, color: c.value === 'Unavailable' ? '#64748b' : c.accent, fontFamily: 'var(--font-plex-mono,monospace)', lineHeight: 1.15 }}>{c.value}</p>
            {c.sub && <p style={{ margin: '7px 0 0', fontSize: '11px', color: '#64748b', lineHeight: 1.5 }}>{c.sub}</p>}
          </div>
        ))}
      </div>

      <div className="affd-surface" style={{ padding: '24px 26px' }}>
        <p style={{ margin: '0 0 4px', fontSize: '11px', fontWeight: 700, letterSpacing: '.14em', color: '#94a3b8', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono,monospace)' }}>Recent conversions</p>
        <p style={{ margin: '0 0 18px', fontSize: '12px', color: '#64748b' }}>Every referred subscription that has been paid for.</p>

        {d.stats.unavailable ? (
          <p style={{ margin: 0, color: '#8ea0b5', fontSize: '13px' }}>{d.stats.reason} Refresh to try again — this does not affect what you have earned.</p>
        ) : d.stats.recent.length === 0 ? (
          <p style={{ margin: 0, color: '#64748b', fontSize: '13px', lineHeight: 1.7 }}>
            No conversions yet.{d.linkIsLive ? ' Once someone subscribes through your link it appears here, usually within a few minutes of their payment confirming.' : ' Referrals start being recorded as soon as your account is approved.'}
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ textAlign: 'left', color: '#64748b', fontSize: '10.5px', letterSpacing: '.1em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono,monospace)' }}>
                  <th style={{ padding: '0 12px 10px 0', fontWeight: 700 }}>Date</th>
                  <th style={{ padding: '0 12px 10px 0', fontWeight: 700 }}>Plan</th>
                  <th style={{ padding: '0 12px 10px 0', fontWeight: 700 }}>Their payment</th>
                  <th style={{ padding: '0 12px 10px 0', fontWeight: 700 }}>Your commission</th>
                  <th style={{ padding: '0 0 10px', fontWeight: 700 }}>Payout</th>
                </tr>
              </thead>
              <tbody>
                {d.stats.recent.map((r, i) => (
                  <tr key={i} style={{ borderTop: '1px solid rgba(255,255,255,.07)' }}>
                    <td style={{ padding: '11px 12px 11px 0', color: '#94a3b8', whiteSpace: 'nowrap' }}>{shortDate(r.createdAt)}</td>
                    <td style={{ padding: '11px 12px 11px 0', color: '#cbd5e1', textTransform: 'capitalize' }}>{r.plan ?? '—'}</td>
                    <td style={{ padding: '11px 12px 11px 0', color: '#94a3b8', fontFamily: 'var(--font-plex-mono,monospace)' }}>{usd(r.paymentUsd)}</td>
                    <td style={{ padding: '11px 12px 11px 0', color: '#2dd4bf', fontWeight: 700, fontFamily: 'var(--font-plex-mono,monospace)' }}>{usd(r.commissionUsd)}</td>
                    <td style={{ padding: '11px 0' }}>
                      <span style={{ padding: '2px 9px', borderRadius: '999px', fontSize: '10.5px', fontWeight: 700, color: r.status === 'paid' ? '#2dd4bf' : '#fbbf24', background: r.status === 'paid' ? 'rgba(45,212,191,.1)' : 'rgba(251,191,36,.1)', border: `1px solid ${r.status === 'paid' ? 'rgba(45,212,191,.3)' : 'rgba(251,191,36,.3)'}`, fontFamily: 'var(--font-plex-mono,monospace)' }}>
                        {r.status === 'paid' ? `Paid ${shortDate(r.paidAt)}` : 'Pending'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p style={{ margin: '20px 0 0', fontSize: '12px', color: '#475569', lineHeight: 1.7 }}>
        Applied {shortDate(d.appliedAt)}{d.approvedAt ? ` · approved ${shortDate(d.approvedAt)}` : ''} · referral code <span style={{ fontFamily: 'var(--font-plex-mono,monospace)', color: '#64748b' }}>{d.referralCode}</span>
      </p>
    </>
  )
}
