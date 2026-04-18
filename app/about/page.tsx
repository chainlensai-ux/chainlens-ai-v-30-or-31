import Navbar from '@/components/Navbar'

// ─── Reusable section components ──────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: '8px',
      marginBottom: '14px',
    }}>
      <div style={{ width: '18px', height: '1.5px', background: 'linear-gradient(90deg,#2DD4BF,#8b5cf6)' }} />
      <span style={{
        fontSize: '9px', fontWeight: 700, letterSpacing: '0.20em',
        color: 'rgba(45,212,191,0.70)',
        fontFamily: 'var(--font-plex-mono,IBM Plex Mono,monospace)',
        textTransform: 'uppercase',
      }}>{children}</span>
    </div>
  )
}

function Card({ children, accent = false }: { children: React.ReactNode; accent?: boolean }) {
  return (
    <div style={{
      background: accent ? 'rgba(45,212,191,0.04)' : 'rgba(255,255,255,0.025)',
      border: `1px solid ${accent ? 'rgba(45,212,191,0.18)' : 'rgba(255,255,255,0.07)'}`,
      borderRadius: '16px',
      padding: '28px',
    }}>
      {children}
    </div>
  )
}

function CheckItem({ children, color = '#2DD4BF' }: { children: React.ReactNode; color?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', marginBottom: '8px' }}>
      <span style={{ color, fontSize: '11px', flexShrink: 0, marginTop: '2px' }}>✓</span>
      <span style={{ fontSize: '13px', color: 'rgba(255,255,255,0.70)', lineHeight: 1.5,
        fontFamily: 'var(--font-inter,Inter,sans-serif)' }}>
        {children}
      </span>
    </div>
  )
}

function DotItem({ children, color = 'rgba(139,92,246,0.70)' }: { children: React.ReactNode; color?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', marginBottom: '7px' }}>
      <div style={{ width: '4px', height: '4px', borderRadius: '50%', background: color, flexShrink: 0, marginTop: '6px' }} />
      <span style={{ fontSize: '13px', color: 'rgba(255,255,255,0.65)', lineHeight: 1.5,
        fontFamily: 'var(--font-inter,Inter,sans-serif)' }}>
        {children}
      </span>
    </div>
  )
}

// ─── Page ──────────────────────────────────────────────────────────────────

