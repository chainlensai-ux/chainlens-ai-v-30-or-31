"use client";

import type { LiquiditySafetyResult } from "@/components/LiquiditySafetyVerdictCard";

interface Props {
  data: LiquiditySafetyResult;
}

// ─── Tier styling ──────────────────────────────────────────────────────────────

const TIER_GLOW: Record<LiquiditySafetyResult["lp_risk_tier"], string> = {
  low:     "shadow-[0_0_32px_rgba(52,211,153,0.18)]",
  medium:  "shadow-[0_0_32px_rgba(251,191,36,0.18)]",
  high:    "shadow-[0_0_32px_rgba(251,146,60,0.20)]",
  extreme: "shadow-[0_0_32px_rgba(244,63,94,0.24)]",
};

const TIER_BORDER: Record<LiquiditySafetyResult["lp_risk_tier"], string> = {
  low:     "border-emerald-400/20",
  medium:  "border-amber-400/20",
  high:    "border-orange-400/20",
  extreme: "border-rose-400/25",
};

// ─── Signal derivation ────────────────────────────────────────────────────────

function deriveFragmentation(n: number) {
  if (n <= 2) return { label: "Stable",     color: "#34d399", bg: "rgba(52,211,153,0.08)",  border: "rgba(52,211,153,0.20)", score: 85 };
  if (n <= 5) return { label: "Moderate",   color: "#fbbf24", bg: "rgba(251,191,36,0.08)",  border: "rgba(251,191,36,0.20)", score: 55 };
  return             { label: "Fragmented", color: "#f43f5e", bg: "rgba(244,63,94,0.08)",   border: "rgba(244,63,94,0.20)",  score: 20 };
}

function deriveDepth(liq: number | null) {
  if (liq == null || liq < 10_000)  return { label: "Illiquid", color: "#f43f5e", bg: "rgba(244,63,94,0.08)",   border: "rgba(244,63,94,0.20)",  score: 8  };
  if (liq < 50_000)                 return { label: "Thin",     color: "#fb923c", bg: "rgba(251,146,60,0.08)",  border: "rgba(251,146,60,0.20)", score: 28 };
  if (liq < 250_000)                return { label: "Healthy",  color: "#fbbf24", bg: "rgba(251,191,36,0.08)",  border: "rgba(251,191,36,0.20)", score: 62 };
  return                                   { label: "Deep",     color: "#34d399", bg: "rgba(52,211,153,0.08)",  border: "rgba(52,211,153,0.20)", score: 92 };
}

function deriveVolatility(pools: LiquiditySafetyResult["pool_breakdown"]) {
  const changes = pools.slice(0, 3).map(p => p.priceChange24h).filter((v): v is number => v != null);
  if (!changes.length) return { label: "Unknown",        color: "#4a6272", bg: "rgba(74,98,114,0.08)",  border: "rgba(74,98,114,0.20)",  score: 50, maxAbs: 0 };
  const maxAbs = Math.max(...changes.map(Math.abs));
  if (maxAbs < 5)  return     { label: "Stable",         color: "#34d399", bg: "rgba(52,211,153,0.08)",  border: "rgba(52,211,153,0.20)", score: 90, maxAbs };
  if (maxAbs < 15) return     { label: "Moderate",       color: "#fbbf24", bg: "rgba(251,191,36,0.08)",  border: "rgba(251,191,36,0.20)", score: 65, maxAbs };
  if (maxAbs < 30) return     { label: "Volatile",       color: "#fb923c", bg: "rgba(251,146,60,0.08)",  border: "rgba(251,146,60,0.20)", score: 38, maxAbs };
  return                      { label: "Highly Unstable",color: "#f43f5e", bg: "rgba(244,63,94,0.08)",   border: "rgba(244,63,94,0.20)",  score: 12, maxAbs };
}

