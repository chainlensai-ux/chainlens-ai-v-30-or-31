const FEATURES = [
  'Token Scanner',
  'Wallet Scanner',
  'Dev Wallet Detector',
  'Liquidity Safety Scanner',
  'Whale Alerts',
  'Pump Alerts',
  'Base Radar',
  'Clark AI',
]

const LOGS = [
  '[SCAN] Token Scanner initialized for BASE pair feeds.',
  '[AI] Signal confidence model warmed with 1,203 historical events.',
  '[CLARK] Clark AI recommends WATCH posture on overnight meme rotations.',
  '[SCAN] Whale sweep detected in low-float social basket.',
  '[AI] Narrative acceleration +22% in last 15m window.',
  '[CLARK] Consider staggered entries and tighten invalidation levels.',
]

const RADAR_CARDS = [
  {
    token: 'AQUA',
    risk: 'SAFE',
    tag: 'Clark: Momentum clean, liquidity support remains stable.',
  },
  {
    token: 'VORTEX',
    risk: 'DANGER',
    tag: 'Clark: Dev wallet outflows elevated; avoid chasing breakouts.',
  },
  {
    token: 'NOVA',
    risk: 'WATCH',
    tag: 'Clark: Volume rising fast, wait for confirmation candle close.',
  },
] as const

const riskPillStyles: Record<(typeof RADAR_CARDS)[number]['risk'], string> = {
  SAFE: 'bg-emerald-500/15 text-emerald-300 border-emerald-300/40',
  DANGER: 'bg-rose-500/15 text-rose-300 border-rose-300/40',
  WATCH: 'bg-amber-500/15 text-amber-300 border-amber-300/40',
}

export default function TerminalPage() {
  return (
    <main className="min-h-screen bg-[#06060a] text-white">
      <div className="mx-auto flex h-screen max-w-[1800px] gap-4 p-4">
        <aside className="w-72 rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur-xl">
          <p className="mb-4 text-xs uppercase tracking-[0.2em] text-white/45">Navigation</p>
          <nav className="space-y-1">
            {FEATURES.map((feature, idx) => {
              const active = idx === 0

              return (
                <a
                  key={feature}
                  href="#"
                  className={`block rounded-lg border-l-2 px-3 py-2 text-sm transition ${
                    active
                      ? 'border-l-[#2DD4BF] bg-white/10 text-white'
                      : 'border-l-transparent text-white/65 hover:bg-white/10 hover:text-white'
                  }`}
                >
                  {feature}
                </a>
              )
            })}
          </nav>
        </aside>

        <section className="flex min-w-0 flex-1 rounded-2xl border border-white/10 bg-white/[0.04] p-4 backdrop-blur-xl">
          <div className="flex h-full w-full flex-col rounded-xl border border-white/10 bg-[#0a0b12]/70 p-4">
            <div className="mb-4 flex items-center justify-between">
              <h1 className="text-sm uppercase tracking-[0.22em] text-white/70">ClarkChat</h1>
              <span className="rounded-full border border-[#2DD4BF]/45 bg-[#2DD4BF]/10 px-2 py-0.5 text-xs text-[#67e8d3]">
                TERMINAL LIVE
              </span>
            </div>

            <div
              className="flex-1 space-y-2 overflow-y-auto rounded-lg border border-white/10 bg-black/40 p-3 text-[13px] leading-relaxed text-white/85"
              style={{ fontFamily: 'var(--font-mono), IBM Plex Mono, monospace' }}
            >
              {LOGS.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>

            <div className="mt-4 flex gap-2 rounded-lg border border-white/10 bg-black/35 p-2">
              <input
                type="text"
                placeholder="Type a command for Clark..."
                className="flex-1 bg-transparent px-2 py-1 text-sm text-white outline-none placeholder:text-white/40"
                style={{ fontFamily: 'var(--font-mono), IBM Plex Mono, monospace' }}
              />
              <button className="rounded-md border border-[#2DD4BF]/35 bg-[#2DD4BF]/15 px-4 py-1 text-xs font-semibold text-[#8af6e2]">
                SEND
              </button>
            </div>
          </div>
        </section>

        <aside className="w-96 rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur-xl">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm uppercase tracking-[0.2em] text-white/70">ClarkRadar</h2>
            <span className="rounded-full border border-pink-300/40 bg-pink-400/15 px-2 py-0.5 text-xs font-medium text-pink-300">
              LIVE
            </span>
          </div>

          <div className="space-y-3">
            {RADAR_CARDS.map((card) => (
              <article
                key={card.token}
                className="rounded-xl border border-white/10 bg-white/[0.06] p-3 backdrop-blur-md"
                style={{ fontFamily: 'var(--font-mono), IBM Plex Mono, monospace' }}
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="text-base font-semibold tracking-wide text-white">{card.token}</p>
                  <div className="flex items-center gap-2">
                    <span className="rounded-full border border-pink-300/50 bg-pink-400/20 px-2 py-0.5 text-[10px] font-semibold text-pink-200">
                      LIVE
                    </span>
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide ${riskPillStyles[card.risk]}`}
                    >
                      {card.risk}
                    </span>
                  </div>
                </div>
                <p className="text-xs text-white/75">{card.tag}</p>
              </article>
            ))}
          </div>
        </aside>
      </div>
    </main>
  )
}
