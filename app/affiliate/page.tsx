'use client'

import { useState } from 'react'
import Link from 'next/link'
import Navbar from '@/components/Navbar'

type FormState = {
  name: string
  email: string
  telegram: string
  x_handle: string
  audience_size: string
  audience_type: string
  promo_plan: string
  payout_wallet: string
  website: string
}

const initialForm: FormState = {
  name: '', email: '', telegram: '', x_handle: '', audience_size: '', audience_type: '', promo_plan: '', payout_wallet: '', website: '',
}

const faqs = [
  {
    q: 'How does the commission work?',
    a: 'You earn a recurring monthly commission for every paying user you refer, for as long as they stay subscribed. The full rate and structure are shared privately after your application is approved.',
  },
  {
    q: 'When and how do I get paid?',
    a: 'Payouts are processed manually each month after a 30-day hold period. We pay in crypto to your on-chain wallet. Full payout instructions are provided after approval.',
  },
  {
    q: 'What audience size do I need?',
    a: "There is no hard minimum. We care more about audience quality and niche fit than raw follower count. A focused Telegram group of 500 Base traders outperforms a generic channel of 50k.",
  },
  {
    q: 'How long does review take?',
    a: 'We review every application manually. Most decisions are made within 24–72 hours. Incomplete or rushed applications take longer — take your time and be specific.',
  },
  {
    q: 'Can large creators get custom terms?',
    a: 'Yes. Serious partners with high-volume or premium audiences can discuss custom commission structures, early access, and co-marketing. Mention this in your application and we will follow up.',
  },
]

const WHO = [
  { label: 'Base KOLs', tier: 'PRIMARY' },
  { label: 'X / Twitter creators', tier: 'PRIMARY' },
  { label: 'Telegram community owners', tier: 'PRIMARY' },
  { label: 'Onchain analysts', tier: 'PRIMARY' },
  { label: 'Trading group operators', tier: 'STANDARD' },
  { label: 'DeFi educators', tier: 'STANDARD' },
  { label: 'Newsletter writers', tier: 'STANDARD' },
  { label: 'TikTok / YouTube crypto creators', tier: 'STANDARD' },
  { label: 'Discord community leaders', tier: 'STANDARD' },
]

