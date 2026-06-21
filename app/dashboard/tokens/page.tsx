"use client";

import dynamic from "next/dynamic";
import { useCallback, useState } from "react";

import { addTrackedToken, canUseTrackedTokenStorage, saveTrackedTokenSymbol } from "@/utils/trackedTokens";

type TokenScanResult = {
  error?: string;
  status?: string;
  marketStatus?: string;
  symbol?: string;
  name?: string;
  priceUsd?: number | string | null;
  liquidityUsd?: number | string | null;
  marketCapUsd?: number | string | null;
  holderDistribution?: {
    topHolders?: unknown[];
  };
  aiSummary?: string;
};

const TrackedTokens = dynamic(() => import("./TrackedTokens"), {
  loading: () => <p className="mt-10 text-sm text-white/60">Loading tracked tokens…</p>,
  ssr: false,
});

function normalizeContract(contract: string): string {
  return contract.trim().toLowerCase();
}

export default function TokenScanner() {
  const [token, setToken] = useState("");
  const [chain, setChain] = useState<"base" | "eth">("base");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TokenScanResult | null>(null);
  const [trackedTokensRefreshKey, setTrackedTokensRefreshKey] = useState(0);
  const [trackedTokenStorageError, setTrackedTokenStorageError] = useState(false);
  const [symbolByContract, setSymbolByContract] = useState<Record<string, string>>({});

  const scanContract = useCallback(async (contractAddress: string) => {
    const contract = contractAddress.trim();
    if (!contract) {
      setResult({ error: "Please enter a token contract address before scanning." });
      return;
    }
    setLoading(true);
    setResult(null);
    setTrackedTokenStorageError(false);

    try {
      const res = await fetch(`/api/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contract, chain }),
      });

      const data = await res.json();
      if (process.env.NODE_ENV !== "production") console.log("[scanner] /api/token response", data);
      if (!res.ok || data?.error) {
        if (data?.status === "invalid_address") setResult({ error: data.error ?? "Invalid address format." });
        else if (data?.status === "wrong_chain" || data?.status === "chain_mismatch") setResult({ error: `Token not found on ${chain === "eth" ? "Ethereum" : "Base"}. Try switching chains.` });
        else if (data?.status === "no_pool_found" || data?.marketStatus === "no_pool_found") setResult({ error: `No active liquidity pools found on ${chain === "eth" ? "Ethereum" : "Base"} for this token.` });
        else setResult({ error: data?.error ?? "Couldn't resolve this token." });
        setLoading(false);
        return;
      }

      setResult(data);

      // PHASE-TS1-FIX: persist successful scans immediately without changing the scan payload/API shape.
      if (!canUseTrackedTokenStorage()) {
        setTrackedTokenStorageError(true);
      } else {
        addTrackedToken(contract);
        const normalizedContract = normalizeContract(contract);
        const symbol = typeof data?.symbol === "string" && data.symbol.trim() ? data.symbol.trim() : "Tracked Token";
        saveTrackedTokenSymbol(contract, symbol);
        setSymbolByContract((previousSymbols) => ({ ...previousSymbols, [normalizedContract]: symbol }));
        setTrackedTokensRefreshKey((key) => key + 1);
      }
    } catch {
      setResult({ error: "Something went wrong" });
    }

    setLoading(false);
  }, [chain]);

  const scanToken = () => scanContract(token);

  const scanTrackedTokenAgain = useCallback((contractAddress: string) => {
    setToken(contractAddress);
    void scanContract(contractAddress);
  }, [scanContract]);

  return (
    <div className="p-10">
      <h1 className="text-3xl font-bold mb-6">Token Scanner</h1>

      <input
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder="Enter token contract address"
        className="w-full p-3 rounded-lg bg-white/5 border border-white/10 mb-4"
      />
      <div className="mb-4 flex gap-2">
        {(["base", "eth"] as const).map((c) => (
          <button key={c} type="button" onClick={() => setChain(c)} className={`px-3 py-1 rounded-full border text-xs ${chain === c ? "border-cyan-300 text-cyan-300" : "border-white/20 text-white/70"}`}>
            {c.toUpperCase()}
          </button>
        ))}
      </div>

      <button
        onClick={scanToken}
        className="px-6 py-3 bg-blue-600 rounded-lg font-semibold"
      >
        Scan Token
      </button>

      {loading && (
        <p className="text-white/60 mt-4">Scanning token…</p>
      )}

      {result?.error && (
        <p className="text-red-400 mt-4">{result.error}</p>
      )}

      {trackedTokenStorageError && (
        <p className="text-red-300 mt-4">Could not load tracked tokens (storage unavailable).</p>
      )}

      {!loading && !result && (
        <p className="text-white/40 mt-4">No token scanned yet.</p>
      )}

      {result && !result.error && (
        <div className="space-y-6 mt-10">
          <div className="p-6 bg-white/5 border border-white/10 rounded-xl">
            <p className="text-white/60 text-sm">Token</p>
            <p className="text-2xl font-bold">{result.symbol}</p>
            <p className="text-white/60">{result.name}</p>
          </div>

          <div className="p-6 bg-white/5 border border-white/10 rounded-xl">
            <p className="text-white/60 text-sm">Price (top pool)</p>
            <p className="text-2xl font-bold">
              {result.priceUsd
                ? `$${Number(result.priceUsd).toFixed(6)}`
                : "N/A"}
            </p>
          </div>

          <div className="p-6 bg-white/5 border border-white/10 rounded-xl">
            <p className="text-white/60 text-sm">Liquidity (top pool)</p>
            <p className="text-2xl font-bold">
              {result.liquidityUsd
                ? `$${Number(result.liquidityUsd).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                : "N/A"}
            </p>
          </div>
          <div className="p-6 bg-white/5 border border-white/10 rounded-xl">
            <p className="text-white/60 text-sm">Market Cap</p>
            <p className="text-2xl font-bold">{result.marketCapUsd ? `$${Number(result.marketCapUsd).toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "N/A"}</p>
          </div>
          <div className="p-6 bg-white/5 border border-white/10 rounded-xl">
            <p className="text-white/60 text-sm">Top Holders</p>
            <p className="text-white/80 text-sm">{Array.isArray(result.holderDistribution?.topHolders) ? `${result.holderDistribution.topHolders.length} holders loaded` : "N/A"}</p>
          </div>

          {result.aiSummary && (
            <div className="p-6 bg-white/5 border border-white/10 rounded-xl">
              <p className="text-white/60 text-sm mb-2">AI Summary</p>
              <p className="text-white/80 text-sm leading-relaxed">{result.aiSummary}</p>
            </div>
          )}
        </div>
      )}

      <TrackedTokens
        refreshKey={trackedTokensRefreshKey}
        symbolByContract={symbolByContract}
        onScanAgain={scanTrackedTokenAgain}
      />
    </div>
  );
}
