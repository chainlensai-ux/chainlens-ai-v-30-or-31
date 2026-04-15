"use client";

import FeatureBar from "@/components/FeatureBar";

interface TerminalSidebarProps {
  selectedFeature: string | null;
  onSelectFeature: (featureKey: string) => void;
}

export default function Sidebar({ selectedFeature, onSelectFeature }: TerminalSidebarProps) {
  return (
    <aside className="w-56 shrink-0 border-r border-white/10 bg-[#06060a] p-4 [font-family:var(--font-inter),_Inter,_sans-serif]">
      <div className="mb-4 rounded-xl border border-white/10 bg-[linear-gradient(135deg,rgba(236,72,153,0.16),rgba(168,85,247,0.14),rgba(45,212,191,0.1))] px-3 py-2 shadow-[0_0_0_1px_rgba(255,255,255,0.04),0_14px_30px_rgba(168,85,247,0.14)]">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-white/90 [font-family:var(--font-plex-mono),_'IBM_Plex_Mono',_monospace]">
          CLARK TERMINAL
        </p>
      </div>

      <div className="flex h-[calc(100%-6rem)] flex-col">
        <div className="flex-1 overflow-y-auto">
          <FeatureBar
            onSelectFeature={onSelectFeature}
            activeFeature={selectedFeature}
            grouped
            compact
          />
        </div>

        <div className="mt-4 rounded-xl border border-[rgba(45,212,191,0.45)] bg-[linear-gradient(135deg,rgba(236,72,153,0.12),rgba(168,85,247,0.12),rgba(45,212,191,0.15))] px-3 py-2 text-center text-[10px] uppercase tracking-[0.14em] text-[#9ff7e8] [font-family:var(--font-plex-mono),_'IBM_Plex_Mono',_monospace]">
          ELITE PLAN
        </div>
      </div>
    </aside>
  );
}
