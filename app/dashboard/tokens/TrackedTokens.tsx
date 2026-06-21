"use client";

import { memo, useEffect, useMemo, useState } from "react";

import {
  canUseTrackedTokenStorage,
  getTrackedTokenSymbols,
  getTrackedTokens,
  removeTrackedToken,
} from "@/utils/trackedTokens";

type TrackedTokensProps = {
  refreshKey: number;
  symbolByContract: Record<string, string>;
  onScanAgain: (contractAddress: string) => void;
};

type TrackedTokensState = "loading" | "empty" | "error" | "list";

function shortenContract(contract: string): string {
  if (contract.length <= 14) return contract;
  return `${contract.slice(0, 8)}…${contract.slice(-6)}`;
}

const TrackedTokenRow = memo(function TrackedTokenRow({
  contract,
  symbol,
  onRemove,
  onScanAgain,
}: {
  contract: string;
  symbol: string;
  onRemove: (contract: string) => void;
  onScanAgain: (contract: string) => void;
}) {
  return (
    <li className="flex flex-col gap-3 rounded-lg border border-white/10 bg-black/20 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-white">{symbol}</p>
        <p className="truncate font-mono text-xs text-white/50" title={contract}>{shortenContract(contract)}</p>
      </div>
      <div className="flex shrink-0 gap-2">
        <button type="button" onClick={() => onScanAgain(contract)} className="rounded-lg border border-cyan-300/40 px-3 py-2 text-xs font-semibold text-cyan-200 hover:bg-cyan-300/10">
          Scan again
        </button>
        <button type="button" onClick={() => onRemove(contract)} className="rounded-lg border border-red-300/30 px-3 py-2 text-xs font-semibold text-red-200 hover:bg-red-300/10">
          Remove
        </button>
      </div>
    </li>
  );
});

export default function TrackedTokens({ refreshKey, symbolByContract, onScanAgain }: TrackedTokensProps) {
  const [mounted, setMounted] = useState(false);
  const [tokens, setTokens] = useState<string[]>([]);
  const [persistedSymbols, setPersistedSymbols] = useState<Record<string, string>>({});
  const [state, setState] = useState<TrackedTokensState>("loading");

  // eslint-disable-next-line react-hooks/set-state-in-effect -- PHASE-TS1-FIX requires a client hydration guard before reading localStorage.
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!mounted) return;

    let cancelled = false;

    queueMicrotask(() => {
      if (cancelled) return;

      // PHASE-TS1-FIX: hydrate tracked tokens only after mount to preserve SSR/CSR boundaries.
      setState("loading");
      if (!canUseTrackedTokenStorage()) {
        setTokens([]);
        setState("error");
        return;
      }

      const nextTokens = getTrackedTokens();
      setTokens(nextTokens);
      setPersistedSymbols(getTrackedTokenSymbols());
      setState(nextTokens.length > 0 ? "list" : "empty");
    });

    return () => {
      cancelled = true;
    };
  }, [mounted, refreshKey]);

  const renderedTokens = useMemo(
    () => tokens.map((contract) => ({
      contract,
      symbol: symbolByContract[contract] || persistedSymbols[contract] || "Tracked Token",
    })),
    [persistedSymbols, symbolByContract, tokens],
  );

  const handleRemove = (contract: string) => {
    if (!canUseTrackedTokenStorage()) {
      setState("error");
      return;
    }

    removeTrackedToken(contract);
    const nextTokens = getTrackedTokens();
    setTokens(nextTokens);
    setState(nextTokens.length > 0 ? "list" : "empty");
  };

  return (
    <aside className="mt-10 rounded-xl border border-white/10 bg-white/5 p-6">
      <div className="mb-4">
        <h2 className="text-xl font-bold">Tracked Tokens</h2>
        <p className="text-sm text-white/50">Successful scans are saved locally on this device.</p>
      </div>

      {state === "loading" && <p className="text-sm text-white/60">Loading tracked tokens…</p>}

      {state === "error" && <p className="text-sm text-red-300">Could not load tracked tokens (storage unavailable).</p>}

      {state === "empty" && <p className="text-sm text-white/50">No tokens tracked yet. Run a successful token scan to add one here.</p>}

      {state === "list" && (
        <ul className="space-y-3">
          {renderedTokens.map((trackedToken) => (
            <TrackedTokenRow
              key={trackedToken.contract}
              contract={trackedToken.contract}
              symbol={trackedToken.symbol}
              onRemove={handleRemove}
              onScanAgain={onScanAgain}
            />
          ))}
        </ul>
      )}
    </aside>
  );
}
