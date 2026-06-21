"use client";

// @ts-expect-error -- Project must use the Supabase auth helpers client here; dependency is provided by the app runtime.
import { createClient } from "@supabase/auth-helpers-nextjs";
import { useEffect, useState } from "react";

type TrackedTokensProps = {
  refreshKey: number;
  symbolByContract: Record<string, string>;
  onScanAgain: (contractAddress: string) => void;
};

type WatchlistToken = {
  id?: string | number;
  user_id?: string;
  symbol?: string | null;
  contract_address?: string | null;
  contract?: string | null;
  address?: string | null;
  token_address?: string | null;
  name?: string | null;
};

function getTokenAddress(token: WatchlistToken): string {
  return token.contract_address || token.contract || token.address || token.token_address || "";
}

function getTokenSymbol(token: WatchlistToken, symbolByContract: Record<string, string>): string {
  const address = getTokenAddress(token);
  return token.symbol || (address ? symbolByContract[address] : undefined) || token.name || "Tracked Token";
}

function shortenContract(contract: string): string {
  if (contract.length <= 14) return contract;
  return `${contract.slice(0, 8)}…${contract.slice(-6)}`;
}

export default function TrackedTokens({ refreshKey, symbolByContract, onScanAgain }: TrackedTokensProps) {
  const [supabase] = useState(() => createClient());
  const [mounted, setMounted] = useState(false);
  const [tokens, setTokens] = useState<WatchlistToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- Required to render nothing until the client has mounted.
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!mounted) return;

    let cancelled = false;

    async function loadTrackedTokens() {
      setLoading(true);
      setError(null);

      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();

        if (cancelled) return;

        if (!session) {
          setTokens([]);
          setLoading(false);
          return;
        }

        const { data, error: queryError } = await supabase
          .from("watchlist_tokens")
          .select("*")
          .eq("user_id", session.user.id);

        if (cancelled) return;

        if (queryError) {
          console.error("Failed to load tracked tokens", queryError);
          setTokens([]);
          setError("Could not load tracked tokens.");
        } else {
          setTokens(data ?? []);
        }
      } catch (loadError) {
        if (!cancelled) {
          console.error("Failed to load tracked tokens", loadError);
          setTokens([]);
          setError("Could not load tracked tokens.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadTrackedTokens();

    return () => {
      cancelled = true;
    };
  }, [mounted, refreshKey, supabase]);

  if (!mounted) return null;

  return (
    <aside className="mt-10 rounded-xl border border-white/10 bg-white/5 p-6">
      <div className="mb-4">
        <h2 className="text-xl font-bold">Tracked Tokens</h2>
        <p className="text-sm text-white/50">Tokens saved to your authenticated watchlist.</p>
      </div>

      {loading && <p className="text-sm text-white/60">Loading tracked tokens…</p>}

      {!loading && error && <p className="text-sm text-red-300">{error}</p>}

      {!loading && !error && tokens.length === 0 && <p className="text-sm text-white/50">No tracked tokens yet.</p>}

      {!loading && !error && tokens.length > 0 && (
        <ul className="space-y-3">
          {tokens.map((token, index) => {
            const contract = getTokenAddress(token);
            const symbol = getTokenSymbol(token, symbolByContract);
            const key = token.id ?? contract ?? index;

            return (
              <li key={key} className="flex flex-col gap-3 rounded-lg border border-white/10 bg-black/20 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-white">{symbol}</p>
                  {contract && (
                    <p className="truncate font-mono text-xs text-white/50" title={contract}>
                      {shortenContract(contract)}
                    </p>
                  )}
                </div>
                {contract && (
                  <button type="button" onClick={() => onScanAgain(contract)} className="rounded-lg border border-cyan-300/40 px-3 py-2 text-xs font-semibold text-cyan-200 hover:bg-cyan-300/10">
                    Scan again
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
