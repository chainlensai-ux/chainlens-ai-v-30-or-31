"use client";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LiquiditySafetyResult {
  name: string;
  symbol: string;
  contract: string;
  lp_total_liquidity_usd: number | null;
  lp_fragments: number;
  liquidity_depth_score: number;
  lp_risk_tier: "low" | "medium" | "high" | "extreme";
  positives: string[];
  negatives: string[];
  pool_breakdown: Array<{
    name: string | undefined;
    address: string;
    liquidity: number | null;
    volume24h: number | null;
    priceChange24h: number | null;
    priceChange1h: number | null;
    dexName: string | null;
    buys24: number | null;
    sells24: number | null;
    volumeH1: number | null;
    volumeH6: number | null;
    liquidityShare: number | null;
    isPrimary: boolean;
    volLiqRatio: number | null;
    isStale: boolean;
  }>;
  // No active lock-proof provider is wired up — always "unverified"
  lockStatus: "locked" | "unlocked" | "unverified";
  lp_data_mode: "strict" | "minimal" | "fallback" | "insufficient";
  lp_data_confidence: "high" | "medium" | "low" | "unverified";
  lp_evidence_gaps: Array<{ id: string; label: string; explanation: string; nextAction: string }>;
  lp_model_proof: {
    model: "constant_product" | "concentrated" | "stableswap" | "unknown";
    dexName: string | null;
    standardLockApplies: boolean;
  };
  lp_migration_proof: {
    status: "low" | "watch" | "flagged" | "unknown";
    confidence: "high" | "medium" | "low" | "unverified";
    reason: string;
    dexsUsed: string[];
    primaryDex: string | null;
    liquidityDistribution: string;
    signals: string[];
    missingEvidence: string[];
    nextAction: string;
  };
  cortex_lp_read: {
    mode: string;
    confidence: string;
    riskSummary: string;
    liquidityAnalysis: string;
    poolStructureAnalysis: string;
    migrationAnalysis: string;
    evidenceGaps: string[];
    nextActions: string[];
  };
}

interface Props {
  result: LiquiditySafetyResult | null;
  loading: boolean;
  error: string | null;
}

// ─── Tier config ──────────────────────────────────────────────────────────────

const TIER_COLOR: Record<LiquiditySafetyResult["lp_risk_tier"], { ring: string; glow: string; badge: string; label: string }> = {
  low:     { ring: "#2DD4BF", glow: "rgba(45,212,191,0.30)",  badge: "rgba(45,212,191,0.12)",  label: "#2DD4BF" },
  medium:  { ring: "#fbbf24", glow: "rgba(251,191,36,0.28)",  badge: "rgba(251,191,36,0.12)",  label: "#fbbf24" },
  high:    { ring: "#fb923c", glow: "rgba(251,146,60,0.28)",  badge: "rgba(251,146,60,0.12)",  label: "#fb923c" },
  extreme: { ring: "#f43f5e", glow: "rgba(244,63,94,0.32)",   badge: "rgba(244,63,94,0.12)",   label: "#f43f5e" },
};

const TIER_LABEL: Record<LiquiditySafetyResult["lp_risk_tier"], string> = {
  low: "LOW RISK", medium: "MEDIUM RISK", high: "HIGH RISK", extreme: "EXTREME RISK",
};

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtLarge(v: number | null | undefined): string {
  if (v == null) return "N/A";
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000)     return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000)         return `$${(v / 1_000).toFixed(2)}K`;
  return `$${v.toFixed(2)}`;
}

