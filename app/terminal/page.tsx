"use client";

import { useState } from "react";
import Sidebar from "./Sidebar";
import TerminalPanel from "./TerminalPanel";
import RadarPanel from "./RadarPanel";

export default function TerminalPage() {
  const [selectedFeature, setSelectedFeature] = useState<string | null>("token-scanner");

  return (
    <main className="h-screen bg-[#06060a] text-white">
      <div className="flex h-full min-w-0">
        <Sidebar
          selectedFeature={selectedFeature}
          onSelectFeature={setSelectedFeature}
        />

        <TerminalPanel selectedFeature={selectedFeature} />

        <RadarPanel onSelectFeature={setSelectedFeature} />
      </div>
    </main>
  );
}
