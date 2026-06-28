import type { ClarkEvidenceBundle, ClarkReportMode, ClarkToolInput, ClarkToolName, ClarkToolResult } from "./types";

export type ClarkInternalCaller = (path: string, payload: Record<string, unknown>, timeoutMs?: number) => Promise<{ ok: boolean; status?: number; json: unknown }>;

export type ClarkToolRuntime = {
  callInternalApi: ClarkInternalCaller;
  chain: string;
  prompt?: string;
};

type ToolRunner = (input: ClarkToolInput, runtime: ClarkToolRuntime) => Promise<ClarkToolResult>;

function status(ok: boolean, data: unknown, missing: string[]): ClarkToolResult["status"] {
  if (ok && missing.length === 0) return "ok";
  if (ok || data != null) return "partial";
  return "unavailable";
}

function missingFromJson(json: unknown, fallback: string): string[] {
  const j = json && typeof json === "object" ? json as Record<string, unknown> : {};
  const out: string[] = [];
  const rawMissing = j.missing ?? j.missingEvidence ?? j.warnings;
  if (Array.isArray(rawMissing)) out.push(...rawMissing.map(String));
  if (j.error || j.errorSafeMessage) out.push(String(j.errorSafeMessage ?? j.error));
  if (out.length === 0 && !j.ok) out.push(fallback);
  return Array.from(new Set(out.filter(Boolean)));
}

async function timed(tool: ClarkToolName, fn: () => Promise<Omit<ClarkToolResult, "tool" | "latencyMs">>): Promise<ClarkToolResult> {
  const started = Date.now();
  try {
    const r = await fn();
    return { tool, latencyMs: Date.now() - started, ...r };
  } catch (err) {
    return { tool, status: "error", data: null, evidence: null, missing: [`${tool} failed before evidence loaded`], errors: [{ tool, message: err instanceof Error ? err.message : String(err) }], latencyMs: Date.now() - started };
  }
}

export const CLARK_TOOL_REGISTRY: Record<ClarkToolName, ToolRunner | null> = {
  "token.scan": async (input, runtime) => timed("token.scan", async () => {
    const address = input.address ?? "";
    const res = await runtime.callInternalApi("/api/token", { contract: address, chain: input.chain ?? runtime.chain, mode: "clark_core" }, 18_000);
    const missing = missingFromJson(res.json, "Token scan data missing");
    return { status: status(res.ok, res.json, missing), data: res.json, evidence: { token: res.json }, missing, errors: res.ok ? [] : [{ tool: "token.scan", message: `Token scan returned ${res.status ?? "unavailable"}` }] };
  }),
  "token.liquidity": async (input, runtime) => timed("token.liquidity", async () => {
    const address = input.address ?? "";
    const res = await runtime.callInternalApi("/api/liquidity-safety", { contract: address, tokenAddress: address, chain: input.chain ?? runtime.chain }, 12_000);
    const root = res.json && typeof res.json === "object" ? res.json as Record<string, unknown> : {};
    const data = (root.data ?? root) as unknown;
    const missing = missingFromJson(res.json, "Liquidity / LP evidence missing");
    return { status: status(res.ok, data, missing), data, evidence: { liquidity: data }, missing, errors: res.ok ? [] : [{ tool: "token.liquidity", message: `Liquidity check returned ${res.status ?? "unavailable"}` }] };
  }),
  "token.devWallet": async (input, runtime) => timed("token.devWallet", async () => {
    const address = input.address ?? "";
    const res = await runtime.callInternalApi("/api/dev-wallet", { contractAddress: address, chain: input.chain ?? runtime.chain }, 12_000);
    const missing = missingFromJson(res.json, "Dev / deployer evidence missing");
    return { status: status(res.ok, res.json, missing), data: res.json, evidence: { devWallet: res.json }, missing, errors: res.ok ? [] : [{ tool: "token.devWallet", message: `Dev-wallet check returned ${res.status ?? "unavailable"}` }] };
  }),
  "token.fullReport": null,
  "wallet.scan": null,
  "wallet.compare": null,
  "market.explainMove": null,
  "alerts.explain": null,
  "memory.getLastContext": null,
  "memory.saveSessionContext": null,
};

export function buildTokenFullReportPlan(address: string, chain: string, mode: ClarkReportMode = "full") {
  return { intent: "token.fullReport" as const, mode, subject: { type: "token" as const, address: address.toLowerCase(), chain }, tools: ["token.scan", "token.liquidity", "token.devWallet"] as ClarkToolName[] };
}

export async function executeClarkToolPlan(plan: ReturnType<typeof buildTokenFullReportPlan>, runtime: ClarkToolRuntime): Promise<ClarkEvidenceBundle> {
  const started = Date.now();
  const results: ClarkToolResult[] = [];
  for (const tool of plan.tools) {
    const runner = CLARK_TOOL_REGISTRY[tool];
    if (!runner) {
      results.push({ tool, status: "unavailable", data: null, evidence: null, missing: [`${tool} is not implemented in this registry version`], errors: [], latencyMs: 0 });
      continue;
    }
    results.push(await runner({ tool, address: plan.subject.address, chain: plan.subject.chain, mode: plan.mode, prompt: runtime.prompt }, runtime));
  }
  const evidence: Record<string, unknown> = {};
  for (const r of results) if (r.evidence) Object.assign(evidence, r.evidence);
  return {
    subject: plan.subject,
    mode: plan.mode,
    results,
    evidence,
    missing: Array.from(new Set(results.flatMap(r => r.missing))),
    errors: results.flatMap(r => r.errors),
    startedAt: new Date(started).toISOString(),
    latencyMs: Date.now() - started,
  };
}

export function normalizeClarkScannerCacheKey(input: { intent: string; address?: string | null; chain?: string | null; prompt?: string | null }): string {
  const scannerIntent = input.intent.trim().toLowerCase();
  const entity = (input.address ?? "").trim().toLowerCase();
  const chain = (input.chain ?? "base").trim().toLowerCase().replace(/^ethereum$/, "eth");
  if (scannerIntent && entity) return JSON.stringify({ intent: scannerIntent, entity, chain });
  return JSON.stringify({ intent: scannerIntent, prompt: (input.prompt ?? "").trim().toLowerCase(), chain });
}