function fmtPct(v: number | null | undefined): string {
  if (v == null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function pctColor(v: number | null | undefined): string {
  if (v == null) return "#4a6272";
  return v >= 0 ? "#2DD4BF" : "#f43f5e";
}

const LOCK_CHIP: Record<LiquiditySafetyResult["lockStatus"], { label: string; color: string; bg: string; border: string }> = {
  locked:     { label: "LP LOCKED",   color: "#34d399", bg: "rgba(52,211,153,0.10)", border: "rgba(52,211,153,0.30)" },
  unlocked:   { label: "LP UNLOCKED", color: "#f43f5e", bg: "rgba(244,63,94,0.10)",  border: "rgba(244,63,94,0.30)" },
  unverified: { label: "LOCK STATUS UNVERIFIED", color: "#fb923c", bg: "rgba(251,146,60,0.10)", border: "rgba(251,146,60,0.30)" },
};

const MODE_LABEL: Record<LiquiditySafetyResult["lp_data_mode"], string> = {
  strict: "STRICT", minimal: "MINIMAL", fallback: "FALLBACK", insufficient: "INSUFFICIENT",
};

const CONFIDENCE_COLOR: Record<LiquiditySafetyResult["lp_data_confidence"], string> = {
  high: "#34d399", medium: "#fbbf24", low: "#fb923c", unverified: "#4a6272",
};

function shorten(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

// ─── Score ring (SVG arc) ─────────────────────────────────────────────────────

function ScoreRing({ score, tier }: { score: number; tier: LiquiditySafetyResult["lp_risk_tier"] }) {
  const c = TIER_COLOR[tier];
  const r = 52;
  const cx = 64;
  const cy = 64;
  const circumference = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, score));
  const filled = (pct / 100) * circumference;

  return (
    <div style={{ position: "relative", width: 128, height: 128, flexShrink: 0 }}>
      <svg width="128" height="128" style={{ transform: "rotate(-90deg)" }}>
        {/* Track */}
        <circle
          cx={cx} cy={cy} r={r}
          fill="none"
          stroke="rgba(255,255,255,0.06)"
          strokeWidth="8"
        />
        {/* Score arc */}
        <circle
          cx={cx} cy={cy} r={r}
          fill="none"
          stroke={c.ring}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={`${filled} ${circumference}`}
          style={{
            filter: `drop-shadow(0 0 8px ${c.ring}cc)`,
            transition: "stroke-dasharray 0.8s cubic-bezier(0.4,0,0.2,1)",
          }}
        />
      </svg>
      {/* Center content */}
      <div style={{
        position: "absolute", inset: 0,
        display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
      }}>
        <span style={{
          fontSize: "36px", fontWeight: 900, lineHeight: 1,
          color: c.ring,
          textShadow: `0 0 24px ${c.glow}`,
          fontFamily: "var(--font-plex-mono)",
        }}>
          {score}
        </span>
        <span style={{
          fontSize: "9px", color: "#3a5268", letterSpacing: "0.12em",
          fontFamily: "var(--font-plex-mono)", marginTop: "2px",
        }}>
          / 100
        </span>
      </div>
    </div>
  );
}

// ─── Stat card ────────────────────────────────────────────────────────────────

function StatCard({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div style={{
      background: "rgba(255,255,255,0.03)",
      border: "1px solid rgba(255,255,255,0.08)",
      borderRadius: "12px",
      padding: "16px 20px",
    }}>
      <p style={{
        fontSize: "9px", fontWeight: 700, letterSpacing: "0.16em",
        color: "#3a5268", textTransform: "uppercase", marginBottom: "8px",
        fontFamily: "var(--font-plex-mono)",
      }}>
        {label}
      </p>
      <p style={{
        fontSize: "20px", fontWeight: 700,
        color: accent ?? "#e2e8f0",
        fontFamily: "var(--font-plex-mono)",
        margin: 0,
      }}>
        {value}
      </p>
    </div>
  );
}

// ─── Section header ───────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p style={{
      fontSize: "9px", fontWeight: 700, letterSpacing: "0.18em",
      color: "#3a5268", textTransform: "uppercase",
      fontFamily: "var(--font-plex-mono)",
      marginBottom: "12px", margin: "0 0 12px",
    }}>
      {children}
    </p>
  );
}

function Divider() {
  return <div style={{ height: "1px", background: "rgba(255,255,255,0.06)", width: "100%" }} />;
}

