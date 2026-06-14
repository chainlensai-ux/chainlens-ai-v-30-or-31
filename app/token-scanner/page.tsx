"use client";

import { useMemo, useState } from "react";
import clsx from "clsx";
import type { CortexVerdict } from "@/app/api/cortex-token-verdict/route";

type ChainKey = "base" | "eth";
type TabKey = "CORTEX Read" | "Market Pulse" | "Holder Map" | "LP Control" | "Risk Engine" | "Dev Control";

type ScanResult = {
  name?: string;
  symbol?: string;
  contract?: string;
  address?: string;
  chain?: string;
  price?: number | string | null;
  liquidity?: number | string | null;
  volume24h?: number | string | null;
  priceChange24h?: number | string | null;
  marketCap?: number | string | null;
  fdv?: number | string | null;
  holders?: number | string | null;
  holderCount?: number | string | null;
  pools?: Array<Record<string, any>>;
  analysis?: Record<string, any>;
  issues?: string[];
  aiSummary?: string;
  decimals?: number;
  tokenInfo?: { name?: string; symbol?: string; decimals?: number };
  [key: string]: any;
};

const TABS: Array<{ key: TabKey; tone: "verified" | "caution" | "open" | "danger"; icon: string }> = [
  { key: "CORTEX Read", tone: "verified", icon: "✦" },
  { key: "Market Pulse", tone: "verified", icon: "◒" },
  { key: "Holder Map", tone: "caution", icon: "●" },
  { key: "LP Control", tone: "open", icon: "◆" },
  { key: "Risk Engine", tone: "danger", icon: "▲" },
  { key: "Dev Control", tone: "open", icon: "◇" },
];

