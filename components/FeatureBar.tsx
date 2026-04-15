// FeatureBar.tsx

type FeatureKey =
  | "token-scanner"
  | "wallet-scanner"
  | "dev-wallet"
  | "liquidity-scanner"
  | "whale-alerts"
  | "pump-alerts"
  | "base-radar"
  | "clark-ai";

interface FeatureBarProps {
  onSelectFeature: (featureKey: string) => void;
  activeFeature?: string | null;
  grouped?: boolean;
  compact?: boolean;
}

const features: { key: FeatureKey; label: string; section: "SCANNERS" | "SIGNALS" | "INTELLIGENCE" }[] = [
  { key: "token-scanner", label: "Token Scanner", section: "SCANNERS" },
  { key: "wallet-scanner", label: "Wallet Scanner", section: "SCANNERS" },
  { key: "dev-wallet", label: "Dev Wallet Detector", section: "SCANNERS" },
  { key: "liquidity-scanner", label: "Liquidity Safety Scanner", section: "SCANNERS" },
  { key: "whale-alerts", label: "Whale Alerts", section: "SIGNALS" },
  { key: "pump-alerts", label: "Pump Alerts", section: "SIGNALS" },
  { key: "base-radar", label: "Base Radar", section: "INTELLIGENCE" },
  { key: "clark-ai", label: "Clark AI", section: "INTELLIGENCE" },
];

export default function FeatureBar({
  onSelectFeature,
  activeFeature = null,
  grouped = false,
  compact = false,
}: FeatureBarProps) {
  if (!grouped) {
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

  const sections: ("SCANNERS" | "SIGNALS" | "INTELLIGENCE")[] = ["SCANNERS", "SIGNALS", "INTELLIGENCE"];

  return (
    <div className={`${compact ? "space-y-4" : "space-y-5"}`}>
      {sections.map((section) => (
        <div key={section}>
          <p
            className="mb-2 px-3 text-[10px] tracking-[0.18em] text-white/45 uppercase"
            style={{ fontFamily: "var(--font-mono), IBM Plex Mono, monospace" }}
          >
            {section}
          </p>
          <ul className="space-y-1">
            {features
              .filter((f) => f.section === section)
              .map((f) => {
                const active = activeFeature === f.key;

                return (
                  <li key={f.key}>
                    <button
                      type="button"
                      onClick={() => onSelectFeature(f.key)}
                      className={`w-full rounded-md border-l-2 px-3 py-2 text-left text-[13px] transition ${
                        active
                          ? "border-l-[#2DD4BF] bg-white/10 text-white"
                          : "border-l-transparent text-white/70 hover:bg-white/10 hover:text-white"
                      }`}
                      style={{ fontFamily: "var(--font-inter), Inter, sans-serif" }}
                    >
                      {f.label}
                    </button>
                  </li>
                );
              })}
          </ul>
        </div>
      ))}
    </div>
  );
}
