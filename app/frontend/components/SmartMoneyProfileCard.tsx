'use client'

// SmartMoneyProfileCard — premium, Base-native identity card. Tailwind-only (no external CSS
// files); the handful of raw @keyframes below are the one thing Tailwind utility classes cannot
// express on their own (a keyframe's steps have to be defined as real CSS somewhere), so they're
// declared once in a scoped <style> tag and then driven entirely via Tailwind's arbitrary-value
// animate-[...] syntax — the same pattern this codebase's own wallet-scanner page already uses for
// its @keyframes fadeUp.

export type SmartMoneyProfileTraits = {
  rotation: number
  risk: number
  signals: number
  activity: number
}

export type SmartMoneyProfileCardProps = {
  style: string
  behavior: string
  chains: string
  confidence: string
  recoveryDepth: string
  traits: SmartMoneyProfileTraits
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, value))
}

function IdentityRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-t border-white/[0.06] py-2.5 first:border-t-0 first:pt-0">
      <span className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400/70">
        {label}
      </span>
      <span className="truncate text-right text-[13px] font-semibold text-slate-100">
        {value}
      </span>
    </div>
  )
}

function TraitBar({ label, value }: { label: string; value: number }) {
  const pct = clampPct(value)
  return (
    <div className="group/trait">
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400/70">
          {label}
        </span>
        <span className="font-mono text-[12px] font-extrabold text-slate-100">
          {Math.round(pct)}
          <span className="text-slate-500">/100</span>
        </span>
      </div>
      <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className="h-full rounded-full transition-[width,filter] duration-500 ease-out group-hover/trait:brightness-125"
          style={{
            width: `${pct}%`,
            background: 'linear-gradient(90deg, #2DD4BF 0%, #8B5CF6 55%, #EC4899 100%)',
            boxShadow: '0 0 10px rgba(45,212,191,0.55), 0 0 4px rgba(139,92,246,0.45)',
          }}
        />
      </div>
    </div>
  )
}

export function SmartMoneyProfileCard({ style, behavior, chains, confidence, recoveryDepth, traits }: SmartMoneyProfileCardProps) {
  return (
    <div className="group relative w-full">
      <style>{`
        @keyframes smpBorderShimmer {
          0% { border-color: rgba(45,212,191,0.4); }
          50% { border-color: rgba(139,92,246,0.4); }
          100% { border-color: rgba(236,72,153,0.4); }
        }
        @keyframes smpGlowPulse {
          0% { box-shadow: 0 0 10px rgba(45,212,191,0.4); }
          50% { box-shadow: 0 0 20px rgba(139,92,246,0.5); }
          100% { box-shadow: 0 0 10px rgba(236,72,153,0.4); }
        }
      `}</style>

      {/* Outer neon glow — soft mint/purple blend, intensifies on hover */}
      <div
        className="pointer-events-none absolute -inset-px rounded-2xl opacity-60 blur-md transition-opacity duration-500 group-hover:opacity-100 animate-[smpGlowPulse_6s_ease-in-out_infinite]"
        style={{ background: 'linear-gradient(135deg, rgba(45,212,191,0.35), rgba(139,92,246,0.30), rgba(236,72,153,0.25))' }}
      />

      <div
        className="relative overflow-hidden rounded-2xl border bg-[#06060A]/80 backdrop-blur-xl transition-shadow duration-500 animate-[smpBorderShimmer_6s_ease-in-out_infinite] group-hover:shadow-[inset_0_0_40px_rgba(139,92,246,0.12)]"
        style={{ borderColor: 'rgba(255,255,255,0.08)' }}
      >
        {/* Diagonal brand-gradient wash, 8% opacity */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{ background: 'linear-gradient(135deg, rgba(45,212,191,0.08) 0%, rgba(139,92,246,0.08) 50%, rgba(236,72,153,0.08) 100%)' }}
        />

        <div className="relative">
          {/* Header bar */}
          <div className="flex items-center justify-between gap-3 border-b border-white/[0.08] px-5 py-4">
            <h3 className="font-mono text-[12px] font-extrabold uppercase tracking-[0.18em] text-slate-100">
              Smart Money Profile
            </h3>
            <span
              className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[9px] font-extrabold uppercase tracking-[0.12em] transition-shadow duration-300 group-hover:shadow-[0_0_16px_rgba(139,92,246,0.35)]"
              style={{
                borderColor: 'rgba(139,92,246,0.45)',
                background: 'linear-gradient(135deg, rgba(45,212,191,0.16), rgba(139,92,246,0.16))',
                color: '#c4b5fd',
              }}
            >
              <span
                className="h-1.5 w-1.5 rounded-full transition-[filter] duration-300 group-hover:brightness-150"
                style={{ background: '#2DD4BF', boxShadow: '0 0 6px rgba(45,212,191,0.9)' }}
              />
              Identity
            </span>
          </div>

          {/* Two-column body */}
          <div className="grid grid-cols-1 gap-6 px-5 py-5 sm:grid-cols-2 sm:gap-8">
            {/* Left column — identity facts */}
            <div>
              <IdentityRow label="Wallet Style" value={style} />
              <IdentityRow label="Behavior Pattern" value={behavior} />
              <IdentityRow label="Chain Footprint" value={chains} />
              <IdentityRow label="Confidence Level" value={confidence} />
              <IdentityRow label="Recovery Depth" value={recoveryDepth} />
            </div>

            {/* Right column — personality traits */}
            <div className="flex flex-col gap-4">
              <TraitBar label="Rotation Discipline" value={traits.rotation} />
              <TraitBar label="Risk Appetite" value={traits.risk} />
              <TraitBar label="Signal Responsiveness" value={traits.signals} />
              <TraitBar label="Chain Activity" value={traits.activity} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default SmartMoneyProfileCard
