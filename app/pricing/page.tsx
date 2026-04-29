import Link from 'next/link'

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
  {
    id: 'free', label: 'FREE', price: '$0', subtext: 'forever', sectionTitle: 'CORE FEATURES',
    features: ['Price, liquidity, volume, 24h change', 'Basic token info only', 'No AI verdict', 'No Wallet Scanner', 'No Dev Wallet Detector', 'No Pump Alerts', 'No Whale Alerts', 'No Base Radar'], cta: 'GET STARTED FREE', ctaClass: 'cta-free',
  },
  {
    id: 'pro', label: 'PRO', price: '$30', subtext: 'per month', sectionTitle: 'EVERYTHING IN FREE, PLUS',
    features: ['Full Token Scanner', 'Full Liquidity Safety', 'Wallet Scanner', 'Dev Wallet Detector', 'Pump Alerts', 'Whale Alerts', 'Base Radar', 'Clark AI — 50 prompts / day'], cta: 'START FREE TRIAL', ctaClass: 'cta-pro', badge: 'MOST POPULAR', trial: '7-DAY FREE TRIAL',
  },
  {
    id: 'elite', label: 'ELITE', price: '$60', subtext: 'per month', sectionTitle: 'EVERYTHING IN PRO, PLUS',
    features: ['Clark AI — unlimited prompts', 'Auto Clark verdict on every scan', 'Smart money tracking', 'Advanced whale alerts', 'Priority CORTEX processing', 'Early access to new features'], cta: 'UNLOCK ELITE', ctaClass: 'cta-elite', trial: '7-DAY FREE TRIAL',
  },
]