export default function AffiliatePage() {
  const [form, setForm] = useState<FormState>(initialForm)
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openFaq, setOpenFaq] = useState<number | null>(null)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setSuccess(null)
    setError(null)
    try {
      const res = await fetch('/api/affiliate/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        setError(typeof data?.error === 'string' ? data.error : 'Submission is temporarily unavailable. Please try again soon.')
      } else {
        setSuccess('Application received. We review every submission manually and will reach out within 72 hours.')
        setForm(initialForm)
      }
    } catch {
      setError('Submission is temporarily unavailable. Please try again soon.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <style>{`
        :root { --teal:#2DD4BF; --purple:#8b5cf6; --cyan:#67e8f9; --gold:#f59e0b; --pink:#ec4899; }

        .aff-page {
          background:
            radial-gradient(ellipse 1400px 800px at -5% -5%,  rgba(139,92,246,.14) 0%, transparent 52%),
            radial-gradient(ellipse 1000px 700px at 105%  2%, rgba(45,212,191,.10) 0%, transparent 52%),
            radial-gradient(ellipse  700px 500px at  50% 98%, rgba(99,102,241,.08) 0%, transparent 58%),
            radial-gradient(ellipse  500px 300px at  20% 55%, rgba(236,72,153,.05) 0%, transparent 55%),
            #04060d;
        }
        .aff-grid { display:grid; gap:52px 40px; }

        /* inputs */
        .aff-input {
          width:100%; background:rgba(6,12,26,.8); border:1px solid rgba(148,163,184,.18);
          border-radius:10px; padding:13px 15px; color:#e2e8f0; font-size:14px;
          outline:none; transition:border-color .18s, box-shadow .18s; box-sizing:border-box;
        }
        .aff-input:focus { border-color:rgba(45,212,191,.65)!important; box-shadow:0 0 0 3px rgba(45,212,191,.12); }
        .aff-input::placeholder { color:#334155; }
        .aff-label { display:grid; gap:8px; font-size:11px; font-weight:600; letter-spacing:.09em; color:#475569; font-family:var(--font-plex-mono,monospace); }
        .aff-label-req { color:#f87171; margin-left:3px; }

        /* cards */
        .aff-glass { background:linear-gradient(160deg,rgba(13,21,40,.75),rgba(5,8,18,.92)); border:1px solid rgba(255,255,255,.07); border-radius:20px; }
        .aff-glass-teal { background:linear-gradient(145deg,rgba(13,21,40,.82),rgba(5,8,18,.95)); border:1px solid rgba(45,212,191,.18); border-radius:20px; box-shadow:0 0 80px rgba(45,212,191,.06),inset 0 1px 0 rgba(255,255,255,.05); }
        .aff-glass-purple { background:linear-gradient(145deg,rgba(13,21,40,.82),rgba(5,8,18,.95)); border:1px solid rgba(139,92,246,.2); border-radius:20px; }

        /* benefit cards */
        .aff-benefit { border-radius:16px; padding:22px 20px; transition:transform .22s,box-shadow .22s; position:relative; overflow:hidden; }
        .aff-benefit::before { content:''; position:absolute; inset:0; border-radius:inherit; opacity:0; transition:opacity .22s; background:radial-gradient(circle at 50% 0%,rgba(255,255,255,.04),transparent 60%); }
        .aff-benefit:hover { transform:translateY(-4px); box-shadow:0 20px 50px rgba(0,0,0,.45); }
        .aff-benefit:hover::before { opacity:1; }

        /* who chips */
        .aff-who-primary { border:1px solid rgba(45,212,191,.38); background:linear-gradient(135deg,rgba(45,212,191,.1),rgba(45,212,191,.04)); color:#2DD4BF; border-radius:10px; padding:10px 16px; font-size:12px; font-family:var(--font-plex-mono,monospace); font-weight:600; letter-spacing:.04em; white-space:nowrap; }
        .aff-who-standard { border:1px solid rgba(148,163,184,.15); background:rgba(255,255,255,.025); color:#94a3b8; border-radius:10px; padding:10px 16px; font-size:12px; font-family:var(--font-plex-mono,monospace); white-space:nowrap; }

        /* step connector */
        .aff-connector { position:absolute; top:42px; left:calc(50% + 44px); right:calc(-50% + 44px); height:1px; background:linear-gradient(90deg,rgba(45,212,191,.5),rgba(139,92,246,.5)); z-index:0; }

        /* faq */
        .aff-faq { border:1px solid rgba(148,163,184,.1); border-radius:14px; overflow:hidden; background:rgba(255,255,255,.02); transition:border-color .18s; }
        .aff-faq:hover { border-color:rgba(148,163,184,.2); }
        .aff-faq-btn { width:100%; background:none; border:none; cursor:pointer; padding:20px 22px; display:flex; justify-content:space-between; align-items:center; gap:16px; text-align:left; }

        /* tag */
        .aff-tag { display:inline-flex; align-items:center; gap:8px; padding:5px 15px; border-radius:999px; font-size:11px; font-weight:700; letter-spacing:.14em; font-family:var(--font-plex-mono,monospace); }

        /* stat strip */
        .aff-stat { border-radius:16px; padding:20px 18px; }

        /* section label */
        .aff-eyebrow { font-family:var(--font-plex-mono,monospace); font-size:10px; font-weight:700; letter-spacing:.2em; margin:0 0 10px; }

        /* section divider glow */
        .aff-divider { height:1px; background:linear-gradient(90deg,transparent,rgba(139,92,246,.25),transparent); margin:0 0 72px; }

        @media (max-width:960px) {
          .aff-hero-grid, .aff-apply-grid { grid-template-columns:1fr!important; }
          .aff-steps-grid { grid-template-columns:1fr!important; }
          .aff-connector { display:none; }
        }
        @media (max-width:760px) {
          .aff-stats-grid { grid-template-columns:repeat(2,1fr)!important; }
          .aff-benefits-grid { grid-template-columns:repeat(2,minmax(0,1fr))!important; }
          .aff-tools-grid { grid-template-columns:repeat(2,minmax(0,1fr))!important; }
          .aff-form-cols { grid-template-columns:1fr!important; }
        }
        @media (max-width:480px) {
          .aff-stats-grid { grid-template-columns:1fr!important; }
          .aff-benefits-grid { grid-template-columns:1fr!important; }
          .aff-tools-grid { grid-template-columns:1fr!important; }
        }
      `}</style>

      <Navbar />

      <div className="aff-page" style={{ minHeight:'100vh', color:'#f8fafc', padding:'80px 16px 120px', position:'relative', overflow:'hidden' }}>

        {/* Grid background */}
        <div style={{ position:'absolute', inset:0, backgroundImage:'linear-gradient(rgba(99,102,241,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(99,102,241,.035) 1px,transparent 1px)', backgroundSize:'56px 56px', maskImage:'radial-gradient(ellipse 90% 80% at 50% 40%,black 20%,transparent 80%)', pointerEvents:'none' }} />
        {/* Top accent line */}
        <div style={{ position:'absolute', top:0, left:0, right:0, height:'1px', background:'linear-gradient(90deg,transparent 0%,rgba(45,212,191,.5) 40%,rgba(139,92,246,.5) 60%,transparent 100%)' }} />

        <div style={{ maxWidth:1140, margin:'0 auto', position:'relative', zIndex:1 }}>

          {/* ══ HERO ════════════════════════════════════════════════════════════ */}
          <section className="aff-hero-grid" style={{ display:'grid', gridTemplateColumns:'1.15fr .85fr', gap:'48px', alignItems:'center', marginBottom:'56px', paddingTop:'16px' }}>

            {/* Left */}
            <div>
              <div className="aff-tag" style={{ marginBottom:'28px', border:'1px solid rgba(45,212,191,.35)', background:'rgba(45,212,191,.08)', color:'#2DD4BF' }}>
                <span style={{ width:'7px', height:'7px', borderRadius:'50%', background:'#2DD4BF', boxShadow:'0 0 10px rgba(45,212,191,1)', flexShrink:0, animation:'none' }} />
                FOUNDING AFFILIATE PROGRAM
              </div>

              <h1 style={{ margin:'0 0 20px', fontSize:'clamp(38px,5.4vw,66px)', fontWeight:800, lineHeight:1.03, letterSpacing:'-.028em' }}>
                Turn your audience<br />into{' '}
                <span style={{ background:'linear-gradient(135deg,#2DD4BF 0%,#8b5cf6 60%,#ec4899 100%)', WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent' }}>
                  recurring revenue.
                </span>
              </h1>

              <p style={{ margin:'0 0 34px', color:'#94a3b8', fontSize:'16px', lineHeight:1.8, maxWidth:'500px' }}>
                Partner with ChainLens AI and earn recurring monthly commissions by referring traders, token scanners, whale watchers, and Base-native communities to the CORTEX intelligence terminal.
              </p>

              <div style={{ display:'flex', gap:'12px', flexWrap:'wrap', marginBottom:'28px' }}>
                <a href="#apply" style={{ display:'inline-flex', alignItems:'center', gap:'8px', padding:'14px 30px', borderRadius:'10px', fontWeight:700, fontSize:'14px', letterSpacing:'.05em', background:'linear-gradient(135deg,#2DD4BF,#8b5cf6)', color:'#04060d', textDecoration:'none', boxShadow:'0 4px 24px rgba(45,212,191,.25)' }}>
                  Apply Now
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M12 5l7 7-7 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </a>
                <a href="#how-it-works" style={{ display:'inline-flex', alignItems:'center', padding:'14px 24px', borderRadius:'10px', fontWeight:600, fontSize:'14px', border:'1px solid rgba(148,163,184,.22)', color:'#cbd5e1', background:'rgba(255,255,255,.025)', textDecoration:'none' }}>
                  How It Works
                </a>
              </div>

              <a href="mailto:chainlensai@gmail.com" style={{ fontSize:'12px', color:'rgba(103,232,249,.6)', textDecoration:'none', fontFamily:'var(--font-plex-mono,monospace)' }}>
                Questions? Contact us →
              </a>
            </div>

            {/* Right — Partner Command Center */}
            <div className="aff-glass-teal" style={{ padding:'0', overflow:'hidden' }}>
              {/* Header bar */}
              <div style={{ padding:'16px 22px', borderBottom:'1px solid rgba(45,212,191,.12)', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                <span style={{ fontFamily:'var(--font-plex-mono,monospace)', fontSize:'10px', fontWeight:700, letterSpacing:'.18em', color:'#2DD4BF' }}>PARTNER COMMAND CENTER</span>
                <span style={{ display:'inline-flex', alignItems:'center', gap:'5px', fontSize:'10px', color:'#34d399', fontFamily:'var(--font-plex-mono,monospace)' }}>
                  <span style={{ width:'5px', height:'5px', borderRadius:'50%', background:'#34d399', boxShadow:'0 0 6px #34d399' }} />
                  OPEN
                </span>
              </div>

              {/* 30% hero number */}
              <div style={{ padding:'28px 22px 20px', borderBottom:'1px solid rgba(255,255,255,.05)', textAlign:'center' }}>
                <p style={{ margin:'0 0 2px', fontFamily:'var(--font-plex-mono,monospace)', fontSize:'10px', letterSpacing:'.18em', color:'#475569' }}>RECURRING COMMISSION RATE</p>
                <div style={{ fontSize:'72px', fontWeight:800, lineHeight:1, letterSpacing:'-.04em', background:'linear-gradient(135deg,#2DD4BF 0%,#8b5cf6 100%)', WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent' }}>30%</div>
                <p style={{ margin:'6px 0 0', fontSize:'12px', color:'#475569' }}>per referred subscription · every month</p>
              </div>

              {/* Info rows */}
              <div style={{ padding:'16px 22px', display:'grid', gap:'8px' }}>
                {([
                  ['Payouts',         'Monthly · Manual · Crypto'],
                  ['Approval',        'Manual review — 24–72h'],
                  ['Tracking',        'Referral / invite link'],
                  ['Custom terms',    'Available for top creators'],
                  ['Best fit',        'Base KOLs · X · Telegram'],
                ] as [string, string][]).map(([k, v]) => (
                  <div key={k} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:'10px', padding:'9px 12px', borderRadius:'9px', background:'rgba(255,255,255,.03)', border:'1px solid rgba(255,255,255,.05)' }}>
                    <span style={{ color:'#334155', fontSize:'11px', fontFamily:'var(--font-plex-mono,monospace)', whiteSpace:'nowrap' }}>{k}</span>
                    <span style={{ color:'#e2e8f0', fontSize:'11px', fontWeight:600, textAlign:'right' }}>{v}</span>
                  </div>
                ))}
              </div>

              {/* Footer note */}
              <div style={{ margin:'0 22px 22px', padding:'12px 14px', borderRadius:'10px', background:'rgba(45,212,191,.05)', border:'1px solid rgba(45,212,191,.12)' }}>
                <p style={{ margin:0, fontSize:'11px', color:'#67e8f9', lineHeight:1.65 }}>
                  Full program terms and referral details are shared privately after approval.
                </p>
              </div>
            </div>
          </section>

          {/* ══ VALUE STRIP ═════════════════════════════════════════════════════ */}
          <div className="aff-stats-grid" style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:'12px', marginBottom:'80px' }}>
            {([
              { accent:'#2DD4BF', rgb:'45,212,191',  value:'30%',         label:'Recurring commission',   sub:'Earn while users stay subscribed' },
              { accent:'#8b5cf6', rgb:'139,92,246',  value:'Monthly',     label:'Manual payouts',         sub:'Paid in crypto during beta' },
              { accent:'#f59e0b', rgb:'245,158,11',  value:'Quality',     label:'First program',          sub:'Partners reviewed manually' },
              { accent:'#67e8f9', rgb:'103,232,249', value:'Creator',     label:'Native program',         sub:'Built for X, Telegram, and Base' },
            ] as Array<{accent:string;rgb:string;value:string;label:string;sub:string}>).map(({ accent, rgb, value, label, sub }) => (
              <div key={label} className="aff-stat" style={{ background:`linear-gradient(145deg,rgba(${rgb},.07),rgba(${rgb},.02))`, border:`1px solid rgba(${rgb},.22)`, boxShadow:`0 0 40px rgba(${rgb},.06)` }}>
                <p style={{ margin:'0 0 4px', fontSize:'22px', fontWeight:800, letterSpacing:'-.02em', color: accent }}>{value}</p>
                <p style={{ margin:'0 0 2px', fontSize:'13px', fontWeight:700, color:'#e2e8f0' }}>{label}</p>
                <p style={{ margin:0, fontSize:'11px', color:'#475569', lineHeight:1.5 }}>{sub}</p>
              </div>
            ))}
          </div>

          <div className="aff-divider" />

          {/* ══ WHAT PARTNERS GET ════════════════════════════════════════════════ */}
          <section style={{ marginBottom:'80px' }}>
            <div style={{ textAlign:'center', marginBottom:'44px' }}>
              <p className="aff-eyebrow" style={{ color:'#8b5cf6' }}>WHAT PARTNERS GET</p>
              <h2 style={{ margin:0, fontSize:'clamp(24px,3.2vw,38px)', fontWeight:800, letterSpacing:'-.018em', color:'#f1f5f9' }}>Built to reward serious partners</h2>
            </div>
            <div className="aff-benefits-grid" style={{ display:'grid', gridTemplateColumns:'repeat(3,minmax(0,1fr))', gap:'14px' }}>
              {([
                { accent:'#2DD4BF', rgb:'45,212,191',  svg:<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" stroke="#2DD4BF" strokeWidth="2" strokeLinecap="round"/></svg>, title:'30% Recurring Commission',  body:'Earn monthly on every referred subscription — not just first sale. Genuine recurring income.' },
                { accent:'#8b5cf6', rgb:'139,92,246',  svg:<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="18" rx="2" stroke="#8b5cf6" strokeWidth="2"/><path d="M16 2v4M8 2v4M3 10h18" stroke="#8b5cf6" strokeWidth="2" strokeLinecap="round"/></svg>, title:'Monthly Manual Payouts',     body:'Commissions paid each month in crypto. Full payout structure shared after you are approved.' },
                { accent:'#f59e0b', rgb:'245,158,11',  svg:<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>, title:'Founding Partner Access',    body:'Early program = founding status. Top founding partners get first access to campaigns and new features.' },
                { accent:'#ec4899', rgb:'236,72,153',  svg:<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" stroke="#ec4899" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>, title:'Premium Product to Promote',  body:'Clark AI, CORTEX scoring, whale tracking, token scanner. Real onchain utility that genuinely converts.' },
                { accent:'#67e8f9', rgb:'103,232,249', svg:<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" stroke="#67e8f9" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>, title:'Custom Terms for Top Creators', body:'High-volume or premium-audience partners can negotiate custom commission structures and co-marketing.' },
                { accent:'#a78bfa', rgb:'167,139,250', svg:<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" stroke="#a78bfa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>, title:'Direct Partner Support',       body:'Approved partners get direct communication. No ticket queues — just a real conversation when you need it.' },
              ] as Array<{accent:string;rgb:string;svg:React.ReactNode;title:string;body:string}>).map(({ accent, rgb, svg, title, body }) => (
                <article key={title} className="aff-benefit" style={{ background:`linear-gradient(155deg,rgba(13,21,40,.75),rgba(5,8,18,.92))`, border:`1px solid rgba(${rgb},.15)`, borderTop:`2px solid ${accent}`, boxShadow:`0 0 30px rgba(${rgb},.04)` }}>
                  <div style={{ width:'40px', height:'40px', borderRadius:'10px', background:`rgba(${rgb},.1)`, display:'flex', alignItems:'center', justifyContent:'center', marginBottom:'16px' }}>
                    {svg}
                  </div>
                  <h3 style={{ margin:'0 0 8px', fontSize:'14px', fontWeight:700, color:'#f1f5f9', lineHeight:1.35 }}>{title}</h3>
                  <p style={{ margin:0, color:'#475569', fontSize:'12px', lineHeight:1.7 }}>{body}</p>
                </article>
              ))}
            </div>
          </section>

          <div className="aff-divider" />

          {/* ══ WHO SHOULD APPLY ════════════════════════════════════════════════ */}
          <section style={{ marginBottom:'80px' }}>
            <div style={{ textAlign:'center', marginBottom:'40px' }}>
              <p className="aff-eyebrow" style={{ color:'#2DD4BF' }}>WHO SHOULD APPLY</p>
              <h2 style={{ margin:'0 0 10px', fontSize:'clamp(24px,3.2vw,38px)', fontWeight:800, letterSpacing:'-.018em', color:'#f1f5f9' }}>Built for crypto creators with real attention</h2>
              <p style={{ margin:0, color:'#475569', fontSize:'14px', maxWidth:'480px', marginLeft:'auto', marginRight:'auto', lineHeight:1.7 }}>Quality over quantity. We prioritise engaged, niche communities over generic large followings.</p>
            </div>
            <div style={{ display:'flex', flexWrap:'wrap', gap:'10px', justifyContent:'center', maxWidth:'780px', margin:'0 auto' }}>
              {WHO.map(({ label, tier }) => (
                <span key={label} className={tier === 'PRIMARY' ? 'aff-who-primary' : 'aff-who-standard'}>{label}</span>
              ))}
            </div>
            <p style={{ textAlign:'center', marginTop:'20px', fontSize:'11px', color:'#334155', fontFamily:'var(--font-plex-mono,monospace)', letterSpacing:'.08em' }}>
              Highlighted = highest-fit audience types
            </p>
          </section>

          <div className="aff-divider" />

          {/* ══ HOW IT WORKS ════════════════════════════════════════════════════ */}
          <section id="how-it-works" style={{ marginBottom:'80px' }}>
            <div style={{ textAlign:'center', marginBottom:'44px' }}>
              <p className="aff-eyebrow" style={{ color:'#8b5cf6' }}>THE PROCESS</p>
              <h2 style={{ margin:0, fontSize:'clamp(24px,3.2vw,38px)', fontWeight:800, letterSpacing:'-.018em', color:'#f1f5f9' }}>Simple. Transparent. Manual.</h2>
            </div>
            <div className="aff-steps-grid" style={{ display:'grid', gridTemplateColumns:'repeat(3,minmax(0,1fr))', gap:'16px', position:'relative' }}>
              {([
                { n:'01', accent:'#2DD4BF', rgb:'45,212,191',  title:'Apply',           body:'Tell us about your audience, platforms, and how you would promote ChainLens. Be specific — it helps your application.' },
                { n:'02', accent:'#8b5cf6', rgb:'139,92,246',  title:'Get Approved',    body:'We manually review every application for partner fit to protect the brand and keep the program quality-first.' },
                { n:'03', accent:'#67e8f9', rgb:'103,232,249', title:'Refer and Earn',  body:'Approved partners receive referral details and earn recurring commissions from every qualified subscription they bring.' },
              ] as Array<{n:string;accent:string;rgb:string;title:string;body:string}>).map(({ n, accent, rgb, title, body }, i) => (
                <article key={n} style={{ background:`linear-gradient(155deg,rgba(13,21,40,.7),rgba(5,8,18,.9))`, border:`1px solid rgba(${rgb},.15)`, borderRadius:'18px', padding:'32px 26px', position:'relative', zIndex:1 }}>
                  {i < 2 && <div className="aff-connector" />}
                  {/* Numbered circle */}
                  <div style={{ width:'58px', height:'58px', borderRadius:'50%', background:`rgba(${rgb},.08)`, border:`1.5px solid rgba(${rgb},.5)`, boxShadow:`0 0 20px rgba(${rgb},.15)`, display:'flex', alignItems:'center', justifyContent:'center', marginBottom:'22px', fontFamily:'var(--font-plex-mono,monospace)', fontSize:'16px', fontWeight:700, color:accent }}>
                    {n}
                  </div>
                  <h3 style={{ margin:'0 0 10px', fontSize:'19px', fontWeight:700, color:'#f1f5f9' }}>{title}</h3>
                  <p style={{ margin:0, color:'#475569', fontSize:'13px', lineHeight:1.75 }}>{body}</p>
                </article>
              ))}
            </div>
          </section>

          <div className="aff-divider" />

          {/* ══ WHY PARTNERS PROMOTE ═══════════════════════════════════════════ */}
          <section style={{ marginBottom:'80px' }}>
            <div style={{ textAlign:'center', marginBottom:'18px' }}>
              <p className="aff-eyebrow" style={{ color:'#f59e0b' }}>WHY PARTNERS PROMOTE US</p>
              <h2 style={{ margin:'0 0 10px', fontSize:'clamp(24px,3.2vw,38px)', fontWeight:800, letterSpacing:'-.018em', color:'#f1f5f9' }}>Real tools. Real value. Easy to promote.</h2>
              <p style={{ margin:'0 auto 40px', color:'#475569', fontSize:'14px', maxWidth:'520px', lineHeight:1.7 }}>
                ChainLens gives your audience real utility — not another noisy call group, hype bot, or empty dashboard.
              </p>
            </div>
            <div className="aff-tools-grid" style={{ display:'grid', gridTemplateColumns:'repeat(4,minmax(0,1fr))', gap:'12px' }}>
              {([
                { icon:'🔍', accent:'#2DD4BF', rgb:'45,212,191',  label:'Token Scanner',       desc:'Instant contract analysis with CORTEX AI risk scoring' },
                { icon:'👛', accent:'#8b5cf6', rgb:'139,92,246',  label:'Wallet Scanner',      desc:'Deep-dive any wallet — age, activity, PnL, history' },
                { icon:'🐋', accent:'#67e8f9', rgb:'103,232,249', label:'Whale Alerts',        desc:'Live alerts when major wallets move on Base' },
                { icon:'🚀', accent:'#f59e0b', rgb:'245,158,11',  label:'Pump Alerts',         desc:'Early signals on emerging momentum tokens on Base' },
                { icon:'🔬', accent:'#ec4899', rgb:'236,72,153',  label:'Dev Wallet Detector', desc:'Identify insider wallets and dev activity pre-launch' },
                { icon:'💧', accent:'#a78bfa', rgb:'167,139,250', label:'Liquidity Safety',    desc:'Scan token liquidity depth, locks, and rug risk' },
                { icon:'📡', accent:'#34d399', rgb:'52,211,153',  label:'Base Radar',          desc:'Live feed of new token launches across Base chain' },
                { icon:'🤖', accent:'#2DD4BF', rgb:'45,212,191',  label:'Clark AI',            desc:'Conversational CORTEX intelligence for any onchain query' },
              ] as Array<{icon:string;accent:string;rgb:string;label:string;desc:string}>).map(({ icon, accent, rgb, label, desc }) => (
                <div key={label} style={{ background:`linear-gradient(155deg,rgba(13,21,40,.7),rgba(5,8,18,.88))`, border:`1px solid rgba(${rgb},.14)`, borderRadius:'14px', padding:'18px 16px', transition:'transform .2s,box-shadow .2s' }}
                  onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.transform='translateY(-3px)'; (e.currentTarget as HTMLDivElement).style.boxShadow=`0 12px 30px rgba(${rgb},.12)`; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.transform=''; (e.currentTarget as HTMLDivElement).style.boxShadow=''; }}>
                  <div style={{ fontSize:'22px', marginBottom:'10px' }}>{icon}</div>
                  <p style={{ margin:'0 0 5px', fontSize:'13px', fontWeight:700, color: accent }}>{label}</p>
                  <p style={{ margin:0, fontSize:'11px', color:'#334155', lineHeight:1.65 }}>{desc}</p>
                </div>
              ))}
            </div>
          </section>

          <div className="aff-divider" />

          {/* ══ APPLICATION FORM ════════════════════════════════════════════════ */}
          <section id="apply" className="aff-apply-grid" style={{ display:'grid', gridTemplateColumns:'1.2fr .8fr', gap:'20px', marginBottom:'80px' }}>

            {/* Form card */}
            <div className="aff-glass" style={{ padding:'40px 36px', boxShadow:'0 0 100px rgba(45,212,191,.05)' }}>
              {/* Accent top border */}
              <div style={{ height:'2px', background:'linear-gradient(90deg,#2DD4BF,#8b5cf6)', borderRadius:'2px 2px 0 0', margin:'-40px -36px 32px', position:'relative' }} />

              <p className="aff-eyebrow" style={{ color:'#2DD4BF', marginBottom:'8px' }}>PARTNER APPLICATION</p>
              <h2 style={{ margin:'0 0 10px', fontSize:'clamp(20px,2.6vw,28px)', fontWeight:800, letterSpacing:'-.018em', color:'#f1f5f9' }}>Apply to become a ChainLens affiliate</h2>
              <p style={{ margin:'0 0 30px', color:'#475569', fontSize:'14px', lineHeight:1.7 }}>
                We review every application manually. Tell us who your audience is, where you create content, and why ChainLens fits your community.
              </p>

              <form onSubmit={onSubmit}>
                {/* Honeypot */}
                <input type="text" name="website" value={form.website} onChange={e => setForm({ ...form, website: e.target.value })} tabIndex={-1} autoComplete="off" style={{ position:'absolute', left:'-9999px', opacity:0 }} aria-hidden="true" />

                <div className="aff-form-cols" style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'14px', marginBottom:'14px' }}>
                  {([
                    { label:'Full Name',             key:'name',          required:true,  placeholder:'Your name' },
                    { label:'Email Address',         key:'email',         required:true,  type:'email', placeholder:'you@example.com' },
                    { label:'X / Twitter Handle',    key:'x_handle',      required:true,  placeholder:'@yourhandle' },
                    { label:'Telegram (optional)',   key:'telegram',      required:false, placeholder:'@yourusername' },
                    { label:'Audience Size',         key:'audience_size', required:true,  placeholder:'e.g. 12,000 X followers' },
                    { label:'Audience Type / Niche', key:'audience_type', required:true,  placeholder:'e.g. Base traders, DeFi analysts' },
                    { label:'Payout Wallet (optional)', key:'payout_wallet', required:false, placeholder:'0x…' },
                  ] as Array<{label:string;key:string;required:boolean;type?:string;placeholder:string}>).map(({ label, key, required, type, placeholder }) => (
                    <label key={key} className="aff-label">
                      {label}{required && <span className="aff-label-req">*</span>}
                      <input className="aff-input" type={type ?? 'text'} required={required} placeholder={placeholder} value={form[key as keyof FormState]} onChange={e => setForm({ ...form, [key]: e.target.value })} />
                    </label>
                  ))}
                </div>

                <label className="aff-label" style={{ marginBottom:'22px' }}>
                  How would you promote ChainLens?<span className="aff-label-req">*</span>
                  <textarea className="aff-input" required rows={5} placeholder="Tell us your exact plan — content style, platform, audience fit, post frequency, etc." value={form.promo_plan} onChange={e => setForm({ ...form, promo_plan: e.target.value })} style={{ resize:'vertical', fontFamily:'inherit' }} />
                </label>

                {success && (
                  <div style={{ marginBottom:'20px', padding:'16px 18px', borderRadius:'12px', background:'rgba(45,212,191,.06)', border:'1px solid rgba(45,212,191,.28)', display:'flex', gap:'12px', alignItems:'flex-start' }}>
                    <span style={{ fontSize:'16px', flexShrink:0 }}>✓</span>
                    <p style={{ margin:0, color:'#2dd4bf', fontSize:'13px', lineHeight:1.65 }}>{success}</p>
                  </div>
                )}
                {error && (
                  <div style={{ marginBottom:'20px', padding:'16px 18px', borderRadius:'12px', background:'rgba(248,113,113,.06)', border:'1px solid rgba(248,113,113,.28)' }}>
                    <p style={{ margin:0, color:'#fca5a5', fontSize:'13px', lineHeight:1.65 }}>{error}</p>
                  </div>
                )}

                <button type="submit" disabled={loading} style={{ width:'100%', border:0, borderRadius:'11px', padding:'15px 20px', fontWeight:700, fontSize:'15px', letterSpacing:'.06em', background: loading ? 'rgba(45,212,191,.35)' : 'linear-gradient(135deg,#2DD4BF 0%,#8b5cf6 100%)', color:'#04060d', cursor: loading ? 'not-allowed' : 'pointer', boxShadow: loading ? 'none' : '0 4px 24px rgba(45,212,191,.22)', transition:'box-shadow .2s,opacity .2s' }}>
                  {loading ? 'Submitting…' : 'Submit Application →'}
                </button>
              </form>
            </div>

            {/* Sidebar */}
            <div style={{ display:'grid', gap:'14px', alignContent:'start' }}>
              {/* Program notes */}
              <div className="aff-glass" style={{ padding:'22px 20px' }}>
                <p className="aff-eyebrow" style={{ color:'#67e8f9', marginBottom:'14px' }}>PROGRAM NOTES</p>
                <ul style={{ margin:0, paddingLeft:'18px', color:'#64748b', fontSize:'13px', lineHeight:2 }}>
                  <li>Commission details shared after approval.</li>
                  <li>Quality audiences prioritised over raw size.</li>
                  <li>No fake tracking or inflated guarantees.</li>
                  <li>Manual review — every application, every time.</li>
                </ul>
              </div>

              {/* Review timeline */}
              <div className="aff-glass-purple" style={{ padding:'22px 20px' }}>
                <p className="aff-eyebrow" style={{ color:'#a78bfa', marginBottom:'16px' }}>REVIEW TIMELINE</p>
                {([['Apply', 'Immediately'], ['Under review', '0 – 24h'], ['Decision', 'Sent by email'], ['Onboarding', 'Day of approval']] as [string,string][]).map(([step, time], i, arr) => (
                  <div key={step} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'9px 0', borderBottom: i < arr.length - 1 ? '1px solid rgba(255,255,255,.05)' : 'none' }}>
                    <span style={{ color:'#334155', fontSize:'12px', fontFamily:'var(--font-plex-mono,monospace)' }}>{step}</span>
                    <span style={{ color:'#e2e8f0', fontSize:'12px', fontWeight:700 }}>{time}</span>
                  </div>
                ))}
              </div>

              {/* Contact */}
              <div className="aff-glass" style={{ padding:'18px 20px' }}>
                <p className="aff-eyebrow" style={{ color:'#94a3b8', marginBottom:'10px' }}>CONTACT</p>
                <a href="mailto:chainlensai@gmail.com" style={{ color:'#67e8f9', fontSize:'13px', fontWeight:600, textDecoration:'none', display:'block', marginBottom:'14px' }}>chainlensai@gmail.com</a>
                <Link href="/pricing" style={{ color:'rgba(148,163,184,.6)', fontSize:'12px', textDecoration:'none' }}>See what you're promoting → Pricing</Link>
              </div>
            </div>
          </section>

          {/* ══ FAQ ══════════════════════════════════════════════════════════════ */}
          <section style={{ marginBottom:'80px', maxWidth:'740px', margin:'0 auto 80px' }}>
            <div style={{ textAlign:'center', marginBottom:'40px' }}>
              <p className="aff-eyebrow" style={{ color:'#8b5cf6' }}>FAQ</p>
              <h2 style={{ margin:0, fontSize:'clamp(24px,3.2vw,36px)', fontWeight:800, letterSpacing:'-.018em', color:'#f1f5f9' }}>Common questions</h2>
            </div>
            <div style={{ display:'grid', gap:'8px' }}>
              {faqs.map((item, i) => (
                <div key={i} className="aff-faq">
                  <button className="aff-faq-btn" onClick={() => setOpenFaq(openFaq === i ? null : i)}>
                    <span style={{ fontSize:'14px', fontWeight:600, color: openFaq === i ? '#e2e8f0' : '#94a3b8', lineHeight:1.5, transition:'color .15s' }}>{item.q}</span>
                    <span style={{ color: openFaq === i ? '#2DD4BF' : '#334155', fontSize:'20px', flexShrink:0, lineHeight:1, transition:'transform .2s,color .15s', display:'block', transform: openFaq === i ? 'rotate(45deg)' : 'none' }}>+</span>
                  </button>
                  {openFaq === i && (
                    <div style={{ padding:'0 22px 20px' }}>
                      <p style={{ margin:0, color:'#64748b', fontSize:'13px', lineHeight:1.8 }}>{item.a}</p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>

          {/* ══ FOOTER ══════════════════════════════════════════════════════════ */}
          <div style={{ borderTop:'1px solid rgba(255,255,255,.06)', paddingTop:'36px', textAlign:'center' }}>
            <div style={{ display:'flex', justifyContent:'center', gap:'28px', flexWrap:'wrap', marginBottom:'16px' }}>
              {([['Terminal','/terminal'],['Pricing','/pricing'],['Contact','/contact']] as [string,string][]).map(([label,href]) => (
                <Link key={href} href={href} style={{ color:'rgba(45,212,191,.6)', fontSize:'13px', textDecoration:'none', fontWeight:600, letterSpacing:'.04em' }}>{label}</Link>
              ))}
              <a href="mailto:chainlensai@gmail.com" style={{ color:'rgba(255,255,255,.25)', fontSize:'13px', textDecoration:'none' }}>chainlensai@gmail.com</a>
            </div>
            <p style={{ margin:0, color:'#1e293b', fontSize:'11px', fontFamily:'var(--font-plex-mono,monospace)', letterSpacing:'.08em' }}>
              © {new Date().getFullYear()} ChainLens AI — Base-native intelligence
            </p>
          </div>

        </div>
      </div>
    </>
  )
}
