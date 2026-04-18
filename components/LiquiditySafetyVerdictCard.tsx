"use client";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LiquiditySafetyResult {
  name: string;
  symbol: string;
  contract: string;
  lp_total_liquidity_usd: number | null;
  lp_fragments: number;
  lp_stability_score: number;
  lp_risk_tier: "low" | "medium" | "high" | "extreme";
  positives: string[];
  negatives: string[];
  pool_breakdown: Array<{
    name: string | undefined;
    address: string;
    liquidity: number | null;
    volume24h: number | null;
    priceChange24h: number | null;
  }>;
}

interface Props {
  result: LiquiditySafetyResult | null;
  loading: boolean;
  error: string | null;
}

// ─── Tier config ──────────────────────────────────────────────────────────────

const TIER: Record<
  LiquiditySafetyResult["lp_risk_tier"],
  {
    glow: string;
    border: string;
    badgeBg: string;
    badgeText: string;
    scoreColor: string;
    barColor: string;
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
    dot:        "bg-emerald-400",
  },
  medium: {
    glow:       "shadow-[0_0_32px_rgba(251,191,36,0.20)]",
    border:     "border-amber-400/25",
    badgeBg:    "bg-amber-500/15 border-amber-400/30",
    badgeText:  "text-amber-300",
    scoreColor: "text-amber-300",
    barColor:   "#fbbf24",
    dot:        "bg-amber-400",
  },
  high: {
    glow:       "shadow-[0_0_32px_rgba(251,146,60,0.22)]",
    border:     "border-orange-400/25",
    badgeBg:    "bg-orange-500/15 border-orange-400/30",
    badgeText:  "text-orange-300",
    scoreColor: "text-orange-300",
    barColor:   "#fb923c",
    dot:        "bg-orange-400",
  },
  extreme: {
    glow:       "shadow-[0_0_32px_rgba(248,113,113,0.28)]",
    border:     "border-red-400/30",
    badgeBg:    "bg-red-500/15 border-red-400/30",
    badgeText:  "text-red-300",
    scoreColor: "text-red-300",
    barColor:   "#f87171",
    dot:        "bg-red-400",
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtLarge(v: number | null | undefined): string {
  if (v == null) return "N/A";
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000)     return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000)         return `$${(v / 1_000).toFixed(2)}K`;
  return `$${v.toFixed(2)}`;
}

