// FeatureBar.tsx

interface FeatureBarProps {
  onSelectFeature: (featureKey: string) => void;
}

export default function FeatureBar({ onSelectFeature }: FeatureBarProps) {
  const features = [
    { key: "token-scanner", label: "Token Scanner" },
    { key: "wallet-scanner", label: "Wallet Scanner" },
    { key: "dev-wallet", label: "Dev Wallet Detector" },
    { key: "liquidity-scanner", label: "Liquidity Safety Scanner" },
    { key: "whale-alerts", label: "Whale Alerts" },
    { key: "pump-alerts", label: "Pump Alerts" },
    { key: "base-radar", label: "Base Radar" },
    { key: "clark-ai", label: "Clark AI" },
  ];

  return (
    <aside className="w-72 bg-[#080c14] p-6 border-r border-[rgba(255,255,255,0.08)]">
      <h2 className="text-xl font-bold text-teal-400">Feature Bar</h2>
      <ul className="mt-6 space-y-4 text-sm text-neutral-200">
        {features.map((f) => (
          <li
            key={f.key}
            onClick={() => onSelectFeature(f.key)}
            className="cursor-pointer hover:text-purple-400 transition"
          >
            {f.label}
          </li>
        ))}
      </ul>
      <button className="mt-8 w-full rounded bg-purple-600 py-2 font-semibold hover:bg-purple-500 transition">
        Connect Wallet
      </button>
    </aside>
  );
}
