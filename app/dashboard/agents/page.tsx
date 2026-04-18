"use client";

import Link from "next/link";

const agents = [
  {
    name: "Wallet Analyzer",
    id: "wallet",
    desc: "Analyze any wallet: behavior, patterns, risks, and on-chain activity.",
  },
  {
    name: "Token Analyzer",
    id: "token",
    desc: "Deep-dive any token: price action, holders, liquidity, and risks.",
  },
  {
    name: "Risk Scoring",
    id: "risk",
    desc: "Instant risk score for wallets or tokens using Clark's AI engine.",
  },
  {
    name: "Narrative Finder",
    id: "narrative",
    desc: "Find emerging narratives and early meta shifts on Base.",
  },
  {
    name: "Whale Watch",
    id: "whale",
    desc: "Track whale movements, inflows, outflows, and smart money trends.",
  },
  {
    name: "Degen Mode",
    id: "degen",
    desc: "High-risk, high-reward mode. Clark goes full degen.",
  },
  {
    name: "AI Summary",
    id: "summary",
    desc: "Summarize any wallet, token, or narrative instantly.",
  },
  {
    name: "Custom Prompt",
    id: "custom",
    desc: "Talk to Clark directly with your own prompt.",
  },
];

export default function AgentsPage() {
  return (
    <div className="p-10">
      <h1 className="text-3xl font-bold mb-6">Clark Agents</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {agents.map((agent) => (
          <Link
            key={agent.id}
            href={`/dashboard/agents/${agent.id}`}
            className="p-6 bg-white/5 border border-white/10 rounded-xl hover:bg-white/10 transition"
          >
            <h2 className="text-xl font-semibold mb-2">{agent.name}</h2>
            <p className="text-white/60 text-sm">{agent.desc}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