export default function AboutPage() {
  return (
    <>
      <style>{`
        @keyframes about-orb-teal {
          0%,100% { transform:translate(0,0) scale(1); opacity:0.18; }
          50%      { transform:translate(30px,-20px) scale(1.1); opacity:0.28; }
        }
        @keyframes about-orb-purple {
          0%,100% { transform:translate(0,0) scale(1); opacity:0.14; }
          50%      { transform:translate(-20px,25px) scale(1.08); opacity:0.22; }
        }
        @keyframes about-grid-fade {
          0%,100% { opacity:0.50; }
          50%      { opacity:0.75; }
        }
      `}</style>

      <Navbar />

      <div style={{ minHeight: '100vh', background: '#07070f', position: 'relative', overflowX: 'hidden' }}>

        {/* Grid overlay */}
        <div style={{
          position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0,
          backgroundImage: `
            linear-gradient(rgba(255,255,255,0.025) 1px,transparent 1px),
            linear-gradient(90deg,rgba(255,255,255,0.025) 1px,transparent 1px)
          `,
          backgroundSize: '52px 52px',
          maskImage: 'radial-gradient(ellipse 100% 60% at 50% 0%, black 10%, transparent 80%)',
          WebkitMaskImage: 'radial-gradient(ellipse 100% 60% at 50% 0%, black 10%, transparent 80%)',
          animation: 'about-grid-fade 6s ease-in-out infinite',
        }} />

        {/* Teal orb */}
        <div style={{
          position: 'absolute', pointerEvents: 'none', zIndex: 0,
          width: '700px', height: '700px', borderRadius: '50%',
          top: '-100px', left: '-100px',
          background: 'radial-gradient(circle,rgba(45,212,191,0.10) 0%,transparent 70%)',
          filter: 'blur(60px)', animation: 'about-orb-teal 14s ease-in-out infinite',
        }} />

        {/* Purple orb */}
        <div style={{
          position: 'absolute', pointerEvents: 'none', zIndex: 0,
          width: '800px', height: '800px', borderRadius: '50%',
          top: '-80px', right: '-150px',
          background: 'radial-gradient(circle,rgba(139,92,246,0.10) 0%,transparent 70%)',
          filter: 'blur(80px)', animation: 'about-orb-purple 18s ease-in-out infinite',
        }} />

        {/* ── Content ─────────────────────────────────── */}
        <div style={{ position: 'relative', zIndex: 1, maxWidth: '960px', margin: '0 auto', padding: '72px 24px 100px' }}>

          {/* ── Hero ──────────────────────────────────── */}
          <div style={{ textAlign: 'center', marginBottom: '72px' }}>
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: '8px',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(45,212,191,0.20)',
              borderRadius: '999px', padding: '5px 16px', marginBottom: '24px',
            }}>
              <div style={{ width: '5px', height: '5px', borderRadius: '50%', background: '#2DD4BF', boxShadow: '0 0 8px rgba(45,212,191,0.80)' }} />
              <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.18em', color: 'rgba(45,212,191,0.80)',
                fontFamily: 'var(--font-plex-mono,IBM Plex Mono,monospace)', textTransform: 'uppercase' }}>
                About ChainLens AI
              </span>
            </div>

            <h1 style={{
              fontSize: 'clamp(36px,5.5vw,64px)', fontWeight: 900,
              lineHeight: 1.05, letterSpacing: '-0.025em', color: '#fff',
              margin: '0 0 20px',
            }}>
              On-chain intelligence,{' '}
              <span style={{
                background: 'linear-gradient(90deg,#2DD4BF 0%,#8b5cf6 50%,#ec4899 100%)',
                WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
              }}>
                for everyone.
              </span>
            </h1>

            <p style={{
              fontSize: '16px', color: 'rgba(255,255,255,0.50)',
              lineHeight: 1.70, maxWidth: '560px', margin: '0 auto',
            }}>
              ChainLens exists to give everyday traders the same level of intelligence,
              speed, and clarity that only whales and insiders used to have.
            </p>
          </div>

          {/* ── Mission ───────────────────────────────── */}
          <div style={{ marginBottom: '48px' }}>
            <SectionLabel>Our Mission</SectionLabel>
            <Card accent>
              <p style={{ fontSize: '15px', color: 'rgba(255,255,255,0.65)', lineHeight: 1.75, margin: '0 0 16px',
                fontFamily: 'var(--font-inter,Inter,sans-serif)' }}>
                We believe on-chain data should be <strong style={{ color: '#fff' }}>simple, beautiful, and actionable</strong> —
                not buried behind dashboards, jargon, or expensive tools.
              </p>
              <p style={{ fontSize: '18px', fontWeight: 700, color: '#2DD4BF', margin: 0,
                fontFamily: 'var(--font-inter,Inter,sans-serif)', letterSpacing: '-0.01em' }}>
                Make crypto safer, smarter, and easier for everyone.
              </p>
            </Card>
          </div>

          {/* ── What We Do + Why We Built It ─────────── */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '48px' }}>

            <div>
              <SectionLabel>What We Do</SectionLabel>
              <Card>
                <p style={{ fontSize: '13px', color: 'rgba(255,255,255,0.55)', lineHeight: 1.6, margin: '0 0 18px',
                  fontFamily: 'var(--font-inter,Inter,sans-serif)' }}>
                  An AI-powered on-chain intelligence platform built for the Base ecosystem. We combine:
                </p>
                {[
                  'Real-time blockchain data',
                  'Advanced liquidity analysis',
                  'Smart money tracking',
                  'Contract safety checks',
                  'AI-driven risk scoring',
                  'Whale flow detection',
                  'Token and wallet scanning',
                  'LP safety analysis',
                  'Market-moving alerts',
                ].map(i => <CheckItem key={i}>{i}</CheckItem>)}
                <p style={{ fontSize: '12px', color: 'rgba(255,255,255,0.35)', margin: '16px 0 0',
                  fontFamily: 'var(--font-plex-mono,IBM Plex Mono,monospace)', letterSpacing: '0.06em' }}>
                  No noise. No clutter. Just what matters.
                </p>
              </Card>
            </div>

            <div>
              <SectionLabel>Why We Built ChainLens</SectionLabel>
              <Card>
                <p style={{ fontSize: '13px', color: 'rgba(255,255,255,0.55)', lineHeight: 1.6, margin: '0 0 18px',
                  fontFamily: 'var(--font-inter,Inter,sans-serif)' }}>
                  Crypto is full of things most traders can't see early:
                </p>
                {[
                  'Hidden risks', 'Liquidity traps', 'Unlock events',
                  'Contract exploits', 'Fake volume', 'Rug-pull patterns', 'Whale manipulation',
                ].map(i => <DotItem key={i} color='rgba(236,72,153,0.65)'>{i}</DotItem>)}
                <div style={{ height: '1px', background: 'rgba(255,255,255,0.07)', margin: '18px 0' }} />
                <p style={{ fontSize: '13px', color: 'rgba(255,255,255,0.65)', lineHeight: 1.65, margin: 0,
                  fontFamily: 'var(--font-inter,Inter,sans-serif)' }}>
                  We built ChainLens because we were tired of seeing people get blindsided.{' '}
                  <strong style={{ color: '#fff' }}>Everyone deserves access to real intelligence — not just insiders.</strong>
                </p>
              </Card>
            </div>
          </div>

          {/* ── Technology ────────────────────────────── */}
          <div style={{ marginBottom: '48px' }}>
            <SectionLabel>Our Technology</SectionLabel>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '16px' }}>

              <Card>
                <div style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.16em', color: 'rgba(45,212,191,0.65)',
                  fontFamily: 'var(--font-plex-mono,IBM Plex Mono,monospace)', marginBottom: '14px' }}>
                  AI ENGINES
                </div>
                {[
                  'CORTEX Engine — elite risk analysis',
                  'Clark AI — token, wallet, LP intelligence',
                  'Rule-based safety systems',
                  'Smart money pattern detection',
                ].map(i => <CheckItem key={i} color='#2DD4BF'>{i}</CheckItem>)}
              </Card>

              <Card>
                <div style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.16em', color: 'rgba(139,92,246,0.65)',
                  fontFamily: 'var(--font-plex-mono,IBM Plex Mono,monospace)', marginBottom: '14px' }}>
                  DATA PIPELINES
                </div>
                {[
                  'Real-time Base chain indexing',
                  'Liquidity monitoring',
                  'Whale tracking',
                  'Contract event parsing',
                  'LP lock + unlock detection',
                  'Volume / liquidity ratio analysis',
                ].map(i => <CheckItem key={i} color='#8b5cf6'>{i}</CheckItem>)}
              </Card>

              <Card>
                <div style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.16em', color: 'rgba(236,72,153,0.65)',
                  fontFamily: 'var(--font-plex-mono,IBM Plex Mono,monospace)', marginBottom: '14px' }}>
                  DESIGN PHILOSOPHY
                </div>
                {['Fast', 'Clean', 'Beautiful', 'No clutter', 'No fake metrics', 'No hype'].map(i => (
                  <CheckItem key={i} color='#ec4899'>{i}</CheckItem>
                ))}
                <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.30)', margin: '12px 0 0',
                  fontFamily: 'var(--font-plex-mono,IBM Plex Mono,monospace)', letterSpacing: '0.06em' }}>
                  Just truth, clarity, and intelligence.
                </p>
              </Card>

            </div>
          </div>

          {/* ── Values ────────────────────────────────── */}
          <div style={{ marginBottom: '48px' }}>
            <SectionLabel>Our Values</SectionLabel>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: '16px' }}>
              {[
                {
                  title: 'Transparency',
                  color: '#2DD4BF',
                  desc: 'No fake stats. No misleading metrics. No hidden agendas.',
                },
                {
                  title: 'Safety',
                  color: '#ec4899',
                  desc: 'We highlight risks early — without fear, hype, or bias.',
                },
                {
                  title: 'Speed',
                  color: '#8b5cf6',
                  desc: 'Crypto moves fast. Your tools should move faster.',
                },
                {
                  title: 'Simplicity',
                  color: '#fbbf24',
                  desc: 'Complex data → simple insights.',
                },
              ].map(v => (
                <Card key={v.title}>
                  <div style={{ fontSize: '14px', fontWeight: 800, color: v.color, marginBottom: '8px',
                    fontFamily: 'var(--font-inter,Inter,sans-serif)', letterSpacing: '-0.01em' }}>
                    {v.title}
                  </div>
                  <p style={{ fontSize: '13px', color: 'rgba(255,255,255,0.55)', margin: 0, lineHeight: 1.6,
                    fontFamily: 'var(--font-inter,Inter,sans-serif)' }}>
                    {v.desc}
                  </p>
                </Card>
              ))}
            </div>
            {/* Community full width */}
            <div style={{ marginTop: '16px' }}>
              <Card>
                <div style={{ fontSize: '14px', fontWeight: 800, color: '#2DD4BF', marginBottom: '8px',
                  fontFamily: 'var(--font-inter,Inter,sans-serif)' }}>Community</div>
                <p style={{ fontSize: '13px', color: 'rgba(255,255,255,0.55)', margin: 0, lineHeight: 1.6,
                  fontFamily: 'var(--font-inter,Inter,sans-serif)' }}>
                  We build with the Base community, not above it.
                </p>
              </Card>
            </div>
          </div>

          {/* ── Who We Serve ──────────────────────────── */}
          <div style={{ marginBottom: '48px' }}>
            <SectionLabel>Who We Serve</SectionLabel>
            <Card>
              <p style={{ fontSize: '13px', color: 'rgba(255,255,255,0.50)', margin: '0 0 18px', lineHeight: 1.6,
                fontFamily: 'var(--font-inter,Inter,sans-serif)' }}>
                ChainLens is built for:
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '10px' }}>
                {[
                  'Everyday traders', 'DeFi explorers', 'LP providers', 'Smart money trackers',
                  'Contract researchers', 'Builders', 'Analysts', 'Degens who want real data',
                ].map(who => (
                  <div key={who} style={{
                    background: 'rgba(45,212,191,0.04)',
                    border: '1px solid rgba(45,212,191,0.12)',
                    borderRadius: '10px', padding: '10px 12px',
                    fontSize: '11px', fontWeight: 600, color: 'rgba(255,255,255,0.65)',
                    textAlign: 'center',
                    fontFamily: 'var(--font-inter,Inter,sans-serif)',
                  }}>
                    {who}
                  </div>
                ))}
              </div>
              <p style={{ fontSize: '13px', color: 'rgba(255,255,255,0.40)', margin: '18px 0 0', lineHeight: 1.6,
                fontFamily: 'var(--font-inter,Inter,sans-serif)', fontStyle: 'italic' }}>
                If you want to understand what's happening on-chain — ChainLens is for you.
              </p>
            </Card>
          </div>

          {/* ── Team ──────────────────────────────────── */}
          <div style={{ marginBottom: '48px' }}>
            <SectionLabel>The Team</SectionLabel>
            <Card>
              <p style={{ fontSize: '14px', color: 'rgba(255,255,255,0.60)', lineHeight: 1.70, margin: '0 0 20px',
                fontFamily: 'var(--font-inter,Inter,sans-serif)' }}>
                ChainLens is built by a small, fast, independent team obsessed with:
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {['AI', 'Crypto', 'Product design', 'Real-time data', 'Safety', 'Transparency'].map(tag => (
                  <span key={tag} style={{
                    padding: '5px 14px', borderRadius: '999px',
                    background: 'rgba(139,92,246,0.10)',
                    border: '1px solid rgba(139,92,246,0.22)',
                    fontSize: '11px', fontWeight: 600, color: 'rgba(255,255,255,0.65)',
                    fontFamily: 'var(--font-inter,Inter,sans-serif)',
                  }}>
                    {tag}
                  </span>
                ))}
              </div>
              <p style={{ fontSize: '13px', color: 'rgba(255,255,255,0.38)', margin: '18px 0 0',
                fontFamily: 'var(--font-inter,Inter,sans-serif)', lineHeight: 1.6 }}>
                We ship fast, listen to users, and iterate relentlessly.
              </p>
            </Card>
          </div>

          {/* ── Vision ────────────────────────────────── */}
          <div style={{
            background: 'linear-gradient(135deg, rgba(45,212,191,0.06) 0%, rgba(139,92,246,0.08) 50%, rgba(236,72,153,0.06) 100%)',
            border: '1px solid rgba(139,92,246,0.20)',
            borderRadius: '20px', padding: '40px 36px', textAlign: 'center',
          }}>
            <SectionLabel>Our Vision</SectionLabel>
            <p style={{
              fontSize: 'clamp(20px,3vw,28px)', fontWeight: 800, color: '#fff',
              lineHeight: 1.35, margin: '0 0 16px', letterSpacing: '-0.01em',
              fontFamily: 'var(--font-inter,Inter,sans-serif)',
            }}>
              To become the{' '}
              <span style={{
                background: 'linear-gradient(90deg,#2DD4BF,#8b5cf6)',
                WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
              }}>
                #1 AI-powered on-chain intelligence platform
              </span>
              {' '}on Base — trusted by traders, respected by builders, and used by everyone.
            </p>
            <p style={{ fontSize: '13px', color: 'rgba(255,255,255,0.35)', margin: 0,
              fontFamily: 'var(--font-plex-mono,IBM Plex Mono,monospace)', letterSpacing: '0.08em' }}>
              We&apos;re just getting started.
            </p>
          </div>

        </div>
      </div>
    </>
  )
}
