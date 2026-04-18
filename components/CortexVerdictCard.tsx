"use client";

import type { CortexVerdict } from "@/app/api/cortex-token-verdict/route";

interface Props {
  verdict: CortexVerdict | null;
  loading: boolean;
  error: string | null;
}

// ─── Tier config ──────────────────────────────────────────────────────────────

const TIER: Record<
  CortexVerdict["risk_tier"],
  {
    glow: string;
    border: string;
    badgeBg: string;
    badgeText: string;
    scoreColor: string;
    barColor: string;
    labelColor: string;
    dot: string;
  }
> = {
  low: {
    glow:       "shadow-[0_0_32px_rgba(52,211,153,0.22)]",
    border:     "border-emerald-400/25",
    badgeBg:    "bg-emerald-500/15 border-emerald-400/30",
    badgeText:  "text-emerald-300",
    scoreColor: "text-emerald-300",
    barColor:   "#34d399",
    labelColor: "text-emerald-400/70",
    dot:        "bg-emerald-400",
  },
  medium: {
    glow:       "shadow-[0_0_32px_rgba(251,191,36,0.20)]",
    border:     "border-amber-400/25",
    badgeBg:    "bg-amber-500/15 border-amber-400/30",
    badgeText:  "text-amber-300",
    scoreColor: "text-amber-300",
    barColor:   "#fbbf24",
    labelColor: "text-amber-400/70",
    dot:        "bg-amber-400",
  },
  high: {
    glow:       "shadow-[0_0_32px_rgba(251,146,60,0.22)]",
    border:     "border-orange-400/25",
    badgeBg:    "bg-orange-500/15 border-orange-400/30",
    badgeText:  "text-orange-300",
    scoreColor: "text-orange-300",
    barColor:   "#fb923c",
    labelColor: "text-orange-400/70",
    dot:        "bg-orange-400",
  },
  extreme: {
    glow:       "shadow-[0_0_32px_rgba(248,113,113,0.28)]",
    border:     "border-red-400/30",
    badgeBg:    "bg-red-500/15 border-red-400/30",
    badgeText:  "text-red-300",
    scoreColor: "text-red-300",
    barColor:   "#f87171",
    labelColor: "text-red-400/70",
    dot:        "bg-red-400",
  },
};

// ─── Score bar ────────────────────────────────────────────────────────────────

function ScoreBar({ score, color }: { score: number; color: string }) {
  const pct = Math.max(0, Math.min(100, score));
  return (
    <div className="relative h-2 w-full overflow-hidden rounded-full bg-white/[0.06]">
      <div
        className="absolute inset-y-0 left-0 rounded-full transition-all duration-700"
        style={{
          width: `${pct}%`,
          background: `linear-gradient(90deg, ${color}99 0%, ${color} 100%)`,
          boxShadow: `0 0 12px ${color}88`,
        }}
      />
    </div>
  );
}

// ─── Section label ────────────────────────────────────────────────────────────

function Label({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-1.5 text-[9px] font-bold uppercase tracking-[0.18em] text-neutral-500">
      {children}
    </p>
  );
}

// ─── Divider ──────────────────────────────────────────────────────────────────

function Divider() {
  return <div className="h-px w-full bg-white/[0.06]" />;
}

// ─── List item ────────────────────────────────────────────────────────────────

function BulletItem({ text, positive }: { text: string; positive: boolean }) {
  return (
    <li className="flex items-start gap-2 text-[12px] leading-relaxed text-neutral-300">
      <span
        className={`mt-[3px] h-1.5 w-1.5 shrink-0 rounded-full ${
          positive ? "bg-emerald-400" : "bg-red-400"
        }`}
        style={{
          boxShadow: positive
            ? "0 0 6px rgba(52,211,153,0.8)"
            : "0 0 6px rgba(248,113,113,0.8)",
        }}
      />
      {text}
    </li>
  );
}

// ─── Analysis row ─────────────────────────────────────────────────────────────

function AnalysisRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.025] px-4 py-3">
      <Label>{label}</Label>
      <p className="text-[12px] leading-relaxed text-neutral-300">{value}</p>
    </div>
  );
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function Skeleton() {
  return (
    <div
      className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#0a0a0f]/60 p-5 backdrop-blur-xl
                 shadow-[0_0_25px_rgba(0,200,255,0.12)] md:p-6"
    >
      {/* shimmer sweep */}
      <div className="absolute inset-0 -translate-x-full animate-[shimmer_1.6s_infinite] bg-gradient-to-r from-transparent via-white/[0.04] to-transparent" />

      <div className="space-y-5">
        {/* header row */}
        <div className="flex items-center justify-between">
          <div className="h-3 w-40 rounded-full bg-white/10" />
          <div className="h-6 w-16 rounded-full bg-white/10" />
        </div>
        <div className="h-2 w-full rounded-full bg-white/10" />

        {/* verdict block */}
        <div className="space-y-2 rounded-xl border border-white/[0.06] bg-white/[0.025] p-4">
          <div className="h-2.5 w-24 rounded-full bg-white/10" />
          <div className="h-3.5 w-full rounded-full bg-white/10" />
          <div className="h-3.5 w-4/5 rounded-full bg-white/10" />
        </div>

        {/* two-col */}
        <div className="grid grid-cols-2 gap-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="space-y-2">
              <div className="h-2 w-14 rounded-full bg-white/10" />
              <div className="h-3 w-full rounded-full bg-white/10" />
              <div className="h-3 w-3/4 rounded-full bg-white/10" />
            </div>
          ))}
        </div>

        <div className="h-3 w-36 rounded-full bg-white/[0.06]" />
      </div>

      <style>{`
        @keyframes shimmer { to { transform: translateX(200%); } }
      `}</style>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function CortexVerdictCard({ verdict, loading, error }: Props) {
  if (loading) return <Skeleton />;

  if (error) {
    return (
      <div
        className="rounded-2xl border border-red-500/25 bg-[#0a0a0f]/60 p-5 backdrop-blur-xl
                   shadow-[0_0_28px_rgba(248,113,113,0.18)] md:p-6"
      >
        <div className="flex items-center gap-2 mb-3">
          <span className="h-1.5 w-1.5 rounded-full bg-red-400 shadow-[0_0_8px_rgba(248,113,113,0.9)]" />
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-red-400">
            CORTEX Error
          </p>
        </div>
        <p className="text-[12px] text-red-300/80 leading-relaxed">{error}</p>
      </div>
    );
  }

  if (!verdict) return null;

  const t = TIER[verdict.risk_tier] ?? TIER.high;
  const pct = Math.max(0, Math.min(100, verdict.risk_score));

  return (
    <div
      className={`relative rounded-2xl border ${t.border} bg-[#0a0a0f]/60 backdrop-blur-xl ${t.glow}
                  shadow-[0_0_25px_rgba(0,200,255,0.10)] overflow-hidden`}
    >
      {/* Gradient border accent — top edge */}
      <div
        className="absolute inset-x-0 top-0 h-px"
        style={{
          background:
            "linear-gradient(90deg, transparent 0%, rgba(0,200,255,0.4) 40%, rgba(99,102,241,0.4) 70%, transparent 100%)",
        }}
      />

      <div className="p-5 md:p-6 space-y-5">

        {/* ── Header ──────────────────────────────────────────────── */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span
                className={`h-1.5 w-1.5 rounded-full ${t.dot} animate-pulse`}
                style={{ boxShadow: `0 0 8px ${t.barColor}cc` }}
              />
              <p className="text-[10px] font-bold uppercase tracking-[0.20em] text-neutral-400">
                CORTEX Engine Verdict
              </p>
            </div>
            <p className="text-[11px] text-neutral-600">
              AI-powered risk analysis — not financial advice.
            </p>
          </div>

          {/* Score + tier badge */}
          <div className="shrink-0 text-right">
            <p className={`text-3xl font-black leading-none ${t.scoreColor}`}
               style={{ textShadow: `0 0 20px ${t.barColor}66` }}>
              {verdict.risk_score}
            </p>
            <p className="mt-0.5 text-[9px] text-neutral-600 uppercase tracking-widest">/ 100</p>
            <span
              className={`mt-2 inline-block rounded-full border px-2.5 py-0.5
                          text-[9px] font-bold uppercase tracking-wider ${t.badgeBg} ${t.badgeText}`}
            >
              {verdict.risk_tier} risk
            </span>
          </div>
        </div>

        {/* ── Score bar ────────────────────────────────────────────── */}
        <div>
          <div className="flex justify-between text-[9px] text-neutral-600 mb-1.5">
            <span>SAFE</span>
            <span>{pct}% RISK</span>
            <span>EXTREME</span>
          </div>
          <ScoreBar score={verdict.risk_score} color={t.barColor} />
        </div>

        <Divider />

        {/* ── Cortex verdict ───────────────────────────────────────── */}
        <div
          className="rounded-xl border border-white/[0.07] bg-white/[0.03] px-4 py-4"
          style={{ boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04)" }}
        >
          <Label>Cortex Verdict</Label>
          <p className="text-[13px] font-medium text-neutral-100 leading-relaxed">
            {verdict.cortex_verdict}
          </p>
        </div>

        {/* ── Positives / Negatives ────────────────────────────────── */}
        {(verdict.positives.length > 0 || verdict.negatives.length > 0) && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {verdict.positives.length > 0 && (
              <div>
                <Label>Positives</Label>
                <ul className="space-y-2">
                  {verdict.positives.map((p, i) => (
                    <BulletItem key={i} text={p} positive={true} />
                  ))}
                </ul>
              </div>
            )}
            {verdict.negatives.length > 0 && (
              <div>
                <Label>Negatives</Label>
                <ul className="space-y-2">
                  {verdict.negatives.map((n, i) => (
                    <BulletItem key={i} text={n} positive={false} />
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <Divider />

        {/* ── Analysis grid ────────────────────────────────────────── */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <AnalysisRow label="Contract Safety"    value={verdict.contract_safety} />
          <AnalysisRow label="Liquidity"          value={verdict.liquidity_analysis} />
          <AnalysisRow label="Volatility"         value={verdict.volatility_analysis} />
          <AnalysisRow label="Whale Flow"         value={verdict.whale_flow} />
        </div>

        {/* ── Overall assessment ───────────────────────────────────── */}
        <AnalysisRow label="Overall Assessment" value={verdict.overall_assessment} />

        {/* ── Disclaimer ───────────────────────────────────────────── */}
        <p className="text-[9px] uppercase tracking-[0.14em] text-neutral-700 text-center">
          Risk analysis only · Not financial advice · ChainLens AI
        </p>

      </div>
    </div>
  );
}
