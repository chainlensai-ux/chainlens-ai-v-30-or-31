// app/components/Balances.tsx
"use client";

import { useEffect, useState } from "react";

type Token = {
  name: string;
  symbol: string;
  balance: number;
  logo: string;
};

export default function Balances({ address }: { address: string }) {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchBalances() {
      try {
        const res = await fetch(
          `/api/proxy/goldrush?path=v1/1/address/${address}/balances_v2/`
        );
        const json = await res.json();

        if (json.ok) {
          const items = json.data.data.items.map((token: any) => ({
            name: token.contract_name,
            symbol: token.contract_ticker_symbol,
            balance:
              Number(token.balance) / 10 ** token.contract_decimals,
            logo: token.logo_url,
          }));
          setTokens(items);
        }
      } catch (err) {
        console.error("Error fetching balances:", err);
      } finally {
        setLoading(false);
      }
    }
    fetchBalances();
  }, [address]);

  if (loading) return <p>Loading balances...</p>;

  return (
    <div className="grid grid-cols-2 gap-4 p-4">
      {tokens.map((t, i) => (
        <div
          key={i}
          className="rounded-xl bg-white/10 backdrop-blur-md shadow-lg p-4 hover:shadow-neon transition"
        >
          <div className="flex items-center gap-2">
            <img src={t.logo} alt={t.name} width={24} />
            <h3 className="font-bold">{t.name}</h3>
          </div>
          <p>
            {t.symbol}: {t.balance}
          </p>
        </div>
      ))}
    </div>
  );
}
