"use client";

import { useState } from "react";
import Sidebar from "@/components/Sidebar";
import FeatureBar from "@/components/FeatureBar";
import ClarkChat from "@/components/ClarkChat";
import ClarkRadar from "@/components/ClarkRadar";
import Topbar from "@/components/Topbar";

export default function TerminalPage() {
  const [selectedFeature, setSelectedFeature] = useState<string | null>("token-scanner");

  return (
    <main className="h-screen bg-[#06060a] text-white">
      <div className="flex h-full">
        <Sidebar
          title="CHAINLENS"
          planLabel="ELITE PLAN"
          className="w-56 bg-[#06060a] border-[rgba(255,255,255,0.08)]"
        >
          <div className="mb-4 rounded-lg border border-[rgba(255,255,255,0.08)] bg-[#080c14] px-3 py-2">
            <p className="text-xs font-semibold tracking-[0.16em] text-white/90" style={{ fontFamily: "var(--font-mono), IBM Plex Mono, monospace" }}>
              CLARK TERMINAL
            </p>
          </div>
          <FeatureBar
            onSelectFeature={setSelectedFeature}
            activeFeature={selectedFeature}
            grouped
            compact
          />
        </Sidebar>

        <section className="flex min-w-0 flex-1 flex-col border-x border-[rgba(255,255,255,0.08)] bg-[#06060a]">
          <Topbar
            title="TERMINAL"
            className="bg-[#080c14] border-[rgba(255,255,255,0.08)]"
            rightSlot={
              <span
                className="rounded-full border border-[rgba(45,212,191,0.45)] bg-[rgba(45,212,191,0.12)] px-3 py-1 text-[10px] tracking-[0.18em] text-[#89f3e1] uppercase"
                style={{ fontFamily: "var(--font-mono), IBM Plex Mono, monospace" }}
              >
                LIVE
              </span>
            }
          />

          <div className="flex-1 bg-[#06060a]">
            <ClarkChat
              selectedFeature={selectedFeature}
              title="CLARK — CORTEX ENGINE"
              showPulse
            />
          </div>
        </section>

        <ClarkRadar
          onSelectRadar={setSelectedFeature}
          title="LIVE RADAR"
          showPulse
          className="w-72 bg-[#080c14] border-[rgba(255,255,255,0.08)]"
        />
      </div>
    </main>
  );
}
