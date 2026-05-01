'use client'

import { Suspense, useState } from 'react'
import ClarkRadar from '@/components/ClarkRadar'
import HeroSection from '@/components/HeroSection'
import HomeTokenScreener from '@/components/HomeTokenScreener'

function TerminalPageContent() {
  const [isTyping, setIsTyping] = useState(false)
  const [pendingMessage, setPendingMessage] = useState<string | null>(null)

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
      `}</style>

      <div
        className="flex h-full overflow-hidden terminal-shell"
        style={{ position: 'relative' }}
      >
        {/* Neon ambient glow — fixed, behind everything */}
        <div
          className="terminal-ambient"
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
          className="flex-1 overflow-y-auto min-w-0 flex flex-col mob-terminal-main"
          style={{ position: 'relative', zIndex: 1 }}
        >
          <HeroSection
            onTyping={setIsTyping}
            onSend={(msg) => {
              setPendingMessage(msg)
            }}
          />
          <HomeTokenScreener />
        </main>

        <aside
          className="shrink-0 overflow-y-auto mob-radar"
          style={{
            width: isTyping ? '750px' : '500px',
            transition: 'width 300ms ease',
            borderLeft: '1px solid rgba(123,92,255,0.18)',
            background: '#050816',
            position: 'relative',
            zIndex: 1,
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
    <Suspense fallback={<div style={{ padding: 24, color: '#94a3b8' }}>Loading Terminal...</div>}>
      <TerminalPageContent />
    </Suspense>
  )
}