function deriveRugSignals(data: LiquiditySafetyResult): string[] {
  const sigs: string[] = [];
  const liq = data.lp_total_liquidity_usd;

  sigs.push("No lock data surfaced — treat as unlocked until proven otherwise. Verify via a lock explorer before trading.");

  if (data.lp_fragments > 5)
    sigs.push(`LP split across ${data.lp_fragments} pools — fragmented depth increases rug-exit ease.`);

  if (data.lp_fragments === 1 && liq != null && liq < 100_000)
    sigs.push("Entire LP concentrated in one thin pool — a single removal event drains all depth.");

  if (liq != null && liq < 50_000)
    sigs.push("Total LP depth critically low — trades over a few hundred dollars face severe slippage.");

  const topPool = data.pool_breakdown[0];
  if (topPool?.volume24h != null && liq != null && liq > 0 && topPool.volume24h / liq > 5)
    sigs.push("24h volume far exceeds total LP depth — potential wash trading or imminent LP drain.");

  const changes = data.pool_breakdown.slice(0, 3).map(p => p.priceChange24h).filter((v): v is number => v != null);
  const maxAbs  = changes.length ? Math.max(...changes.map(Math.abs)) : 0;
  if (maxAbs > 30)
    sigs.push(`Price swings of ${maxAbs.toFixed(1)}% in 24h signal unstable LP conditions.`);

  return sigs;
}

function deriveExpandedPositives(data: LiquiditySafetyResult): string[] {
  const pos: string[] = [];
  const liq = data.lp_total_liquidity_usd;

  if (liq != null && liq >= 500_000)
    pos.push(`Total LP depth of ${liq >= 1_000_000 ? `$${(liq / 1_000_000).toFixed(2)}M` : `$${(liq / 1_000).toFixed(0)}K`} provides a strong liquidity buffer.`);

  if (data.lp_fragments <= 2)
    pos.push("LP is consolidated in 1–2 pools — straightforward to monitor and track.");

  const changes = data.pool_breakdown.slice(0, 3).map(p => p.priceChange24h).filter((v): v is number => v != null);
  const maxAbs  = changes.length ? Math.max(...changes.map(Math.abs)) : null;
  if (maxAbs != null && maxAbs < 5)
    pos.push("Low 24h price variance across pools — LP has been stable recently.");

  const topPool = data.pool_breakdown[0];
  if (topPool?.volume24h != null && liq != null && liq > 0) {
    const ratio = topPool.volume24h / liq;
    if (ratio >= 0.05 && ratio <= 1.5)
      pos.push("Volume-to-liquidity ratio is within healthy range — natural organic trading activity.");
  }

  return pos;
}

function deriveExpandedNegatives(data: LiquiditySafetyResult): string[] {
  const neg: string[] = [];
  const liq = data.lp_total_liquidity_usd;

  neg.push("No lock data surfaced — liquidity is either unlocked or not using a standard lock provider. Treat as high-risk until verified.");

  if (liq != null && liq < 100_000)
    neg.push(`LP depth of ${liq < 1_000 ? `$${liq.toFixed(0)}` : `$${(liq / 1_000).toFixed(1)}K`} is below the $100K safety threshold.`);

  if (data.lp_fragments > 5)
    neg.push("Highly fragmented liquidity makes it harder to assess true available depth.");

  const changes = data.pool_breakdown.slice(0, 3).map(p => p.priceChange24h).filter((v): v is number => v != null);
  const maxAbs  = changes.length ? Math.max(...changes.map(Math.abs)) : null;
  if (maxAbs != null && maxAbs > 20)
    neg.push(`${maxAbs.toFixed(1)}% price swing in 24h indicates LP instability or thin-market manipulation.`);

  return neg;
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p style={{
      fontSize: "9px", fontWeight: 700, letterSpacing: "0.18em",
      color: "#3a5268", textTransform: "uppercase",
      fontFamily: "var(--font-plex-mono)", margin: "0 0 12px",
    }}>
      {children}
    </p>
  );
}

function Divider() {
  return <div style={{ height: "1px", background: "rgba(255,255,255,0.06)", width: "100%" }} />;
}

function StatusBadge({ label, color, bg, border }: { label: string; color: string; bg: string; border: string }) {
  return (
    <span style={{
      display: "inline-block", padding: "4px 12px",
      borderRadius: "99px", fontSize: "10px", fontWeight: 700,
      letterSpacing: "0.12em", textTransform: "uppercase",
      color, background: bg, border: `1px solid ${border}`,
      fontFamily: "var(--font-plex-mono)",
    }}>
      {label}
    </span>
  );
}

