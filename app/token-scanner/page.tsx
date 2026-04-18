"use client";

import { useState } from "react";
import clsx from "clsx";
import CortexVerdictCard from "@/components/CortexVerdictCard";
import type { CortexVerdict } from "@/app/api/cortex-token-verdict/route";


function shorten(str: string, start = 6, end = 4): string {
  if (str.length <= start + end) return str;
  return `${str.slice(0, start)}...${str.slice(-end)}`;
}


type ScanResult = {
  name?: string;
  symbol?: string;
  contract?: string;
  chain?: string;
  price?: number | null;
  liquidity?: number | null;
  volume24h?: number | null;
  priceChange24h?: number | null;
  pools?: Array<{
    name?: string;
    address?: string;
    price?: number | null;
    liquidity?: number | null;
    volume24h?: number | null;
    priceChange24h?: number | null;
  }>;
  // retained for AI Summary / Issues tabs
  analysis?: any;
  issues?: string[];
  aiSummary?: string;
  decimals?: number;
  tokenInfo?: {
    name?: string;
    symbol?: string;
    decimals?: number;
  };
};

const TABS = ["Overview", "Market", "Contract", "AI Summary", "Raw Data"] as const;
type TabKey = (typeof TABS)[number];


function IssuesCard({ issues }: { issues?: string[] }) {
  if (!issues || issues.length === 0) return null;


  return (
    <div className="rounded-2xl border border-red-500/20 bg-red-500/5 p-4 backdrop-blur">
      <h3 className="mb-3 text-sm font-medium text-red-200">Issues Detected</h3>
      <ul className="space-y-2">
        {issues.map((issue, i) => (
          <li key={i} className="text-xs text-red-100/80 flex items-start gap-2">
            <span className="mt-1 inline-block h-1 w-1 rounded-full bg-red-400 flex-shrink-0" />
            {issue}
          </li>
        ))}
      </ul>
    </div>
  );
}


function getRiskLevel(data?: ScanResult | null): "low" | "medium" | "high" | null {
  if (!data || !data.issues) return null;
  if (data.issues.length >= 3) return "high";
  if (data.issues.length >= 1) return "medium";
  return "low";
}


function getChainBadge(chain?: string) {
  if (!chain) return null;
  const colors: Record<string, { bg: string; text: string }> = {
    ethereum: { bg: "bg-blue-500/10", text: "text-blue-200" },
    polygon: { bg: "bg-purple-500/10", text: "text-purple-200" },
    solana: { bg: "bg-green-500/10", text: "text-green-200" },
  };
  const style = colors[chain.toLowerCase()] || { bg: "bg-neutral-500/10", text: "text-neutral-200" };
  return (
    <span className={`rounded-full border border-white/20 ${style.bg} px-3 py-1 text-xs font-medium ${style.text}`}>
      {chain}
    </span>
  );
}


function RiskPill({ level }: { level: "low" | "medium" | "high" }) {
  const colors = {
    low: { bg: "bg-green-500/10", border: "border-green-500/30", text: "text-green-200" },
    medium: { bg: "bg-yellow-500/10", border: "border-yellow-500/30", text: "text-yellow-200" },
    high: { bg: "bg-red-500/10", border: "border-red-500/30", text: "text-red-200" },
  };
  const style = colors[level];
  return (
    <div className={`rounded-full border ${style.border} ${style.bg} px-4 py-2 text-sm font-medium ${style.text}`}>
      Risk: {level.charAt(0).toUpperCase() + level.slice(1)}
    </div>
  );
}


function SideMetaCard({ data }: { data?: ScanResult }) {
  if (!data) return null;


  return (
    <div className="rounded-2xl border border-white/10 bg-black/40 p-4 backdrop-blur">
      <h3 className="mb-3 text-sm font-medium text-neutral-200">Token Info</h3>
      <div className="space-y-3">
        {data.name && (
          <div>
            <p className="text-xs text-neutral-400">Name</p>
            <p className="text-sm font-medium text-neutral-100">{data.name}</p>
          </div>
        )}
        {data.symbol && (
          <div>
            <p className="text-xs text-neutral-400">Symbol</p>
            <p className="text-sm font-medium text-neutral-100">{data.symbol}</p>
          </div>
        )}
        {data.decimals !== undefined && (
          <div>
            <p className="text-xs text-neutral-400">Decimals</p>
            <p className="text-sm font-medium text-neutral-100">{data.decimals}</p>
          </div>
        )}
      </div>
    </div>
  );
}


function OverviewPanel({ data }: { data: ScanResult }) {
  const name = data.name ?? "Unknown";
  const symbol = data.symbol ?? "?";
  const decimals = data.decimals ?? "?";
  const poolsCount = data.pools?.length ?? 0;


  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-white/5 bg-black/40 p-4 backdrop-blur">
        <h2 className="text-sm font-semibold text-neutral-100">Token overview</h2>
        <div className="mt-4 grid gap-3 text-sm md:grid-cols-2">
          <InfoRow label="Name" value={name} />
          <InfoRow label="Symbol" value={symbol} />
          <InfoRow label="Decimals" value={String(decimals)} />
          <InfoRow label="Pools (GeckoTerminal)" value={String(poolsCount)} />
        </div>
      </div>
    </div>
  );
}


