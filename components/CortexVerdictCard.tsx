"use client";

import type { CortexVerdict } from "@/app/api/cortex-token-verdict/route";

interface Props {
  verdict: CortexVerdict | null;
  loading: boolean;
  error: string | null;
}

const TIER_STYLES: Record<
  CortexVerdict["risk_tier"],
  { border: string; bg: string; badge: string; badgeText: string; score: string }
> = {
  low: {
    border: "border-emerald-500/30",
    bg: "bg-emerald-500/5",
    badge: "bg-emerald-500/15 border-emerald-500/30",
    badgeText: "text-emerald-300",
    score: "text-emerald-400",
  },
  medium: {
    border: "border-yellow-500/30",
    bg: "bg-yellow-500/5",
    badge: "bg-yellow-500/15 border-yellow-500/30",
    badgeText: "text-yellow-300",
    score: "text-yellow-400",
  },
  high: {
    border: "border-orange-500/30",
    bg: "bg-orange-500/5",
    badge: "bg-orange-500/15 border-orange-500/30",
    badgeText: "text-orange-300",
    score: "text-orange-400",
  },
  extreme: {
    border: "border-red-500/30",
    bg: "bg-red-500/5",
    badge: "bg-red-500/15 border-red-500/30",
    badgeText: "text-red-300",
    score: "text-red-400",
  },
};

function ScoreBar({ score }: { score: number }) {
  const pct = Math.max(0, Math.min(100, score));
  const color =
    pct >= 75 ? "#ef4444" : pct >= 50 ? "#f97316" : pct >= 25 ? "#eab308" : "#10b981";
  return (
    <div className="mt-2 h-1.5 w-full rounded-full bg-white/10 overflow-hidden">
      <div
        className="h-full rounded-full transition-all duration-500"
        style={{ width: `${pct}%`, background: color }}
      />
    </div>
  );
}

function Section({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-bold uppercase tracking-widest text-neutral-500 mb-1">{label}</p>
      <p className="text-xs text-neutral-300 leading-relaxed">{value}</p>
    </div>
  );
}

function ListSection({ label, items, positive }: { label: string; items: string[]; positive: boolean }) {
  if (!items.length) return null;
  return (
    <div>
      <p className="text-[10px] font-bold uppercase tracking-widest text-neutral-500 mb-1">{label}</p>
      <ul className="space-y-1">
        {items.map((item, i) => (
          <li key={i} className="flex items-start gap-2 text-xs">
            <span className={`mt-0.5 flex-shrink-0 ${positive ? "text-emerald-400" : "text-red-400"}`}>
              {positive ? "+" : "−"}
            </span>
            <span className="text-neutral-300">{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Loading skeleton
function Skeleton() {
  return (
    <div className="rounded-2xl border border-white/10 bg-black/40 p-5 space-y-4 animate-pulse">
      <div className="flex items-center gap-3">
        <div className="h-4 w-24 rounded bg-white/10" />
        <div className="h-5 w-16 rounded-full bg-white/10" />
      </div>
      <div className="h-1.5 w-full rounded-full bg-white/10" />
      <div className="grid grid-cols-2 gap-3">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="space-y-1.5">
            <div className="h-2.5 w-16 rounded bg-white/10" />
            <div className="h-3 w-full rounded bg-white/10" />
          </div>
        ))}
      </div>
      <div className="space-y-1.5">
        <div className="h-2.5 w-20 rounded bg-white/10" />
        <div className="h-12 w-full rounded bg-white/10" />
      </div>
    </div>
  );
}

export default function CortexVerdictCard({ verdict, loading, error }: Props) {
  if (loading) return <Skeleton />;

  if (error) {
    return (
      <div className="rounded-2xl border border-red-500/20 bg-red-500/5 p-4">
        <p className="text-xs font-bold uppercase tracking-widest text-red-400 mb-1">CORTEX Error</p>
        <p className="text-xs text-red-300">{error}</p>
      </div>
    );
  }

  if (!verdict) return null;

  const s = TIER_STYLES[verdict.risk_tier] ?? TIER_STYLES.high;

  return (
    <div className={`rounded-2xl border ${s.border} ${s.bg} p-5 space-y-4`}>
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-widest text-neutral-400">
            CORTEX Risk Engine
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`text-lg font-bold ${s.score}`}>{verdict.risk_score}</span>
          <span
            className={`rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${s.badge} ${s.badgeText}`}
          >
            {verdict.risk_tier}
          </span>
        </div>
      </div>

      {/* Score bar */}
      <ScoreBar score={verdict.risk_score} />

      {/* Verdict headline */}
      <div className="rounded-xl border border-white/5 bg-black/30 p-3">
        <p className="text-[10px] font-bold uppercase tracking-widest text-neutral-500 mb-1">
          Cortex Verdict
        </p>
        <p className="text-sm text-neutral-100 leading-relaxed">{verdict.cortex_verdict}</p>
      </div>

      {/* Positives / Negatives */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ListSection label="Positives" items={verdict.positives} positive={true} />
        <ListSection label="Negatives" items={verdict.negatives} positive={false} />
      </div>

      {/* Analysis sections */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Section label="Contract Safety" value={verdict.contract_safety} />
        <Section label="Liquidity" value={verdict.liquidity_analysis} />
        <Section label="Volatility" value={verdict.volatility_analysis} />
        <Section label="Whale Flow" value={verdict.whale_flow} />
      </div>

      {/* Overall assessment */}
      <Section label="Overall Assessment" value={verdict.overall_assessment} />

      <p className="text-[10px] text-neutral-600 leading-relaxed">
        Risk analysis only. Not financial advice.
      </p>
    </div>
  );
}
