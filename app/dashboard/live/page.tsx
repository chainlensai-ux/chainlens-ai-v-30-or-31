"use client";

import { useEffect, useState } from "react";

export default function LiveFeed() {
  const [tokens, setTokens] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = async () => {
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL}/api/trending`);
      const data = await res.json();
      setTokens(data?.data || []);
    } catch (err) {
      console.error("Live feed error:", err);
    }
    setLoading(false);
  };

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="p-10">
      <h1 className="text-3xl font-bold mb-6">Live Feed</h1>

      {loading && (
        <p className="text-white/60">Loading live data…</p>
      )}

      <div className="space-y-4">
        {tokens.map((t: any, i: number) => (
          <div
            key={i}
            className="p-4 bg-white/5 border border-white/10 rounded-xl flex justify-between"
          >
            <div>
              <p className="text-lg font-semibold">{t.symbol}</p>
              <p className="text-white/60 text-sm">{t.name}</p>
            </div>

            <div className="text-right">
              <p className="font-semibold">
                {t.price != null ? `$${Number(t.price).toFixed(6)}` : "N/A"}
              </p>
              <p
                className={`text-sm ${
                  (t.change24h ?? 0) >= 0 ? "text-green-400" : "text-red-400"
                }`}
              >
                {t.change24h != null ? `${t.change24h.toFixed(2)}% (24h)` : "—"}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
