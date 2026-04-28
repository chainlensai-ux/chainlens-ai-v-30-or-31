export type HoneypotSecurityResult = {
  ok: boolean;
  securityStatus: "verified" | "partial" | "unverified";
  honeypot: boolean | null;
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
  honeypot: null,
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

function pickAddress(raw: Record<string, unknown>): string | null {
  const candidates = [
    raw.pair?.toString(),
    (raw.pair as Record<string, unknown> | undefined)?.toString?.(),
    (raw as { pairAddress?: unknown }).pairAddress,
    ((raw.pair as Record<string, unknown> | undefined)?.pair as unknown),
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

  const honeypot = parseBool(summary.isHoneypot ?? raw.isHoneypot ?? simulation.isHoneypot);
  const buyTax = parseNum(summary.buyTax ?? simulation.buyTax ?? tokenData.buyTax);
  const sellTax = parseNum(summary.sellTax ?? simulation.sellTax ?? tokenData.sellTax);
  const transferTax = parseNum(summary.transferTax ?? simulation.transferTax ?? tokenData.transferTax);
  const simulationSuccess = parseBool(raw.simulationSuccess ?? simulation.simulationSuccess ?? simulation.success);
  const pairAddress = pickAddress(raw);

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
    honeypot,
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
  if (!/^0x[a-fA-F0-9]{40}$/.test(tokenAddress)) return { ...UNVERIFIED, warnings: ["Security simulation unavailable"], ok: false };

  const chainID = chainIdOrNetwork === "base" ? "8453" : String(chainIdOrNetwork || "8453");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const primary = `https://api.honeypot.is/v2/IsHoneypot?address=${tokenAddress}&chainID=${chainID}`;
    let response = await fetch(primary, { method: "GET", signal: controller.signal, headers: { "accept": "application/json" }, cache: "no-store" });

    if (!response.ok && chainIdOrNetwork === "base") {
      const fallback = `https://api.honeypot.is/v2/IsHoneypot?address=${tokenAddress}&chain=base`;
      response = await fetch(fallback, { method: "GET", signal: controller.signal, headers: { "accept": "application/json" }, cache: "no-store" });
    }

    if (!response.ok) return { ...UNVERIFIED };
    const json = await response.json();
    if (!json || typeof json !== "object") return { ...UNVERIFIED };
    return normalize(json as Record<string, unknown>);
  } catch {
    return { ...UNVERIFIED };
  } finally {
    clearTimeout(timeout);
  }
}