function RiskReasonBadge({ label }: { label: string }) {
  return (
    <span style={{
      display: "inline-block", padding: "4px 12px",
      borderRadius: "99px", fontSize: "10px", fontWeight: 700,
      letterSpacing: "0.10em", textTransform: "uppercase",
      color: "#fb923c", background: "rgba(251,146,60,0.08)",
      border: "1px solid rgba(251,146,60,0.22)",
      fontFamily: "var(--font-plex-mono)",
    }}>
      {label}
    </span>
  );
}

function IndicatorCard({
  label,
  badge,
  note,
}: {
  label: string;
  badge: React.ReactNode;
  note?: string;
}) {
  return (
    <div style={{
      background: "rgba(255,255,255,0.03)",
      border: "1px solid rgba(255,255,255,0.08)",
      borderRadius: "12px", padding: "14px 16px",
    }}>
      <p style={{
        fontSize: "9px", fontWeight: 700, letterSpacing: "0.16em",
        color: "#3a5268", textTransform: "uppercase",
        fontFamily: "var(--font-plex-mono)", marginBottom: "10px",
      }}>
        {label}
      </p>
      {badge}
      {note && (
        <p style={{
          fontSize: "10px", color: "#2a3f50",
          fontFamily: "var(--font-plex-mono)", marginTop: "8px", lineHeight: 1.5,
        }}>
          {note}
        </p>
      )}
    </div>
  );
}

function SubScoreBar({ label, score, color, unavailable }: { label: string; score: number; color: string; unavailable?: boolean }) {
  const pct = Math.max(0, Math.min(100, score));
  return (
    <div style={{ marginBottom: "12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "5px", alignItems: "center" }}>
        <span style={{ fontSize: "11px", color: "#64748b", fontFamily: "var(--font-plex-mono)" }}>
          {label}
        </span>
        <span style={{ fontSize: "11px", fontWeight: 700, color: unavailable ? "#2a3f50" : color, fontFamily: "var(--font-plex-mono)" }}>
          {unavailable ? "N/A" : `${pct}`}
        </span>
      </div>
      <div style={{
        height: "6px", borderRadius: "99px",
        background: "rgba(255,255,255,0.05)", overflow: "hidden",
      }}>
        {!unavailable && (
          <div style={{
            height: "100%", borderRadius: "99px",
            width: `${pct}%`,
            background: `linear-gradient(90deg, ${color}88 0%, ${color} 100%)`,
            boxShadow: `0 0 8px ${color}66`,
            transition: "width 0.7s cubic-bezier(0.4,0,0.2,1)",
          }} />
        )}
      </div>
    </div>
  );
}

function TimelineBar({ pct, color }: { pct: number; color: string }) {
  const filled = Math.max(0, Math.min(100, pct));
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
        <span style={{ fontSize: "9px", color: "#3a5268", fontFamily: "var(--font-plex-mono)", letterSpacing: "0.12em", textTransform: "uppercase" }}>
          Lock Progress
        </span>
        <span style={{ fontSize: "9px", color: filled > 0 ? color : "#2a3f50", fontFamily: "var(--font-plex-mono)" }}>
          {filled > 0 ? `${filled}% locked` : "No data"}
        </span>
      </div>
      <div style={{
        height: "8px", borderRadius: "99px",
        background: "rgba(255,255,255,0.05)", overflow: "hidden",
        position: "relative",
      }}>
        {filled > 0 && (
          <div style={{
            height: "100%", borderRadius: "99px",
            width: `${filled}%`,
            background: `linear-gradient(90deg, ${color}77 0%, ${color} 100%)`,
            boxShadow: `0 0 10px ${color}55`,
            transition: "width 0.8s cubic-bezier(0.4,0,0.2,1)",
          }} />
        )}
      </div>
      {filled === 0 && (
        <p style={{
          fontSize: "10px", color: "#fb923c", fontFamily: "var(--font-plex-mono)",
          marginTop: "6px", opacity: 0.75,
        }}>
          No lock data surfaced — treat as unlocked until verified via a lock explorer. Cannot confirm safety without manual check.
        </p>
      )}
    </div>
  );
}

// ─── Check / Warning icons ────────────────────────────────────────────────────

function IconCheck() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" style={{ flexShrink: 0, marginTop: "2px" }}>
      <circle cx="6.5" cy="6.5" r="6" stroke="#2DD4BF" strokeOpacity="0.3" />
      <path d="M3.5 6.5L5.5 8.8L9.5 4.5" stroke="#2DD4BF" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconWarn() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" style={{ flexShrink: 0, marginTop: "3px" }}>
      <path d="M6.5 1.5L12 11.5H1L6.5 1.5Z" stroke="#f43f5e" strokeOpacity="0.35" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M6.5 5V8" stroke="#f43f5e" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="6.5" cy="9.5" r="0.7" fill="#f43f5e" />
    </svg>
  );
}

