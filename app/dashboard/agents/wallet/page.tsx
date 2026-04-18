"use client";

import { useState } from "react";

export default function WalletAgent() {
  const [address, setAddress] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  const analyzeWallet = async () => {
    setLoading(true);
    setResult(null);

    const res = await fetch("/api/wallet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address }),
    });

    const data = await res.json();
    setResult(data);
    setLoading(false);
  };

  return (
    <div className="p-10 space-y-6">
      <h1 className="text-3xl font-bold">Wallet Analyzer</h1>

      <input
        type="text"
        placeholder="Enter wallet address..."
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        className="w-full p-3 rounded bg-black/40 border border-white/10 text-white"
      />

      <button
        onClick={analyzeWallet}
        disabled={loading}
        className="px-6 py-3 rounded bg-purple-600 hover:bg-purple-700 transition"
      >
        {loading ? "Analyzing..." : "Analyze Wallet"}
      </button>

      {result && (
        <div className="p-6 rounded bg-black/30 border border-white/10">
          <pre className="whitespace-pre-wrap text-white/80">
            {JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
