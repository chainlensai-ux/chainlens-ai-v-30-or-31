"use client";

import React, { useState } from "react";

export default function AISummaryCard({ data }: { data: any }) {
  const { chain, contract, goldrush, gtPools, cortex, gmgn, bytecode } = data;

  const [activeTab, setActiveTab] = useState<
    "overview" | "market" | "contract" | "ai" | "raw"
  >("overview");

  const tabs: { id: typeof activeTab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "market", label: "Market" },
    { id: "contract", label: "Contract" },
    { id: "ai", label: "AI Summary" },
    { id: "raw", label: "Raw Data" },
  ];

  return (
    <div className="mt-8 bg-[#050510] border border-[#2a2350] rounded-2xl p-6 shadow-[0_0_40px_rgba(123,77,255,0.35)]">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-5">
        <div>
          <p className="text-xs text-[#777] uppercase tracking-wide">Chain</p>
          <p className="text-lg font-semibold text-[#b28cff]">
            {chain ? String(chain).toUpperCase() : "UNKNOWN"}
          </p>
        </div>
        <div className="text-right max-w-[60%]">
          <p className="text-xs text-[#777] uppercase tracking-wide">Contract</p>
          <p className="text-xs text-[#ccc] break-all">{contract || "N/A"}</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="relative mb-5">
        <div className="flex gap-2 bg-[#0a0a16] border border-[#26223f] rounded-full p-1">
          {tabs.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={[
                  "relative flex-1 text-xs md:text-sm font-medium px-3 py-2 rounded-full transition-all duration-200",
                  "focus:outline-none",
                  isActive
                    ? "text-white"
                    : "text-[#9ca3af] hover:text-[#e5e7eb]",
                ].join(" ")}
              >
                {isActive && (
                  <span className="absolute inset-0 rounded-full bg-gradient-to-r from-[#ec4899] via-[#a855f7] to-[#22c55e] opacity-80 blur-[6px]" />
                )}
                {isActive && (
                  <span className="absolute inset-[1px] rounded-full bg-[#050510]" />
                )}
                <span className="relative z-10">{tab.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Content */}
      <div className="space-y-4 text-sm text-[#e5e7eb]">
        {activeTab === "overview" && (
          <div className="space-y-3">
            <h3 className="text-[#7b4dff] font-semibold">Token Overview</h3>
            <div className="grid grid-cols-2 gap-3 text-xs md:text-sm">
              <p>
                <span className="text-[#777]">Name:</span>{" "}
                {goldrush?.name || gmgn?.name || "Unknown"}
              </p>
              <p>
                <span className="text-[#777]">Symbol:</span>{" "}
                {goldrush?.symbol || gmgn?.symbol || "Unknown"}
              </p>
              <p>
                <span className="text-[#777]">Decimals:</span>{" "}
                {goldrush?.decimals ?? gmgn?.decimals ?? "?"}
              </p>
              <p>
                <span className="text-[#777]">Pools (GeckoTerminal):</span>{" "}
                {Array.isArray(gtPools) ? gtPools.length : 0}
              </p>
            </div>
          </div>
        )}

        {activeTab === "market" && (
          <div className="space-y-3">
            <h3 className="text-[#4dffb5] font-semibold">Market Intel</h3>
            <div className="grid grid-cols-2 gap-3 text-xs md:text-sm">
              <p>
                <span className="text-[#777]">Price:</span>{" "}
                {goldrush?.price ?? "?"}
              </p>
              <p>
                <span className="text-[#777]">24h Volume:</span>{" "}
                {goldrush?.volume24h ?? goldrush?.volume ?? "?"}
              </p>
              <p>
                <span className="text-[#777]">Holders:</span>{" "}
                {goldrush?.holders ?? "?"}
              </p>
              <p>
                <span className="text-[#777]">Liquidity:</span>{" "}
                {goldrush?.liquidity ?? "?"}
              </p>
            </div>

            {Array.isArray(gtPools) && gtPools.length > 0 ? (
              <div className="mt-3">
                <p className="text-xs text-[#9ca3af] mb-1">
                  Top GeckoTerminal pool:
                </p>
                <div className="bg-[#0b0b16] border border-[#26223f] rounded-xl p-3 text-xs space-y-1">
                  <p>
                    <span className="text-[#777]">Pool:</span>{" "}
                    {gtPools[0]?.attributes?.name || "Unknown"}
                  </p>
                  <p>
                    <span className="text-[#777]">Price USD:</span>{" "}
                    {gtPools[0]?.attributes?.base_token_price_usd
                      ? `$${Number(gtPools[0].attributes.base_token_price_usd).toFixed(6)}`
                      : "Unknown"}
                  </p>
                  <p>
                    <span className="text-[#777]">Liquidity:</span>{" "}
                    {gtPools[0]?.attributes?.reserve_in_usd
                      ? `$${Number(gtPools[0].attributes.reserve_in_usd).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                      : "Unknown"}
                  </p>
                  <p>
                    <span className="text-[#777]">24h Volume:</span>{" "}
                    {gtPools[0]?.attributes?.volume_usd?.h24
                      ? `$${Number(gtPools[0].attributes.volume_usd.h24).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                      : "Unknown"}
                  </p>
                </div>
              </div>
            ) : (
              <p className="text-xs text-[#6b7280]">
                No GeckoTerminal pools found for this contract.
              </p>
            )}
          </div>
        )}

        {activeTab === "contract" && (
          <div className="space-y-3">
            <h3 className="text-[#ffb347] font-semibold">Contract Intel</h3>
            <div className="grid grid-cols-2 gap-3 text-xs md:text-sm">
              <p>
                <span className="text-[#777]">Owner status:</span>{" "}
                {cortex?.ownerStatus || "Unknown"}
              </p>
              <p>
                <span className="text-[#777]">Liquidity status:</span>{" "}
                {cortex?.liquidityStatus || "Unknown"}
              </p>
              <p>
                <span className="text-[#777]">Honeypot:</span>{" "}
                {cortex?.honeypot || "Unknown"}
              </p>
              <p>
                <span className="text-[#777]">Suspicious functions:</span>{" "}
                {cortex?.suspiciousFunctions?.length
                  ? cortex.suspiciousFunctions.join(", ")
                  : "None detected"}
              </p>
            </div>

            <div className="mt-3">
              <p className="text-xs text-[#9ca3af] mb-1">Bytecode (preview):</p>
              <div className="bg-[#0b0b16] border border-[#26223f] rounded-xl p-3 max-h-40 overflow-auto text-[11px] leading-snug text-[#d1d5db]">
                {bytecode ? String(bytecode).slice(0, 420) + "..." : "No bytecode available."}
              </div>
            </div>
          </div>
        )}

        {activeTab === "ai" && (
          <div className="space-y-3">
            <h3 className="text-[#c94bff] font-semibold">AI Summary</h3>
            <p className="text-xs md:text-sm text-[#ddd] whitespace-pre-line leading-relaxed">
              {cortex?.verdict ||
                "No AI summary available yet. This section provides a descriptive, non-financial overview of the contract and its on-chain context."}
            </p>
            <p className="text-[11px] text-[#6b7280]">
              This summary is informational only and does not constitute financial advice or a recommendation.
            </p>
          </div>
        )}

        {activeTab === "raw" && (
          <div className="space-y-3">
            <h3 className="text-[#9ca3ff] font-semibold">Raw Data</h3>
            <div className="bg-[#050512] border border-[#26223f] rounded-xl p-3 max-h-72 overflow-auto text-[11px] leading-snug text-[#d1d5db]">
              <pre className="whitespace-pre-wrap break-words">
                {JSON.stringify(data, null, 2)}
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
