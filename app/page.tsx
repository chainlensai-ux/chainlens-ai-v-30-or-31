
'use client'

import Link from 'next/link'
import Navbar from '@/components/Navbar'
import ConnectWallet from '@/components/ConnectWallet'

// ─── Bottom ticker tokens ──────────────────────────────────────────────────

const TICKER = [
  { sym: 'ADA',  price: '$0.2493', pct: '+3.88%' },
  { sym: 'AVAX', price: '$9.47',   pct: '+1.25%' },
  { sym: 'DOGE', price: '$0.0963', pct: '+3.55%' },
  { sym: 'DOT',  price: '$1.26',   pct: '+8.60%' },
  { sym: 'LINK', price: '$9.29',   pct: '+2.44%' },
  { sym: 'UNI',  price: '$3.27',   pct: '+3.63%' },
  { sym: 'LTC',  price: '$55.50',  pct: '+2.21%' },
  { sym: 'BCH',  price: '$439.90', pct: '+1.39%' },
  { sym: 'XLM',  price: '$0.1619', pct: '+3.78%' },
  { sym: 'ATOM', price: '$1.80',   pct: '+3.35%' },
  { sym: 'XMR',  price: '$344.77', pct: '+1.22%' },
  { sym: 'ETC',  price: '$8.55',   pct: '+2.79%' },
  { sym: 'FIL',  price: '$0.9692', pct: '+8.31%' },
  { sym: 'AAVE', price: '$106.45', pct: '+5.66%' },
  { sym: 'MKR',  price: '$1,773',  pct: '+0.78%' },
  { sym: 'OP',   price: '$0.1227', pct: '+8.46%' },
  { sym: 'ARB',  price: '$0.1190', pct: '+5.54%' },
  { sym: 'NEAR', price: '$1.43',   pct: '+6.09%' },
  { sym: 'FTM',  price: '$0.0471', pct: '+3.84%' },
]

// ─── Feature cards ────────────────────────────────────────────────────────────

const FEATURES = [
  {
    accent: '#2DD4BF',
    grad: 'linear-gradient(90deg, #2DD4BF 0%, #22d3ee 100%)',
    borderColor: 'rgba(45,212,191,0.16)',
    hoverBorder: 'rgba(45,212,191,0.42)',
    hoverShadow: '0 16px 56px rgba(45,212,191,0.18), 0 0 32px rgba(45,212,191,0.12), 0 4px 20px rgba(0,0,0,0.45)',
    title: 'Scan Wallets Instantly',
    body: 'See everything inside any wallet — tokens, positions, PnL, behavior patterns, smart money tags, and chain activity.',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/><circle cx="16" cy="15" r="1.5"/>
      </svg>
    ),
  },
  {
    accent: '#ec4899',
    grad: 'linear-gradient(90deg, #ec4899 0%, #f472b6 100%)',
    borderColor: 'rgba(236,72,153,0.16)',
    hoverBorder: 'rgba(236,72,153,0.42)',
    hoverShadow: '0 16px 56px rgba(236,72,153,0.12), 0 0 28px rgba(45,212,191,0.10), 0 4px 20px rgba(0,0,0,0.45)',
    title: 'Real-Time Onchain Intelligence',
    body: 'Track whale movements, early pumps, deployer activity, and market shifts as they happen — not after.',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
      </svg>
    ),
  },
  {
    accent: '#8b5cf6',
    grad: 'linear-gradient(90deg, #8b5cf6 0%, #a78bfa 100%)',
    borderColor: 'rgba(139,92,246,0.16)',
    hoverBorder: 'rgba(139,92,246,0.42)',
    hoverShadow: '0 16px 56px rgba(139,92,246,0.14), 0 0 28px rgba(45,212,191,0.10), 0 4px 20px rgba(0,0,0,0.45)',
    title: 'Advanced Token Scanner',
    body: 'Paste any contract and get instant AI analysis: price, liquidity, holders, deployer history, risk score, bytecode flags, and social momentum.',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/><path d="M11 8v6M8 11h6"/>
      </svg>
    ),
  },
  {
    accent: '#60a5fa',
    grad: 'linear-gradient(90deg, #3b82f6 0%, #60a5fa 100%)',
    borderColor: 'rgba(96,165,250,0.16)',
    hoverBorder: 'rgba(96,165,250,0.42)',
    hoverShadow: '0 16px 56px rgba(96,165,250,0.12), 0 0 28px rgba(45,212,191,0.10), 0 4px 20px rgba(0,0,0,0.45)',
    title: 'Liquidity Safety Engine',
    body: 'Detect rugs before they happen. ChainLens checks LP locks, ownership, burns, mint functions, suspicious patterns, and contract risks.',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>
      </svg>
    ),
  },
]

