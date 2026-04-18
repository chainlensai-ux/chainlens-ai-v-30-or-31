"use client";

import { useState } from "react";

// 🔑 Chain ID mapping (kept for UI, though backend loops all chains)
const chainMap: Record<string, number> = {
  eth: 1,
  base: 8453,
  polygon: 137,
  bnb: 56,
  optimism: 10,
  arbitrum: 42161,
};

// 🖼️ Chain logos (place PNGs/SVGs in /public/logos)
const chainLogos: Record<string, string> = {
  Ethereum: "/logos/ethereum.png",
  Base: "/logos/base.png",
  Polygon: "/logos/polygon.png",
  "BNB Chain": "/logos/bnb.png",
  Optimism: "/logos/optimism.png",
  Arbitrum: "/logos/arbitrum.png",
};

export default function WalletAnalyzer() {
  const [address, setAddress] = useState("");
  const [chain, setChain] = useState("eth");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);

  const analyzeWallet = async () => {
    if (!address) {
      alert("Please enter a wallet address");
      return;
    }

    setLoading(true);

    try {
      // Backend already loops through all chains
      const res = await fetch("/api/wallet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address }),
      });

      const data = await res.json();
      setResult(data);
    } catch (err) {
      console.error(err);
      alert("Error analyzing wallet");
    }

    setLoading(false);
  };

  return (
    <div style={{ padding: "40px", maxWidth: "700px", margin: "0 auto" }}>
      <h1 style={{ fontSize: "28px", marginBottom: "20px" }}>
        Multi‑Chain Wallet Analyzer
      </h1>

      {/* Wallet input */}
      <input
        type="text"
        placeholder="Enter wallet address"
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        style={{
          width: "100%",
          padding: "12px",
          marginBottom: "15px",
          borderRadius: "8px",
          border: "1px solid #ccc",
        }}
      />

      {/* Chain selector (kept for UI, even though backend loops all chains) */}
      <select
        value={chain}
        onChange={(e) => setChain(e.target.value)}
        style={{
          width: "100%",
          padding: "12px",
          marginBottom: "15px",
          borderRadius: "8px",
          border: "1px solid #ccc",
        }}
      >
        <option value="eth">Ethereum</option>
        <option value="base">Base</option>
        <option value="polygon">Polygon</option>
        <option value="bnb">BNB</option>
        <option value="optimism">Optimism</option>
        <option value="arbitrum">Arbitrum</option>
      </select>

      {/* Analyze button */}
      <button
        onClick={analyzeWallet}
        disabled={loading}
        style={{
          width: "100%",
          padding: "14px",
          background: "#6a5acd",
          color: "white",
          borderRadius: "8px",
          border: "none",
          cursor: "pointer",
          fontSize: "16px",
        }}
      >
        {loading ? "Analyzing..." : "Analyze Wallet"}
      </button>

      {/* Results */}
      {result && result.results && (
        <div style={{ marginTop: "30px" }}>
          {Object.keys(result.results).map((key) => {
            const chainData = result.results[key];
            return (
              <div
                key={key}
                style={{
                  background: "rgba(255,255,255,0.05)",
                  backdropFilter: "blur(10px)",
                  borderRadius: "12px",
                  padding: "20px",
                  marginBottom: "20px",
                }}
              >
                <h2>
                  {chainLogos[chainData.chain] && (
                    <img
                      src={chainLogos[chainData.chain]}
                      alt={chainData.chain}
                      style={{
                        width: "20px",
                        verticalAlign: "middle",
                        marginRight: "8px",
                      }}
                    />
                  )}
                  {chainData.chain}
                </h2>
                <p>
                  <strong>Native Balance:</strong>{" "}
                  {Number(chainData.nativeBalance).toFixed(3)}{" "}
                  {chainData.nativeSymbol}
                </p>

                <h3>Recent Transactions</h3>
                {chainData.transactions.length > 0 ? (
                  <ul style={{ listStyle: "none", padding: 0 }}>
                    {chainData.transactions.slice(0, 5).map((tx: any, i: number) => (
                      <li
                        key={i}
                        style={{
                          background: "#222",
                          color: "#0f0",
                          padding: "10px",
                          borderRadius: "8px",
                          marginBottom: "8px",
                        }}
                      >
                        <strong>{tx.tx_hash?.slice(0, 10)}...</strong> from{" "}
                        {tx.from_address?.slice(0, 6)}... to{" "}
                        {tx.to_address?.slice(0, 6)}... value:{" "}
                        {(Number(tx.value) / 1e18).toFixed(4)}{" "}
                        {chainData.nativeSymbol}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>No transactions found</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
