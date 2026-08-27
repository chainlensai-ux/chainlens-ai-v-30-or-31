'use client'

import { Suspense, useState } from 'react'
import { useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import ClarkRadar from '@/components/ClarkRadar'
import HeroSection from '@/components/HeroSection'

// Below the fold on mobile — defer parse + execution until after first paint
const HomeTokenScreener = dynamic(() => import('@/components/HomeTokenScreener'), {
  ssr: false,
  loading: () => <div style={{ flex: 1, background: 'linear-gradient(160deg, #080d1c 0%, #060a14 100%)', minHeight: '120px' }} />,
})

function TerminalPageContent() {
  const [isTyping, setIsTyping] = useState(false)
  const [pendingMessage, setPendingMessage] = useState<string | null>(null)
  const router = useRouter()

  const shouldRouteMobileToClark = () => {
    if (typeof window === 'undefined') return false
    const mobileUA = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '')
    return Boolean(window.innerWidth < 768 || mobileUA)
  }

  return (
    <>
      <style>{`
        @keyframes terminalAmbient {
          0%, 100% { opacity: 0.55; }
          50%       { opacity: 1; }
        }
        .terminal-ambient {
          animation: terminalAmbient 5s ease-in-out infinite;
          pointer-events: none;
        }
        @media (max-width: 900px) {
          .terminal-shell { flex-direction: column; }
          .terminal-ambient { display: none !important; }
          .mob-radar {
            width: 100% !important;
            max-height: 42vh;
            border-left: none !important;
            border-top: 1px solid rgba(123,92,255,0.18);
          }
        }
        /* SLIGHTLY WIDER ON LARGE DESKTOP ONLY, DISCLOSED (Clark right-panel layout fix task): the
           Clark panel's own width (min(500px,36vw) idle / min(750px,42vw) typing, inline JS style
           above) stays the fallback for every viewport up to 1440px — this only nudges it a bit
           wider on genuinely large desktop screens, where the extra px comes from spare viewport
           width rather than squeezing the main dashboard column (main stays flex:1, so it simply
           gets very slightly narrower, never below its own min-w-0 content). !important is required
           to win over the same element's inline width style at this breakpoint only.
           */
        @media (min-width: 1440px) {
          .clark-radar-aside:not(.is-typing) { width: min(560px, 34vw) !important; }
          .clark-radar-aside.is-typing { width: min(820px, 40vw) !important; }
        }
      `}</style>

      <div
        className="flex h-dvh min-h-dvh w-full max-w-full overflow-hidden terminal-shell"
        style={{ position: 'relative' }}
      >
        {/* Neon ambient glow — fixed, behind everything */}
        <div
          className="terminal-ambient terminal-heavy-visual"
          style={{
            position: 'fixed',
            top: '35%',
            left: '55%',
            transform: 'translate(-50%, -50%)',
            width: '700px',
            height: '420px',
            borderRadius: '50%',
            background:
              'radial-gradient(ellipse, rgba(123,92,255,0.08) 0%, rgba(255,75,154,0.05) 45%, transparent 72%)',
            zIndex: 0,
          }}
        />

        <main
          className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden mob-terminal-main"
          style={{ position: 'relative', zIndex: 1, height: '100dvh' }}
        >
          <HeroSection
            onTyping={setIsTyping}
            onSend={(msg) => {
              if (shouldRouteMobileToClark()) {
                const prompt = encodeURIComponent(msg.trim())
                router.push(`/terminal/clark-ai?prompt=${prompt}&autosend=1`)
                return
              }
              setPendingMessage(msg)
            }}
          />
          <HomeTokenScreener />
        </main>

        <aside
          className={`shrink-0 overflow-hidden mob-radar clark-radar-aside w-full lg:w-auto${isTyping ? ' is-typing' : ''}`}
          style={{
            width: isTyping ? 'min(750px, 42vw)' : 'min(500px, 36vw)',
            transition: 'width 300ms ease',
            borderLeft: '1px solid rgba(123,92,255,0.18)',
            background: '#050816',
            position: 'relative',
            zIndex: 1,
            height: '100dvh',
          }}
        >
          <ClarkRadar pendingMessage={pendingMessage} />
        </aside>
      </div>
    </>
  )
}

export default function TerminalPage() {
  return (
    <Suspense fallback={<div style={{ height: '100%', minHeight: '100dvh', background: 'linear-gradient(160deg, #080d1c 0%, #060a14 100%)' }} aria-hidden />}>
      <TerminalPageContent />
    </Suspense>
  )
}