export default function PricingPage() {
  return <div style={{ minHeight: '100vh', background: '#050810', color: '#f8fafc', position: 'relative', overflow: 'hidden' }}>
    <style>{` .glass{background:linear-gradient(160deg,rgba(14,21,38,.86),rgba(8,12,24,.8));backdrop-filter:blur(10px);border:1px solid rgba(148,163,184,.18);border-radius:20px}.nav-pill{border-radius:999px;border:1px solid rgba(125,211,252,.25);background:linear-gradient(120deg,rgba(2,6,23,.82),rgba(15,23,42,.88));box-shadow:0 0 35px rgba(45,212,191,.09),0 0 40px rgba(168,85,247,.09)} .cta{display:block;text-align:center;border-radius:12px;padding:12px 14px;font-weight:800;font-size:12px;letter-spacing:.08em;text-decoration:none;transition:.2s transform,.2s box-shadow}.cta:hover{transform:translateY(-2px)}.cta-free{border:1px solid rgba(148,163,184,.35);color:#e2e8f0;background:rgba(15,23,42,.55)}.cta-pro{color:#fff;background:linear-gradient(100deg,#7c3aed,#ec4899);box-shadow:0 8px 24px rgba(168,85,247,.45)}.cta-elite{color:#201100;background:linear-gradient(120deg,#f59e0b,#fde047);box-shadow:0 8px 24px rgba(251,191,36,.4)} @media(max-width:1200px){.hero{grid-template-columns:1fr !important}.plan-grid{grid-template-columns:repeat(2,minmax(0,1fr)) !important}.stats{max-width:360px}} @media(max-width:820px){.plan-grid{grid-template-columns:1fr !important}.nav-links{display:none}}`}</style>

    <div style={{ position: 'absolute', inset: 0, backgroundImage: 'linear-gradient(rgba(148,163,184,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.04) 1px, transparent 1px)', backgroundSize: '52px 52px', maskImage: 'radial-gradient(circle at center, black 10%, transparent 80%)' }} />
    <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(circle at 18% 24%, rgba(34,211,238,.22), transparent 32%), radial-gradient(circle at 84% 20%, rgba(217,70,239,.2), transparent 30%), radial-gradient(circle at 52% 4%, rgba(99,102,241,.12), transparent 35%)' }} />
    <div style={{ position: 'absolute', left: '-10%', right: '-10%', bottom: -130, height: 290, borderTop: '2px solid rgba(56,189,248,.75)', borderRadius: '50% 50% 0 0 / 100% 100% 0 0', boxShadow: '0 -14px 50px rgba(34,211,238,.45), 0 -12px 70px rgba(168,85,247,.36)' }} />

    <div style={{ position: 'relative', zIndex: 2, maxWidth: 1600, margin: '0 auto', padding: '20px 20px 70px' }}>
      <nav className='nav-pill' style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 22px', marginBottom: 38 }}>
        <Link href='/' style={{ fontWeight: 900, letterSpacing: '.03em', color: '#fff', textDecoration: 'none' }}>CHAINLENS</Link>
        <div className='nav-links' style={{ display: 'flex', gap: 24, color: '#94a3b8', fontSize: 14 }}>
          <Link href='/dashboard/tokens' style={{ color: 'inherit', textDecoration: 'none' }}>Tools</Link><Link href='/terminal' style={{ color: 'inherit', textDecoration: 'none' }}>Terminal</Link><Link href='/pricing' style={{ color: '#e2e8f0', textDecoration: 'none' }}>Pricing</Link><Link href='/affiliate' style={{ color: 'inherit', textDecoration: 'none' }}>Affiliate</Link><Link href='/about' style={{ color: 'inherit', textDecoration: 'none' }}>About</Link>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}><span style={{ fontSize: 10, borderRadius: 999, border: '1px solid rgba(34,197,94,.4)', padding: '2px 8px', color: '#86efac' }}>LIVE</span><span style={{ fontSize: 11, color: '#67e8f9' }}>Powered by CORTEX</span><Link href='/app' style={{ marginLeft: 8, textDecoration: 'none', padding: '9px 14px', borderRadius: 999, border: '1px solid rgba(45,212,191,.5)', color: '#99f6e4', background: 'rgba(45,212,191,.12)', fontWeight: 700 }}>Get Access</Link></div>
      </nav>

      <section className='hero' style={{ display: 'grid', gridTemplateColumns: '1.2fr 3fr .9fr', gap: 16, alignItems: 'start' }}>
        <div className='glass' style={{ padding: 24, minHeight: 540, display: 'flex', flexDirection: 'column' }}>
          <div style={{ color: '#67e8f9', fontSize: 11, letterSpacing: '.2em', marginBottom: 16 }}>• PRICING</div>
          <div style={{ fontSize: 'clamp(42px,4vw,72px)', lineHeight: .95, fontWeight: 900 }}>ONE PRICE.<br /><span style={{ background: 'linear-gradient(90deg,#22d3ee,#a855f7,#ec4899)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>WORLDWIDE.</span></div>
          <p style={{ marginTop: 20, color: '#94a3b8', lineHeight: 1.6 }}>No dark patterns. No regional pricing.<br />Cancel any time. Your data stays yours.</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 16 }}>{['Secure Checkout', 'Cancel Anytime', 'Used by Base Traders'].map((chip) => <span key={chip} style={{ borderRadius: 999, border: '1px solid rgba(148,163,184,.24)', padding: '6px 10px', fontSize: 11, color: '#cbd5e1' }}>{chip}</span>)}</div>
          <div style={{ marginTop: 'auto', fontSize: 12, color: '#94a3b8' }}>Powered by <span style={{ color: '#e2e8f0', fontWeight: 700 }}>BASE</span></div>
        </div>

        <div className='plan-grid' style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 14 }}>
          {plans.map((plan) => <div key={plan.id} className='glass' style={{ padding: 18, minHeight: 540, borderColor: plan.id === 'pro' ? 'rgba(217,70,239,.6)' : plan.id === 'elite' ? 'rgba(251,191,36,.58)' : 'rgba(147,51,234,.3)', boxShadow: plan.id === 'pro' ? '0 0 38px rgba(217,70,239,.28)' : plan.id === 'elite' ? '0 0 35px rgba(251,191,36,.24)' : 'none', position: 'relative' }}>
            {plan.badge && <div style={{ position: 'absolute', top: -12, left: '50%', transform: 'translateX(-50%)', borderRadius: 999, background: 'linear-gradient(90deg,#a855f7,#ec4899)', color: '#fff', fontSize: 10, letterSpacing: '.12em', fontWeight: 800, padding: '4px 12px' }}>{plan.badge}</div>}
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><div style={{ fontSize: 12, letterSpacing: '.18em', color: plan.id === 'elite' ? '#facc15' : plan.id === 'pro' ? '#a78bfa' : '#e879f9' }}>{plan.label}</div>{plan.trial && <span style={{ fontSize: 9, border: '1px solid rgba(148,163,184,.4)', color: '#cbd5e1', borderRadius: 999, padding: '4px 8px' }}>{plan.trial}</span>}</div>
            <div style={{ fontSize: 52, fontWeight: 800, marginTop: 8, color: plan.id === 'elite' ? '#fde68a' : '#fff' }}>{plan.price}</div><div style={{ color: '#94a3b8', marginTop: -4 }}>{plan.subtext}</div>
            <div style={{ marginTop: 18, fontSize: 10, color: plan.id === 'elite' ? '#fcd34d' : plan.id === 'pro' ? '#67e8f9' : '#f0abfc', letterSpacing: '.15em' }}>{plan.sectionTitle}</div>
            <div style={{ display: 'grid', gap: 7, marginTop: 10, minHeight: 260 }}>{plan.features.map((f) => {const no = f.startsWith('No '); return <div key={f} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', color: no ? '#64748b' : '#dbeafe', fontSize: 13 }}><span style={{ color: no ? '#475569' : plan.id === 'elite' ? '#facc15' : plan.id === 'pro' ? '#22d3ee' : '#c084fc' }}>{no ? '✕' : '✓'}</span><span>{f}</span></div>})}</div>
            {plan.id === 'elite' && <div style={{ border: '1px solid rgba(250,204,21,.35)', background: 'rgba(250,204,21,.08)', color: '#fde68a', borderRadius: 12, padding: 10, fontSize: 12, marginBottom: 12 }}>Everything in Pro included — plus full CORTEX intelligence.</div>}
            <Link href='/app' className={`cta ${plan.ctaClass}`}>{plan.cta}</Link>
          </div>)}
        </div>

        <aside className='glass stats' style={{ padding: 18, minHeight: 540, borderColor: 'rgba(34,211,238,.45)' }}>
          <div style={{ color: '#67e8f9', fontSize: 11, letterSpacing: '.13em', marginBottom: 18 }}>TRUSTED BY WINNING TRADERS</div>
          {[['50K+', 'Active Traders'], ['2M+', 'Scans Performed'], ['$2.4B+', 'Volume Analyzed'], ['99.9%', 'Uptime']].map(([v, k]) => <div key={k} style={{ borderTop: '1px solid rgba(148,163,184,.18)', padding: '16px 0' }}><div style={{ color: '#5eead4', fontSize: 34, fontWeight: 800 }}>{v}</div><div style={{ color: '#94a3b8', fontSize: 12 }}>{k}</div></div>)}
        </aside>
      </section>
    </div>
  </div>
}
