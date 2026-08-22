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
//
// LEDGER REDESIGN, DISCLOSED (requested: "make it look not ai clean and beautiful but simple
// design", after this exact system was already applied to /affiliate). This page still used the
// PREVIOUS look — a diagonal teal→purple gradient on the copy/sign-in/join buttons and soft
// translucent rounded-16px "glass" cards — the same cluster of choices already replaced on the
// apply page. Brought into the same financial-statement register: hairline-bordered panels instead
// of glass, ChainLens teal (#2DD4BF) as the ONLY accent (never blended into a gradient), Fraunces
// for the page thesis and stat figures, sharp 3-4px radii, rectangular tags instead of pill badges.
// The background token (--ink) is set to the exact literal value html/body already uses
// (#07070f) — see the BACKGROUND SEAM note on the apply page for why that specific match matters.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Fraunces } from 'next/font/google'
import Navbar from '@/components/Navbar'
import { supabase } from '@/lib/supabaseClient'

const fraunces = Fraunces({ subsets: ['latin'], weight: ['500', '600'], style: ['normal', 'italic'], variable: '--font-fraunces', display: 'swap' })

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
        :root {
          --affd-ink: #07070f;
          --affd-panel: #10141b;
          --affd-line: rgba(226,232,240,.11);
          --affd-line-strong: rgba(226,232,240,.18);
          --affd-text: #e7e9ee;
          --affd-muted: #8b93a3;
          --affd-teal: #2DD4BF;
          --affd-teal-soft: rgba(45,212,191,.11);
          --affd-teal-text: #04241f;
        }
        .affd-page { min-height: 100vh; background: var(--affd-ink); }
        .affd-serif { font-family: var(--font-fraunces), Georgia, 'Iowan Old Style', serif; }
        .affd-surface { background: var(--affd-panel); border: 1px solid var(--affd-line); border-radius: 4px; }
        .affd-eyebrow {
          font-family: var(--font-plex-mono,monospace); font-size: 11px; font-weight: 600;
          letter-spacing: .16em; margin: 0 0 12px; color: var(--affd-teal); text-transform: uppercase;
          display: flex; align-items: center; gap: 10px;
        }
        .affd-eyebrow::before { content: ''; width: 16px; height: 1px; background: var(--affd-teal); flex-shrink: 0; }
        .affd-tag { border-radius: 3px; padding: 3px 11px; font-size: 10.5px; font-weight: 700; font-family: var(--font-plex-mono,monospace); letter-spacing: .02em; }
        .affd-btn-primary {
          display: inline-flex; align-items: center; gap: 8px; background: var(--affd-teal); color: var(--affd-teal-text);
          border: none; border-radius: 3px; padding: 12px 24px; font-weight: 700; font-size: 13.5px;
          cursor: pointer; text-decoration: none; transition: transform .15s ease, filter .15s ease, box-shadow .15s ease;
        }
        .affd-btn-primary:hover { transform: translateY(-1px); filter: brightness(1.06); box-shadow: 0 6px 16px rgba(45,212,191,.22); }
        .affd-btn-primary:active { transform: translateY(0); filter: brightness(.97); }
        .affd-btn-secondary {
          padding: 10px 18px; border-radius: 3px; border: 1px solid var(--affd-line-strong); background: transparent;
          color: var(--affd-text); font-size: 13px; font-weight: 600; cursor: pointer; transition: border-color .15s, color .15s;
        }
        .affd-btn-secondary:hover { border-color: var(--affd-muted); }
        @media (prefers-reduced-motion: reduce) { .affd-btn-primary { transition: none; } .affd-btn-primary:hover { transform: none; } }
        .affd-stat-grid { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 0; border-top: 1px solid var(--affd-line); border-bottom: 1px solid var(--affd-line); }
        .affd-stat-cell { padding: 20px 22px; border-left: 1px solid var(--affd-line); }
        .affd-stat-cell:first-child { border-left: none; }
        .affd-link-row { display: flex; gap: 10px; align-items: stretch; }
        @media (max-width:820px) {
          .affd-stat-grid { grid-template-columns: repeat(2,1fr); }
          .affd-stat-cell:nth-child(3) { border-left: none; }
          .affd-stat-cell:nth-child(odd) { border-left: none; }
          .affd-stat-cell:nth-child(even) { border-left: 1px solid var(--affd-line); }
          .affd-stat-cell:nth-child(n+3) { border-top: 1px solid var(--affd-line); }
          .affd-link-row { flex-direction: column; }
          .affd-wrap { padding: 28px 16px 90px !important; }
        }
      `}</style>
      <div className={`affd-page ${fraunces.variable}`}>
        <Navbar />
        <div className="affd-wrap" style={{ maxWidth: '980px', margin: '0 auto', padding: '48px 32px 120px' }}>
          {children}
        </div>
      </div>
    </>
  )

  const heading = (
    <div style={{ marginBottom: '32px' }}>
      <p className="affd-eyebrow">Affiliate Dashboard</p>
      <h1 className="affd-serif" style={{ fontSize: 'clamp(26px,3vw,34px)', fontWeight: 500, letterSpacing: '-.01em', color: '#f4f5f7', margin: 0, lineHeight: 1.2 }}>
        Your referral link &amp; earnings
      </h1>
    </div>
  )

  if (loading) return shell(<>{heading}<div className="affd-surface" style={{ padding: '32px' }}><p style={{ margin: 0, color: 'var(--affd-muted)', fontSize: '14px' }}>Loading your affiliate account…</p></div></>)

  if (signedOut) return shell(<>{heading}
    <div className="affd-surface" style={{ padding: '32px' }}>
      <p style={{ margin: '0 0 8px', color: 'var(--affd-text)', fontSize: '15px', fontWeight: 600 }}>Sign in to see your link</p>
      <p style={{ margin: '0 0 20px', color: 'var(--affd-muted)', fontSize: '13.5px', lineHeight: 1.7 }}>
        Sign in with the same email address you used on your affiliate application, and your referral link and earnings will appear here.
      </p>
      <Link href="/login" className="affd-btn-primary">Sign in →</Link>
    </div>
  </>)

  if (error) return shell(<>{heading}
    <div className="affd-surface" style={{ padding: '28px', borderColor: 'rgba(248,113,113,.22)', background: 'rgba(248,113,113,.05)' }}>
      <p style={{ margin: '0 0 16px', color: '#fca5a5', fontSize: '14px' }}>{error}</p>
      <button onClick={retry} className="affd-btn-secondary">Try again</button>
    </div>
  </>)

  // Signed in, but this email has no affiliate application — an ordinary state, not an error.
  if (!data || data.isAffiliate === false) return shell(<>{heading}
    <div className="affd-surface" style={{ padding: '32px' }}>
      <p style={{ margin: '0 0 8px', color: 'var(--affd-text)', fontSize: '15px', fontWeight: 600 }}>No affiliate account on this email</p>
      <p style={{ margin: '0 0 20px', color: 'var(--affd-muted)', fontSize: '13.5px', lineHeight: 1.7 }}>
        We could not find an affiliate application for the email you are signed in with. If you applied using a different address, sign in with that one — otherwise you can apply now and your referral link is created straight away.
      </p>
      <Link href="/affiliate#apply" className="affd-btn-primary">Join the affiliate program →</Link>
    </div>
  </>)

  const d = data
  const statusColor = d.status === 'approved' ? '#2dd4bf' : d.status === 'rejected' ? '#f87171' : '#fbbf24'
  const statusLabel = d.status === 'approved' ? 'Approved · link is live' : d.status === 'rejected' ? 'Not approved' : 'Pending review'

  const statCards: Array<{ label: string; value: string; sub?: string; accent: string }> = [
    { label: 'Referred accounts', value: d.referredAccounts == null ? 'Unavailable' : String(d.referredAccounts), sub: 'Signed-up users attributed to you', accent: '#7dd3fc' },
    { label: 'Paid conversions', value: d.stats.unavailable ? 'Unavailable' : String(d.stats.conversions), sub: 'Referrals that became paying subscribers', accent: '#c4b5fd' },
    { label: 'Commission earned', value: d.stats.unavailable ? 'Unavailable' : usd(d.stats.earnedTotalUsd), sub: d.stats.unavailable ? undefined : `${usd(d.stats.earnedPaidUsd)} paid out so far`, accent: 'var(--affd-teal)' },
    { label: 'Awaiting payout', value: d.stats.unavailable ? 'Unavailable' : usd(d.stats.earnedPendingUsd), sub: 'Paid manually each month', accent: '#fbbf24' },
  ]

  return shell(
    <>
      {heading}

      {/* ── The link itself — the headline of this page ─────────────────────────────────────── */}
      <div className="affd-surface" style={{ padding: '28px 30px', marginBottom: '0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '18px' }}>
          <span style={{ fontSize: '10.5px', fontWeight: 600, letterSpacing: '.12em', color: 'var(--affd-muted)', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono,monospace)' }}>Your referral link</span>
          <span className="affd-tag" style={{ color: statusColor, background: `${statusColor}14`, border: `1px solid ${statusColor}44` }}>{statusLabel}</span>
          {d.commissionRate != null && (
            <span className="affd-tag" style={{ color: '#7ce8d8', background: 'var(--affd-teal-soft)', border: '1px solid rgba(45,212,191,.32)' }}>{Math.round(d.commissionRate * 100)}% recurring</span>
          )}
        </div>

        <div className="affd-link-row">
          <input
            readOnly
            value={d.referralLink}
            onFocus={(e) => e.currentTarget.select()}
            style={{ flex: 1, minWidth: 0, background: 'var(--affd-ink)', border: '1px solid var(--affd-line-strong)', borderRadius: '3px', padding: '13px 15px', color: 'var(--affd-text)', fontSize: '14px', fontFamily: 'var(--font-plex-mono,monospace)', outline: 'none' }}
          />
          <button onClick={() => void copyLink(d.referralLink)} className="affd-btn-primary" style={{ flexShrink: 0, whiteSpace: 'nowrap', background: copied ? 'rgba(45,212,191,.22)' : 'var(--affd-teal)', color: copied ? '#7ce8d8' : 'var(--affd-teal-text)' }}>
            {copied ? '✓ Copied' : 'Copy link'}
          </button>
        </div>

        <p style={{ margin: '16px 0 0', color: 'var(--affd-muted)', fontSize: '12.5px', lineHeight: 1.7 }}>
          Share this anywhere. Anyone who opens it is credited to you for <strong style={{ color: '#a3b4c5' }}>60 days</strong>, and you keep earning for as long as they stay subscribed — the first affiliate to refer a buyer keeps that buyer on every future payment.
        </p>

        {/* HONESTY GATE, DISCLOSED: /api/checkout/crypto only credits an affiliate whose status is
            'approved'. Telling a pending applicant to "start promoting immediately" without saying
            so would cost them real conversions silently, so the state is stated plainly here. */}
        {!d.linkIsLive && d.status !== 'rejected' && (
          <div style={{ marginTop: '18px', padding: '13px 15px', background: 'rgba(251,191,36,.05)', borderLeft: '2px solid #fbbf24' }}>
            <p style={{ margin: 0, color: '#fcd34d', fontSize: '12.5px', lineHeight: 1.7 }}>
              <strong>Your link is not tracking yet.</strong> Applications are reviewed manually, and referrals are only credited once your account is approved — usually within 24–72 hours. The link above is permanently yours and will not change, so you can set up your content now, but conversions before approval will not be counted.
            </p>
          </div>
        )}
        {d.status === 'rejected' && (
          <div style={{ marginTop: '18px', padding: '13px 15px', background: 'rgba(248,113,113,.05)', borderLeft: '2px solid #f87171' }}>
            <p style={{ margin: 0, color: '#fca5a5', fontSize: '12.5px', lineHeight: 1.7 }}>This application was not approved, so this link does not track referrals. Reach out if you believe this was a mistake.</p>
          </div>
        )}
      </div>

      {/* ── Tracking ──────────────────────────────────────────────────────────────────────── */}
      <div className="affd-stat-grid" style={{ marginTop: '22px', marginBottom: '22px' }}>
        {statCards.map((c) => (
          <div key={c.label} className="affd-stat-cell">
            <p style={{ margin: '0 0 8px', fontSize: '10px', fontWeight: 600, letterSpacing: '.1em', color: 'var(--affd-muted)', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono,monospace)' }}>{c.label}</p>
            <p className={c.value === 'Unavailable' ? undefined : 'affd-serif'} style={{ margin: 0, fontSize: c.value === 'Unavailable' ? '14px' : '26px', fontWeight: c.value === 'Unavailable' ? 600 : 500, color: c.value === 'Unavailable' ? 'var(--affd-muted)' : c.accent, letterSpacing: c.value === 'Unavailable' ? 'normal' : '-.01em', lineHeight: 1.15 }}>{c.value}</p>
            {c.sub && <p style={{ margin: '8px 0 0', fontSize: '11px', color: 'var(--affd-muted)', lineHeight: 1.5 }}>{c.sub}</p>}
          </div>
        ))}
      </div>

      <div className="affd-surface" style={{ padding: '26px 28px' }}>
        <p style={{ margin: '0 0 4px', fontSize: '10.5px', fontWeight: 600, letterSpacing: '.12em', color: 'var(--affd-muted)', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono,monospace)' }}>Recent conversions</p>
        <p style={{ margin: '0 0 20px', fontSize: '12px', color: 'var(--affd-muted)' }}>Every referred subscription that has been paid for.</p>

        {d.stats.unavailable ? (
          <p style={{ margin: 0, color: 'var(--affd-muted)', fontSize: '13px' }}>{d.stats.reason} Refresh to try again — this does not affect what you have earned.</p>
        ) : d.stats.recent.length === 0 ? (
          <p style={{ margin: 0, color: 'var(--affd-muted)', fontSize: '13px', lineHeight: 1.7 }}>
            No conversions yet.{d.linkIsLive ? ' Once someone subscribes through your link it appears here, usually within a few minutes of their payment confirming.' : ' Referrals start being recorded as soon as your account is approved.'}
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--affd-muted)', fontSize: '10.5px', letterSpacing: '.1em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono,monospace)' }}>
                  <th style={{ padding: '0 12px 12px 0', fontWeight: 600, borderBottom: '1px solid var(--affd-line)' }}>Date</th>
                  <th style={{ padding: '0 12px 12px 0', fontWeight: 600, borderBottom: '1px solid var(--affd-line)' }}>Plan</th>
                  <th style={{ padding: '0 12px 12px 0', fontWeight: 600, borderBottom: '1px solid var(--affd-line)' }}>Their payment</th>
                  <th style={{ padding: '0 12px 12px 0', fontWeight: 600, borderBottom: '1px solid var(--affd-line)' }}>Your commission</th>
                  <th style={{ padding: '0 0 12px', fontWeight: 600, borderBottom: '1px solid var(--affd-line)' }}>Payout</th>
                </tr>
              </thead>
              <tbody>
                {d.stats.recent.map((r, i) => (
                  <tr key={i} style={{ borderTop: '1px solid var(--affd-line)' }}>
                    <td style={{ padding: '12px 12px 12px 0', color: 'var(--affd-muted)', whiteSpace: 'nowrap' }}>{shortDate(r.createdAt)}</td>
                    <td style={{ padding: '12px 12px 12px 0', color: 'var(--affd-text)', textTransform: 'capitalize' }}>{r.plan ?? '—'}</td>
                    <td style={{ padding: '12px 12px 12px 0', color: 'var(--affd-muted)', fontFamily: 'var(--font-plex-mono,monospace)' }}>{usd(r.paymentUsd)}</td>
                    <td style={{ padding: '12px 12px 12px 0', color: 'var(--affd-teal)', fontWeight: 700, fontFamily: 'var(--font-plex-mono,monospace)' }}>{usd(r.commissionUsd)}</td>
                    <td style={{ padding: '12px 0' }}>
                      <span className="affd-tag" style={{ color: r.status === 'paid' ? '#7ce8d8' : '#fbbf24', background: r.status === 'paid' ? 'var(--affd-teal-soft)' : 'rgba(251,191,36,.1)', border: `1px solid ${r.status === 'paid' ? 'rgba(45,212,191,.3)' : 'rgba(251,191,36,.3)'}` }}>
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

      <p style={{ margin: '24px 0 0', fontSize: '12px', color: '#526075', lineHeight: 1.7, fontFamily: 'var(--font-plex-mono,monospace)' }}>
        Applied {shortDate(d.appliedAt)}{d.approvedAt ? ` · approved ${shortDate(d.approvedAt)}` : ''} · referral code {d.referralCode}
      </p>
    </>
  )
}