function formatNumber(value: number | string): string {
  const num = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(num)) return "Unknown";


  if (num >= 1_000_000_000) return `$${(num / 1_000_000_000).toFixed(2)}B`;
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(2)}K`;
  return `$${num.toFixed(2)}`;
}


function formatPrice(value: number | string): string {
  const num = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(num)) return "Unknown";


  if (num < 0.0001) {
    return num.toExponential(2);
  }
  return `$${num.toFixed(6)}`;
}


function MarketPanel({ data }: { data: ScanResult }) {
  const pools    = data.pools ?? [];
  const mainPool = pools[0] ?? null;

  const price     = data.price;
  const liquidity = data.liquidity;
  const volume24h = data.volume24h;
  const change24h = data.priceChange24h;
  const poolName  = mainPool?.name ?? "Unknown";

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-4">
        <h2 className="text-sm font-semibold text-neutral-100">Market snapshot</h2>
        <div className="mt-4 grid gap-3 text-sm md:grid-cols-2">
          <InfoRow label="Price"           value={price     != null ? formatPrice(price)        : "Unknown"} />
          <InfoRow label="Liquidity (USD)" value={liquidity != null ? formatNumber(liquidity)   : "Unknown"} />
          <InfoRow label="Volume 24h"      value={volume24h != null ? formatNumber(volume24h)   : "Unknown"} />
          <InfoRow label="24h Change"      value={change24h != null ? `${change24h.toFixed(2)}%` : "Unknown"} />
          <InfoRow label="Top Pool"        value={poolName} />
          <InfoRow label="Pools tracked"   value={String(pools.length)} />
        </div>
      </div>
      <CodeBlock title="Pools" payload={data.pools} />
    </div>
  );
}


function ContractPanel({ data }: { data: ScanResult }) {
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-sky-500/30 bg-sky-500/5 p-4">
        <h2 className="text-sm font-semibold text-neutral-100">Contract analysis</h2>
      </div>
      <CodeBlock title="Analysis" payload={data.analysis} />
    </div>
  );
}


function AISummaryPanel({ data }: { data: ScanResult }) {
  const analysis = data.analysis;
  const tokenInfo = data.tokenInfo;

  return (
    <div className="space-y-4">
      {/* Cortex Engine narrative */}
      {data.aiSummary && (
        <div className="animate-fadeIn animate-pulseGlow rounded-2xl border border-purple-500/30 bg-purple-500/5 p-4">
          <h2 className="text-sm font-semibold text-transparent bg-clip-text bg-gradient-to-r from-purple-400 via-pink-400 to-fuchsia-500">
            🧠 Cortex Engine
          </h2>
          <p className="mt-2 text-sm text-neutral-200">{data.aiSummary}</p>
        </div>
      )}

      {/* Structured contract analysis */}
      {analysis && (
        <div className="rounded-2xl border border-fuchsia-500/30 bg-fuchsia-500/5 p-4">
          <h2 className="text-sm font-semibold text-neutral-100">AI Summary</h2>
          <div className="mt-3 space-y-2 text-sm text-neutral-200">
            <p>🔑 <strong>Owner Status:</strong> {analysis.ownerStatus ?? "Unknown"}</p>
            <p>💧 <strong>Liquidity:</strong> {analysis.liquidityStatus ?? "Unknown"}</p>
            <p>🚫 <strong>Honeypot Check:</strong> {analysis.honeypot ?? "Unknown"}</p>
            <p>
              ⚠️ <strong>Suspicious Functions:</strong>{" "}
              {!analysis.suspiciousFunctions?.length
                ? "None detected"
                : analysis.suspiciousFunctions.join(", ")}
            </p>
            <p>🏷️ <strong>Token Name:</strong> {tokenInfo?.name}</p>
            <p>🔣 <strong>Symbol:</strong> {tokenInfo?.symbol}</p>
            <p>🔢 <strong>Decimals:</strong> {tokenInfo?.decimals}</p>
          </div>
        </div>
      )}
    </div>
  );
}


// ------------------------------
// Main Page Component
// ------------------------------
function RawDataPanel({ data }: { data: ScanResult }) {
  return (
    <div className="space-y-4">
      <CodeBlock title="All data" payload={data} />
    </div>
  );
}

export default function TokenScannerPage() {
  const [contract, setContract] = useState("");
  const [data, setData] = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>("Overview");

  const [cortexVerdict, setCortexVerdict] = useState<CortexVerdict | null>(null);
  const [cortexLoading, setCortexLoading] = useState(false);
  const [cortexError, setCortexError] = useState<string | null>(null);

  async function scanToken(contract: string) {
    try {
      const res = await fetch(`/api/scan-token?query=${encodeURIComponent(contract)}`, {
        method: "GET",
      });
      if (!res.ok) return null;
      const json = await res.json();
      return (json.ok ? json.data : null) as ScanResult | null;
    } catch (err) {
      console.error("Frontend scan error:", err);
      return null;
    }
  }

  async function fetchCortexVerdict(tokenData: ScanResult) {
    setCortexLoading(true);
    setCortexVerdict(null);
    setCortexError(null);
    try {
      const res = await fetch("/api/cortex-token-verdict", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokenData }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setCortexError(json.error ?? "CORTEX analysis failed");
      } else {
        setCortexVerdict(json.verdict as CortexVerdict);
      }
    } catch {
      setCortexError("Network error — CORTEX unavailable");
    } finally {
      setCortexLoading(false);
    }
  }

  async function handleScan() {
    if (!contract) return;
    setLoading(true);
    setData(null);
    setCortexVerdict(null);
    setCortexError(null);
    const result = await scanToken(contract);
    setData(result);
    setActiveTab("Overview");
    setLoading(false);
    if (result) {
      fetchCortexVerdict(result);
    }
  }

  const riskLevel = getRiskLevel(data);
  const chainBadge = getChainBadge(data?.chain);

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#050510] via-[#050712] to-[#050510] text-neutral-100">
      <div className="max-w-5xl mx-auto px-4 py-8">
        {/* Header */}
        <header className="flex flex-col gap-3 mb-8 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-purple-500/40 bg-purple-500/10 px-3 py-1 text-xs font-medium text-purple-200">
              <span className="h-1.5 w-1.5 rounded-full bg-purple-400 shadow-[0_0_10px_rgba(216,180,254,0.8)]" />
              ChainLens AI · Token Scanner Elite
            </div>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
              Token Scanner Elite
            </h1>
          </div>
          {riskLevel && <RiskPill level={riskLevel} />}
        </header>

        {/* Input + button */}
        <div className="mb-6 flex gap-4">
          <input
            type="text"
            placeholder="0x..."
            value={contract}
            onChange={(e) => setContract(e.target.value)}
            className="flex-1 rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none"
          />
          <button
            onClick={handleScan}
            disabled={loading}
            className={clsx(
              "inline-flex items-center justify-center rounded-xl px-4 py-2 text-sm font-medium transition",
              "bg-gradient-to-r from-purple-500 via-fuchsia-500 to-emerald-400 text-white shadow-[0_0_25px_rgba(168,85,247,0.7)]",
              "hover:shadow-[0_0_35px_rgba(168,85,247,0.9)] hover:brightness-110",
              loading && "opacity-60 cursor-not-allowed"
            )}
          >
            {loading ? "Scanning..." : "Scan Token"}
          </button>
        </div>

        {/* Tabs + Panels */}
        {data && (
          <div className="space-y-4">
            {/* Tabs */}
            <div className="flex flex-wrap gap-2 rounded-2xl border border-white/5 bg-black/40 p-2 backdrop-blur">
              {TABS.map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={clsx(
                    "px-3 py-1.5 text-xs font-medium rounded-xl transition",
                    activeTab === tab
                      ? "bg-gradient-to-r from-purple-500/80 to-emerald-400/80 text-white shadow-[0_0_18px_rgba(168,85,247,0.7)]"
                      : "text-neutral-400 hover:text-neutral-100 hover:bg-white/5"
                  )}
                >
                  {tab}
                </button>
              ))}
            </div>

            {/* Panels */}
            <div className="grid gap-4 md:grid-cols-3">
              {/* Left column */}
              <div className="md:col-span-2 space-y-4">
                {activeTab === "Overview" && <OverviewPanel data={data} />}
                {activeTab === "Market" && <MarketPanel data={data} />}
                {activeTab === "AI Summary" && <AISummaryPanel data={data} />}
                {activeTab === "Contract" && <ContractPanel data={data} />}
                {activeTab === "Raw Data" && <RawDataPanel data={data} />}
              </div>

              {/* Right column */}
              <div className="space-y-4">
                <SideMetaCard data={data} />
                <IssuesCard issues={data.issues} />
              </div>
            </div>
          </div>
        )}

        {/* CORTEX verdict — shown after any scan attempt */}
        {(cortexLoading || cortexVerdict || cortexError) && (
          <div className="mt-4">
            <CortexVerdictCard
              verdict={cortexVerdict}
              loading={cortexLoading}
              error={cortexError}
            />
          </div>
        )}

        {!data && !loading && (
          <p className="mt-10 text-center text-sm text-neutral-500">
            Paste a contract above and hit{" "}
            <span className="text-purple-300 font-medium">Scan Token</span> to see ChainLens AI in
            action.
          </p>
        )}
      </div>
    </div>
  );
}

/* ---------- UI helpers ---------- */
function InfoRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-neutral-400">{label}</span>
      <span className="font-mono text-neutral-100">{value}</span>
    </div>
  );
}

function CodeBlock({ title, payload }: { title: string; payload: any }) {
  return (
    <div className="rounded-2xl border border-white/5 bg-black/40 p-4 backdrop-blur">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-300 mb-2">{title}</h3>
      <pre className="text-xs text-neutral-400 overflow-auto max-h-64">
        {JSON.stringify(payload, null, 2)}
      </pre>
    </div>
  );
}
