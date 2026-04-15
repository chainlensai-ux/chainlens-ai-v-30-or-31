""use client";

import ClarkRadar from "@/components/ClarkRadar";

interface RadarPanelProps {
  onSelectFeature: (featureKey: string) => void;
}

export default function RadarPanel({ onSelectFeature }: RadarPanelProps) {
  return (
    <aside className="flex h-full w-72 shrink-0 border-l border-white/10 bg-[#06060a] p-4">
      <div className="h-full w-full overflow-hidden rounded-2xl border border-white/15 bg-[linear-gradient(145deg,rgba(18,11,28,0.72),rgba(11,17,23,0.68))] shadow-[0_16px_50px_rgba(124,58,237,0.23),inset_0_1px_0_rgba(255,255,255,0.08)] backdrop-blur-xl transition hover:shadow-[0_24px_68px_rgba(236,72,153,0.24),0_0_42px_rgba(45,212,191,0.2)]">
        <ClarkRadar
          onSelectRadar={onSelectFeature}
          title="LIVE RADAR"
          showPulse
          className="!h-full !w-full !border-l-0 !bg-transparent !p-5"
        />
      </div>
    </aside>
  );
}
