import Navbar from '@/components/Navbar'

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="about-label">{children}</div>
}

function Card({ children, accent = false }: { children: React.ReactNode; accent?: boolean }) {
  return <div className={accent ? 'about-card about-card-accent' : 'about-card'}>{children}</div>
}

function CheckItem({ children }: { children: React.ReactNode }) {
  return (
    <div className="about-check">
      <span>✓</span>
      <p>{children}</p>
    </div>
  )
}

function DotItem({ children }: { children: React.ReactNode }) {
  return (
    <div className="about-dot">
      <i />
      <p>{children}</p>
    </div>
  )
}

const whatWeDo = [
  'Real-time blockchain data',
  'Liquidity and LP analysis',
  'Whale alerts',
  'Contract safety checks',
  'AI-driven risk scoring',
  'Token and wallet scanning',
  'Pump alerts and Base Radar',
  'Clark AI reports',
]

const blindspots = [
  'Hidden risks', 'Liquidity traps', 'Unlock events',
  'Contract exploits', 'Fake volume', 'Rug-pull patterns', 'Whale manipulation',
]

export default function AboutPage() {
  return (
    <>
      <style>{`
        @keyframes about-orb {
          0%,100% { transform: translate(0,0) scale(1); }
          50% { transform: translate(28px,-16px) scale(1.06); }
        }
        .about-shell { min-height: 100vh; background: #07070f; color: #e2e8f0; position: relative; overflow-x: hidden; font-family: var(--font-inter, Inter, sans-serif); }
        .about-grid {
          position: absolute; inset: 0; pointer-events: none; z-index: 0;
          background-image:
            linear-gradient(rgba(45,212,191,0.05) 1px, transparent 1px),
            linear-gradient(90deg, rgba(45,212,191,0.05) 1px, transparent 1px);
          background-size: 52px 52px;
          mask-image: radial-gradient(ellipse 90% 58% at 50% 0%, black 8%, transparent 78%);
          -webkit-mask-image: radial-gradient(ellipse 90% 58% at 50% 0%, black 8%, transparent 78%);
        }
        .about-content { position: relative; z-index: 1; max-width: 1040px; margin: 0 auto; padding: 56px 24px 100px; }
        .about-kicker {
          display: inline-flex; align-items: center; gap: 8px;
          background: rgba(45,212,191,0.08); border: 1px solid rgba(45,212,191,0.28);
          border-radius: 999px; padding: 6px 14px; margin-bottom: 22px;
          font-size: 10px; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase; color: #5eead4;
          font-family: var(--font-plex-mono, IBM Plex Mono, monospace);
        }
        .about-kicker b { width: 6px; height: 6px; border-radius: 50%; background: #2DD4BF; box-shadow: 0 0 10px #2DD4BF; }
        .about-label {
          display: inline-flex; align-items: center; gap: 8px; margin-bottom: 14px;
          font-size: 10px; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase; color: #5eead4;
          font-family: var(--font-plex-mono, IBM Plex Mono, monospace);
        }
        .about-label::before { content: ''; width: 18px; height: 1.5px; background: linear-gradient(90deg, #2DD4BF, transparent); }
        .about-card {
          position: relative; overflow: hidden; height: 100%;
          background: linear-gradient(180deg, rgba(45,212,191,0.08) 0%, rgba(8,14,18,0.55) 34%, rgba(7,10,16,0.78) 100%);
          border: 1px solid rgba(45,212,191,0.18);
          border-radius: 22px; padding: 26px 24px;
          box-shadow: inset 0 1px 0 rgba(153,246,228,0.14);
        }
        .about-card::before {
          content: ''; position: absolute; left: 18px; right: 18px; top: 0; height: 1px;
          background: linear-gradient(90deg, transparent, #5eead4, transparent);
        }
        .about-card-accent { background: rgba(45,212,191,0.06); border-color: rgba(45,212,191,0.28); }
        .about-check, .about-dot { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 8px; }
        .about-check span {
          width: 16px; height: 16px; margin-top: 1px; flex-shrink: 0; border-radius: 999px;
          display: inline-flex; align-items: center; justify-content: center;
          background: rgba(45,212,191,0.16); color: #5eead4; font-size: 10px; font-weight: 800;
        }
        .about-check p, .about-dot p { margin: 0; font-size: 13.5px; line-height: 1.5; color: rgba(226,232,240,0.72); }
        .about-dot i { width: 6px; height: 6px; margin-top: 7px; border-radius: 50%; flex-shrink: 0; background: #2DD4BF; box-shadow: 0 0 8px rgba(45,212,191,0.7); }
        .about-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
        .about-grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
        .about-grid-4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
        .about-mini {
          font-size: 10px; font-weight: 700; letter-spacing: 0.16em; color: #5eead4;
          font-family: var(--font-plex-mono, IBM Plex Mono, monospace); margin-bottom: 14px;
        }
        .about-chip {
          background: rgba(45,212,191,0.08); border: 1px solid rgba(45,212,191,0.22);
          border-radius: 14px; padding: 14px 12px; text-align: center;
          font-size: 12.5px; font-weight: 650; color: #d1fae5;
        }
        .about-tag {
          padding: 6px 14px; border-radius: 999px;
          background: rgba(45,212,191,0.1); border: 1px solid rgba(45,212,191,0.28);
          font-size: 12px; font-weight: 650; color: #99f6e4;
        }
        .about-vision {
          position: relative; overflow: hidden; text-align: center;
          border-radius: 24px; padding: 42px 36px;
          background: linear-gradient(180deg, rgba(45,212,191,0.12), rgba(7,12,14,0.4));
          border: 1px solid rgba(45,212,191,0.28);
          box-shadow: inset 0 1px 0 rgba(153,246,228,0.2), 0 0 60px rgba(45,212,191,0.08);
        }
        .about-block { margin-bottom: 28px; }
        @media (max-width: 860px) {
          .about-content { padding: 36px 16px 72px !important; }
          .about-card { padding: 18px !important; }
          .about-grid-2, .about-grid-3, .about-grid-4 { grid-template-columns: 1fr !important; }
          .about-vision { padding: 28px 18px !important; }
        }
        @media (min-width: 641px) and (max-width: 860px) {
          .about-grid-4 { grid-template-columns: 1fr 1fr !important; }
        }
      `}</style>

      <Navbar />

      <div className="about-shell">
        <div className="about-grid" />
        <div style={{
          position: 'absolute', pointerEvents: 'none', zIndex: 0,
          width: '720px', height: '720px', borderRadius: '50%', top: '-200px', left: '6%',
          background: 'radial-gradient(circle, rgba(45,212,191,0.22) 0%, transparent 68%)',
          filter: 'blur(36px)', animation: 'about-orb 16s ease-in-out infinite',
        }} />
        <div style={{
          position: 'absolute', pointerEvents: 'none', zIndex: 0,
          width: '480px', height: '480px', borderRadius: '50%', top: '40px', right: '-60px',
          background: 'radial-gradient(circle, rgba(16,185,129,0.14) 0%, transparent 70%)',
          filter: 'blur(48px)',
        }} />

        <div className="about-content">
          <div style={{ textAlign: 'center', marginBottom: '56px', paddingTop: '12px' }}>
            <div className="about-kicker"><b /> About ChainLens AI</div>
            <h1 style={{
              fontSize: 'clamp(40px, 6vw, 72px)', fontWeight: 800, lineHeight: 0.98,
              letterSpacing: '-0.035em', color: '#fff', margin: '0 0 18px',
            }}>
              On-chain intelligence,
              <br />
              <span style={{
                background: 'linear-gradient(90deg, #99f6e4 0%, #2DD4BF 48%, #34d399 100%)',
                WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
              }}>
                for everyone.
              </span>
            </h1>
            <p style={{ fontSize: '16px', color: 'rgba(226,232,240,0.62)', lineHeight: 1.7, maxWidth: '560px', margin: '0 auto' }}>
              ChainLens exists to give everyday traders the same level of intelligence,
              speed, and clarity that only whales and insiders used to have.
            </p>
          </div>

          <div className="about-block">
            <SectionLabel>Our Mission</SectionLabel>
            <Card accent>
              <p style={{ fontSize: '16px', color: 'rgba(226,232,240,0.72)', lineHeight: 1.75, margin: '0 0 16px' }}>
                We believe on-chain data should be <strong style={{ color: '#fff' }}>simple, beautiful, and actionable</strong> —
                not buried behind dashboards, jargon, or expensive tools.
              </p>
              <p style={{ fontSize: '22px', fontWeight: 750, color: '#5eead4', margin: 0, letterSpacing: '-0.02em' }}>
                Make crypto safer, smarter, and easier for everyone.
              </p>
            </Card>
          </div>

          <div className="about-grid-2 about-block">
            <div>
              <SectionLabel>What We Do</SectionLabel>
              <Card>
                <p style={{ fontSize: '14px', color: 'rgba(226,232,240,0.58)', lineHeight: 1.6, margin: '0 0 16px' }}>
                  An AI-powered on-chain intelligence platform built for the Base ecosystem. We combine:
                </p>
                {whatWeDo.map((item) => <CheckItem key={item}>{item}</CheckItem>)}
                <p style={{ fontSize: '12px', color: '#5eead4', margin: '16px 0 0', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', letterSpacing: '0.04em' }}>
                  No noise. No clutter. Just what matters.
                </p>
              </Card>
            </div>
            <div>
              <SectionLabel>Why We Built ChainLens</SectionLabel>
              <Card>
                <p style={{ fontSize: '14px', color: 'rgba(226,232,240,0.58)', lineHeight: 1.6, margin: '0 0 16px' }}>
                  Crypto is full of things most traders can&apos;t see early:
                </p>
                {blindspots.map((item) => <DotItem key={item}>{item}</DotItem>)}
                <div style={{ height: '1px', background: 'rgba(45,212,191,0.16)', margin: '16px 0' }} />
                <p style={{ fontSize: '14px', color: 'rgba(226,232,240,0.7)', lineHeight: 1.65, margin: 0 }}>
                  We built ChainLens because we were tired of seeing people get blindsided.{' '}
                  <strong style={{ color: '#fff' }}>Everyone deserves access to real intelligence — not just insiders.</strong>
                </p>
              </Card>
            </div>
          </div>

          <div className="about-block">
            <SectionLabel>Our Technology</SectionLabel>
            <div className="about-grid-3">
              <Card>
                <div className="about-mini">AI ENGINES</div>
                {['CORTEX Engine — risk analysis', 'Clark AI — token, wallet, LP intelligence', 'Rule-based safety systems', 'Wallet behavior reads'].map((item) => (
                  <CheckItem key={item}>{item}</CheckItem>
                ))}
              </Card>
              <Card>
                <div className="about-mini">DATA PIPELINES</div>
                {['Real-time Base chain indexing', 'Liquidity monitoring', 'Whale tracking', 'Contract event parsing', 'LP lock + unlock detection', 'Volume / liquidity ratio analysis'].map((item) => (
                  <CheckItem key={item}>{item}</CheckItem>
                ))}
              </Card>
              <Card>
                <div className="about-mini">DESIGN PHILOSOPHY</div>
                {['Fast', 'Clean', 'Beautiful', 'No clutter', 'No fake metrics', 'No hype'].map((item) => (
                  <CheckItem key={item}>{item}</CheckItem>
                ))}
                <p style={{ fontSize: '12px', color: '#5eead4', margin: '14px 0 0', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                  Just truth, clarity, and intelligence.
                </p>
              </Card>
            </div>
          </div>

          <div className="about-block">
            <SectionLabel>Our Values</SectionLabel>
            <div className="about-grid-2">
              {[
                ['Transparency', 'No fake stats. No misleading metrics. No hidden agendas.'],
                ['Safety', 'We highlight risks early — without fear, hype, or bias.'],
                ['Speed', 'Crypto moves fast. Your tools should move faster.'],
                ['Simplicity', 'Complex data → simple insights.'],
              ].map(([title, desc]) => (
                <Card key={title}>
                  <div style={{ fontSize: '16px', fontWeight: 750, color: '#5eead4', marginBottom: '8px', letterSpacing: '-0.02em' }}>{title}</div>
                  <p style={{ fontSize: '14px', color: 'rgba(226,232,240,0.6)', margin: 0, lineHeight: 1.6 }}>{desc}</p>
                </Card>
              ))}
            </div>
            <div style={{ marginTop: '16px' }}>
              <Card>
                <div style={{ fontSize: '16px', fontWeight: 750, color: '#5eead4', marginBottom: '8px' }}>Community</div>
                <p style={{ fontSize: '14px', color: 'rgba(226,232,240,0.6)', margin: 0, lineHeight: 1.6 }}>
                  We build with the Base community, not above it.
                </p>
              </Card>
            </div>
          </div>

          <div className="about-block">
            <SectionLabel>Who We Serve</SectionLabel>
            <Card>
              <p style={{ fontSize: '14px', color: 'rgba(226,232,240,0.55)', margin: '0 0 16px' }}>ChainLens is built for:</p>
              <div className="about-grid-4">
                {['Everyday traders', 'DeFi explorers', 'LP providers', 'Smart money trackers', 'Contract researchers', 'Builders', 'Analysts', 'Degens who want real data'].map((who) => (
                  <div key={who} className="about-chip">{who}</div>
                ))}
              </div>
              <p style={{ fontSize: '14px', color: 'rgba(153,246,228,0.7)', margin: '18px 0 0', lineHeight: 1.6 }}>
                If you want to understand what&apos;s happening on-chain — ChainLens is for you.
              </p>
            </Card>
          </div>

          <div className="about-block">
            <SectionLabel>The Team</SectionLabel>
            <Card>
              <p style={{ fontSize: '15px', color: 'rgba(226,232,240,0.68)', lineHeight: 1.7, margin: '0 0 16px' }}>
                ChainLens is built by a small, fast, independent team obsessed with:
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {['AI', 'Crypto', 'Product design', 'Real-time data', 'Safety', 'Transparency'].map((tag) => (
                  <span key={tag} className="about-tag">{tag}</span>
                ))}
              </div>
              <p style={{ fontSize: '14px', color: 'rgba(226,232,240,0.5)', margin: '16px 0 0', lineHeight: 1.6 }}>
                We ship fast, listen to users, and iterate relentlessly.
              </p>
            </Card>
          </div>

          <div className="about-vision">
            <SectionLabel>Our Vision</SectionLabel>
            <p style={{ fontSize: 'clamp(22px, 3vw, 32px)', fontWeight: 800, color: '#fff', lineHeight: 1.3, margin: '8px 0 14px', letterSpacing: '-0.03em' }}>
              To become the{' '}
              <span style={{
                background: 'linear-gradient(90deg, #99f6e4, #2DD4BF)',
                WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
              }}>
                #1 AI-powered on-chain intelligence platform
              </span>
              {' '}on Base — trusted by traders, respected by builders, and used by everyone.
            </p>
            <p style={{ fontSize: '12px', color: '#5eead4', margin: 0, fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', letterSpacing: '0.08em' }}>
              We&apos;re just getting started.
            </p>
          </div>
        </div>
      </div>
    </>
  )
}
