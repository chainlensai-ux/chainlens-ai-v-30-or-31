import { classifyClarkPrompt } from "../lib/server/clarkRouting";
import { buildTokenFullReport } from "../lib/clark/reportBuilders";
import type { ClarkEvidenceBundle } from "../lib/clark/types";

const token = "0x1111111111111111111111111111111111111111";
const wallet = "0x2222222222222222222222222222222222222222";

const full = classifyClarkPrompt(`Give me a full analyst report on ${token}`);
if (full.intent !== "token_full_report") throw new Error(`full analyst report routed to ${full.intent}`);

const walletRoute = classifyClarkPrompt(`Scan this wallet ${wallet}`);
if (walletRoute.intent === "token_full_report") throw new Error("wallet prompt routed to token.fullReport");

const casual = classifyClarkPrompt("What is ChainLens?");
if (casual.intent !== "none") throw new Error(`casual prompt should not execute token tools; got ${casual.intent}`);

const missingBundle: ClarkEvidenceBundle = {
  subject: { type: "token", address: token, chain: "base" },
  mode: "full",
  results: [
    { tool: "token.scan", status: "partial", data: { token: { name: "Test", symbol: "TST", address: token }, market: {} }, evidence: {}, missing: ["LP data missing", "Dev wallet data missing"], errors: [], latencyMs: 1 },
    { tool: "token.liquidity", status: "unavailable", data: null, evidence: null, missing: ["Liquidity / LP evidence missing"], errors: [], latencyMs: 1 },
    { tool: "token.devWallet", status: "unavailable", data: null, evidence: null, missing: ["Dev / deployer evidence missing"], errors: [], latencyMs: 1 },
  ],
  evidence: {},
  missing: ["LP data missing", "Dev wallet data missing"],
  errors: [],
  startedAt: new Date(0).toISOString(),
  latencyMs: 3,
};
const report = buildTokenFullReport(missingBundle);
if (!/Missing evidence:/i.test(report) || !/LP data missing/i.test(report) || !/Dev wallet data missing/i.test(report)) {
  throw new Error("full report missing evidence section did not include LP/dev gaps");
}

console.log("Clark Tool Layer smoke checks passed");
