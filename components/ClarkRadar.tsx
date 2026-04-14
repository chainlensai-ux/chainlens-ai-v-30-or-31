export default function ClarkRadar({ onSelectRadar }: { onSelectRadar: (val: string) => void }) {
  const mockCards = [
    { token: "BRETT", risk: "DANGER", tag: "whale exit" },
    { token: "TOSHI", risk: "SAFE", tag: "early pump" },
    { token: "VIRTUAL", risk: "WATCH", tag: "new deployment" },
  ];

  return (
    <div className="w-96 p-6 bg-[#080c14] border-l border-[rgba(255,255,255,0.08)]">
      <h2 className="text-lg font-bold">Clark Radar</h2>
      <div className="mt-4 space-y-4">
        {mockCards.map((c, idx) => (
          <div
            key={idx}
            onClick={() => onSelectRadar(c.token)}
            className="p-4 rounded bg-[#06060a] cursor-pointer animate-slideIn shadow-md animate-pulse"
          >
            <div className="flex justify-between items-center">
              <span className="font-mono">{c.token}</span>
              <span
                className={`px-2 py-1 text-xs rounded ${
                  c.risk === "SAFE"
                    ? "bg-teal-500"
                    : c.risk === "DANGER"
                    ? "bg-red-500"
                    : "bg-yellow-500"
                }`}
              >
                {c.risk}
              </span>
              <span className="ml-2 text-pink-500 animate-pulse">LIVE</span>
            </div>
            <div className="mt-2 text-sm text-neutral-400">{c.tag}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
