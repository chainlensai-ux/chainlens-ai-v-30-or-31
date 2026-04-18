"use client";

import { useState } from "react";
import clsx from "clsx";


function shorten(str: string, start = 6, end = 4): string {
  if (str.length <= start + end) return str;
  return `${str.slice(0, start)}...${str.slice(-end)}`;
}


type ScanResult = {
  chain?: string;
  contract?: string;
  goldrush?: any;
  dexscreener?: any;
  gmgn?: any;
  analysis?: any;
  cortex?: any;
  issues?: string[];
  name?: string;
  symbol?: string;
  decimals?: number;
  aiSummary?: string; // correct field name
  pairs?: any[];
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
  const pairsCount = data.dexscreener?.pairs?.length ?? 0;


  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-white/5 bg-black/40 p-4 backdrop-blur">
        <h2 className="text-sm font-semibold text-neutral-100">Token overview</h2>
        <div className="mt-4 grid gap-3 text-sm md:grid-cols-2">
          <InfoRow label="Name" value={name} />
          <InfoRow label="Symbol" value={symbol} />
          <InfoRow label="Decimals" value={String(decimals)} />
          <InfoRow label="Pairs (DexScreener)" value={String(pairsCount)} />
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
  const pairs = data.pairs || [];


  const mainPair = pairs.reduce((best: any, p: any) => {
    if (!best) return p;
    return (p.liquidity?.usd || 0) > (best.liquidity?.usd || 0) ? p : best;
  }, null);


  const price = mainPair?.priceUsd ?? mainPair?.priceNative ?? "Unknown";
  const liquidity = mainPair?.liquidity?.usd ?? "Unknown";
  const volume24h = mainPair?.volume?.h24 ?? "Unknown";
  const buys24h = mainPair?.txns?.h24?.buys ?? 0;
  const sells24h = mainPair?.txns?.h24?.sells ?? 0;


  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-4">
        <h2 className="text-sm font-semibold text-neutral-100">Market snapshot</h2>
        <div className="mt-4 grid gap-3 text-sm md:grid-cols-2">
          <InfoRow label="Price" value={formatPrice(price)} />
          <InfoRow label="Liquidity (USD)" value={formatNumber(liquidity)} />
          <InfoRow label="Volume 24h" value={formatNumber(volume24h)} />
          <InfoRow label="24h Buys" value={String(buys24h)} />
          <InfoRow label="24h Sells" value={String(sells24h)} />
          <InfoRow label="Pairs tracked" value={String(pairs.length)} />
        </div>
      </div>
      <CodeBlock title="DexScreener raw" payload={data.dexscreener} />
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
      <div className="rounded-2xl border border-fuchsia-500/30 bg-fuchsia-500/5 p-4">
        <h2 className="text-sm font-semibold text-neutral-100">AI Summary</h2>
        <div className="mt-3 space-y-2 text-sm text-neutral-200">
          <p>🔑 <strong>Owner Status:</strong> {analysis.ownerStatus}</p>
          <p>💧 <strong>Liquidity:</strong> {analysis.liquidityStatus}</p>
          <p>🚫 <strong>Honeypot Check:</strong> {analysis.honeypot}</p>
          <p>
            ⚠️ <strong>Suspicious Functions:</strong>{" "}
            {analysis.suspiciousFunctions?.length === 0
              ? "None detected"
              : analysis.suspiciousFunctions.join(", ")}
          </p>
          <p>🏷️ <strong>Token Name:</strong> {tokenInfo?.name}</p>
          <p>🔣 <strong>Symbol:</strong> {tokenInfo?.symbol}</p>
          <p>🔢 <strong>Decimals:</strong> {tokenInfo?.decimals}</p>
        </div>
      </div>
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

  async function scanToken(contract: string) {
    try {
      const res = await fetch("/api/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contract }),
      });
      if (!res.ok) return null;
      return (await res.json()) as ScanResult;
    } catch (err) {
      console.error("Frontend scan error:", err);
      return null;
    }
  }

  async function handleScan() {
    if (!contract) return;
    setLoading(true);
    setData(null);
    const result = await scanToken(contract);
    setData(result);
    setActiveTab("Overview");
    setLoading(false);
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
            <p className="mt-2 max-w-xl text-sm text-neutral-400">
              Paste any contract — ChainLens AI detects the chain, pulls on‑chain + market data,
              analyzes the contract, and compresses everything into an AI‑powered summary.
            </p>
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
                {activeTab === "Contract" && (
                  <>
                    <AISummaryPanel data={data} />
                    <ContractPanel data={data} />
                  </>
                )}
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