function IconShield() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" style={{ flexShrink: 0, marginTop: "2px" }}>
      <path d="M6.5 1.5L11 3.5V6.5C11 9 8.5 11 6.5 11.5C4.5 11 2 9 2 6.5V3.5L6.5 1.5Z"
        stroke="#f43f5e" strokeOpacity="0.35" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M4.5 6.5L6 8L8.5 5" stroke="#f43f5e" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function LPSafetyExtendedBox({ data }: Props) {
  const tier       = data.lp_risk_tier;
  const frag       = deriveFragmentation(data.lp_fragments);
  const depth      = deriveDepth(data.lp_total_liquidity_usd);
  const volatility = deriveVolatility(data.pool_breakdown);
  const rugSignals = deriveRugSignals(data);
  const exPos      = deriveExpandedPositives(data);
  const exNeg      = deriveExpandedNegatives(data);

  return (
    <div
      className={`relative border-0 border-b ${TIER_BORDER[tier]} bg-[#0a0a0f]/60 backdrop-blur-xl
                  overflow-hidden`}
    >

      <div style={{ padding: "24px 20px", display: "flex", flexDirection: "column", gap: "22px" }}>

        {/* ── Header ─────────────────────────────────────────────────── */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{
            width: 6, height: 6, borderRadius: "50%",
            background: "#2DD4BF", boxShadow: "0 0 8px rgba(45,212,191,0.8)",
            flexShrink: 0,
          }} />
          <p style={{
            fontSize: "10px", fontWeight: 700, letterSpacing: "0.20em",
            color: "#2DD4BF", fontFamily: "var(--font-plex-mono)",
            textTransform: "uppercase", margin: 0,
          }}>
            Extended LP Safety Report
          </p>
        </div>

        <Divider />

        {/* ── Key Indicators 2×3 grid ─────────────────────────────────── */}
        <div>
          <SectionLabel>Key Indicators</SectionLabel>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "10px" }}>

            {/* LP Lock Status */}
            <IndicatorCard
              label="LP Lock Status"
              badge={<RiskReasonBadge label="Not Detected" />}
              note="No lock data surfaced — likely unlocked or not using a standard lock provider. Treat as high-risk."
            />

            {/* LP Owner */}
            <IndicatorCard
              label="LP Owner"
              badge={<RiskReasonBadge label="Unverified" />}
              note="Owner not surfaced — likely EOA or unverified contract. Increases rug-exit risk."
            />

            {/* LP Unlock Countdown */}
            <IndicatorCard
              label="Unlock Countdown"
              badge={<RiskReasonBadge label="No Timestamp" />}
              note="No unlock timestamp — either unlocked, burned, or not using a known lock provider."
            />

            {/* Depth */}
            <IndicatorCard
              label="LP Depth"
              badge={
                <StatusBadge
                  label={depth.label}
                  color={depth.color}
                  bg={depth.bg}
                  border={depth.border}
                />
              }
              note={
                data.lp_total_liquidity_usd != null
                  ? `$${data.lp_total_liquidity_usd >= 1_000_000
                      ? (data.lp_total_liquidity_usd / 1_000_000).toFixed(2) + "M"
                      : data.lp_total_liquidity_usd >= 1_000
                      ? (data.lp_total_liquidity_usd / 1_000).toFixed(1) + "K"
                      : data.lp_total_liquidity_usd.toFixed(0)} total`
                  : undefined
              }
            />

            {/* Fragmentation */}
            <IndicatorCard
              label="Fragmentation"
              badge={
                <StatusBadge
                  label={frag.label}
                  color={frag.color}
                  bg={frag.bg}
                  border={frag.border}
                />
              }
              note={`${data.lp_fragments} pool${data.lp_fragments !== 1 ? "s" : ""} detected`}
            />

            {/* Volatility */}
            <IndicatorCard
              label="LP Volatility"
              badge={
                <StatusBadge
                  label={volatility.label}
                  color={volatility.color}
                  bg={volatility.bg}
                  border={volatility.border}
                />
              }
              note={
                volatility.maxAbs > 0
                  ? `${volatility.maxAbs.toFixed(1)}% max 24h swing`
                  : "No price data"
              }
            />
          </div>
        </div>

        <Divider />

        {/* ── Safety Sub-Scores ───────────────────────────────────────── */}
        <div>
          <SectionLabel>Safety Breakdown</SectionLabel>
          <SubScoreBar label="LP Depth Score"         score={depth.score}      color={depth.color}      />
          <SubScoreBar label="Fragmentation Score"    score={frag.score}       color={frag.color}       />
          <SubScoreBar label="Volatility Score"       score={volatility.score} color={volatility.color} />
          <SubScoreBar label="Lock Score"             score={0}  color="#4a6272" unavailable />
          <SubScoreBar label="Owner Score"            score={0}  color="#4a6272" unavailable />
        </div>

        <Divider />

        {/* ── LP Unlock Timeline Bar ───────────────────────────────────── */}
        <div>
          <SectionLabel>LP Unlock Timeline</SectionLabel>
          <TimelineBar pct={0} color="#34d399" />
        </div>

        <Divider />

        {/* ── Rug-Risk Signals ────────────────────────────────────────── */}
        {rugSignals.length > 0 && (
          <div>
            <SectionLabel>Rug-Risk Signals · {rugSignals.length}</SectionLabel>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {rugSignals.map((sig, i) => (
                <div key={i} style={{
                  display: "flex", alignItems: "flex-start", gap: "10px",
                  background: "rgba(244,63,94,0.04)",
                  border: "1px solid rgba(244,63,94,0.12)",
                  borderRadius: "10px", padding: "10px 14px",
                }}>
                  <IconShield />
                  <p style={{
                    fontSize: "12px", lineHeight: 1.6, color: "#94a3b8",
                    fontFamily: "var(--font-plex-mono)", margin: 0,
                  }}>
                    {sig}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Expanded Positives ──────────────────────────────────────── */}
        {exPos.length > 0 && (
          <div>
            <SectionLabel>Additional Positives</SectionLabel>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {exPos.map((text, i) => (
                <div key={i} style={{
                  display: "flex", alignItems: "flex-start", gap: "10px",
                  background: "rgba(45,212,191,0.04)",
                  border: "1px solid rgba(45,212,191,0.12)",
                  borderRadius: "10px", padding: "10px 14px",
                }}>
                  <IconCheck />
                  <p style={{
                    fontSize: "12px", lineHeight: 1.6, color: "#94a3b8",
                    fontFamily: "var(--font-plex-mono)", margin: 0,
                  }}>
                    {text}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Expanded Negatives ──────────────────────────────────────── */}
        {exNeg.length > 0 && (
          <div>
            <SectionLabel>Additional Negatives</SectionLabel>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {exNeg.map((text, i) => (
                <div key={i} style={{
                  display: "flex", alignItems: "flex-start", gap: "10px",
                  background: "rgba(244,63,94,0.04)",
                  border: "1px solid rgba(244,63,94,0.14)",
                  borderRadius: "10px", padding: "10px 14px",
                }}>
                  <IconWarn />
                  <p style={{
                    fontSize: "12px", lineHeight: 1.6, color: "#94a3b8",
                    fontFamily: "var(--font-plex-mono)", margin: 0,
                  }}>
                    {text}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Disclaimer ─────────────────────────────────────────────── */}
        <p style={{
          fontSize: "9px", letterSpacing: "0.14em", textTransform: "uppercase",
          color: "#1e2e38", textAlign: "center", fontFamily: "var(--font-plex-mono)", margin: 0,
        }}>
          Rule-based analysis only · Not financial advice · ChainLens AI
        </p>

      </div>
    </div>
  );
}
