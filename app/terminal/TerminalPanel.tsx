"use client";

import ClarkChat from "@/components/ClarkChat";
import Topbar from "@/components/Topbar";

interface TerminalPanelProps {
  selectedFeature: string | null;
}

export default function TerminalPanel({ selectedFeature }: TerminalPanelProps) {
  return (
    <section className="flex min-w-0 flex-1 flex-col gap-4 border-x border-white/10 bg-[#06060a] p-4">
      <div className="rounded-2xl border border-white/15 bg-[linear-gradient(145deg,rgba(18,10,28,0.72),rgba(11,12,22,0.64))] shadow-[0_16px_50px_rgba(124,58,237,0.24),inset_0_1px_0_rgba(255,255,255,0.08)] backdrop-blur-xl transition hover:shadow-[0_22px_65px_rgba(236,72,153,0.27),0_0_40px_rgba(45,212,191,0.22)]">
        <Topbar
          title="TERMINAL"
          className="rounded-2xl border-[rgba(255,255,255,0.08)] bg-transparent"
          rightSlot={
            <span className="rounded-full border border-[rgba(45,212,191,0.55)] bg-[linear-gradient(120deg,rgba(236,72,153,0.2),rgba(45,212,191,0.2))] px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-[#9ff7e8] [font-family:var(--font-plex-mono),_'IBM_Plex_Mono',_monospace]">
              LIVE
            </span>
          }
        />
      </div>

      <div className="flex-1 overflow-hidden rounded-2xl border border-white/15 bg-[linear-gradient(145deg,rgba(15,10,26,0.72),rgba(6,10,18,0.68))] shadow-[0_16px_50px_rgba(168,85,247,0.22),inset_0_1px_0_rgba(255,255,255,0.08)] backdrop-blur-xl transition hover:shadow-[0_24px_70px_rgba(236,72,153,0.26),0_0_45px_rgba(45,212,191,0.2)]">
        <ClarkChat
          selectedFeature={selectedFeature}
          title="CLARK — CORTEX ENGINE"
          showPulse
        />
      </div>
    </section>
  );
}