function fmtPct(v: number | null | undefined): string {
  if (v == null) return "N/A";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function pctColor(v: number | null | undefined): string {
  if (v == null) return "#94a3b8";
  return v >= 0 ? "#2DD4BF" : "#f87171";
}

function shorten(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

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

function Label({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-1.5 text-[9px] font-bold uppercase tracking-[0.18em] text-neutral-500">
      {children}
    </p>
  );
}

function Divider() {
  return <div className="h-px w-full bg-white/[0.06]" />;
}

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

function Skeleton() {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#0a0a0f]/60 p-5 backdrop-blur-xl shadow-[0_0_25px_rgba(0,200,255,0.12)] md:p-6">
      <div className="absolute inset-0 -translate-x-full animate-[shimmer_1.6s_infinite] bg-gradient-to-r from-transparent via-white/[0.04] to-transparent" />
      <div className="space-y-5">
        <div className="flex items-center justify-between">
          <div className="h-3 w-40 rounded-full bg-white/10" />
          <div className="h-6 w-16 rounded-full bg-white/10" />
        </div>
        <div className="h-2 w-full rounded-full bg-white/10" />
        <div className="space-y-2 rounded-xl border border-white/[0.06] bg-white/[0.025] p-4">
          <div className="h-2.5 w-24 rounded-full bg-white/10" />
          <div className="h-3.5 w-full rounded-full bg-white/10" />
          <div className="h-3.5 w-4/5 rounded-full bg-white/10" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="space-y-2">
              <div className="h-2 w-14 rounded-full bg-white/10" />
              <div className="h-3 w-full rounded-full bg-white/10" />
            </div>
          ))}
        </div>
        <div className="h-3 w-36 rounded-full bg-white/[0.06]" />
      </div>
      <style>{`@keyframes shimmer { to { transform: translateX(200%); } }`}</style>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function LiquiditySafetyVerdictCard({ result, loading, error }: Props) {
  if (loading) return <Skeleton />;

  if (error) {
    return (
      <div className="rounded-2xl border border-red-500/25 bg-[#0a0a0f]/60 p-5 backdrop-blur-xl shadow-[0_0_28px_rgba(248,113,113,0.18)] md:p-6">
        <div className="flex items-center gap-2 mb-3">
          <span className="h-1.5 w-1.5 rounded-full bg-red-400 shadow-[0_0_8px_rgba(248,113,113,0.9)]" />
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-red-400">
            Scan Error
          </p>
        </div>
        <p className="text-[12px] text-red-300/80 leading-relaxed">{error}</p>
      </div>
    );
  }

  if (!result) return null;

  const t = TIER[result.lp_risk_tier] ?? TIER.high;
  const pct = Math.max(0, Math.min(100, result.lp_stability_score));

  return (
    <div
      className={`relative rounded-2xl border ${t.border} bg-[#0a0a0f]/60 backdrop-blur-xl ${t.glow}
                  shadow-[0_0_25px_rgba(0,200,255,0.10)] overflow-hidden`}
    >
      {/* Gradient top accent */}
      <div
        className="absolute inset-x-0 top-0 h-px"
        style={{
          background:
            "linear-gradient(90deg, transparent 0%, rgba(0,200,255,0.4) 40%, rgba(99,102,241,0.4) 70%, transparent 100%)",
        }}
      />

      <div className="p-5 md:p-6 space-y-5">

        {/* ── Header ────────────────────────────────────────────────── */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span
                className={`h-1.5 w-1.5 rounded-full ${t.dot} animate-pulse`}
                style={{ boxShadow: `0 0 8px ${t.barColor}cc` }}
              />
              <p className="text-[10px] font-bold uppercase tracking-[0.20em] text-neutral-400">
                LP Safety Analysis
              </p>
            </div>
            <p className="text-[11px] text-neutral-600">
              On-chain liquidity risk assessment — not financial advice.
            </p>
          </div>

          {/* Score + tier */}
          <div className="shrink-0 text-right">
            <p
              className={`text-3xl font-black leading-none ${t.scoreColor}`}
              style={{ textShadow: `0 0 20px ${t.barColor}66` }}
            >
              {result.lp_stability_score}
            </p>
            <p className="mt-0.5 text-[9px] text-neutral-600 uppercase tracking-widest">/ 100</p>
            <span
              className={`mt-2 inline-block rounded-full border px-2.5 py-0.5
                          text-[9px] font-bold uppercase tracking-wider ${t.badgeBg} ${t.badgeText}`}
            >
              {result.lp_risk_tier} risk
            </span>
          </div>
        </div>

        {/* ── Score bar ──────────────────────────────────────────────── */}
        <div>
          <div className="flex justify-between text-[9px] text-neutral-600 mb-1.5">
            <span>SAFE</span>
            <span>{pct}% RISK</span>
            <span>EXTREME</span>
          </div>
          <ScoreBar score={result.lp_stability_score} color={t.barColor} />
        </div>

        <Divider />

        {/* ── LP metrics grid ────────────────────────────────────────── */}
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.025] px-4 py-3">
            <Label>Total Liquidity</Label>
            <p className="text-[20px] font-bold text-[#2DD4BF]" style={{ fontFamily: "var(--font-plex-mono)" }}>
              {fmtLarge(result.lp_total_liquidity_usd)}
            </p>
          </div>
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.025] px-4 py-3">
            <Label>Pool Count</Label>
            <p className="text-[20px] font-bold text-neutral-200" style={{ fontFamily: "var(--font-plex-mono)" }}>
              {result.lp_fragments}
            </p>
          </div>
        </div>

        {/* ── Positives / Negatives ──────────────────────────────────── */}
        {(result.positives.length > 0 || result.negatives.length > 0) && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {result.positives.length > 0 && (
              <div>
                <Label>Positives</Label>
                <ul className="space-y-2">
                  {result.positives.map((p, i) => (
                    <BulletItem key={i} text={p} positive={true} />
                  ))}
                </ul>
              </div>
            )}
            {result.negatives.length > 0 && (
              <div>
                <Label>Negatives</Label>
                <ul className="space-y-2">
                  {result.negatives.map((n, i) => (
                    <BulletItem key={i} text={n} positive={false} />
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <Divider />

        {/* ── Pool breakdown ─────────────────────────────────────────── */}
        {result.pool_breakdown.length > 0 && (
          <div>
            <Label>Pool Breakdown · {result.pool_breakdown.length}</Label>
            <div className="flex flex-col gap-1.5">
              {result.pool_breakdown.slice(0, 8).map((pool, i) => (
                <div
                  key={i}
                  className="grid items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.025] px-4 py-2.5"
                  style={{
                    gridTemplateColumns: "1fr repeat(3, auto)",
                    fontSize: "12px",
                    fontFamily: "var(--font-plex-mono)",
                  }}
                >
                  <span className="overflow-hidden text-ellipsis whitespace-nowrap text-neutral-400">
                    {pool.name ?? shorten(pool.address)}
                  </span>
                  <span className="whitespace-nowrap text-[#2DD4BF]">
                    {fmtLarge(pool.liquidity)}
                  </span>
                  <span className="whitespace-nowrap text-neutral-600">
                    Vol {fmtLarge(pool.volume24h)}
                  </span>
                  <span
                    className="whitespace-nowrap"
                    style={{ color: pctColor(pool.priceChange24h) }}
                  >
                    {fmtPct(pool.priceChange24h)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Disclaimer ─────────────────────────────────────────────── */}
        <p className="text-[9px] uppercase tracking-[0.14em] text-neutral-700 text-center">
          LP risk analysis only · Not financial advice · ChainLens AI
        </p>

      </div>
    </div>
  );
}
