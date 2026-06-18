export type HoneypotSecurityResult = {
  ok: boolean;
  securityStatus: "verified" | "partial" | "unverified";
  honeypotProvider: "ok" | "unavailable" | "unsupported" | "error";
  honeypotSource: string;
  honeypot: boolean | null;
  // Which raw provider field the honeypot boolean was read from — null when no field had data.
  mappedHoneypotFrom: string | null;
  // Provider-supplied explanation for the honeypot result, when available (e.g. why a
  // simulation failed or could not run). Never fabricated.
  honeypotReason: string | null;
  // Distinct from securityStatus/honeypotProvider: this is specifically the simulation's
  // own outcome, so "tax confirmed, honeypot unavailable" and "honeypot confirmed false"
  // are never collapsed into the same status.
  simulationStatus: "confirmed" | "unavailable" | "failed" | "not_supported" | "timeout";
  buyTax: number | null;
  sellTax: number | null;
  transferTax: number | null;
  simulationSuccess: boolean | null;
  pairAddress: string | null;
  riskLevel: "low" | "medium" | "high" | "unknown";
  warnings: string[];
  missing: string[];
};

const UNVERIFIED: HoneypotSecurityResult = {
  ok: false,
  securityStatus: "unverified",
  honeypotProvider: "unavailable",
  honeypotSource: "honeypot.is",
  honeypot: null,
  mappedHoneypotFrom: null,
  honeypotReason: "Security simulation unavailable",
  simulationStatus: "unavailable",
  buyTax: null,
  sellTax: null,
  transferTax: null,
  simulationSuccess: null,
  pairAddress: null,
  riskLevel: "unknown",
  warnings: ["Security simulation unavailable"],
  missing: ["honeypot", "buyTax", "sellTax", "transferTax", "simulationSuccess"],
};

function parseNum(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parseBool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1 ? true : value === 0 ? false : null;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["1", "true", "yes"].includes(v)) return true;
    if (["0", "false", "no"].includes(v)) return false;
  }
  return null;
}

function pickString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

function pickAddress(raw: Record<string, unknown>): string | null {
  const pair = raw.pair as Record<string, unknown> | undefined;
  const pairInfo = pair?.pair as Record<string, unknown> | undefined;
  const candidates = [
    pairInfo?.address,
    pair?.address,
    (raw as Record<string, unknown>).pairAddress,
    raw.pair_address,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && /^0x[a-fA-F0-9]{40}$/.test(c)) return c;
  }
  return null;
}