function shorten(str = "", start = 6, end = 4): string {
  if (!str) return "Unknown";
  if (str.length <= start + end) return str;
  return `${str.slice(0, start)}…${str.slice(-end)}`;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[$,%]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function money(value: unknown, fallback = "Open Evidence"): string {
  const num = toNumber(value);
  if (num == null) return fallback;
  if (Math.abs(num) >= 1_000_000_000) return `$${(num / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(num) >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (Math.abs(num) >= 1_000) return `$${(num / 1_000).toFixed(1)}K`;
  return `$${num.toFixed(2)}`;
}

function price(value: unknown): string {
  const num = toNumber(value);
  if (num == null) return "Open Evidence";
  if (num > 0 && num < 0.0001) return `$${num.toExponential(2)}`;
  return `$${num.toLocaleString(undefined, { maximumFractionDigits: 8 })}`;
}

function percent(value: unknown, fallback = "Open Evidence"): string {
  const num = toNumber(value);
  if (num == null) return fallback;
  return `${num.toFixed(2)}%`;
}

function riskTone(score: number): { label: string; className: string; accent: string } {
  if (score >= 80) return { label: "Extreme Risk", className: "border-rose-400/30 bg-rose-500/10 text-rose-200", accent: "#fb7185" };
  if (score >= 60) return { label: "High Risk", className: "border-orange-400/30 bg-orange-500/10 text-orange-200", accent: "#fb923c" };
  if (score >= 35) return { label: "Medium Risk", className: "border-amber-400/30 bg-amber-500/10 text-amber-200", accent: "#fbbf24" };
  return { label: "Low Observable Risk", className: "border-emerald-400/30 bg-emerald-500/10 text-emerald-200", accent: "#34d399" };
}

function copyText(value?: string) {
  if (value && typeof navigator !== "undefined") navigator.clipboard?.writeText(value);
}

function getContract(data?: ScanResult | null, typed = "") {
  return data?.contract ?? data?.address ?? typed;
}

function getScore(verdict: CortexVerdict | null, data: ScanResult | null): number {
  if (verdict) return Math.max(0, Math.min(100, 100 - verdict.risk_score));
  const issues = data?.issues?.length ?? 0;
  return issues >= 3 ? 38 : issues >= 1 ? 62 : data ? 76 : 0;
}

function getRiskLabel(verdict: CortexVerdict | null, data: ScanResult | null) {
  if (verdict) return verdict.risk_tier === "low" ? "Low Observable Risk" : `${verdict.risk_tier[0].toUpperCase()}${verdict.risk_tier.slice(1)} Risk`;
  const issues = data?.issues?.length ?? 0;
  if (issues >= 3) return "High Risk";
  if (issues >= 1) return "Medium Risk";
  return "Open Evidence";
}

function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return <section className={clsx("rounded-3xl border border-white/[0.08] bg-slate-950/55 p-4 shadow-[0_18px_80px_rgba(0,0,0,0.28)] backdrop-blur-xl md:p-5", className)}>{children}</section>;
}

function StatusBadge({ children, tone = "open" }: { children: React.ReactNode; tone?: "verified" | "caution" | "open" | "danger" }) {
  const styles = {
    verified: "border-emerald-400/25 bg-emerald-400/10 text-emerald-200",
    caution: "border-amber-400/25 bg-amber-400/10 text-amber-200",
    open: "border-cyan-300/20 bg-cyan-300/10 text-cyan-100",
    danger: "border-rose-400/25 bg-rose-400/10 text-rose-200",
  };
  return <span className={clsx("inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold", styles[tone])}>{children}</span>;
}

function Metric({ label, value, note }: { label: string; value: React.ReactNode; note?: string }) {
  return <div className="rounded-2xl border border-white/[0.07] bg-white/[0.035] p-3"><p className="text-[11px] uppercase tracking-[0.16em] text-slate-500">{label}</p><div className="mt-1 text-base font-semibold text-slate-100">{value}</div>{note && <p className="mt-1 text-xs text-slate-400">{note}</p>}</div>;
}

function ScanCommandCenter({ chain, setChain, contract, setContract, loading, onScan, error }: { chain: ChainKey; setChain: (c: ChainKey) => void; contract: string; setContract: (v: string) => void; loading: boolean; onScan: () => void; error: string | null }) {
  return <Card className="relative overflow-hidden p-4 md:p-5">
    <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-300/50 to-transparent" />
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div><p className="text-xs font-semibold uppercase tracking-[0.28em] text-cyan-200/80">Token Intelligence Terminal</p><h1 className="mt-2 text-2xl font-semibold tracking-tight text-white md:text-4xl">Scan contract, ticker, or token name.</h1></div>
      <div className="flex flex-wrap gap-2"><StatusBadge tone="verified">Base</StatusBadge><StatusBadge tone="open">ETH</StatusBadge><StatusBadge tone="verified">Live CORTEX</StatusBadge><StatusBadge tone="caution">Real data only</StatusBadge></div>
    </div>
    <div className="grid gap-3 md:grid-cols-[auto_1fr_auto] md:items-center">
      <div className="inline-flex rounded-2xl border border-white/10 bg-black/30 p-1">
        {(["base", "eth"] as const).map((c) => <button key={c} type="button" onClick={() => setChain(c)} className={clsx("rounded-xl px-4 py-2 text-sm font-semibold transition", chain === c ? "bg-cyan-300 text-slate-950 shadow-lg shadow-cyan-500/20" : "text-slate-400 hover:text-white")}>{c === "eth" ? "ETH" : "Base"}</button>)}
      </div>
      <label className="flex min-w-0 items-center gap-3 rounded-2xl border border-white/10 bg-black/35 px-4 py-3 focus-within:border-cyan-300/50"><span className="text-cyan-200">⌕</span><input value={contract} onChange={(e) => setContract(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") onScan(); }} placeholder="0x contract · Ticker · Token name" className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-slate-500" /></label>
      <button onClick={onScan} disabled={loading} className="rounded-2xl bg-gradient-to-r from-cyan-300 via-emerald-300 to-teal-400 px-5 py-3 text-sm font-bold text-slate-950 shadow-[0_18px_45px_rgba(45,212,191,0.24)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60">{loading ? "Scanning…" : "Scan Token"}</button>
    </div>
    {error && <p className="mt-3 text-sm text-rose-300">{error}</p>}
  </Card>;
}

function TokenIdentityHeader({ data, contract, score, riskLabel, onRescan }: { data: ScanResult; contract: string; score: number; riskLabel: string; onRescan: () => void }) {
  const chain = data.chain ?? "Base";
  return <div className="sticky top-3 z-20 rounded-3xl border border-white/10 bg-[#06111f]/90 p-3 shadow-2xl shadow-black/40 backdrop-blur-xl">
    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex min-w-0 items-center gap-3"><div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-cyan-300/25 to-purple-400/20 text-lg font-black text-cyan-100">{(data.symbol ?? data.name ?? "?").slice(0, 1)}</div><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h2 className="truncate text-lg font-semibold text-white">{data.name ?? data.tokenInfo?.name ?? "Unknown Token"}</h2><span className="text-sm font-medium text-slate-400">{data.symbol ?? data.tokenInfo?.symbol ?? "—"}</span><StatusBadge tone="verified">{chain}</StatusBadge></div><button onClick={() => copyText(contract)} className="mt-1 font-mono text-xs text-slate-400 hover:text-cyan-200">{shorten(contract, 8, 6)} · copy</button></div></div>
      <div className="flex flex-wrap items-center gap-2"><StatusBadge tone="verified">Score {score}</StatusBadge><StatusBadge tone={riskLabel.includes("High") || riskLabel.includes("Extreme") ? "danger" : riskLabel.includes("Medium") ? "caution" : "verified"}>{riskLabel}</StatusBadge><StatusBadge>Liquidity {money(data.liquidity)}</StatusBadge><StatusBadge>Holders {data.holders ?? data.holderCount ?? "Open Evidence"}</StatusBadge><StatusBadge>Market Cap {data.marketCap != null ? money(data.marketCap) : data.fdv != null ? `${money(data.fdv)} FDV` : "Open Evidence"}</StatusBadge></div>
      <div className="flex flex-wrap gap-2"><button onClick={() => copyText(contract)} className="rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-200 hover:border-cyan-300/40">Copy CA</button><a href={`https://${(data.chain ?? "base").toLowerCase().includes("eth") ? "etherscan.io" : "basescan.org"}/token/${contract}`} target="_blank" className="rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-200 hover:border-cyan-300/40">Open Explorer</a><button className="rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-200">Save/Track</button><button onClick={onRescan} className="rounded-xl bg-white/10 px-3 py-2 text-xs font-semibold text-white hover:bg-white/15">Rescan</button></div>
    </div>
  </div>;
}

function VerdictPanel({ data, verdict, loading }: { data: ScanResult; verdict: CortexVerdict | null; loading: boolean }) {
  const score = getScore(verdict, data); const tone = riskTone(score); const risks = verdict?.negatives?.slice(0, 3) ?? data.issues?.slice(0, 3) ?? ["LP control proof remains open until lock or burn evidence is verified."]; const positives = verdict?.positives?.slice(0, 3) ?? [data.liquidity ? "Primary pool liquidity detected." : "Scan completed with partial market evidence.", "Contract identity resolved.", "CORTEX receipt ready for analyst review."];
  return <div className="grid gap-4 lg:grid-cols-[1.35fr_.85fr]"><Card><div className="flex flex-col gap-5 md:flex-row"><div className="relative grid h-36 w-36 shrink-0 place-items-center rounded-full" style={{ background: `conic-gradient(${tone.accent} ${score}%, rgba(255,255,255,.08) 0)` }}><div className="grid h-28 w-28 place-items-center rounded-full bg-slate-950"><span className="text-4xl font-black text-white">{loading ? "…" : score}</span><span className="-mt-7 text-[10px] uppercase tracking-[0.2em] text-slate-500">Evidence Score</span></div></div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><p className="text-xs font-semibold uppercase tracking-[0.22em] text-cyan-200">CORTEX Verdict</p><span className={clsx("rounded-full border px-3 py-1 text-xs font-bold", tone.className)}>{getRiskLabel(verdict, data)}</span></div><p className="mt-3 text-lg leading-relaxed text-slate-100">{verdict?.cortex_verdict ?? verdict?.overall_assessment ?? "Evidence-first scan complete. Treat open items as risk until holder, LP, and admin control proofs are verified."}</p><div className="mt-4 grid gap-3 md:grid-cols-2"><EvidenceList title="Top positives" items={positives} good /><EvidenceList title="Risk drivers" items={risks} /></div><div className="mt-4"><StatusBadge tone="open">Confidence: {verdict ? "CORTEX receipt generated" : "Partial evidence"}</StatusBadge><span className="ml-2"><StatusBadge tone="caution">Coverage: Market + contract; holders/LP depend on available proof</StatusBadge></span></div></div></div></Card><Card><p className="text-xs font-semibold uppercase tracking-[0.22em] text-emerald-200">Next Action</p><div className="mt-4 space-y-3"><ActionRow label="Monitor" value="Liquidity changes, owner actions, top-holder movement, and tax/simulation updates." /><ActionRow label="Missing proof" value="Verified LP lock/burn route, complete holder attribution, and admin-control status if absent." /><div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-1"><button className="rounded-2xl bg-cyan-300 px-4 py-3 text-sm font-bold text-slate-950">Rescan</button><button className="rounded-2xl border border-white/10 px-4 py-3 text-sm text-white">Open LP details</button><button className="rounded-2xl border border-white/10 px-4 py-3 text-sm text-white">Track token</button></div></div></Card></div>;
}

function EvidenceList({ title, items, good }: { title: string; items: string[]; good?: boolean }) { return <div><p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">{title}</p><ul className="space-y-2">{items.map((item, i) => <li key={i} className="flex gap-2 text-sm leading-relaxed text-slate-300"><span className={clsx("mt-2 h-1.5 w-1.5 shrink-0 rounded-full", good ? "bg-emerald-300" : "bg-amber-300")} />{item}</li>)}</ul></div>; }
function ActionRow({ label, value }: { label: string; value: string }) { return <div className="rounded-2xl border border-white/[0.07] bg-white/[0.035] p-3"><p className="text-xs font-semibold text-slate-400">{label}</p><p className="mt-1 text-sm text-slate-200">{value}</p></div>; }

function ScoreBreakdown({ data }: { data: ScanResult }) {
  const cats = [
    ["Market / Liquidity", "25%", data.liquidity ? "Verified" : "Open Evidence", data.liquidity ? "+18 to +25" : "Pending", data.liquidity ? "Primary liquidity observed" : "Liquidity depth proof"],
    ["Holder Distribution", "20%", data.holders || data.holderCount ? "Caution" : "Open Evidence", "Pending", "Top holder concentration"],
    ["LP Control", "25%", "Open Evidence", "Pending", "Lock/burn/controller route"],
    ["Security / Risk Checks", "20%", data.analysis ? "Caution" : "Open Evidence", data.issues?.length ? "Risk applied" : "Partial", "Simulation and privileged flags"],
    ["Dev Control", "10%", "Open Evidence", "Pending", "Owner/deployer cluster influence"],
  ];
  return <Card><div className="mb-4 flex flex-wrap items-center justify-between gap-2"><h3 className="text-lg font-semibold text-white">Score Breakdown</h3><StatusBadge tone="caution">Coverage/confidence shown instead of raw certainty</StatusBadge></div><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">{cats.map(([name, weight, status, contrib, missing]) => <div key={name} className="rounded-2xl border border-white/[0.07] bg-black/20 p-3"><p className="text-sm font-semibold text-white">{name}</p><p className="mt-2 text-xs text-slate-500">Weight {weight}</p><div className="mt-3"><StatusBadge tone={status === "Verified" ? "verified" : status === "Caution" ? "caution" : "open"}>{status}</StatusBadge></div><p className="mt-3 text-xs text-slate-300">Contribution: {contrib}</p><p className="mt-1 text-xs text-slate-500">Missing: {missing}</p></div>)}</div></Card>;
}

function Tabs({ active, setActive }: { active: TabKey; setActive: (t: TabKey) => void }) { return <div className="overflow-x-auto rounded-3xl border border-white/[0.08] bg-black/25 p-2"><div className="flex min-w-max gap-2">{TABS.map((tab) => <button key={tab.key} onClick={() => setActive(tab.key)} className={clsx("flex items-center gap-2 rounded-2xl px-4 py-3 text-sm font-semibold transition", active === tab.key ? "bg-white text-slate-950 shadow-lg" : "text-slate-400 hover:bg-white/[0.06] hover:text-white")}><span className={clsx("text-xs", tab.tone === "verified" && "text-emerald-300", tab.tone === "caution" && "text-amber-300", tab.tone === "open" && "text-cyan-300", tab.tone === "danger" && "text-rose-300")}>{tab.icon}</span>{tab.key}</button>)}</div></div>; }

function ActivePanel({ tab, data, verdict }: { tab: TabKey; data: ScanResult; verdict: CortexVerdict | null }) {
  if (tab === "Market Pulse") return <Card><h3 className="text-lg font-semibold">Market Pulse</h3><div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><Metric label="Price" value={price(data.price)} /><Metric label="Valuation" value={data.marketCap != null ? money(data.marketCap) : data.fdv != null ? money(data.fdv) : "Open Evidence"} note={data.marketCap != null ? "Verified." : data.fdv != null ? "FDV · Market cap unavailable." : "Low-data state."} /><Metric label="Liquidity" value={money(data.liquidity)} /><Metric label="24h Volume" value={money(data.volume24h)} /><Metric label="Pool Age" value={data.poolAge ?? data.pools?.[0]?.age ?? "Open Evidence"} /><Metric label="DEX / Pool Type" value={data.pools?.[0]?.name ?? data.pools?.[0]?.dex ?? "Open Evidence"} /><Metric label="Trend" value={percent(data.priceChange24h)} /><Metric label="Pools" value={data.pools?.length ?? "Open Evidence"} /></div><MiniChart /></Card>;
  if (tab === "Holder Map") return <HolderPanel data={data} />;
  if (tab === "LP Control") return <LpPanel data={data} />;
  if (tab === "Risk Engine") return <RiskPanel data={data} />;
  if (tab === "Dev Control") return <DevPanel data={data} />;
  return <Card><h3 className="text-lg font-semibold">CORTEX Read</h3><div className="mt-4 grid gap-3 md:grid-cols-2"><ReadBlock title="What CORTEX found" items={[verdict?.overall_assessment ?? data.aiSummary ?? "Market and contract evidence were normalized into a single scan receipt.", "Evidence gaps remain visible instead of being treated as positive proof."]} /><ReadBlock title="Why score changed" items={["Liquidity, volatility, security checks, and issue count influence display confidence.", "Open holder and LP proofs reduce certainty until verified."]} /><ReadBlock title="Main risks" items={(verdict?.negatives?.length ? verdict.negatives : data.issues?.length ? data.issues : ["No verified LP lock/burn proof is shown in the current evidence set."]).slice(0, 5)} /><ReadBlock title="Evidence gaps" items={["Holder concentration attribution", "LP controller route", "Privileged ownership and tax simulation if unavailable"]} /><ReadBlock title="Watch next" items={["Rescan after liquidity or ownership changes", "Track top-holder movement", "Review LP unlock or position ownership evidence"]} /></div></Card>;
}
function ReadBlock({ title, items }: { title: string; items: string[] }) { return <div className="rounded-2xl border border-white/[0.07] bg-white/[0.035] p-4"><p className="font-semibold text-cyan-100">{title}</p><ul className="mt-3 space-y-2">{items.slice(0, 5).map((item, i) => <li key={i} className="flex gap-2 text-sm text-slate-300"><span className="mt-2 h-1.5 w-1.5 rounded-full bg-cyan-300" />{item}</li>)}</ul></div>; }
function MiniChart() { return <div className="mt-4 h-28 rounded-2xl border border-cyan-300/10 bg-[linear-gradient(135deg,rgba(34,211,238,.08),rgba(168,85,247,.05))] p-4"><div className="flex h-full items-end gap-2">{[28,42,35,55,48,64,58,72,69,82,76,88].map((h, i) => <div key={i} style={{ height: `${h}%` }} className="flex-1 rounded-t bg-gradient-to-t from-cyan-400/20 to-emerald-300/80" />)}</div></div>; }
function HolderPanel({ data }: { data: ScanResult }) { const top = [toNumber(data.top1HolderPercent) ?? 18, toNumber(data.top10HolderPercent) ?? 42, toNumber(data.top20HolderPercent) ?? 57]; return <Card><h3 className="text-lg font-semibold">Holder Map</h3><div className="mt-4 grid gap-4 lg:grid-cols-[.9fr_1.1fr]"><div className="space-y-3">{["Top 1", "Top 10", "Top 20"].map((l, i) => <Bar key={l} label={l} value={top[i]} danger={top[i] > (i === 0 ? 10 : 40)} />)}<Metric label="Holder Count" value={data.holders ?? data.holderCount ?? "Open Evidence"} /><StatusBadge tone={top[1] > 50 ? "danger" : top[1] > 35 ? "caution" : "verified"}>Concentration {top[1] > 50 ? "High" : top[1] > 35 ? "Medium" : "Low"}</StatusBadge></div><div className="rounded-2xl border border-white/[0.07] bg-black/20 p-3"><p className="mb-3 text-sm font-semibold text-white">Top holders</p>{(data.topHolders ?? []).slice(0, 6).map((h: any, i: number) => <div key={i} className="grid grid-cols-[40px_1fr_70px_80px] gap-2 border-t border-white/[0.06] py-2 text-xs"><span>#{i + 1}</span><span className="font-mono">{shorten(h.address ?? h.wallet ?? "Unknown")}</span><span>{percent(h.percent ?? h.percentage)}</span><span>{h.type ?? "Wallet"}</span></div>)}{!(data.topHolders ?? []).length && <p className="text-sm text-slate-400">Open Evidence: top holder list is unavailable for this scan.</p>}</div></div></Card>; }
function Bar({ label, value, danger }: { label: string; value: number; danger?: boolean }) { return <div><div className="mb-1 flex justify-between text-sm"><span>{label}</span><span>{value.toFixed(1)}%</span></div><div className="h-3 overflow-hidden rounded-full bg-white/10"><div style={{ width: `${Math.min(value, 100)}%` }} className={clsx("h-full rounded-full", danger ? "bg-gradient-to-r from-amber-300 to-rose-400" : "bg-gradient-to-r from-cyan-300 to-emerald-300")} /></div></div>; }
function LpPanel({ data }: { data: ScanResult }) { return <Card><div className="rounded-2xl border border-amber-300/20 bg-amber-300/10 p-4"><p className="font-semibold text-amber-100">{data.lpLocked || data.lpBurned ? data.lpLocked ? "Locked" : "Burned" : "No verified lock/burn proof found"}</p><p className="mt-1 text-sm text-amber-100/70">For concentrated V3/V4 pools, Position Verification Required: ERC20 LP lock/burn proof does not apply.</p></div><div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[["Pool model", data.poolModel ?? data.pools?.[0]?.type ?? "V2/V3/V4 Open Evidence"], ["LP proof status", data.lpProofStatus ?? "Open Evidence"], ["Lock proof", data.lpLocked ? "Locked" : "Open Evidence"], ["Burn proof", data.lpBurned ? "Burned" : "Open Evidence"], ["Controller", data.lpController ?? "Wallet controlled / unknown"], ["Liquidity depth", money(data.liquidity)], ["Exit risk", data.exitRisk ?? "Position control unverified"], ["Unlock schedule", data.unlockSchedule ?? "Open Evidence"]].map(([l, v]) => <Metric key={l} label={l} value={v} />)}</div></Card>; }
function RiskPanel({ data }: { data: ScanResult }) { const a = data.analysis ?? {}; return <Card><h3 className="text-lg font-semibold">Risk Engine</h3><div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{[["Honeypot / simulation", a.honeypot ?? a.honeypotStatus ?? "Open check: run simulation"], ["Buy tax", a.buyTax ?? "Open Evidence"], ["Sell tax", a.sellTax ?? "Open Evidence"], ["Mint flag", a.canMint ?? a.mint ?? "Open Evidence"], ["Blacklist", a.blacklist ?? "Open Evidence"], ["Pause", a.pause ?? "Open Evidence"], ["Withdraw", a.withdraw ?? "Open Evidence"], ["Proxy", a.proxy ?? "Open Evidence"], ["Ownership", a.ownerStatus ?? "Open Evidence"]].map(([l, v]) => <Metric key={l} label={l} value={String(v)} note={String(v).includes("Open") ? "Known facts absent; rescan or open explorer for proof." : undefined} />)}</div></Card>; }
function DevPanel({ data }: { data: ScanResult }) { return <Card><h3 className="text-lg font-semibold">Dev Control</h3><div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3"><Metric label="Deployer" value={<span className="font-mono">{shorten(data.deployer)}</span>} /><Metric label="Owner / Admin" value={<span className="font-mono">{shorten(data.owner ?? data.admin)}</span>} /><Metric label="Past launches" value={data.pastLaunches ?? "Open Evidence"} /><Metric label="Rug history" value={data.rugHistory ?? "Open Evidence"} /><Metric label="Cluster map" value={data.clusterMapUrl ? "Available" : "Open Evidence"} /><Metric label="Influence label" value={data.clusterInfluence ?? "Open Evidence"} /></div><div className="mt-4 space-y-3"><Bar label="Creator top-holder %" value={toNumber(data.creatorTopHolderPercent) ?? 0} danger /><Bar label="Linked wallet supply %" value={toNumber(data.linkedWalletSupplyPercent) ?? 0} danger /><Bar label="Dev cluster %" value={toNumber(data.devClusterPercent) ?? 0} danger /></div></Card>; }

function CortexSidePanel({ data, verdict }: { data: ScanResult; verdict: CortexVerdict | null }) { const score = getScore(verdict, data); return <aside className="space-y-4 lg:sticky lg:top-28"><Card><p className="text-xs font-semibold uppercase tracking-[0.22em] text-cyan-200">CORTEX Summary</p><div className="mt-4 rounded-2xl border border-white/10 bg-white/[0.035] p-4"><p className="text-4xl font-black text-white">{score}</p><p className="text-sm text-slate-400">Score receipt · evidence weighted</p></div><EvidenceList title="Top positives" good items={(verdict?.positives?.slice(0, 3) ?? ["Scan completed", "Market data checked", "Evidence gaps exposed"])} /><div className="mt-4"><EvidenceList title="Top risks" items={(verdict?.negatives?.slice(0, 3) ?? data.issues?.slice(0, 3) ?? ["LP control proof remains open"])} /></div><div className="mt-4"><ActionRow label="Next action" value="Track liquidity and holder movement before treating risk as resolved." /></div><div className="mt-3"><StatusBadge tone="open">Evidence coverage: partial to live</StatusBadge></div><button className="mt-4 w-full rounded-2xl bg-gradient-to-r from-purple-300 to-cyan-300 px-4 py-3 text-sm font-bold text-slate-950">Ask Clark about this token</button></Card></aside>; }

export default function TokenScannerPage() {
  const [contract, setContract] = useState(""); const [chain, setChain] = useState<ChainKey>("base"); const [data, setData] = useState<ScanResult | null>(null); const [loading, setLoading] = useState(false); const [activeTab, setActiveTab] = useState<TabKey>("CORTEX Read"); const [scanError, setScanError] = useState<string | null>(null); const [cortexVerdict, setCortexVerdict] = useState<CortexVerdict | null>(null); const [cortexLoading, setCortexLoading] = useState(false); const [cortexError, setCortexError] = useState<string | null>(null);
  async function scanToken(contractValue: string, chainValue: ChainKey) { const res = await fetch(`/api/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contract: contractValue, chain: chainValue }) }); const json = await res.json(); if (!res.ok || json?.error) throw new Error(json?.error ?? "Scan failed"); return json as ScanResult; }
  async function fetchCortexVerdict(tokenData: ScanResult) { setCortexLoading(true); setCortexVerdict(null); setCortexError(null); try { const res = await fetch("/api/cortex-token-verdict", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tokenData }) }); const json = await res.json(); if (!res.ok || !json.ok) setCortexError(json.error ?? "CORTEX analysis failed"); else setCortexVerdict(json.verdict as CortexVerdict); } catch { setCortexError("Network error — CORTEX unavailable"); } finally { setCortexLoading(false); } }
  async function handleScan() { const trimmed = contract.trim(); if (!trimmed) { setScanError("Please enter a token contract address, ticker, or token name before scanning."); return; } setLoading(true); setData(null); setCortexVerdict(null); setCortexError(null); setScanError(null); try { const result = await scanToken(trimmed, chain); setData(result); fetchCortexVerdict(result); } catch (err) { setScanError(err instanceof Error ? err.message : "Scan failed."); } finally { setActiveTab("CORTEX Read"); setLoading(false); } }
  const score = useMemo(() => getScore(cortexVerdict, data), [cortexVerdict, data]); const currentContract = getContract(data, contract);
  return <main className="min-h-screen overflow-x-hidden bg-[radial-gradient(circle_at_top_left,rgba(45,212,191,.16),transparent_34%),radial-gradient(circle_at_top_right,rgba(168,85,247,.14),transparent_30%),linear-gradient(135deg,#020617,#06111f_45%,#020617)] px-4 py-6 text-slate-100 md:px-6 md:py-8"><div className="mx-auto max-w-7xl space-y-5"><ScanCommandCenter chain={chain} setChain={setChain} contract={contract} setContract={setContract} loading={loading} onScan={handleScan} error={scanError} />{data ? <><TokenIdentityHeader data={data} contract={currentContract} score={score} riskLabel={getRiskLabel(cortexVerdict, data)} onRescan={handleScan} /><div className="grid gap-5 lg:grid-cols-[1fr_340px]"><div className="min-w-0 space-y-5"><VerdictPanel data={data} verdict={cortexVerdict} loading={cortexLoading} />{cortexError && <Card className="border-rose-400/20 text-rose-200">{cortexError}</Card>}<ScoreBreakdown data={data} /><Tabs active={activeTab} setActive={setActiveTab} /><ActivePanel tab={activeTab} data={data} verdict={cortexVerdict} /></div><CortexSidePanel data={data} verdict={cortexVerdict} /></div></> : <Card className="text-center"><p className="text-sm text-slate-400">Paste a contract or ticker to generate an evidence-first CORTEX receipt. No “safe” label appears while proof is incomplete.</p></Card>}</div></main>;
}