export default function HomePage() {
  return (
    <>
      {/* Keyframes */}
      <style>{`
        @keyframes ticker-scroll {
          0%   { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
        ::placeholder { color: rgba(255,255,255,0.3); }

        @keyframes orb-teal {
          0%,100% { transform: translate(0, 0) scale(1); opacity: 0.55; }
          33%      { transform: translate(60px, -40px) scale(1.12); opacity: 0.70; }
          66%      { transform: translate(-40px, 30px) scale(0.90); opacity: 0.45; }
        }
        @keyframes orb-purple {
          0%,100% { transform: translate(0, 0) scale(1); opacity: 0.45; }
          33%      { transform: translate(-50px, 50px) scale(1.08); opacity: 0.60; }
          66%      { transform: translate(70px, -30px) scale(0.92); opacity: 0.38; }
        }
        @keyframes aurora-drift {
          0%, 100% { transform: translate3d(0, 0, 0) scale(1); }
          50% { transform: translate3d(-2.4%, 1.6%, 0) scale(1.05); }
        }
        @keyframes glow-drift {
          0%, 100% { transform: translate3d(0, 0, 0) scale(1); opacity: 0.72; }
          50% { transform: translate3d(2%, -1.8%, 0) scale(1.08); opacity: 0.9; }
        }
        @keyframes arc-sway {
          0%,100% { transform: translate3d(0,0,0) rotate(0deg); opacity: 0.22; }
          50% { transform: translate3d(1.2%, -0.8%, 0) rotate(2.2deg); opacity: 0.33; }
        }
        @keyframes streak-drift-left {
          0%,100% { transform: translate3d(0,0,0) rotate(-9deg); opacity: 0.24; }
          50% { transform: translate3d(2.5%, -2%, 0) rotate(-7deg); opacity: 0.32; }
        }
        @keyframes streak-drift-right {
          0%,100% { transform: translate3d(0,0,0) rotate(13deg); opacity: 0.22; }
          50% { transform: translate3d(-2.4%, 1.8%, 0) rotate(11deg); opacity: 0.30; }
        }
        @keyframes particle-float {
          0%,100% { transform: translate3d(0,0,0); opacity: 0.18; }
          50% { transform: translate3d(0,-8px,0); opacity: 0.3; }
        }
        @keyframes halo-drift {
          0%,100% { transform: translate3d(0,0,0) scale(1); opacity: 0.55; }
          50% { transform: translate3d(1.4%, -1.2%, 0) scale(1.06); opacity: 0.72; }
        }
        @keyframes ambient-shift {
          0%,100% { transform: translate3d(0,0,0); opacity: 0.28; }
          50% { transform: translate3d(0, -1.6%, 0); opacity: 0.4; }
        }
        @keyframes texture-shift {
          0% { transform: translateY(0); opacity: 0.14; }
          50% { transform: translateY(-10px); opacity: 0.2; }
          100% { transform: translateY(0); opacity: 0.14; }
        }
        @keyframes feat-in {
          from { opacity: 0; transform: translateY(22px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .feat-card {
          transition: transform 0.24s cubic-bezier(0.22,1,0.36,1),
                      box-shadow 0.24s ease, border-color 0.24s ease;
          animation: feat-in 0.55s ease-out both;
        }
        .feat-card:hover { transform: translateY(-6px); }

        @keyframes arc-rotate {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
        @keyframes horizon-breathe {
          0%,100% { opacity: 0.55; transform: scaleX(1); }
          50%      { opacity: 0.75; transform: scaleX(1.04); }
        }
        .hero-horizon { animation: horizon-breathe 8s ease-in-out infinite; }

        @media (prefers-reduced-motion: reduce) {
          .hero-premium-bg * {
            animation: none !important;
            transition: none !important;
          }
        }

        @media (max-width: 767px) {
          .mob-hero-main { padding: 80px 16px 60px !important; }
          .feat-grid { grid-template-columns: 1fr !important; }
          .feat-section { padding: 56px 16px 64px !important; }
          .hero-feat-row { flex-direction: column !important; gap: 16px !important; }
          .hero-feat-row > div { border-right: none !important; border-bottom: 1px solid rgba(255,255,255,0.06) !important; padding-bottom: 16px !important; }
          .hero-feat-row > div:last-child { border-bottom: none !important; }
          .hero-cta-row { flex-direction: column !important; width: 100%; }
          .hero-cta-row > * { width: 100% !important; }
          .hero-premium-bg { opacity: 0.68; }
        }
        @media (max-width: 1023px) {
          .hero-feat-row { gap: 16px !important; }
        }

        /* CORTEX badge teal pulse */
        @keyframes cortex-pulse {
          0%,100% {
            box-shadow: 0 0 12px rgba(45,212,191,0.16), 0 1px 0 rgba(255,255,255,0.04) inset;
            border-color: rgba(45,212,191,0.32);
          }
          50% {
            box-shadow: 0 0 38px rgba(45,212,191,0.52), 0 0 76px rgba(45,212,191,0.20), 0 1px 0 rgba(255,255,255,0.04) inset;
            border-color: rgba(45,212,191,0.68);
          }
        }
        .cortex-badge { animation: cortex-pulse 2.8s ease-in-out infinite; }

        /* Particle twinkle */
        @keyframes particle-twinkle {
          0%,100% { opacity: 0.10; transform: scale(1); }
          50%      { opacity: 0.38; transform: scale(1.9); }
        }

        /* Section heading teal glow */
        .section-heading {
          text-shadow: 0 0 40px rgba(45,212,191,0.30), 0 0 80px rgba(45,212,191,0.12);
        }

        /* Capability card top border slides in on hover */
        .feat-top-line {
          transform: scaleX(0);
          transform-origin: left center;
          transition: transform 0.34s cubic-bezier(0.22,1,0.36,1);
        }
        .feat-card:hover .feat-top-line { transform: scaleX(1); }

        /* Pricing card animations */
        @keyframes pro-glow {
          0%,100% { box-shadow: 0 0 40px rgba(139,92,246,0.18), inset 0 0 0 1px rgba(139,92,246,0.55); }
          50%      { box-shadow: 0 0 64px rgba(139,92,246,0.32), inset 0 0 0 1px rgba(139,92,246,0.80); }
        }
        @keyframes elite-glow {
          0%,100% { box-shadow: 0 0 50px rgba(251,191,36,0.18), 0 0 100px rgba(251,191,36,0.08), inset 0 0 0 1px rgba(251,191,36,0.40); }
          50%      { box-shadow: 0 0 80px rgba(251,191,36,0.32), 0 0 140px rgba(251,191,36,0.14), inset 0 0 0 1px rgba(251,191,36,0.70); }
        }
        @keyframes shine-sweep {
          0%   { transform: translateX(-100%) skewX(-15deg); }
          100% { transform: translateX(300%) skewX(-15deg); }
        }
        .card-pro   { animation: pro-glow   4s ease-in-out infinite; }
        .card-elite { animation: elite-glow 3.5s ease-in-out infinite; }
        .pricing-card {
          transition: transform 0.28s cubic-bezier(0.22,1,0.36,1), box-shadow 0.28s ease;
          overflow: hidden;
        }
        .pricing-card::before {
          content: ''; position: absolute; top:0; left:0; right:0; bottom:0;
          background: linear-gradient(105deg, transparent 40%, rgba(255,255,255,0.04) 50%, transparent 60%);
          opacity: 0; transition: opacity 0.3s; pointer-events: none; z-index: 2;
        }
        .pricing-card:hover { transform: translateY(-8px); }
        .pricing-card:hover::before { opacity: 1; animation: shine-sweep 0.6s ease forwards; }
        .pricing-card.card-free:hover { box-shadow: 0 20px 60px rgba(0,0,0,0.55), 0 0 40px rgba(236,72,153,0.18); border-color: rgba(236,72,153,0.35) !important; }
        .pricing-card.card-pro:hover  { box-shadow: 0 20px 60px rgba(0,0,0,0.55), 0 0 80px rgba(139,92,246,0.40), inset 0 0 0 1px rgba(139,92,246,0.90); animation-play-state: paused; }
        .pricing-card.card-elite:hover { box-shadow: 0 24px 70px rgba(0,0,0,0.60), 0 0 100px rgba(251,191,36,0.45), 0 0 160px rgba(251,191,36,0.18), inset 0 0 0 1px rgba(251,191,36,0.85); animation-play-state: paused; }
        .cta-outline  { background:transparent; border:1px solid rgba(255,255,255,0.18); color:rgba(255,255,255,0.70); transition:border-color 0.15s,color 0.15s,background 0.15s; }
        .cta-outline:hover { border-color:rgba(255,255,255,0.40); color:#fff; background:rgba(255,255,255,0.05); }
        .cta-gradient { background:linear-gradient(135deg,#8b5cf6 0%,#ec4899 100%); border:none; color:#fff; transition:opacity 0.15s,transform 0.15s; }
        .cta-gradient:hover { opacity:0.88; transform:translateY(-1px); }
        .cta-gold { background:linear-gradient(135deg,#f59e0b 0%,#fbbf24 50%,#f59e0b 100%); border:none; color:#0a0800; font-weight:800; transition:opacity 0.15s,transform 0.15s,box-shadow 0.15s; box-shadow:0 0 20px rgba(251,191,36,0.35); }
        .cta-gold:hover { opacity:0.90; transform:translateY(-2px); box-shadow:0 0 32px rgba(251,191,36,0.55); }
      `}</style>

      <Navbar />

      <div className="relative min-h-screen w-full bg-[#05050b]" style={{ display: 'flex', flexDirection: 'column' }}>

        {/* ── Unified page ambient system ── */}
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0, overflow: 'hidden' }}>
          <div style={{
            position: 'absolute',
            inset: 0,
            background: 'linear-gradient(180deg, #05050d 0%, #060711 34%, #05050d 100%)',
          }} />
          <div style={{
            position: 'absolute',
            inset: '-12% -4%',
            background: 'radial-gradient(48% 18% at 50% 16%, rgba(139,92,246,0.14) 0%, rgba(139,92,246,0.04) 48%, transparent 80%), radial-gradient(58% 26% at 50% 50%, rgba(168,85,247,0.12) 0%, rgba(168,85,247,0.04) 52%, transparent 84%), radial-gradient(62% 30% at 50% 79%, rgba(167,139,250,0.10) 0%, rgba(217,70,239,0.03) 56%, transparent 86%)',
            filter: 'blur(54px)',
            animation: 'ambient-shift 40s ease-in-out infinite',
          }} />
          <div style={{
            position: 'absolute',
            inset: 0,
            background: 'linear-gradient(90deg, transparent 0%, rgba(128,90,213,0.09) 18%, transparent 34%, transparent 66%, rgba(192,132,252,0.08) 82%, transparent 100%)',
            filter: 'blur(14px)',
            opacity: 0.24,
          }} />
          <div style={{
            position: 'absolute',
            inset: 0,
            background: 'radial-gradient(80% 120% at 50% 50%, transparent 50%, rgba(1,2,7,0.58) 92%)',
          }} />
        </div>

        {/* ── Cinematic background layer ── */}
        <div className="hero-premium-bg" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0, overflow: 'hidden' }}>
          <div style={{
            position: 'absolute', inset: 0,
            background: 'linear-gradient(180deg, #05050b 0%, #06070f 44%, #05050b 100%)',
            animation: 'aurora-drift 38s ease-in-out infinite',
            willChange: 'transform',
          }} />

          <div style={{
            position: 'absolute',
            left: '-28%',
            bottom: '-30%',
            width: '102%',
            height: '92%',
            background: 'conic-gradient(from 244deg at 72% 46%, rgba(167,139,250,0.00) 0deg, rgba(167,139,250,0.34) 70deg, rgba(129,92,249,0.00) 156deg)',
            filter: 'blur(8px)',
            maskImage: 'radial-gradient(84% 66% at 68% 42%, black 12%, rgba(0,0,0,0.85) 46%, transparent 86%)',
            animation: 'streak-drift-left 42s ease-in-out infinite',
          }} />

          <div style={{
            position: 'absolute',
            right: '-32%',
            top: '-10%',
            width: '92%',
            height: '88%',
            background: 'conic-gradient(from 42deg at 28% 56%, rgba(45,212,191,0) 0deg, rgba(129,92,249,0.20) 62deg, rgba(236,72,153,0.08) 98deg, rgba(129,92,249,0) 160deg)',
            filter: 'blur(12px)',
            maskImage: 'radial-gradient(82% 72% at 34% 56%, black 12%, rgba(0,0,0,0.84) 48%, transparent 84%)',
            animation: 'streak-drift-right 44s ease-in-out infinite',
          }} />

          <div style={{
            position: 'absolute',
            left: '-12%',
            top: '38%',
            width: '42%',
            height: '24%',
            background: 'linear-gradient(100deg, rgba(168,85,247,0) 0%, rgba(168,85,247,0.20) 46%, rgba(236,72,153,0.12) 56%, rgba(236,72,153,0) 100%)',
            filter: 'blur(7px)',
            maskImage: 'radial-gradient(120% 90% at 56% 50%, black 8%, rgba(0,0,0,0.72) 48%, transparent 100%)',
            animation: 'streak-drift-left 46s ease-in-out infinite',
          }} />

          <div style={{
            position: 'absolute',
            right: '-10%',
            top: '34%',
            width: '40%',
            height: '22%',
            background: 'linear-gradient(258deg, rgba(139,92,246,0) 0%, rgba(139,92,246,0.16) 46%, rgba(217,70,239,0.10) 58%, rgba(217,70,239,0) 100%)',
            filter: 'blur(8px)',
            maskImage: 'radial-gradient(110% 90% at 44% 46%, black 10%, rgba(0,0,0,0.74) 50%, transparent 100%)',
            animation: 'streak-drift-right 48s ease-in-out infinite',
          }} />

          <div style={{
            position: 'absolute',
            inset: '-6%',
            background: 'radial-gradient(42% 34% at 50% 34%, rgba(168,85,247,0.20) 0%, rgba(139,92,246,0.08) 42%, rgba(7,7,15,0) 76%), radial-gradient(26% 24% at 56% 48%, rgba(217,70,239,0.13) 0%, rgba(217,70,239,0.04) 50%, transparent 100%)',
            filter: 'blur(56px)',
            animation: 'halo-drift 36s ease-in-out infinite',
            willChange: 'transform',
          }} />

          <div style={{
            position: 'absolute', inset: '-8%',
            background: 'radial-gradient(34% 34% at 50% 34%, rgba(167,139,250,0.16) 0%, rgba(167,139,250,0.05) 50%, transparent 100%), radial-gradient(22% 24% at 72% 54%, rgba(139,92,246,0.12) 0%, rgba(139,92,246,0.04) 46%, transparent 100%), radial-gradient(18% 20% at 76% 36%, rgba(56,189,248,0.03) 0%, rgba(56,189,248,0.01) 48%, transparent 100%), radial-gradient(24% 24% at 82% 68%, rgba(217,70,239,0.09) 0%, rgba(217,70,239,0.02) 52%, transparent 100%)',
            filter: 'blur(62px)',
            animation: 'glow-drift 32s ease-in-out infinite',
            willChange: 'transform',
          }} />

          <div style={{
            position: 'absolute',
            inset: 0,
            background: 'radial-gradient(58% 48% at 50% 34%, rgba(160,120,255,0.16) 0%, rgba(110,76,220,0.06) 45%, transparent 100%)',
            filter: 'blur(34px)',
          }} />

          <div style={{
            position: 'absolute',
            left: '-18%',
            bottom: '-22%',
            width: '62%',
            height: '56%',
            background: 'radial-gradient(closest-side, rgba(192,132,252,0.16) 0%, rgba(168,85,247,0.08) 34%, transparent 80%)',
            filter: 'blur(34px)',
          }} />

          <div style={{
            position: 'absolute',
            right: '-16%',
            bottom: '-18%',
            width: '58%',
            height: '54%',
            background: 'radial-gradient(closest-side, rgba(217,70,239,0.12) 0%, rgba(167,139,250,0.08) 36%, transparent 82%)',
            filter: 'blur(32px)',
          }} />

          <div style={{
            position: 'absolute',
            left: '-8%',
            top: '-14%',
            width: '76%',
            height: '122%',
            borderRadius: '50%',
            border: '1px solid rgba(167,139,250,0.09)',
            maskImage: 'radial-gradient(circle at 62% 42%, black 42%, transparent 74%)',
            animation: 'arc-sway 34s ease-in-out infinite',
          }} />

          <div style={{
            position: 'absolute',
            right: '-22%',
            top: '-18%',
            width: '96%',
            height: '136%',
            borderRadius: '50%',
            border: '1px solid rgba(167,139,250,0.07)',
            maskImage: 'radial-gradient(circle at 38% 46%, black 40%, transparent 74%)',
            animation: 'arc-sway 42s ease-in-out infinite reverse',
          }} />

          <div style={{
            position: 'absolute',
            inset: 0,
            backgroundImage: 'radial-gradient(rgba(210,214,255,0.34) 0.75px, transparent 0.9px)',
            backgroundSize: '160px 160px',
            maskImage: 'radial-gradient(80% 68% at 50% 44%, black 22%, rgba(0,0,0,0.4) 58%, transparent 100%)',
            opacity: 0.1,
          }} />

          <div style={{
            position: 'absolute',
            inset: 0,
            backgroundImage: 'linear-gradient(rgba(120,88,214,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(120,88,214,0.08) 1px, transparent 1px)',
            backgroundSize: '56px 56px',
            maskImage: 'linear-gradient(180deg, transparent 0%, rgba(0,0,0,0.22) 55%, rgba(0,0,0,0.9) 100%)',
            animation: 'texture-shift 22s ease-in-out infinite',
            opacity: 0.06,
          }} />

          <div style={{
            position: 'absolute', inset: 0,
            background: 'radial-gradient(48% 32% at 50% 35%, rgba(150,118,255,0.14) 0%, rgba(95,61,194,0.06) 40%, rgba(7,7,15,0) 72%), radial-gradient(112% 84% at 50% 42%, transparent 48%, rgba(3,6,15,0.56) 72%, rgba(2,4,12,0.92) 100%)',
          }} />
        </div>

        {/* Hero */}
        <main className="mob-hero-main" style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '100px 24px 80px',
          position: 'relative',
          zIndex: 1,
          textAlign: 'center',
        }}>

          {/* Animated particle field */}
          {[
            { x: '7%',  y: '14%', dur: '6.2s', del: '0s',   sz: 1.5 },
            { x: '17%', y: '44%', dur: '9.1s', del: '1.3s', sz: 1   },
            { x: '31%', y: '21%', dur: '7.4s', del: '2.6s', sz: 2   },
            { x: '46%', y: '70%', dur: '11s',  del: '0.9s', sz: 1.5 },
            { x: '57%', y: '11%', dur: '8.2s', del: '3.2s', sz: 1   },
            { x: '70%', y: '37%', dur: '10.3s',del: '1.8s', sz: 2   },
            { x: '81%', y: '76%', dur: '6.8s', del: '4.3s', sz: 1   },
            { x: '91%', y: '27%', dur: '9.7s', del: '0.5s', sz: 1.5 },
            { x: '24%', y: '86%', dur: '7.8s', del: '2.1s', sz: 1   },
            { x: '63%', y: '54%', dur: '8.7s', del: '3.7s', sz: 2   },
            { x: '39%', y: '31%', dur: '12s',  del: '1.1s', sz: 1   },
            { x: '14%', y: '63%', dur: '9.4s', del: '5.1s', sz: 1.5 },
            { x: '75%', y: '17%', dur: '7.2s', del: '2.9s', sz: 1   },
            { x: '51%', y: '89%', dur: '10.6s',del: '0.7s', sz: 2   },
            { x: '87%', y: '51%', dur: '8.4s', del: '4.9s', sz: 1   },
            { x: '3%',  y: '50%', dur: '11.2s',del: '1.5s', sz: 1.5 },
            { x: '95%', y: '72%', dur: '7.0s', del: '3.4s', sz: 1   },
            { x: '42%', y: '6%',  dur: '9.8s', del: '6.0s', sz: 1.5 },
          ].map((p, i) => (
            <div key={i} style={{
              position: 'absolute',
              left: p.x, top: p.y,
              width: `${p.sz}px`, height: `${p.sz}px`,
              borderRadius: '50%',
              background: '#fff',
              pointerEvents: 'none',
              opacity: 0.3,
              animation: `particle-float ${p.dur} ease-in-out infinite ${p.del}, particle-twinkle ${p.dur} ease-in-out infinite ${p.del}`,
            }} />
          ))}

          {/* POWERED BY CORTEX ENGINE badge */}
          <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '8px',
            background: 'rgba(45,212,191,0.05)',
            border: '1px solid rgba(45,212,191,0.32)',
            borderRadius: '999px',
            padding: '6px 18px',
            marginBottom: '24px',
            boxShadow: '0 0 12px rgba(45,212,191,0.10), 0 1px 0 rgba(255,255,255,0.04) inset',
          }}>
            <span style={{
              width: '6px', height: '6px', borderRadius: '50%',
              background: '#4ade80',
              boxShadow: '0 0 8px rgba(74,222,128,0.8)',
              display: 'inline-block',
              flexShrink: 0,
              animation: 'cl-pulse 2s ease-in-out infinite',
            }} />
            <span style={{
              fontSize: '10px',
              fontWeight: 700,
              letterSpacing: '0.16em',
              color: '#2DD4BF',
              fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
              textTransform: 'uppercase',
            }}>
              Powered by CORTEX ENGINE
            </span>
          </div>

          {/* Headline */}
          <h1 style={{
            fontSize: 'clamp(52px, 7.2vw, 102px)',
            fontWeight: 900,
            lineHeight: 1.03,
            letterSpacing: '-0.025em',
            margin: '0 0 24px',
            maxWidth: '1100px',
            textShadow: '0 8px 30px rgba(0,0,0,0.46)',
          }}>
            {/* Line 1 — white */}
            <span style={{ color: '#f8fafc', display: 'block' }}>
              See what whales do
            </span>
            {/* Line 2 — pink → indigo gradient */}
            <span style={{
              display: 'block',
              background: 'linear-gradient(94deg, #ec4899 0%, #a855f7 32%, #818cf8 64%, #22d3ee 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
              textShadow: '0 0 34px rgba(139,92,246,0.30), 0 0 64px rgba(34,211,238,0.20)',
            }}>
              before everyone else
            </span>
            <span style={{
              display: 'block',
              background: 'linear-gradient(96deg, #a855f7 0%, #818cf8 52%, #60a5fa 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
              textShadow: '0 0 30px rgba(139,92,246,0.26), 0 0 54px rgba(96,165,250,0.18)',
            }}>
              does.
            </span>
          </h1>

          {/* Subtext */}
          <p style={{
            fontSize: '17px',
            color: 'rgba(255,255,255,0.66)',
            lineHeight: 1.62,
            maxWidth: '700px',
            margin: '0 0 38px',
            fontWeight: 400,
          }}>
            Ask Clark anything — scan wallets, find early pumps, track
            smart money, and get real-time onchain intelligence.
          </p>

          {/* Feature icon row */}
          <div className="hero-feat-row" style={{
            display: 'flex',
            alignItems: 'stretch',
            gap: '0',
            maxWidth: '1060px',
            width: '100%',
            margin: '8px 0 36px',
            background: 'linear-gradient(180deg, rgba(6,11,28,0.82) 0%, rgba(5,10,24,0.66) 100%)',
            border: '1px solid rgba(148,163,184,0.24)',
            borderRadius: '22px',
            backdropFilter: 'blur(18px)',
            WebkitBackdropFilter: 'blur(18px)',
            boxShadow: '0 22px 64px rgba(0,0,0,0.52), 0 0 42px rgba(45,212,191,0.08), inset 0 1px 0 rgba(255,255,255,0.10)',
            overflow: 'hidden',
          }}>
            {([
              {
                accent: '#2DD4BF',
                heading: 'Scan & Analyze',
                desc: 'Tokens, wallets, and contracts',
                icon: (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
                  </svg>
                ),
              },
              {
                accent: '#8b5cf6',
                heading: 'Detect Early',
                desc: 'Find early pumps and smart moves',
                icon: (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
                  </svg>
                ),
              },
              {
                accent: '#ec4899',
                heading: 'Track Smart Money',
                desc: 'Whales, dev wallets, and key flows',
                icon: (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                  </svg>
                ),
              },
              {
                accent: '#60a5fa',
                heading: 'Stay Ahead',
                desc: 'Real-time alerts and onchain insights',
                icon: (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                  </svg>
                ),
              },
            ] as { accent: string; heading: string; desc: string; icon: React.ReactNode }[]).map((item, i) => (
              <div key={i} style={{
                flex: 1,
                padding: '24px 20px',
                borderRight: i < 3 ? '1px solid rgba(148,163,184,0.22)' : 'none',
                display: 'flex',
                gap: '12px',
                alignItems: 'flex-start',
              }}>
                <div style={{
                  width: '44px', height: '44px', borderRadius: '50%',
                  flexShrink: 0,
                  border: `1.5px solid ${item.accent}66`,
                  background: `radial-gradient(circle at 35% 30%, ${item.accent}2A 0%, rgba(15,23,42,0.8) 75%)`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: item.accent,
                  boxShadow: `0 0 20px ${item.accent}28`,
                }}>
                  {item.icon}
                </div>
                <div>
                  <div style={{ fontSize: '13px', fontWeight: 700, color: '#f1f5f9', marginBottom: '3px', lineHeight: 1.3 }}>{item.heading}</div>
                  <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.60)', lineHeight: 1.5 }}>{item.desc}</div>
                </div>
              </div>
            ))}
          </div>

          {/* CTA buttons — horizontal row */}
          <div className="hero-cta-row" style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center' }}>

            {/* Connect Wallet — teal */}
            <ConnectWallet />

            {/* Primary — Enter Terminal */}
            <Link href="/terminal" style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '9px',
              padding: '18px 46px',
              borderRadius: '999px',
              background: 'linear-gradient(100deg, rgba(45,212,191,0.24) 0%, rgba(34,211,238,0.26) 25%, rgba(99,102,241,0.28) 64%, rgba(168,85,247,0.26) 100%)',
              border: '1px solid rgba(34,211,238,0.58)',
              color: '#fff',
              fontSize: '15px',
              fontWeight: 800,
              letterSpacing: '0.09em',
              textTransform: 'uppercase',
              textDecoration: 'none',
              boxShadow: '0 0 42px rgba(45,212,191,0.34), 0 0 42px rgba(139,92,246,0.30), inset 0 1px 0 rgba(255,255,255,0.32)',
              transition: 'opacity 0.15s, box-shadow 0.15s, transform 0.15s',
            }}
              onMouseEnter={e => {
                const el = e.currentTarget as HTMLAnchorElement
                el.style.opacity   = '0.92'
                el.style.transform = 'translateY(-2px)'
                el.style.boxShadow = '0 0 62px rgba(45,212,191,0.52), 0 0 62px rgba(139,92,246,0.46), inset 0 1px 0 rgba(255,255,255,0.36)'
              }}
              onMouseLeave={e => {
                const el = e.currentTarget as HTMLAnchorElement
                el.style.opacity   = '1'
                el.style.transform = 'translateY(0)'
                el.style.boxShadow = '0 0 42px rgba(45,212,191,0.34), 0 0 42px rgba(139,92,246,0.30), inset 0 1px 0 rgba(255,255,255,0.32)'
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <rect x="2" y="3" width="20" height="14" rx="2" stroke="currentColor" strokeWidth="2"/>
                <path d="M7 8l3 3-3 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                <line x1="13" y1="11" x2="17" y2="11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
              </svg>
              Enter Terminal →
            </Link>

            {/* Start Free — purple */}
            <Link href="/pricing" style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '17px 38px',
              borderRadius: '999px',
              background: 'rgba(139,92,246,0.12)',
              color: 'rgba(255,255,255,0.92)',
              fontSize: '15px',
              fontWeight: 700,
              letterSpacing: '0.10em',
              textTransform: 'uppercase',
              textDecoration: 'none',
              border: '1px solid rgba(168,85,247,0.56)',
              boxShadow: '0 0 26px rgba(139,92,246,0.18)',
              transition: 'background 0.15s, color 0.15s, border-color 0.15s, transform 0.15s',
            }}
              onMouseEnter={e => {
                const el = e.currentTarget as HTMLAnchorElement
                el.style.background  = 'rgba(139,92,246,0.22)'
                el.style.color       = '#fff'
                el.style.borderColor = 'rgba(139,92,246,0.55)'
                el.style.transform   = 'translateY(-1px)'
              }}
              onMouseLeave={e => {
                const el = e.currentTarget as HTMLAnchorElement
                el.style.background  = 'rgba(139,92,246,0.12)'
                el.style.color       = 'rgba(255,255,255,0.80)'
                el.style.borderColor = 'rgba(139,92,246,0.32)'
                el.style.transform   = 'translateY(0)'
              }}
            >
              Start Free
            </Link>
          </div>

        </main>

        {/* Token price ticker — live prices bar */}
        <div style={{
          position: 'relative', zIndex: 1,
          borderTop: '1px solid rgba(255,255,255,0.06)',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          background: 'linear-gradient(180deg, #04040b 0%, #05050c 100%)',
          height: '44px', overflow: 'hidden',
          display: 'flex', alignItems: 'center',
        }}>
          <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: '80px', background: 'linear-gradient(90deg, #05050c 0%, transparent 100%)', zIndex: 2, pointerEvents: 'none' }} />
          <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: '80px', background: 'linear-gradient(270deg, #05050c 0%, transparent 100%)', zIndex: 2, pointerEvents: 'none' }} />
          <div style={{ display: 'flex', gap: '0', whiteSpace: 'nowrap', animation: 'ticker-scroll 44s linear infinite', willChange: 'transform' }}>
            {[...TICKER, ...TICKER].map((t, i) => (
              <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: '7px', padding: '0 32px', fontSize: '11.5px', color: 'rgba(255,255,255,0.45)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', borderRight: '1px solid rgba(255,255,255,0.05)' }}>
                <span style={{ fontWeight: 700, color: 'rgba(255,255,255,0.75)', letterSpacing: '0.04em' }}>{t.sym}</span>
                <span style={{ color: 'rgba(255,255,255,0.40)' }}>{t.price}</span>
                <span style={{ color: '#4ade80', fontWeight: 600 }}>{t.pct}</span>
              </span>
            ))}
          </div>
        </div>

        {/* ── What ChainLens Does ──────────────────────────────────────────── */}
        <section className="feat-section" style={{
          position: 'relative', zIndex: 1,
          padding: '88px 24px 96px',
          maxWidth: '1120px',
          margin: '0 auto',
          width: '100%',
        }}>
          {/* Top separator */}
          <div style={{
            position: 'absolute', top: 0, left: '10%', right: '10%', height: '1px',
            background: 'linear-gradient(90deg, transparent, rgba(45,212,191,0.25), rgba(139,92,246,0.25), transparent)',
          }} />

          {/* Section header */}
          <div style={{ textAlign: 'center', marginBottom: '60px' }}>
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: '7px',
              marginBottom: '16px',
            }}>
              <div style={{ height: '1px', width: '28px', background: 'linear-gradient(90deg, transparent, #2DD4BF)' }} />
              <span style={{
                fontSize: '10px', fontWeight: 700, letterSpacing: '0.22em',
                color: '#2DD4BF', textTransform: 'uppercase',
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
              }}>Capabilities</span>
              <div style={{ height: '1px', width: '28px', background: 'linear-gradient(90deg, #2DD4BF, transparent)' }} />
            </div>
            <h2 className="section-heading" style={{
              fontSize: 'clamp(30px, 4vw, 44px)', fontWeight: 800,
              letterSpacing: '-0.02em', lineHeight: 1.1,
              color: '#f8fafc', margin: '0 0 16px',
            }}>
              What ChainLens Does
            </h2>
            <p style={{
              fontSize: '16px', color: 'rgba(255,255,255,0.42)',
              maxWidth: '460px', margin: '0 auto', lineHeight: 1.65,
            }}>
              Eight features. One terminal. Built natively on Base.
            </p>
          </div>

          {/* 2 × 2 grid */}
          <div className="feat-grid" style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '20px',
          }}>
            {FEATURES.map((f, i) => (
              <div
                key={f.title}
                className="feat-card"
                style={{
                  background: 'linear-gradient(145deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.015) 100%)',
                  border: `1px solid ${f.borderColor}`,
                  borderRadius: '20px',
                  padding: '32px 28px',
                  backdropFilter: 'blur(12px)',
                  WebkitBackdropFilter: 'blur(12px)',
                  boxShadow: '0 4px 24px rgba(0,0,0,0.30)',
                  animationDelay: `${i * 0.10}s`,
                  position: 'relative',
                  overflow: 'hidden',
                  transition: 'border-color 300ms ease, box-shadow 300ms ease, background 300ms ease',
                }}
                onMouseEnter={e => {
                  const el = e.currentTarget as HTMLDivElement
                  el.style.borderColor = 'rgba(45,212,191,0.55)'
                  el.style.boxShadow   = '0 0 32px rgba(45,212,191,0.18), 0 8px 40px rgba(0,0,0,0.40)'
                  el.style.background  = 'linear-gradient(145deg, rgba(255,255,255,0.05) 0%, rgba(45,212,191,0.03) 100%)'
                }}
                onMouseLeave={e => {
                  const el = e.currentTarget as HTMLDivElement
                  el.style.borderColor = f.borderColor
                  el.style.boxShadow   = '0 4px 24px rgba(0,0,0,0.30)'
                  el.style.background  = 'linear-gradient(145deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.015) 100%)'
                }}
              >
                {/* Top accent line — slides in on hover */}
                <div className="feat-top-line" style={{
                  position: 'absolute', top: 0, left: 0, right: 0, height: '2px',
                  background: `linear-gradient(90deg, transparent 0%, ${f.accent}88 50%, transparent 100%)`,
                }} />

                {/* Icon — circular ring */}
                <div style={{
                  width: '56px', height: '56px', borderRadius: '50%',
                  background: `rgba(${f.accent === '#2DD4BF' ? '45,212,191' : f.accent === '#ec4899' ? '236,72,153' : f.accent === '#8b5cf6' ? '139,92,246' : '96,165,250'}, 0.08)`,
                  border: `2px solid ${f.accent}55`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: f.accent,
                  marginBottom: '20px',
                  boxShadow: `0 0 24px ${f.accent}33, inset 0 0 12px ${f.accent}11`,
                  flexShrink: 0,
                }}>
                  {f.icon}
                </div>

                {/* Title */}
                <h3 style={{
                  fontSize: '17px', fontWeight: 700,
                  letterSpacing: '-0.01em', lineHeight: 1.2,
                  margin: '0 0 10px',
                  background: f.grad,
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  backgroundClip: 'text',
                }}>
                  {f.title}
                </h3>

                {/* Body */}
                <p style={{
                  fontSize: '14px', lineHeight: 1.7,
                  color: 'rgba(255,255,255,0.45)',
                  margin: 0,
                  fontWeight: 400,
                }}>
                  {f.body}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* ── Testimonials ─────────────────────────────────────────────────── */}
        <section style={{
          position: 'relative', zIndex: 1,
          padding: '88px 24px 96px',
          maxWidth: '1120px', margin: '0 auto', width: '100%',
        }}>
          {/* Section header */}
          <div style={{ textAlign: 'center', marginBottom: '56px' }}>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: '7px', marginBottom: '16px' }}>
              <div style={{ height: '1px', width: '28px', background: 'linear-gradient(90deg, transparent, #2DD4BF)' }} />
              <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.22em', color: '#2DD4BF', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Traders</span>
              <div style={{ height: '1px', width: '28px', background: 'linear-gradient(90deg, #2DD4BF, transparent)' }} />
            </div>
            <h2 className="section-heading" style={{
              fontSize: 'clamp(28px, 3.8vw, 42px)', fontWeight: 800,
              letterSpacing: '-0.02em', lineHeight: 1.1,
              color: '#f8fafc', margin: 0,
            }}>
              What Base traders are saying.
            </h2>
          </div>

          {/* 3 × 2 grid */}
          <div className="mob-grid-1" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px' }}>
            {[
              { handle: '@0xdegen_base',   name: '0xDegen',        initials: '0D', grad: 'linear-gradient(135deg,#2DD4BF,#8b5cf6)', quote: 'clark called the rug before it happened. saved me $4k. nothing else on base does this.' },
              { handle: '@basewhale_eth',  name: 'BaseWhale.eth',  initials: 'BW', grad: 'linear-gradient(135deg,#3b82f6,#2DD4BF)', quote: 'scanned a wallet and clark literally described my trading personality. eerie accurate.' },
              { handle: '@virtualsmaxi',   name: 'VirtualsMaxi',   initials: 'VM', grad: 'linear-gradient(135deg,#8b5cf6,#ec4899)', quote: 'been using nansen for 2 years. chainlens does more for base at $30. not even close.' },
              { handle: '@defi_lurker',    name: 'DeFi Lurker',    initials: 'DL', grad: 'linear-gradient(135deg,#ec4899,#f97316)', quote: 'base radar found a gem 40 minutes before it hit ct. already 8x.' },
              { handle: '@0xalphahunter', name: '0xAlphaHunter',  initials: '0A', grad: 'linear-gradient(135deg,#4ade80,#2DD4BF)', quote: 'the liquidity scanner flagged an unlocked lp. token rugged 3 hours later. this thing works.' },
              { handle: '@basedegen99',    name: 'BaseDegen99',    initials: 'BD', grad: 'linear-gradient(135deg,#a78bfa,#3b82f6)', quote: 'clark ai is the real deal. asked about a token and got a full breakdown in 5 seconds. insane.' },
            ].map((t, i) => (
              <div
                key={i}
                style={{
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: '16px',
                  padding: '20px',
                  backdropFilter: 'blur(12px)',
                  WebkitBackdropFilter: 'blur(12px)',
                  boxShadow: '0 4px 24px rgba(0,0,0,0.28)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '14px',
                  position: 'relative',
                  transition: 'border-color 300ms ease, box-shadow 300ms ease',
                }}
                onMouseEnter={e => { const el = e.currentTarget as HTMLDivElement; el.style.borderColor = 'rgba(255,255,255,0.16)'; el.style.boxShadow = '0 0 28px rgba(0,0,0,0.45), 0 8px 40px rgba(0,0,0,0.30)' }}
                onMouseLeave={e => { const el = e.currentTarget as HTMLDivElement; el.style.borderColor = 'rgba(255,255,255,0.08)'; el.style.boxShadow = '0 4px 24px rgba(0,0,0,0.28)' }}
              >
                {/* Header row: avatar + name/handle */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  {/* Avatar */}
                  <div style={{
                    width: '44px', height: '44px', borderRadius: '50%',
                    background: t.grad,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    flexShrink: 0,
                    fontSize: '14px', fontWeight: 800, color: '#fff',
                    letterSpacing: '-0.02em',
                  }}>
                    {t.initials}
                  </div>
                  {/* Name + handle */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginBottom: '2px' }}>
                      <span style={{ fontSize: '14px', fontWeight: 700, color: '#fff', lineHeight: 1.2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.name}</span>
                      {/* Verified blue tick */}
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
                        <circle cx="12" cy="12" r="12" fill="#1d9bf0"/>
                        <path d="M9.5 16.5l-3.5-3.5 1.4-1.4 2.1 2.1 5.6-5.6 1.4 1.4z" fill="#fff"/>
                      </svg>
                    </div>
                    <div style={{ fontSize: '12px', color: '#2DD4BF', fontWeight: 500 }}>{t.handle}</div>
                  </div>
                  {/* X/Twitter logo top right */}
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="rgba(255,255,255,0.25)" style={{ flexShrink: 0 }}>
                    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.748l7.73-8.835L1.254 2.25H8.08l4.261 5.632zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
                  </svg>
                </div>

                {/* Stars */}
                <div style={{ display: 'flex', gap: '2px' }}>
                  {[...Array(5)].map((_, s) => (
                    <svg key={s} width="14" height="14" viewBox="0 0 24 24" fill="#fbbf24">
                      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>
                    </svg>
                  ))}
                </div>

                {/* Quote */}
                <p style={{ fontSize: '14px', lineHeight: 1.65, color: 'rgba(255,255,255,0.85)', margin: 0, fontWeight: 400, flex: 1 }}>
                  {t.quote}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* ── Stats bar ────────────────────────────────────────────────────── */}
        <div style={{
          position: 'relative', zIndex: 1,
          borderTop: '1px solid rgba(255,255,255,0.06)',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          background: 'linear-gradient(180deg, rgba(45,212,191,0.03) 0%, transparent 100%)',
          padding: '40px 24px',
        }}>
          <div className="mob-grid-1" style={{
            maxWidth: '900px', margin: '0 auto',
            display: 'grid', gridTemplateColumns: '1fr 1fr 1fr',
            gap: '0',
          }}>
            {[
              { label: '8',                        sub: 'Intelligence Features' },
              { label: 'Base',                     sub: 'Built Natively On' },
              { label: 'CORTEX',                   sub: 'Powered by Engine' },
            ].map((s, i) => (
              <div key={i} style={{
                textAlign: 'center',
                borderRight: i < 2 ? '1px solid rgba(255,255,255,0.07)' : 'none',
                padding: '0 24px',
              }}>
                <div style={{
                  fontSize: 'clamp(28px, 4vw, 42px)', fontWeight: 800,
                  letterSpacing: '-0.02em', lineHeight: 1,
                  color: '#2DD4BF',
                  fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                  marginBottom: '8px',
                  textShadow: '0 0 28px rgba(45,212,191,0.45)',
                }}>
                  {s.label}
                </div>
                <div style={{
                  fontSize: '13px', color: 'rgba(255,255,255,0.38)',
                  fontWeight: 500, letterSpacing: '0.04em',
                }}>
                  {s.sub}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── How It Works ─────────────────────────────────────────────────── */}
        <section style={{
          position: 'relative', zIndex: 1,
          padding: '88px 24px 96px',
          maxWidth: '1120px', margin: '0 auto', width: '100%',
        }}>
          {/* Section header */}
          <div style={{ textAlign: 'center', marginBottom: '56px' }}>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: '7px', marginBottom: '16px' }}>
              <div style={{ height: '1px', width: '28px', background: 'linear-gradient(90deg, transparent, #2DD4BF)' }} />
              <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.22em', color: '#2DD4BF', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>How It Works</span>
              <div style={{ height: '1px', width: '28px', background: 'linear-gradient(90deg, #2DD4BF, transparent)' }} />
            </div>
            <h2 className="section-heading" style={{
              fontSize: 'clamp(28px, 3.8vw, 42px)', fontWeight: 800,
              letterSpacing: '-0.02em', lineHeight: 1.1,
              color: '#f8fafc', margin: 0,
            }}>
              Three steps. Total clarity.
            </h2>
          </div>

          {/* Steps row */}
          <div className="feat-grid mob-grid-1" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '20px' }}>
            {[
              { step: '01', title: 'Paste any wallet or token',       desc: 'Drop in any address, contract, or token — Clark handles the rest.' },
              { step: '02', title: 'CORTEX analyses the data',        desc: 'Our engine pulls onchain data, scores risk, and maps smart money in seconds.' },
              { step: '03', title: 'Clark tells you what it means',   desc: 'No charts to decode. Clark gives you clear, plain-English intelligence.' },
            ].map((s, i) => (
              <div key={i} style={{
                background: 'linear-gradient(145deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.015) 100%)',
                border: '1px solid rgba(255,255,255,0.07)',
                borderRadius: '20px', padding: '32px 28px',
                backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
                boxShadow: '0 4px 24px rgba(0,0,0,0.30)',
                position: 'relative', overflow: 'hidden',
                transition: 'border-color 300ms ease, box-shadow 300ms ease',
              }}
                onMouseEnter={e => { const el = e.currentTarget as HTMLDivElement; el.style.borderColor = 'rgba(45,212,191,0.40)'; el.style.boxShadow = '0 0 28px rgba(45,212,191,0.14), 0 8px 40px rgba(0,0,0,0.40)' }}
                onMouseLeave={e => { const el = e.currentTarget as HTMLDivElement; el.style.borderColor = 'rgba(255,255,255,0.07)'; el.style.boxShadow = '0 4px 24px rgba(0,0,0,0.30)' }}
              >
                {/* Top teal line */}
                <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '1px', background: 'linear-gradient(90deg, transparent, rgba(45,212,191,0.40), transparent)' }} />

                <div style={{
                  fontSize: 'clamp(36px, 4vw, 48px)', fontWeight: 800,
                  color: '#2DD4BF', lineHeight: 1, marginBottom: '20px',
                  fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                  textShadow: '0 0 24px rgba(45,212,191,0.40)',
                  letterSpacing: '-0.02em',
                }}>
                  {s.step}
                </div>
                <h3 style={{
                  fontSize: '16px', fontWeight: 700,
                  color: '#f1f5f9', margin: '0 0 10px',
                  letterSpacing: '-0.01em', lineHeight: 1.3,
                }}>
                  {s.title}
                </h3>
                <p style={{
                  fontSize: '14px', lineHeight: 1.65,
                  color: 'rgba(255,255,255,0.42)',
                  margin: 0, fontWeight: 400,
                }}>
                  {s.desc}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* ── Live Intelligence Preview ─────────────────────────────────────── */}
        <section style={{ position: 'relative', zIndex: 1, padding: '0 24px 96px', maxWidth: '1120px', margin: '0 auto', width: '100%' }}>
          {/* Section header */}
          <div style={{ textAlign: 'center', marginBottom: '52px' }}>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: '7px', marginBottom: '16px' }}>
              <div style={{ height: '1px', width: '28px', background: 'linear-gradient(90deg, transparent, #ec4899)' }} />
              <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.22em', color: '#ec4899', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Live Preview</span>
              <div style={{ height: '1px', width: '28px', background: 'linear-gradient(90deg, #ec4899, transparent)' }} />
            </div>
            <h2 className="section-heading" style={{ fontSize: 'clamp(28px, 3.8vw, 42px)', fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1.1, color: '#f8fafc', margin: '0 0 14px' }}>
              Live Intelligence Preview
            </h2>
            <p style={{ fontSize: '15px', color: 'rgba(255,255,255,0.38)', maxWidth: '420px', margin: '0 auto', lineHeight: 1.65 }}>
              A glimpse of the intelligence ChainLens surfaces — live, onchain, and AI-powered.
            </p>
          </div>

          {/* 2 × 2 grid */}
          <div className="feat-grid mob-grid-1" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
            {[
              { accent: '#2DD4BF', title: 'Trending Tokens',    desc: "A clean overview of what's moving on-chain. Shows which tokens are gaining attention, volume, or momentum." },
              { accent: '#ec4899', title: 'Smart Money Moves',  desc: 'A preview of how ChainLens will track high-value wallets and their actions in real time.' },
              { accent: '#8b5cf6', title: 'Liquidity Scanner',  desc: 'An overview of how ChainLens will analyze liquidity health, LP status, and contract safety.' },
              { accent: '#60a5fa', title: 'Token Scan + Clark AI', desc: 'A preview of how ChainLens AI will break down any token and provide insights, risks, and context.' },
            ].map((p, i) => (
              <div
                key={p.title}
                className="feat-card"
                style={{
                  background: 'linear-gradient(145deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0.01) 100%)',
                  border: '1px solid rgba(255,255,255,0.07)',
                  borderRadius: '20px', padding: '28px',
                  backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
                  boxShadow: '0 4px 24px rgba(0,0,0,0.28)',
                  animationDelay: `${i * 0.10}s`,
                  position: 'relative', overflow: 'hidden',
                  transition: 'border-color 300ms ease, box-shadow 300ms ease',
                }}
                onMouseEnter={e => { const el = e.currentTarget as HTMLDivElement; el.style.borderColor = `${p.accent}44`; el.style.boxShadow = `0 16px 48px ${p.accent}18, 0 4px 16px rgba(0,0,0,0.40)` }}
                onMouseLeave={e => { const el = e.currentTarget as HTMLDivElement; el.style.borderColor = 'rgba(255,255,255,0.07)'; el.style.boxShadow = '0 4px 24px rgba(0,0,0,0.28)' }}
              >
                {/* Top accent line — slides in on hover */}
                <div className="feat-top-line" style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '2px', background: `linear-gradient(90deg, transparent, ${p.accent}88, transparent)` }} />

                {/* Card header */}
                <div style={{ marginBottom: '20px' }}>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
                    <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: p.accent, boxShadow: `0 0 8px ${p.accent}99` }} />
                    <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.18em', color: p.accent, textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Preview</span>
                  </div>
                  <h3 style={{ fontSize: '16px', fontWeight: 700, color: '#f1f5f9', margin: '0 0 8px', letterSpacing: '-0.01em' }}>{p.title}</h3>
                  <p style={{ fontSize: '13px', lineHeight: 1.65, color: 'rgba(255,255,255,0.38)', margin: 0 }}>{p.desc}</p>
                </div>

                {/* Placeholder box */}
                <div style={{ height: '160px', borderRadius: '12px', background: 'linear-gradient(160deg, rgba(255,255,255,0.025) 0%, rgba(255,255,255,0.008) 100%)', border: '1px solid rgba(255,255,255,0.06)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '10px', position: 'relative', overflow: 'hidden' }}>
                  <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', backgroundImage: 'radial-gradient(rgba(255,255,255,0.06) 1px, transparent 1px)', backgroundSize: '20px 20px' }} />
                  <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px' }}>
                    <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#2DD4BF', boxShadow: '0 0 8px rgba(45,212,191,0.6)', animation: 'cl-pulse 2s ease-in-out infinite' }} />
                    <span style={{ fontSize: '12px', color: '#475569', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', letterSpacing: '0.04em' }}>Coming Soon</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* ── CTA ─────────────────────────────────────────────────────────── */}
        <section style={{
          position: 'relative', zIndex: 1,
          padding: '80px 24px 100px',
          textAlign: 'center',
        }}>
          <h2 className="section-heading" style={{
            fontSize: 'clamp(26px, 3.5vw, 40px)', fontWeight: 800,
            letterSpacing: '-0.02em', lineHeight: 1.15,
            color: '#f8fafc', margin: '0 0 36px',
          }}>
            Ready to see the market before it moves?
          </h2>
          <Link href="/terminal" style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '10px',
            padding: '16px 44px',
            borderRadius: '12px',
            background: 'linear-gradient(90deg, #2DD4BF 0%, #0ea5e9 100%)',
            color: '#07070f',
            fontSize: '14px',
            fontWeight: 800,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            textDecoration: 'none',
            boxShadow: '0 0 40px rgba(45,212,191,0.45), 0 0 80px rgba(45,212,191,0.15)',
            transition: 'opacity 0.15s, transform 0.15s, box-shadow 0.15s',
          }}
            onMouseEnter={e => {
              const el = e.currentTarget as HTMLAnchorElement
              el.style.opacity   = '0.90'
              el.style.transform = 'translateY(-2px)'
              el.style.boxShadow = '0 0 56px rgba(45,212,191,0.60), 0 0 100px rgba(45,212,191,0.22)'
            }}
            onMouseLeave={e => {
              const el = e.currentTarget as HTMLAnchorElement
              el.style.opacity   = '1'
              el.style.transform = 'translateY(0)'
              el.style.boxShadow = '0 0 40px rgba(45,212,191,0.45), 0 0 80px rgba(45,212,191,0.15)'
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <rect x="2" y="3" width="20" height="14" rx="2" stroke="currentColor" strokeWidth="2"/>
              <path d="M8 21h8M12 17v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              <path d="M7 8l3 3-3 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
              <line x1="13" y1="11" x2="17" y2="11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
            </svg>
            Enter Terminal
          </Link>
        </section>

        {/* ── Pricing ──────────────────────────────────────────────────────── */}
        <section style={{ position: 'relative', zIndex: 1, padding: '88px 24px 96px' }}>
          {/* Top separator */}
          <div style={{ position: 'absolute', top: 0, left: '10%', right: '10%', height: '1px', background: 'linear-gradient(90deg, transparent, rgba(45,212,191,0.25), rgba(139,92,246,0.25), transparent)' }} />

          {/* Header */}
          <div style={{ textAlign: 'center', marginBottom: '48px' }}>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: '7px', marginBottom: '16px' }}>
              <div style={{ height: '1px', width: '28px', background: 'linear-gradient(90deg, transparent, #2DD4BF)' }} />
              <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.22em', color: '#2DD4BF', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Pricing</span>
              <div style={{ height: '1px', width: '28px', background: 'linear-gradient(90deg, #2DD4BF, transparent)' }} />
            </div>
            <h2 className="section-heading" style={{ fontSize: 'clamp(22px, 3vw, 40px)', fontWeight: 900, letterSpacing: '-0.03em', lineHeight: 1.0, color: '#fff', margin: '0 0 10px' }}>
              One price. Worldwide.
            </h2>
            <p style={{ fontSize: '13px', color: 'rgba(255,255,255,0.38)', lineHeight: 1.65, maxWidth: '360px', margin: '0 auto' }}>
              No dark patterns. No regional pricing. Cancel any time. Your data stays yours.
            </p>
          </div>

          {/* Cards — Elite gets 1.28× width */}
          <div className="mob-pricing-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.28fr', gap: '14px', maxWidth: '1020px', margin: '0 auto', alignItems: 'start' }}>
            {[
              {
                id: 'free', label: 'FREE', labelColor: '#ec4899', price: '$0',
                billing: 'forever free · no card required', engine: 'CORTEX LITE', engineColor: 'rgba(236,72,153,0.65)',
                cta: 'Get Started Free', ctaStyle: 'outline', border: 'rgba(255,255,255,0.09)', badge: null,
                bg: 'rgba(10,10,18,0.72)', radius: '14px', pad: '20px 16px 18px', mt: '0',
                sections: [
                  { title: 'Token Scanner', items: ['Price, liquidity, volume, 24h change', 'Basic token info only', 'No AI verdict'] },
                  { title: 'Liquidity Safety', items: ['Basic LP score only', 'No full LP analysis'] },
                  { title: 'Clark AI', items: ['3 prompts per day'] },
                  { title: 'Not Included', items: ['No Wallet Scanner', 'No Dev Wallet Detector', 'No Pump Alerts', 'No Whale Alerts', 'No Base Radar'] },
                ],
              },
              {
                id: 'pro', label: 'PRO', labelColor: '#2DD4BF', price: '$30',
                billing: 'per month · 7-day free trial', engine: 'CORTEX STANDARD', engineColor: 'rgba(45,212,191,0.65)',
                cta: 'Start Free Trial', ctaStyle: 'gradient', border: 'rgba(139,92,246,0.55)', badge: 'MOST POPULAR',
                bg: 'rgba(12,10,26,0.92)', radius: '14px', pad: '20px 16px 18px', mt: '-8px',
                sections: [
                  { title: 'Everything in Free, plus', items: ['Full Token Scanner', 'Full Liquidity Safety', 'Wallet Scanner', 'Dev Wallet Detector', 'Pump Alerts', 'Whale Alerts', 'Base Radar', 'Clark AI — 50 prompts / day'] },
                ],
              },
              {
                id: 'elite', label: 'ELITE', labelColor: '#fbbf24', price: '$60',
                billing: 'per month · 7-day free trial', engine: 'CORTEX FULL INTELLIGENCE', engineColor: 'rgba(251,191,36,0.75)',
                cta: 'Unlock Elite', ctaStyle: 'gold', border: 'rgba(251,191,36,0.40)', badge: 'FULL INTELLIGENCE',
                bg: 'rgba(16,12,4,0.95)', radius: '18px', pad: '24px 22px 20px', mt: '-14px',
                sections: [
                  { title: 'Everything in Pro, plus', items: ['Clark AI — unlimited prompts', 'Auto Clark verdict on every scan', 'Smart money tracking', 'Advanced whale alerts', 'Priority CORTEX processing', 'Early access to new features'] },
                ],
              },
            ].map(plan => {
              const isElite = plan.id === 'elite'
              const isPro   = plan.id === 'pro'
              const checkColor: Record<string,string> = { free: 'rgba(236,72,153,0.55)', pro: '#2DD4BF', elite: '#fbbf24' }
              const secColor:   Record<string,string> = { free: 'rgba(236,72,153,0.60)', pro: 'rgba(45,212,191,0.60)', elite: 'rgba(251,191,36,0.65)' }
              return (
                <div
                  key={plan.id}
                  className={`pricing-card ${isElite ? 'card-elite' : isPro ? 'card-pro' : 'card-free'}`}
                  style={{
                    position: 'relative',
                    background: plan.bg,
                    borderRadius: plan.radius,
                    padding: plan.pad,
                    display: 'flex', flexDirection: 'column',
                    marginTop: plan.mt,
                    ...(!isPro && !isElite ? { border: `1px solid ${plan.border}` } : {}),
                  }}
                >
                  {/* Badge */}
                  {plan.badge && (
                    <div style={{
                      position: 'absolute', top: '-15px', left: '50%', transform: 'translateX(-50%)',
                      background: isElite ? 'linear-gradient(90deg,#f59e0b,#fbbf24,#f59e0b)' : 'linear-gradient(90deg,#8b5cf6,#ec4899)',
                      borderRadius: '999px', padding: '3px 12px',
                      fontSize: '8px', fontWeight: 800, letterSpacing: '0.18em',
                      color: isElite ? '#0a0800' : '#fff',
                      whiteSpace: 'nowrap', fontFamily: 'var(--font-plex-mono,IBM Plex Mono,monospace)',
                      boxShadow: isElite ? '0 0 14px rgba(251,191,36,0.50)' : undefined,
                    }}>{plan.badge}</div>
                  )}
                  {/* Tier label */}
                  <div style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.18em', color: plan.labelColor, fontFamily: 'var(--font-plex-mono,IBM Plex Mono,monospace)', marginBottom: '7px' }}>{plan.label}</div>
                  {/* Price */}
                  <div style={{
                    fontSize: isElite ? 'clamp(34px,3.8vw,48px)' : 'clamp(30px,3.2vw,42px)',
                    fontWeight: 300, lineHeight: 1, letterSpacing: '-0.01em', marginBottom: '4px',
                    ...(isElite ? { background: 'linear-gradient(135deg,#fbbf24 0%,#fff 60%,#fbbf24 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' } : { color: '#fff' }),
                  }}>{plan.price}</div>
                  {/* Billing */}
                  <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.30)', marginBottom: '12px', fontFamily: 'var(--font-plex-mono,IBM Plex Mono,monospace)' }}>{plan.billing}</div>
                  {/* Engine badge */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginBottom: '12px' }}>
                    <div style={{ width: '4px', height: '4px', borderRadius: '50%', background: plan.engineColor, flexShrink: 0, boxShadow: isElite ? '0 0 5px rgba(251,191,36,0.80)' : undefined }} />
                    <span style={{ fontSize: '7px', fontWeight: 700, letterSpacing: '0.16em', color: plan.engineColor, fontFamily: 'var(--font-plex-mono,IBM Plex Mono,monospace)' }}>{plan.engine}</span>
                  </div>
                  {/* Divider */}
                  <div style={{ height: '1px', background: isElite ? 'rgba(251,191,36,0.15)' : 'rgba(255,255,255,0.07)', marginBottom: '14px' }} />
                  {/* Feature sections */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '16px', flex: 1 }}>
                    {plan.sections.map(sec => (
                      <div key={sec.title}>
                        <div style={{ fontSize: '7px', fontWeight: 700, letterSpacing: '0.16em', color: secColor[plan.id], fontFamily: 'var(--font-plex-mono,IBM Plex Mono,monospace)', textTransform: 'uppercase', marginBottom: '5px' }}>{sec.title}</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                          {sec.items.map(item => {
                            const isNo = item.startsWith('No ')
                            return (
                              <div key={item} style={{ display: 'flex', alignItems: 'flex-start', gap: '7px' }}>
                                <span style={{ fontSize: '9px', flexShrink: 0, marginTop: '1px', color: isNo ? 'rgba(255,255,255,0.18)' : checkColor[plan.id], lineHeight: 1.2 }}>{isNo ? '✕' : '✓'}</span>
                                <span style={{ fontSize: '11px', lineHeight: 1.45, color: isNo ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.72)' }}>{item}</span>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                  {/* Elite note */}
                  {isElite && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(251,191,36,0.07)', border: '1px solid rgba(251,191,36,0.18)', borderRadius: '10px', padding: '8px 12px', marginBottom: '12px' }}>
                      <span style={{ fontSize: '13px', flexShrink: 0 }}>⭐</span>
                      <span style={{ fontSize: '11px', fontWeight: 600, color: 'rgba(251,191,36,0.85)', lineHeight: 1.4 }}>Everything in Pro included — plus full CORTEX intelligence.</span>
                    </div>
                  )}
                  {/* CTA */}
                  <Link href="/pricing" className={`cta-${plan.ctaStyle}`} style={{ display: 'block', textAlign: 'center', padding: isElite ? '10px 16px' : '9px 14px', borderRadius: '8px', fontSize: '10px', fontWeight: 700, letterSpacing: '0.10em', textTransform: 'uppercase', textDecoration: 'none', cursor: 'pointer' }}>{plan.cta}</Link>
                </div>
              )
            })}
          </div>
        </section>

      </div>

      {/* ── Footer ───────────────────────────────────────────────────────────── */}
      <footer style={{
        background: '#080c14',
        position: 'relative', zIndex: 1,
        padding: '80px 32px 72px',
        borderTop: '1px solid rgba(255,255,255,0.06)',
      }}>
        {/* Full-width teal gradient top border */}
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: '1px',
          background: 'linear-gradient(90deg, transparent 0%, #2DD4BF 50%, transparent 100%)',
        }} />

        <div className="mob-footer-grid" style={{ maxWidth: '1120px', margin: '0 auto', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '48px', alignItems: 'start' }}>

          {/* Left — brand + socials */}
          <div style={{ position: 'relative' }}>
            {/* Subtle teal glow behind left section */}
            <div style={{
              position: 'absolute', top: '-20px', left: '-40px',
              width: '300px', height: '200px',
              background: 'radial-gradient(ellipse, rgba(45,212,191,0.07) 0%, transparent 70%)',
              filter: 'blur(30px)', pointerEvents: 'none',
            }} />
            {/* Logo + name */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px', position: 'relative' }}>
              <img src="/cl-logo.png" alt="ChainLens" style={{ width: '34px', height: '34px', objectFit: 'contain' }} />
              <span style={{ fontSize: '19px', fontWeight: 800, color: '#f8fafc', letterSpacing: '-0.02em' }}>ChainLens AI</span>
            </div>
            {/* Tagline */}
            <div style={{ fontSize: '13px', color: '#94a3b8', lineHeight: 1.65, marginBottom: '8px', position: 'relative' }}>
              onchain intelligence for Base traders
            </div>
            <div style={{ fontSize: '13px', color: '#475569', lineHeight: 1.65, marginBottom: '24px', position: 'relative', maxWidth: '280px' }}>
              Scan wallets, track whales, detect pumps, and get AI-powered analysis from Clark — all in one terminal.
            </div>
            {/* Social pills */}
            <div style={{ display: 'flex', gap: '10px', position: 'relative' }}>
              <Link
                href="https://x.com/chainlens__ai"
                target="_blank" rel="noopener noreferrer"
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: '7px',
                  padding: '8px 16px', borderRadius: '999px',
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  fontSize: '12px', fontWeight: 600, color: 'rgba(255,255,255,0.65)',
                  textDecoration: 'none',
                  transition: 'border-color 150ms, color 150ms, background 150ms',
                }}
                onMouseEnter={e => { const el = e.currentTarget as HTMLAnchorElement; el.style.borderColor = '#2DD4BF'; el.style.color = '#2DD4BF'; el.style.background = 'rgba(45,212,191,0.06)' }}
                onMouseLeave={e => { const el = e.currentTarget as HTMLAnchorElement; el.style.borderColor = 'rgba(255,255,255,0.12)'; el.style.color = 'rgba(255,255,255,0.65)'; el.style.background = 'rgba(255,255,255,0.05)' }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.748l7.73-8.835L1.254 2.25H8.08l4.261 5.632zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
                </svg>
                Twitter
              </Link>
              <Link
                href="https://t.me/chainlensaigroup"
                target="_blank" rel="noopener noreferrer"
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: '7px',
                  padding: '8px 16px', borderRadius: '999px',
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  fontSize: '12px', fontWeight: 600, color: 'rgba(255,255,255,0.65)',
                  textDecoration: 'none',
                  transition: 'border-color 150ms, color 150ms, background 150ms',
                }}
                onMouseEnter={e => { const el = e.currentTarget as HTMLAnchorElement; el.style.borderColor = '#2DD4BF'; el.style.color = '#2DD4BF'; el.style.background = 'rgba(45,212,191,0.06)' }}
                onMouseLeave={e => { const el = e.currentTarget as HTMLAnchorElement; el.style.borderColor = 'rgba(255,255,255,0.12)'; el.style.color = 'rgba(255,255,255,0.65)'; el.style.background = 'rgba(255,255,255,0.05)' }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.894 8.221-1.97 9.28c-.145.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c.242-.213-.054-.333-.373-.12L7.17 13.947l-2.965-.924c-.643-.204-.658-.643.136-.953l11.57-4.461c.537-.194 1.006.131.983.612z"/>
                </svg>
                Telegram
              </Link>
            </div>
          </div>

          {/* Center — nav links */}
          <div>
            <div style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.18em', color: '#2DD4BF', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '18px' }}>
              Navigation
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              {[
                { label: 'Terminal',  href: '/terminal'  },
                { label: 'Pricing',   href: '/pricing'   },
                { label: 'Affiliate', href: '/affiliate' },
                { label: 'About',     href: '/about'     },
                { label: 'Terms',     href: '/terms'     },
              ].map(l => (
                <Link key={l.label} href={l.href} style={{ fontSize: '14px', fontWeight: 500, color: '#fff', textDecoration: 'none', transition: 'color 150ms' }}
                  onMouseEnter={e => { (e.currentTarget as HTMLAnchorElement).style.color = '#2DD4BF' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLAnchorElement).style.color = '#fff' }}
                >
                  {l.label}
                </Link>
              ))}
            </div>
          </div>

          {/* Right — Built on Base + copyright */}
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.18em', color: '#2DD4BF', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '18px' }}>
              Infrastructure
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '9px', marginBottom: '16px' }}>
              <div style={{
                width: '7px', height: '7px', borderRadius: '50%',
                background: '#2DD4BF', boxShadow: '0 0 8px rgba(45,212,191,0.75)',
                animation: 'cl-pulse 2s ease-in-out infinite', flexShrink: 0,
              }} />
              <span style={{
                fontSize: '13px', fontWeight: 600,
                color: 'rgba(255,255,255,0.55)',
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                letterSpacing: '0.04em',
              }}>
                Built on Base. Powered by CORTEX.
              </span>
            </div>
            <div style={{ fontSize: '12px', color: '#475569' }}>
              © 2026 ChainLens AI
            </div>
          </div>

        </div>
      </footer>

    </>
  )
}