function normalize(raw: Record<string, unknown>): HoneypotSecurityResult {
  const tokenData = (raw.token as Record<string, unknown> | undefined) ?? {};
  const summary = (raw.summary as Record<string, unknown> | undefined) ?? {};
  const simulation = (raw.simulationResult as Record<string, unknown> | undefined) ?? {};
  // honeypot.is v2 puts the actual honeypot verdict under honeypotResult.isHoneypot —
  // not summary/top-level/simulationResult. Those were checked first below as compat
  // fallbacks, but the real field must be checked first or an explicit "false" result
  // from the provider is silently dropped to null ("unavailable") instead of being
  // surfaced as a confirmed result.
  const honeypotResult = (raw.honeypotResult as Record<string, unknown> | undefined) ?? {};

  let honeypot: boolean | null = null;
  let mappedHoneypotFrom: string | null = null;
  for (const [path, value] of [
    ["honeypotResult.isHoneypot", honeypotResult.isHoneypot],
    ["summary.isHoneypot", summary.isHoneypot],
    ["isHoneypot", raw.isHoneypot],
    ["simulationResult.isHoneypot", simulation.isHoneypot],
  ] as const) {
    const parsed = parseBool(value);
    if (parsed !== null) { honeypot = parsed; mappedHoneypotFrom = path; break; }
  }

  const honeypotReason =
    pickString(honeypotResult.honeypotReason) ??
    pickString(raw.error) ??
    pickString(simulation.error) ??
    (honeypot === null ? "Security simulation unavailable" : null);

  const buyTax = parseNum(summary.buyTax ?? simulation.buyTax ?? tokenData.buyTax);
  const sellTax = parseNum(summary.sellTax ?? simulation.sellTax ?? tokenData.sellTax);
  const transferTax = parseNum(summary.transferTax ?? simulation.transferTax ?? tokenData.transferTax);
  const simulationSuccess = parseBool(raw.simulationSuccess ?? simulation.simulationSuccess ?? simulation.success);
  const pairAddress = pickAddress(raw);

  // Tax data and honeypot verdict are independent — confirming one never implies the other.
  const simulationStatus: HoneypotSecurityResult["simulationStatus"] =
    honeypot !== null ? "confirmed" : simulationSuccess === false ? "failed" : "unavailable";

  const missing = [
    honeypot === null ? "honeypot" : "",
    buyTax === null ? "buyTax" : "",
    sellTax === null ? "sellTax" : "",
    transferTax === null ? "transferTax" : "",
    simulationSuccess === null ? "simulationSuccess" : "",
  ].filter(Boolean);

  const securityStatus: HoneypotSecurityResult["securityStatus"] =
    missing.length === 0 ? "verified" : missing.length <= 2 ? "partial" : "unverified";

  const warnings: string[] = [];
  if (honeypot === true) warnings.push("Security simulation flagged honeypot behavior.");
  if ((buyTax ?? 0) > 15 || (sellTax ?? 0) > 15) warnings.push("Tax profile is elevated.");
  if (simulationSuccess === false) warnings.push("Security simulation failed.");
  if (!warnings.length && securityStatus !== "verified") warnings.push("Tax/honeypot check unverified.");

  const riskLevel: HoneypotSecurityResult["riskLevel"] =
    honeypot === true ? "high"
      : ((buyTax ?? 0) > 15 || (sellTax ?? 0) > 15 || simulationSuccess === false) ? "medium"
        : honeypot === false && simulationSuccess === true ? "low"
          : "unknown";

  return {
    ok: securityStatus !== "unverified" || honeypot !== null || buyTax !== null || sellTax !== null,
    securityStatus,
    honeypotProvider: "ok" as const,
    honeypotSource: "honeypot.is",
    honeypot,
    mappedHoneypotFrom,
    honeypotReason,
    simulationStatus,
    buyTax,
    sellTax,
    transferTax,
    simulationSuccess,
    pairAddress,
    riskLevel,
    warnings,
    missing,
  };
}

export async function fetchHoneypotSecurity(tokenAddress: string, chainIdOrNetwork: string | number = "base"): Promise<HoneypotSecurityResult> {
  if (!/^0x[a-fA-F0-9]{40}$/.test(tokenAddress)) {
    return { ...UNVERIFIED, honeypotProvider: "error", warnings: ["Invalid token address"], ok: false };
  }

  const chainID = chainIdOrNetwork === "base" ? "8453" : String(chainIdOrNetwork || "8453");
  const endpoint = `/v2/IsHoneypot?address=${tokenAddress}&chainID=${chainID}`;
  const url = `https://api.honeypot.is${endpoint}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: { "accept": "application/json", "user-agent": "ChainLens/1.0" },
      cache: "no-store",
    });

    if (response.status === 404 || response.status === 403) {
      const reason = response.status === 403 ? "unsupported" : "unavailable";
      console.warn(`[honeypot] ${reason} chainID=${chainID} status=${response.status} endpoint=${endpoint}`);
      return {
        ...UNVERIFIED,
        honeypotProvider: reason as "unsupported" | "unavailable",
        simulationStatus: reason === "unsupported" ? "not_supported" : "unavailable",
        honeypotReason: reason === "unsupported" ? "Security provider does not support this token/chain pair" : "Honeypot check unavailable for this token",
        warnings: ["Honeypot check unavailable for this token"],
      };
    }

    if (!response.ok) {
      console.warn(`[honeypot] provider_error chainID=${chainID} status=${response.status} endpoint=${endpoint}`);
      return { ...UNVERIFIED, honeypotProvider: "error", simulationStatus: "failed", honeypotReason: "Security provider returned an error" };
    }

    const json = await response.json();
    if (!json || typeof json !== "object") return { ...UNVERIFIED, honeypotProvider: "error", simulationStatus: "failed", honeypotReason: "Security provider returned an invalid response" };
    return normalize(json as Record<string, unknown>);
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "AbortError";
    console.warn(`[honeypot] provider_error chainID=${chainID} endpoint=${endpoint} (fetch ${isTimeout ? "timed out" : "threw"})`);
    return {
      ...UNVERIFIED,
      honeypotProvider: "error",
      simulationStatus: isTimeout ? "timeout" : "failed",
      honeypotReason: isTimeout ? "Security simulation timed out" : "Security provider returned an error",
    };
  } finally {
    clearTimeout(timeout);
  }
}
