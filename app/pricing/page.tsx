import Link from 'next/link'
import Image from 'next/image'

type Plan = {
  id: 'free' | 'pro' | 'elite'
  label: string
  price: string
  subtext: string
  sectionTitle: string
  features: string[]
  cta: string
  ctaClass: string
  badge?: string
  trial?: string
}

const plans: Plan[] = [
  { id: 'free', label: 'FREE', price: '$0', subtext: 'forever', sectionTitle: 'CORE FEATURES', features: ['Price, liquidity, volume, 24h change', 'Basic token info only', 'No AI verdict', 'No Wallet Scanner', 'No Dev Wallet Detector', 'No Pump Alerts', 'No Whale Alerts', 'No Base Radar'], cta: 'GET STARTED FREE', ctaClass: 'cta-free' },
  { id: 'pro', label: 'PRO', price: '$30', subtext: 'per month', sectionTitle: 'EVERYTHING IN FREE, PLUS', features: ['Full Token Scanner', 'Full Liquidity Safety', 'Wallet Scanner', 'Dev Wallet Detector', 'Pump Alerts', 'Whale Alerts', 'Base Radar', 'Clark AI — 50 prompts / day'], cta: 'START FREE TRIAL', ctaClass: 'cta-pro', badge: 'MOST POPULAR', trial: '7-DAY FREE TRIAL' },
  { id: 'elite', label: 'ELITE', price: '$60', subtext: 'per month', sectionTitle: 'EVERYTHING IN PRO, PLUS', features: ['Clark AI — unlimited prompts', 'Auto Clark verdict on every scan', 'Smart money tracking', 'Advanced whale alerts', 'Priority CORTEX processing', 'Early access to new features'], cta: 'UNLOCK ELITE', ctaClass: 'cta-elite', trial: '7-DAY FREE TRIAL' },
]