// ─── Checkmark icon ───────────────────────────────────────────────────────────

function IconCheck() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ flexShrink: 0, marginTop: "2px" }}>
      <circle cx="7" cy="7" r="6.5" stroke="#2DD4BF" strokeOpacity="0.25" />
      <path d="M4 7L6.2 9.5L10 5" stroke="#2DD4BF" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ─── Warning icon ─────────────────────────────────────────────────────────────

function IconWarn() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ flexShrink: 0, marginTop: "2px" }}>
      <path d="M7 1.5L12.8 11.5H1.2L7 1.5Z" stroke="#f43f5e" strokeOpacity="0.35" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M7 5.5V8" stroke="#f43f5e" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="7" cy="10" r="0.75" fill="#f43f5e" />
    </svg>
  );
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function Skeleton() {
  return (
    <div style={{
      background: "#080c14",
      border: "1px solid rgba(255,255,255,0.08)",
      borderRadius: "16px",
      padding: "32px",
      overflow: "hidden",
      position: "relative",
    }}>
      <style>{`@keyframes lp-shimmer { 0% { transform: translateX(-100%); } 100% { transform: translateX(200%); } }`}</style>
      <div style={{
        position: "absolute", inset: 0,
        background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.03), transparent)",
        animation: "lp-shimmer 1.8s ease-in-out infinite",
      }} />
      <div style={{ display: "flex", gap: "32px", alignItems: "center", marginBottom: "32px" }}>
        <div style={{ width: 128, height: 128, borderRadius: "50%", background: "rgba(255,255,255,0.06)" }} />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "10px" }}>
          <div style={{ height: 12, width: "60%", borderRadius: 6, background: "rgba(255,255,255,0.08)" }} />
          <div style={{ height: 8,  width: "40%", borderRadius: 4, background: "rgba(255,255,255,0.05)" }} />
          <div style={{ height: 32, width: 100, borderRadius: 8, background: "rgba(255,255,255,0.06)", marginTop: 8 }} />
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 24 }}>
        {[0, 1].map(i => (
          <div key={i} style={{ height: 80, borderRadius: 12, background: "rgba(255,255,255,0.04)" }} />
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {[0, 1, 2].map(i => (
          <div key={i} style={{ height: 44, borderRadius: 10, background: "rgba(255,255,255,0.03)" }} />
        ))}
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function LiquiditySafetyVerdictCard({ result, loading, error }: Props) {
  if (loading) return <Skeleton />;

  if (error) {
    return (
      <div style={{
        background: "rgba(244,63,94,0.06)",
        border: "1px solid rgba(244,63,94,0.20)",
        borderRadius: "16px",
        padding: "24px",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px" }}>
          <span style={{
            width: 6, height: 6, borderRadius: "50%",
            background: "#f43f5e",
            boxShadow: "0 0 8px rgba(244,63,94,0.9)",
            flexShrink: 0,
          }} />
          <p style={{
            fontSize: "10px", fontWeight: 700, letterSpacing: "0.18em",
            color: "#f43f5e", fontFamily: "var(--font-plex-mono)",
            textTransform: "uppercase", margin: 0,
          }}>
            Scan Error
          </p>
        </div>
        <p style={{ fontSize: "13px", color: "rgba(244,63,94,0.8)", fontFamily: "var(--font-plex-mono)", margin: 0 }}>
          {error}
        </p>
      </div>
    );
  }

  if (!result) return null;

  const tc = TIER_COLOR[result.lp_risk_tier] ?? TIER_COLOR.high;
  const tierLabel = TIER_LABEL[result.lp_risk_tier];

  return (
    <div style={{
      background: "#080c14",
      border: "1px solid rgba(255,255,255,0.08)",
      borderRadius: "16px",
      overflow: "hidden",
      boxShadow: `0 0 40px ${tc.glow}`,
      position: "relative",
    }}>
      {/* Top accent line */}
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0, height: "1px",
        background: `linear-gradient(90deg, transparent 0%, ${tc.ring}66 40%, ${tc.ring}44 70%, transparent 100%)`,
      }} />

      <div style={{ padding: "32px", display: "flex", flexDirection: "column", gap: "28px" }}>

        {/* ── Data mode / confidence ───────────────────────────────── */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" }}>
          <span style={{
            display: "inline-block", padding: "5px 12px", borderRadius: "99px",
            background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.10)",
            fontSize: "9px", fontWeight: 700, letterSpacing: "0.12em",
            color: "#94a3b8", fontFamily: "var(--font-plex-mono)",
          }}>
            SCAN MODE: {MODE_LABEL[result.lp_data_mode]}
          </span>
          <span style={{
            display: "inline-block", padding: "5px 12px", borderRadius: "99px",
            background: "rgba(255,255,255,0.04)", border: `1px solid ${CONFIDENCE_COLOR[result.lp_data_confidence]}40`,
            fontSize: "9px", fontWeight: 700, letterSpacing: "0.12em",
            color: CONFIDENCE_COLOR[result.lp_data_confidence], fontFamily: "var(--font-plex-mono)",
          }}>
            EVIDENCE CONFIDENCE: {result.lp_data_confidence.toUpperCase()}
          </span>
        </div>

        {/* ── Evidence gap chips ───────────────────────────────────── */}
        {result.lp_evidence_gaps.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", paddingBottom: "2px" }}>
            {result.lp_evidence_gaps.map((gap) => (
              <span key={gap.id} title={gap.explanation} style={{
                flexShrink: 0,
                display: "inline-block",
                padding: "5px 12px",
                borderRadius: "99px",
                background: "rgba(251,146,60,0.08)",
                border: "1px solid rgba(251,146,60,0.25)",
                fontSize: "9px", fontWeight: 700, letterSpacing: "0.12em",
                color: "#fb923c",
                fontFamily: "var(--font-plex-mono)",
                whiteSpace: "nowrap",
              }}>
                {gap.label}
              </span>
            ))}
          </div>
        )}

        {/* ── Score + identity ────────────────────────────────────── */}
        <div style={{ display: "flex", gap: "32px", alignItems: "center" }}>
          <div>
            <ScoreRing score={result.liquidity_depth_score} tier={result.lp_risk_tier} />
            <p style={{
              fontSize: "8px", color: "#3a5268", textAlign: "center",
              lineHeight: 1.5, marginTop: "10px", maxWidth: "128px",
              fontFamily: "var(--font-plex-mono)",
            }}>
              Liquidity depth &amp; pool structure only — not a security audit.
            </p>
          </div>

          <div style={{ flex: 1 }}>
            <p style={{
              fontSize: "10px", fontWeight: 700, letterSpacing: "0.18em",
              color: "#2DD4BF", fontFamily: "var(--font-plex-mono)",
              textTransform: "uppercase", marginBottom: "6px",
            }}>
              LIQUIDITY DEPTH SCORE
            </p>
            <p style={{
              fontSize: "10px", color: "#4a6272", lineHeight: 1.6,
              fontFamily: "var(--font-plex-mono)", marginTop: "-2px", marginBottom: "8px", maxWidth: "420px",
            }}>
              This score measures liquidity depth and pool structure only. Lock, burn, ownership, mintability, honeypot and tax proof are not confirmed by this scan.
            </p>
            <p style={{
              fontSize: "11px", color: "#4a6272",
              fontFamily: "var(--font-plex-mono)",
              marginBottom: "16px",
            }}>
              On-chain liquidity depth assessment · not financial advice
            </p>

            {/* Tier + lock-status badges */}
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "7px" }}>
              <span style={{
                display: "inline-block",
                padding: "5px 14px",
                borderRadius: "99px",
                background: tc.badge,
                border: `1px solid ${tc.ring}40`,
                fontSize: "10px", fontWeight: 700, letterSpacing: "0.14em",
                color: tc.label,
                fontFamily: "var(--font-plex-mono)",
                textTransform: "uppercase",
              }}>
                {tierLabel}
              </span>
              {(() => {
                const lc = LOCK_CHIP[result.lockStatus]
                return (
                  <span style={{
                    display: "inline-block",
                    padding: "5px 14px",
                    borderRadius: "99px",
                    background: lc.bg,
                    border: `1px solid ${lc.border}`,
                    fontSize: "10px", fontWeight: 700, letterSpacing: "0.14em",
                    color: lc.color,
                    fontFamily: "var(--font-plex-mono)",
                    textTransform: "uppercase",
                  }}>
                    {lc.label}
                  </span>
                )
              })()}
            </div>
          </div>
        </div>

        <Divider />

        {/* ── LP status row ────────────────────────────────────────── */}
        <div>
          <SectionLabel>LP Status</SectionLabel>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
            <StatCard label="Liquidity Depth"    value={fmtLarge(result.lp_total_liquidity_usd)} accent="#2DD4BF" />
            <StatCard label="Pool Count"         value={String(result.lp_fragments)} />
            <StatCard label="Primary DEX"        value={result.lp_model_proof.dexName ?? "Unverified"} />
            <StatCard label="LP Model"           value={result.lp_model_proof.model === "unknown" ? "Unverified" : result.lp_model_proof.model.replace("_", " ")} />
            <StatCard label="Concentration"      value={result.lp_migration_proof.liquidityDistribution === "unknown" ? "Not checked" : result.lp_migration_proof.liquidityDistribution} />
            <StatCard label="Lock Status"        value={result.lockStatus === "unverified" ? "Unverified" : result.lockStatus} accent={result.lockStatus === "unverified" ? "#fb923c" : undefined} />
            <StatCard label="Evidence Confidence" value={result.lp_data_confidence === "unverified" ? "Unverified" : result.lp_data_confidence} accent={CONFIDENCE_COLOR[result.lp_data_confidence]} />
          </div>
        </div>

        {result.lp_model_proof.model === "concentrated" && (
          <p style={{
            fontSize: "11px", lineHeight: 1.6, color: "#fb923c",
            fontFamily: "var(--font-plex-mono)", margin: 0,
            background: "rgba(251,146,60,0.06)", border: "1px solid rgba(251,146,60,0.20)",
            borderRadius: "10px", padding: "12px 14px",
          }}>
            This token trades on a concentrated-liquidity pool. Standard LP lock proofs may not apply — lock verification methods differ for this AMM model.
          </p>
        )}

        <Divider />

        {/* ── Positives ───────────────────────────────────────────── */}
        {result.positives.length > 0 && (
          <div>
            <SectionLabel>Positives</SectionLabel>
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              {result.positives.map((text, i) => (
                <div key={i} style={{
                  display: "flex", alignItems: "flex-start", gap: "10px",
                  background: "rgba(45,212,191,0.04)",
                  border: "1px solid rgba(45,212,191,0.12)",
                  borderRadius: "10px",
                  padding: "12px 14px",
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

        {/* ── Negatives ───────────────────────────────────────────── */}
        {result.negatives.length > 0 && (
          <div>
            <SectionLabel>Negatives</SectionLabel>
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              {result.negatives.map((text, i) => (
                <div key={i} style={{
                  display: "flex", alignItems: "flex-start", gap: "10px",
                  background: "rgba(244,63,94,0.04)",
                  border: "1px solid rgba(244,63,94,0.14)",
                  borderRadius: "10px",
                  padding: "12px 14px",
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

        <Divider />

        {/* ── Pool breakdown table ─────────────────────────────────── */}
        {result.pool_breakdown.length > 0 && (
          <div>
            <SectionLabel>Pool Breakdown · {result.pool_breakdown.length}</SectionLabel>

            {/* Table header */}
            <div style={{
              display: "grid",
              gridTemplateColumns: "1fr 120px 120px 80px",
              padding: "0 14px 8px",
              borderBottom: "1px solid rgba(255,255,255,0.06)",
              marginBottom: "4px",
            }}>
              {["Pool", "Liquidity", "Vol 24h", "24h"].map(h => (
                <span key={h} style={{
                  fontSize: "9px", fontWeight: 700, letterSpacing: "0.16em",
                  color: "#3a5268", textTransform: "uppercase",
                  fontFamily: "var(--font-plex-mono)",
                  textAlign: h === "24h" ? "right" : "left",
                }}>
                  {h}
                </span>
              ))}
            </div>

            {/* Table rows */}
            <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
              {result.pool_breakdown.slice(0, 8).map((pool, i) => (
                <div
                  key={i}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 120px 120px 80px",
                    alignItems: "center",
                    padding: "10px 14px",
                    borderRadius: "8px",
                    background: i % 2 === 0 ? "rgba(255,255,255,0.02)" : "transparent",
                    fontFamily: "var(--font-plex-mono)",
                    fontSize: "12px",
                    transition: "background 0.12s",
                  }}
                >
                  <span style={{
                    color: "#64748b",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    paddingRight: "12px",
                  }}>
                    {pool.name ?? shorten(pool.address)}
                  </span>
                  <span style={{ color: "#2DD4BF", whiteSpace: "nowrap" }}>
                    {fmtLarge(pool.liquidity)}
                  </span>
                  <span style={{ color: "#4a6272", whiteSpace: "nowrap" }}>
                    {fmtLarge(pool.volume24h)}
                  </span>
                  <span style={{
                    color: pctColor(pool.priceChange24h),
                    whiteSpace: "nowrap", textAlign: "right",
                  }}>
                    {fmtPct(pool.priceChange24h)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <Divider />

        {/* ── CORTEX LP Read ───────────────────────────────────────── */}
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <SectionLabel>CORTEX LP Read</SectionLabel>
          {[
            result.cortex_lp_read.riskSummary,
            result.cortex_lp_read.liquidityAnalysis,
            result.cortex_lp_read.poolStructureAnalysis,
            result.cortex_lp_read.migrationAnalysis,
          ].map((line, i) => (
            <p key={i} style={{
              fontSize: "12px", lineHeight: 1.6, color: "#94a3b8",
              fontFamily: "var(--font-plex-mono)", margin: 0,
              background: "rgba(255,255,255,0.02)",
              border: "1px solid rgba(255,255,255,0.06)",
              borderRadius: "10px", padding: "12px 14px",
            }}>
              {line}
            </p>
          ))}
          {result.cortex_lp_read.nextActions.length > 0 && (
            <div style={{
              background: "rgba(45,212,191,0.03)", border: "1px solid rgba(45,212,191,0.10)",
              borderRadius: "10px", padding: "12px 14px",
            }}>
              <p style={{ fontSize: "9px", fontWeight: 700, letterSpacing: "0.14em", color: "#2DD4BF", fontFamily: "var(--font-plex-mono)", margin: "0 0 8px 0", textTransform: "uppercase" }}>
                Next Actions
              </p>
              <ul style={{ margin: 0, paddingLeft: "16px", display: "flex", flexDirection: "column", gap: "6px" }}>
                {result.cortex_lp_read.nextActions.map((action, i) => (
                  <li key={i} style={{ fontSize: "11px", lineHeight: 1.6, color: "#94a3b8", fontFamily: "var(--font-plex-mono)" }}>
                    {action}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* ── Disclaimer ───────────────────────────────────────────── */}
        <p style={{
          fontSize: "9px", letterSpacing: "0.14em", textTransform: "uppercase",
          color: "#1e2e38", textAlign: "center", fontFamily: "var(--font-plex-mono)",
          margin: 0,
        }}>
          LP risk analysis only · Not financial advice · ChainLens AI
        </p>

      </div>
    </div>
  );
}
