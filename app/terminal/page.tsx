"use client";
import { useState } from "react";
import FeatureBar from "@/components/FeatureBar";
import ClarkChat from "@/components/ClarkChat";
import ClarkRadar from "@/components/ClarkRadar";

export default function TerminalPage() {
  const [selectedFeature, setSelectedFeature] = useState<string | null>(null);

  return (
    <div className="flex h-screen bg-[#06060a] text-white font-inter">
      <FeatureBar onSelectFeature={setSelectedFeature} />
      <ClarkChat selectedFeature={selectedFeature} />
      <ClarkRadar onSelectRadar={setSelectedFeature} />
    </div>
  );
}