export default function PricingPage() {
  return (
    <div style={{ minHeight: '100vh', background: '#03060f', color: '#f8fafc', position: 'relative', overflow: 'hidden' }}>
      <style>{`
        .glass{background:linear-gradient(170deg,rgba(10,17,33,.88),rgba(5,9,20,.82));backdrop-filter:blur(12px);border:1px solid rgba(148,163,184,.18);border-radius:18px}
        .nav-pill{border-radius:999px;border:1px solid rgba(125,211,252,.22);background:linear-gradient(120deg,rgba(3,9,24,.86),rgba(14,22,39,.88));box-shadow:0 0 24px rgba(34,211,238,.08),0 0 26px rgba(168,85,247,.08),inset 0 0 0 1px rgba(255,255,255,.04)}
        .cta{display:block;text-align:center;border-radius:11px;padding:12px 14px;font-weight:800;font-size:12px;letter-spacing:.09em;text-decoration:none;transition:.2s transform,.2s box-shadow,.2s opacity}.cta:hover{transform:translateY(-2px)}
        .cta-free{border:1px solid rgba(148,163,184,.36);color:#e2e8f0;background:rgba(15,23,42,.55)}
        .cta-pro{color:#fff;background:linear-gradient(98deg,#7c3aed,#a855f7,#ec4899);box-shadow:0 10px 28px rgba(168,85,247,.5)}
        .cta-elite{color:#221300;background:linear-gradient(120deg,#f59e0b,#fde047,#facc15);box-shadow:0 10px 30px rgba(251,191,36,.45)}
        .energy-right{position:absolute;right:-80px;top:120px;width:480px;height:360px;opacity:.17;background:repeating-linear-gradient(135deg,rgba(217,70,239,.45) 0 1px,transparent 1px 14px);filter:blur(1.2px)}
        .energy-left{position:absolute;left:-130px;top:120px;width:420px;height:340px;opacity:.12;background:radial-gradient(circle at 25% 50%, rgba(56,189,248,.28), transparent 65%)}
        @media(max-width:1250px){.hero{grid-template-columns:1fr !important}.plan-grid{grid-template-columns:repeat(2,minmax(0,1fr)) !important}.stats{max-width:340px}.intro{min-height:auto !important}}
        @media(max-width:860px){.plan-grid{grid-template-columns:1fr !important}.nav-links{display:none}}
      `}</style>

      <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(7,12,24,0.2) 0%, rgba(3,6,15,0.0) 55%)' }} />
      <div className='energy-right' />
      <div className='energy-left' />
      <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(circle at 18% 22%, rgba(34,211,238,.22), transparent 35%), radial-gradient(circle at 84% 20%, rgba(217,70,239,.22), transparent 34%), radial-gradient(circle at 60% 8%, rgba(129,140,248,.15), transparent 38%)' }} />
      <div style={{ position: 'absolute', inset: 'auto -28% -320px -28%', height: 620, background: 'radial-gradient(ellipse at 50% 10%, rgba(11,25,56,.96) 0%, rgba(7,14,33,.92) 38%, rgba(4,8,19,.55) 63%, rgba(3,6,15,.08) 86%, transparent 100%)' }} />
      <div style={{ position: 'absolute', left: '-24%', right: '-24%', bottom: -255, height: 520, borderTop: '2px solid rgba(56,189,248,.82)', borderRadius: '58% 58% 0 0 / 100% 100% 0 0', boxShadow: '0 -24px 95px rgba(34,211,238,.54), 0 -16px 130px rgba(59,130,246,.32)' }} />
      <div style={{ position: 'absolute', left: '-20%', right: '-20%', bottom: -276, height: 520, borderTop: '1px solid rgba(217,70,239,.48)', borderRadius: '54% 54% 0 0 / 100% 100% 0 0', boxShadow: '0 -10px 68px rgba(217,70,239,.2)' }} />
      <div style={{ position: 'absolute', left: '-14%', right: '-14%', bottom: -240, height: 400, background: 'radial-gradient(ellipse at 50% 0%, rgba(34,211,238,.14), rgba(147,197,253,.1) 28%, rgba(217,70,239,.08) 48%, transparent 78%)' }} />

      <div style={{ position: 'relative', zIndex: 2, maxWidth: 1620, margin: '0 auto', padding: '18px 22px 52px' }}>
        <nav className='nav-pill' style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 22px', marginBottom: 24 }}>
          <Link href='/' style={{ display: 'flex', alignItems: 'center', gap: 12, textDecoration: 'none' }}>
            <Image src='/cl-logo.png' alt='ChainLens logo' width={36} height={36} style={{ width: 36, height: 36, objectFit: 'contain' }} priority />
            <span>
              <span style={{ display: 'block', fontWeight: 800, letterSpacing: '.005em', lineHeight: 1, fontSize: 21 }}>
                <span style={{ color: '#f8fafc' }}>Chain</span><span style={{ background: 'linear-gradient(90deg,#7dd3fc,#a78bfa,#e879f9)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>Lens</span>
              </span>
              <span style={{ display: 'block', fontSize: 10, color: '#67e8f9', marginTop: 2 }}>AI Intelligence</span>
            </span>
          </Link>
          <div className='nav-links' style={{ display: 'flex', gap: 24, color: '#94a3b8', fontSize: 14 }}>
            <Link href='/dashboard/tokens' style={{ color: 'inherit', textDecoration: 'none' }}>Tools</Link><Link href='/terminal' style={{ color: 'inherit', textDecoration: 'none' }}>Terminal</Link><Link href='/pricing' style={{ color: '#e2e8f0', textDecoration: 'none' }}>Pricing</Link><Link href='/affiliate' style={{ color: 'inherit', textDecoration: 'none' }}>Affiliate</Link><Link href='/about' style={{ color: 'inherit', textDecoration: 'none' }}>About</Link>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}><span style={{ fontSize: 10, borderRadius: 999, border: '1px solid rgba(34,197,94,.45)', padding: '2px 8px', color: '#86efac', background: 'rgba(22,163,74,.12)' }}>LIVE</span><span style={{ fontSize: 11, color: '#67e8f9' }}>Powered by CORTEX</span><Link href='/app' style={{ marginLeft: 8, textDecoration: 'none', padding: '9px 14px', borderRadius: 999, border: '1px solid rgba(45,212,191,.54)', color: '#99f6e4', background: 'rgba(45,212,191,.13)', fontWeight: 700 }}>Get Access</Link></div>
        </nav>

        <section className='hero' style={{ display: 'grid', gridTemplateColumns: '1.02fr 2.58fr .72fr', gap: 12, alignItems: 'stretch' }}>
          <div className='intro' style={{ padding: '18px 12px 14px 6px', minHeight: 468 }}>
            <div style={{ color: '#67e8f9', fontSize: 11, letterSpacing: '.2em', marginBottom: 14 }}>• PRICING</div>
            <div style={{ fontSize: 'clamp(40px,3.6vw,66px)', lineHeight: .95, fontWeight: 900 }}>ONE PRICE.<br /><span style={{ background: 'linear-gradient(90deg,#22d3ee,#a855f7,#ec4899)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>WORLDWIDE.</span></div>
            <p style={{ marginTop: 14, color: '#94a3b8', lineHeight: 1.5, fontSize: 14 }}>No dark patterns. No regional pricing.<br />Cancel any time. Your data stays yours.</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>{['Secure Checkout', 'Cancel Anytime', 'Used by Base Traders'].map((chip) => <span key={chip} style={{ borderRadius: 999, border: '1px solid rgba(148,163,184,.28)', padding: '6px 10px', fontSize: 11, color: '#dbeafe', background: 'rgba(15,23,42,.55)', boxShadow: '0 0 16px rgba(34,211,238,.12)' }}>{chip}</span>)}</div>
            <div style={{ marginTop: 14, fontSize: 12, color: '#94a3b8' }}>Powered by <span style={{ color: '#e2e8f0', fontWeight: 700 }}>BASE</span></div>
          </div>

          <div className='plan-grid' style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 12 }}>
            {plans.map((plan) => <div key={plan.id} className='glass' style={{ padding: 16, minHeight: 468, borderColor: plan.id === 'pro' ? 'rgba(217,70,239,.72)' : plan.id === 'elite' ? 'rgba(251,191,36,.66)' : 'rgba(147,51,234,.36)', boxShadow: plan.id === 'pro' ? '0 0 48px rgba(217,70,239,.34),inset 0 0 0 1px rgba(217,70,239,.2)' : plan.id === 'elite' ? '0 0 48px rgba(251,191,36,.3),inset 0 0 0 1px rgba(250,204,21,.2)' : '0 0 24px rgba(168,85,247,.12)', position: 'relative', transform: plan.id === 'pro' ? 'translateY(-3px)' : 'none' }}>
              {plan.badge && <div style={{ position: 'absolute', top: -11, left: '50%', transform: 'translateX(-50%)', borderRadius: 999, background: 'linear-gradient(90deg,#a855f7,#ec4899)', color: '#fff', fontSize: 10, letterSpacing: '.12em', fontWeight: 800, padding: '4px 12px', boxShadow: '0 0 24px rgba(217,70,239,.6)' }}>{plan.badge}</div>}
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><div style={{ fontSize: 12, letterSpacing: '.18em', color: plan.id === 'elite' ? '#facc15' : plan.id === 'pro' ? '#a78bfa' : '#e879f9' }}>{plan.label}</div>{plan.trial && <span style={{ fontSize: 9, border: '1px solid rgba(148,163,184,.42)', color: '#cbd5e1', borderRadius: 999, padding: '4px 8px' }}>{plan.trial}</span>}</div>
              <div style={{ fontSize: 48, fontWeight: 800, marginTop: 8, color: plan.id === 'elite' ? '#fde68a' : '#fff', lineHeight: 1 }}>{plan.price}</div><div style={{ color: '#94a3b8', marginTop: 0, fontSize: 13 }}>{plan.subtext}</div>
              <div style={{ marginTop: 14, fontSize: 10, color: plan.id === 'elite' ? '#fcd34d' : plan.id === 'pro' ? '#67e8f9' : '#f0abfc', letterSpacing: '.15em' }}>{plan.sectionTitle}</div>
              <div style={{ display: 'grid', gap: 6, marginTop: 9, minHeight: 246 }}>{plan.features.map((f) => {const no = f.startsWith('No '); return <div key={f} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', color: no ? '#64748b' : '#dbeafe', fontSize: 12.5, lineHeight: 1.4 }}><span style={{ color: no ? '#475569' : plan.id === 'elite' ? '#facc15' : plan.id === 'pro' ? '#22d3ee' : '#c084fc' }}>{no ? '✕' : '✓'}</span><span>{f}</span></div>})}</div>
              {plan.id === 'elite' && <div style={{ border: '1px solid rgba(250,204,21,.4)', background: 'rgba(250,204,21,.1)', color: '#fde68a', borderRadius: 11, padding: 10, fontSize: 12, marginBottom: 10 }}>Everything in Pro included — plus full CORTEX intelligence.</div>}
              <Link href='/app' className={`cta ${plan.ctaClass}`}>{plan.cta}</Link>
            </div>)}
          </div>

          <aside className='glass stats' style={{ padding: 14, minHeight: 468, borderColor: 'rgba(34,211,238,.52)', boxShadow: '0 0 34px rgba(34,211,238,.22)' }}>
            <div style={{ color: '#67e8f9', fontSize: 10, letterSpacing: '.15em', marginBottom: 14, fontWeight: 700 }}>TRUSTED BY WINNING TRADERS</div>
            {[['50K+', 'Active Traders'], ['2M+', 'Scans Performed'], ['$2.4B+', 'Volume Analyzed'], ['99.9%', 'Uptime']].map(([v, k], i) => <div key={k} style={{ borderTop: i === 0 ? '1px solid rgba(148,163,184,.2)' : '1px solid rgba(148,163,184,.16)', padding: '14px 0' }}><div style={{ color: '#22d3ee', fontSize: 32, fontWeight: 800, lineHeight: 1 }}>{v}</div><div style={{ color: '#94a3b8', fontSize: 11 }}>{k}</div></div>)}
          </aside>
        </section>
      </div>
    </div>
  )
}
