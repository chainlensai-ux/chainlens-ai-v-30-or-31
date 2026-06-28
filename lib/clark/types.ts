export type ClarkToolName =
  | "token.scan"
  | "token.liquidity"
  | "token.devWallet"
  | "token.fullReport"
  | "wallet.scan"
  | "wallet.compare"
  | "market.explainMove"
  | "alerts.explain"
  | "memory.getLastContext"
  | "memory.saveSessionContext";

export type ClarkReportMode = "preview" | "full" | "risk" | "safety";
export type ClarkToolStatus = "ok" | "partial" | "unavailable" | "error";

export type ClarkToolInput = {
  tool: ClarkToolName;
  address?: string | null;
  chain?: "base" | "eth" | "ethereum" | "polygon" | "bnb" | string | null;
  mode?: ClarkReportMode;
  prompt?: string;
};

export type ClarkToolError = {
  tool: ClarkToolName;
  message: string;
  code?: string;
};

export type ClarkToolResult<TData = unknown> = {
  tool: ClarkToolName;
  status: ClarkToolStatus;
  data: TData | null;
  evidence: Record<string, unknown> | null;
  missing: string[];
  errors: ClarkToolError[];
  latencyMs: number;
};

export type ClarkEvidenceBundle = {
  subject: { type: "token" | "wallet" | "unknown"; address: string | null; chain: string | null };
  mode: ClarkReportMode;
  results: ClarkToolResult[];
  evidence: Record<string, unknown>;
  missing: string[];
  errors: ClarkToolError[];
  startedAt: string;
  latencyMs: number;
};

export type ClarkToolPlan = {
  intent: ClarkToolName;
  mode: ClarkReportMode;
  subject: { type: "token" | "wallet" | "unknown"; address: string | null; chain: string | null };
  tools: ClarkToolName[];
};
