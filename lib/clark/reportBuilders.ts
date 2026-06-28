import type { ClarkEvidenceBundle, ClarkToolResult } from "./types";

function pickObj(v: unknown): Record<string, unknown> { return v && typeof v === "object" ? v as Record<string, unknown> : {}; }
function nested(root: Record<string, unknown>, keys: string[]): unknown {
  let cur: unknown = root;
  for (const key of keys) cur = pickObj(cur)[key];
  return cur;
}
function firstString(...vals: unknown[]): string | null { for (const v of vals) if (typeof v === "string" && v.trim()) return v.trim(); return null; }
function firstNumber(...vals: unknown[]): number | null { for (const v of vals) if (typeof v === "number" && Number.isFinite(v)) return v; return null; }
function money(v: number | null): string { if (v == null) return "missing"; if (Math.abs(v) >= 1e9) return `$${(v/1e9).toFixed(2)}B`; if (Math.abs(v) >= 1e6) return `$${(v/1e6).toFixed(2)}M`; if (Math.abs(v) >= 1e3) return `$${(v/1e3).toFixed(1)}K`; return `$${v.toFixed(2)}`; }
function pct(v: number | null): string { return v == null ? "missing" : `${v.toFixed(2)}%`; }
function result(bundle: ClarkEvidenceBundle, tool: string): ClarkToolResult | null { return bundle.results.find(r => r.tool === tool) ?? null; }
function publicMissing(bundle: ClarkEvidenceBundle): string[] {
  return Array.from(new Set(bundle.missing.map(m => String(m).replace(/provider|honeypot|goplus|geckoterminal|basescan|covalent|zerion/gi, "upstream check")).filter(Boolean)));
}

export function buildTokenFullReport(bundle: ClarkEvidenceBundle): string {
  const scan = result(bundle, "token.scan");
  const liq = result(bundle, "token.liquidity");
  const dev = result(bundle, "token.devWallet");
  const scanData = pickObj(scan?.data);
  const token = pickObj(scanData.token);
  const market = pickObj(scanData.market);
  const holders = pickObj(scanData.holders);
  const security = pickObj(scanData.security);
  const lpControl = pickObj(scanData.lpControl);
  const liqData = pickObj(liq?.data);
  const devData = pickObj(dev?.data);

  const name = firstString(token.name, nested(liqData, ["token", "name"])) ?? "Unknown token";
  const symbol = firstString(token.symbol, nested(liqData, ["token", "symbol"])) ?? "?";
  const address = firstString(token.address, nested(liqData, ["token", "address"]), bundle.subject.address) ?? "missing";
  const price = firstNumber(market.price, scanData.priceUsd);
  const liquidity = firstNumber(market.liquidity, liqData.liquidityUsd);
  const volume = firstNumber(market.volume24h, liqData.volume24h);
  const top10 = firstNumber(holders.top10);
  const holderCount = firstNumber(holders.holderCount);
  const honeypot = typeof security.honeypot === "boolean" ? security.honeypot as boolean : null;
  const buyTax = firstNumber(security.buyTax);
  const sellTax = firstNumber(security.sellTax);
  const lpStatus = firstString(lpControl.status, liqData.riskTier);
  const devVerdict = firstString(devData.verdict);
  const missing = publicMissing(bundle);
  const statuses = bundle.results.map(r => r.status);
  const anyOk = statuses.includes("ok") || statuses.includes("partial");
  const highRisk = honeypot === true || /avoid|high|unlocked|dominant|pull/i.test(`${lpStatus} ${devVerdict}`);
  const verdict = !anyOk ? "OPEN CHECK" : highRisk ? "HIGH RISK / DO NOT ASSUME SAFE" : missing.length ? "OPEN CHECK — evidence incomplete" : "WATCH — no critical red flag confirmed by checked evidence";
  const confidence = !anyOk ? "Low" : missing.length || statuses.includes("partial") || statuses.includes("unavailable") || statuses.includes("error") ? "Medium-Low" : "Medium";

  const risks = [
    honeypot === true ? "Security simulation indicates honeypot risk." : null,
    lpStatus ? `LP/control status: ${lpStatus}.` : "LP/control data is missing; missing is not safe.",
    devVerdict ? `Dev/deployer read: ${devVerdict}.` : "Dev/deployer data is missing; cannot clear deployer risk.",
    top10 != null ? `Top-10 holder concentration: ${pct(top10)}.` : "Holder concentration is missing.",
  ].filter(Boolean) as string[];
  const bullish = [
    liquidity != null && liquidity > 0 ? `Active liquidity observed: ${money(liquidity)}.` : null,
    honeypot === false ? "Security simulation did not flag a honeypot in checked evidence." : null,
    buyTax != null || sellTax != null ? `Tax evidence loaded: buy ${pct(buyTax)}, sell ${pct(sellTax)}.` : null,
  ].filter(Boolean) as string[];

  return [
    `Verdict: ${verdict}`,
    `Confidence: ${confidence}`,
    "",
    "What ChainLens checked:",
    `- Token scan: ${scan?.status ?? "missing"}`,
    `- Liquidity / LP control: ${liq?.status ?? "missing"}`,
    `- Dev / deployer risk: ${dev?.status ?? "missing"}`,
    "",
    "Market / Pool:",
    `- ${name} (${symbol}) — ${address}`,
    `- Price: ${price == null ? "missing" : `$${price}`}; Liquidity: ${money(liquidity)}; 24h volume: ${money(volume)}`,
    "",
    "Liquidity / LP control:",
    `- ${lpStatus ? lpStatus : "Missing LP control evidence. Do not treat this as safe."}`,
    "",
    "Dev / deployer risk:",
    `- ${devVerdict ? `${devVerdict}${devData.deployerAddress ? ` — deployer ${devData.deployerAddress}` : ""}` : "Missing dev/deployer evidence. No rug history is confirmed from missing data."}`,
    "",
    "Holder / concentration:",
    `- ${top10 != null || holderCount != null ? `Top 10: ${pct(top10)}; holders: ${holderCount ?? "missing"}` : "Missing holder concentration evidence."}`,
    "",
    "Security / honeypot / tax:",
    `- Honeypot: ${honeypot === null ? "missing" : honeypot ? "flagged" : "not flagged in checked evidence"}; buy tax: ${pct(buyTax)}; sell tax: ${pct(sellTax)}`,
    "",
    "Main risks:",
    ...risks.map(r => `- ${r}`),
    "",
    "Bullish/neutral signals:",
    ...(bullish.length ? bullish.map(s => `- ${s}`) : ["- No bullish signal should be inferred from missing evidence."]),
    "",
    "Missing evidence:",
    ...(missing.length ? missing.map(m => `- ${m}`) : ["- None reported by the executed checks, but rescans can still change the read."]),
    "",
    "What to watch next:",
    "- LP/control changes, liquidity drops, tax or transfer-control changes, deployer movement, and holder concentration shifts.",
    "",
    "Not financial advice: this is an evidence report, not a trade call. Do your own risk management before buying, selling, or aping.",
  ].join("\n");
}
