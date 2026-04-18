"use client";

import { useState } from "react";

export default function TokenScanner() {
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);

  const scanToken = async () => {
    setLoading(true);
    setResult(null);

    try {
      const res = await fetch(`/api/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contract: token }),
      });

      const data = await res.json();
      setResult(data);
    } catch (err) {
      setResult({ error: "Something went wrong" });
    }

    setLoading(false);
  };

  return (
    <div className="p-10">
      <h1 className="text-3xl font-bold mb-6">Token Scanner</h1>

      <input
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder="Enter token contract address"
        className="w-full p-3 rounded-lg bg-white/5 border border-white/10 mb-4"
      />

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
              {result.gtPools?.[0]?.attributes?.base_token_price_usd
                ? `$${Number(result.gtPools[0].attributes.base_token_price_usd).toFixed(6)}`
                : "N/A"}
            </p>
          </div>

          <div className="p-6 bg-white/5 border border-white/10 rounded-xl">
            <p className="text-white/60 text-sm">Liquidity (top pool)</p>
            <p className="text-2xl font-bold">
              {result.liquidity
                ? `$${Number(result.liquidity).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                : "N/A"}
            </p>
          </div>

          {result.aiSummary && (
            <div className="p-6 bg-white/5 border border-white/10 rounded-xl">
              <p className="text-white/60 text-sm mb-2">AI Summary</p>
              <p className="text-white/80 text-sm leading-relaxed">{result.aiSummary}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
