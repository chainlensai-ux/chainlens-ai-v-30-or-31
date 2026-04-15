const starters: Record<string, string> = {
  "token-scanner": "paste a contract address and I'll break it down",
  "wallet-scanner": "drop a wallet address and I'll profile it",
  "dev-wallet": "give me a contract and I'll find the dev wallet cluster",
  "pump-alerts": "here are the top pump signals on Base right now",
  "whale-alerts": "I'm watching Base for whale moves right now",
  "base-radar": "here are the newest Base deployments I'm tracking",
  "liquidity-scanner": "paste a contract and I'll check the liquidity safety",
};

interface ClarkChatProps {
  selectedFeature: string | null;
  title?: string;
  showPulse?: boolean;
}

export default function ClarkChat({ selectedFeature, title = "Clark Chat", showPulse = false }: ClarkChatProps) {
  const messages = selectedFeature
    ? [
        "[SCAN] fetching onchain data...",
        "[AI] CORTEX engine processing...",
        "[CLARK] stream stabilized — telemetry online",
        `Clark: ${starters[selectedFeature] ?? "ask me for any chain intelligence task"}`,
      ]
    : [
        "[CLARK] terminal initialized",
        "Clark: Select a feature from the left panel to run a scan.",
      ];

  return (
    <div className="flex-1 p-6 bg-[#06060a] font-inter">
      <h2 className="text-lg font-bold flex items-center gap-2">
        {showPulse ? <span className="h-2 w-2 rounded-full bg-[#2DD4BF] animate-pulse" /> : null}
        {title}
      </h2>
      <div className="mt-4 h-[70%] rounded bg-[#080c14] p-4 overflow-y-auto font-mono text-sm">
        {messages.map((msg, idx) => (
          <div key={idx} className="mb-2 text-neutral-200">
            {msg}
          </div>
        ))}
      </div>
      <input
        type="text"
        placeholder="Type a message..."
        className="mt-2 w-full rounded bg-neutral-700 p-2 font-mono"
      />
    </div>
  );
}
