// Shared, client-safe command headers and timeout copy. No Node/server imports —
// Clark surfaces use this when a request times out locally so the badge/body stay
// on the command that was sent, never a generic TOKEN READ.

import { isValidSolanaMintAddress } from "../solanaAddress.ts";

export type ClarkCommandName = "lp" | "token" | "wallet" | "deployer" | "holders" | "explain" | "base";

export type ClarkCommandFormat =
  | "DEPLOYER READ"
  | "HOLDERS READ"
  | "LIQUIDITY CHECK"
  | "TOKEN READ"
  | "WALLET READ"
  | "BASE MARKET READ"
  | "GENERIC";

const EVM_ADDRESS_RE = /\b0x[a-fA-F0-9]{40}\b/;
const TICKER_ON_CHAIN_RE = /\s+on\s+(base|ethereum|eth|bnb|bsc|robinhood|solana)\b.*$/i;
const TICKER_SEARCH_TAG_RE = /\s+#?clkts_[a-z0-9]+/ig;

export type ClarkTokenCommand = {
  input: string;
  address: string | null;
  ticker: string | null;
};

/**
 * Reads the entity explicitly supplied to `/token`.  This deliberately does
 * not consult Clark memory: callers use it to make the current command win
 * over a previously scanned token.
 */
export function parseClarkTokenCommand(prompt: string): ClarkTokenCommand | null {
  const match = String(prompt ?? "").trim().match(/^\/token\s+(.+)$/i);
  if (!match) return null;
  const input = match[1].trim();
  if (!input) return null;
  const evm = input.match(EVM_ADDRESS_RE)?.[0] ?? null;
  if (evm) return { input, address: evm, ticker: null };
  const parts = input.split(/[\s,#]+/).filter(Boolean);
  for (const part of parts) {
    if (isValidSolanaMintAddress(part)) return { input, address: part, ticker: null };
  }
  const ticker = input
    .replace(TICKER_SEARCH_TAG_RE, "")
    .replace(TICKER_ON_CHAIN_RE, "")
    .replace(/^\$/, "")
    .trim();
  return { input, address: null, ticker: ticker || input };
}

/** Whether a scan response belongs to the explicit `/token` command in flight. */
export function doesClarkTokenResponseMatch(
  command: ClarkTokenCommand,
  previousAddress: string | null | undefined,
  responseAddress: string | null | undefined,
  pickerRequired = false,
): boolean {
  if (!responseAddress || pickerRequired) return false;
  if (command.address) return responseAddress.toLowerCase() === command.address.toLowerCase();
  // A ticker picker/resolver may leave session memory unchanged. That old value
  // is not a result for the ticker in the current message.
  return responseAddress.toLowerCase() !== (previousAddress ?? '').toLowerCase();
}

/** Never title a TOKEN READ with "?". Prefer symbol, then short address, then "unverified". */
export function clarkTokenReadHeading(symbolOrName: string | null | undefined, address?: string | null): string {
  const raw = String(symbolOrName ?? "").trim();
  const looksUnknown = !raw || raw === "?" || raw === "(?)" || /^[?( )\s]+$/.test(raw);
  if (!looksUnknown) {
    const cleaned = raw.replace(/\s*\(\?\)$/, "").replace(/\s*\?$/, "").trim();
    if (cleaned && cleaned !== "?") return cleaned;
  }
  const addr = String(address ?? "").trim();
  if (addr.length >= 10) return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  return "unverified";
}

export function parseClarkCommandName(prompt: string): ClarkCommandName | null {
  const t = String(prompt ?? "").trim();
  if (!t) return null;
  if (/^\/explain(?:\s+lp(?:\s|$)|$)/i.test(t)) return "explain";
  if (/^\/deep\s+wallet\b/i.test(t)) return "wallet";
  const slash = t.match(/^\/(lp|token|wallet|deployer|holders|base)\b/i);
  if (slash) return slash[1].toLowerCase() as ClarkCommandName;
  if (/^(?:who\s+deployed|check\s+(?:the\s+)?deployer|deployer\s+(?:of|for|check))\b/i.test(t)) return "deployer";
  if (/^(?:(?:check\s+)?holders?\??|holder\s+(?:check|distribution|concentration)|who\s+holds)\b/i.test(t)) return "holders";
  return null;
}

export function intendedFormatForCommand(command: ClarkCommandName | null): ClarkCommandFormat {
  if (command === "deployer") return "DEPLOYER READ";
  if (command === "holders") return "HOLDERS READ";
  if (command === "lp" || command === "explain") return "LIQUIDITY CHECK";
  if (command === "wallet") return "WALLET READ";
  if (command === "token") return "TOKEN READ";
  if (command === "base") return "BASE MARKET READ";
  return "GENERIC";
}

export function extractClarkCommandAddress(prompt: string): string | null {
  const t = String(prompt ?? "");
  return t.match(EVM_ADDRESS_RE)?.[0] ?? null;
}

export function formatDeployerTimeoutPartial(opts?: { address?: string | null; chain?: string | null }): string {
  const addr = opts?.address ? `Contract: ${opts.address}` : null;
  const chain = opts?.chain ? `Chain: ${opts.chain}` : null;
  return [
    "DEPLOYER READ — partial",
    "",
    "Reason:",
    "Deployer resolver timed out.",
    ...(addr ? [addr] : []),
    ...(chain ? [chain] : []),
    "",
    "Origin wallet was not verified in this pass. This stayed a deployer read — it did not fall through into a token scan.",
    "",
    "Actions:",
    "Retry Deployer / Open Token Scanner",
  ].join("\n");
}

export function formatHoldersTimeoutPartial(opts?: { address?: string | null; chain?: string | null }): string {
  const addr = opts?.address ? `Address: ${opts.address}` : null;
  const chain = opts?.chain ? `Chain: ${opts.chain}` : null;
  return [
    "HOLDERS READ — partial",
    "",
    "Reason:",
    "Holder source timed out.",
    ...(addr ? [addr] : []),
    ...(chain ? [chain] : []),
    "",
    "Holder concentration was not returned in this pass. This stayed a holders read — it did not fall through into a token scan.",
    "",
    "Actions:",
    "Retry Holders / Open Token Scanner",
  ].join("\n");
}

export function formatLpTimeoutPartial(opts?: { address?: string | null; symbol?: string | null }): string {
  const label = opts?.symbol ? opts.symbol.toUpperCase() : "this token";
  return [
    `LIQUIDITY CHECK — partial`,
    `- Token: ${label}`,
    ...(opts?.address ? [`- Address: ${opts.address}`] : []),
    "- Liquidity unavailable: the LP pipeline timed out before evidence could be returned.",
    "- This stayed a liquidity check. It did not fall through into a full token read.",
    "",
    "CTA:",
    "- Open Token Scanner",
    "- Run full LP Safety",
  ].join("\n");
}

export function formatTokenTimeoutPartial(opts?: { address?: string | null; symbol?: string | null; chain?: string | null }): string {
  const symLine = opts?.symbol ? ` (${opts.symbol})` : "";
  return [
    `TOKEN READ — timed out${symLine}`,
    `- Chain: ${opts?.chain ?? "base"}`,
    ...(opts?.address ? [`- Address: ${opts.address}`] : []),
    `- Stage: token scan`,
    `- Reason: Token scan timed out before evidence could be returned.`,
    ``,
    `Paste the contract address in Token Scanner to run the full scan directly.`,
    `CTA: Open Token Scanner / Retry Token Scan`,
  ].join("\n");
}

export function formatWalletTimeoutPartial(): string {
  return [
    "WALLET READ — timed out",
    "- Reason: Wallet scan timed out before data could be returned.",
    "",
    "Open Wallet Scanner and paste the address to run the scan directly.",
    "CTA: Open Wallet Scanner / Retry Wallet Scan",
  ].join("\n");
}

export function formatCommandTimeoutPartial(
  command: ClarkCommandName | null,
  opts?: { address?: string | null; symbol?: string | null; chain?: string | null },
): string {
  const format = intendedFormatForCommand(command);
  if (format === "DEPLOYER READ") return formatDeployerTimeoutPartial(opts);
  if (format === "HOLDERS READ") return formatHoldersTimeoutPartial(opts);
  if (format === "LIQUIDITY CHECK") return formatLpTimeoutPartial(opts);
  if (format === "WALLET READ") return formatWalletTimeoutPartial();
  if (format === "TOKEN READ") return formatTokenTimeoutPartial(opts);
  return "Clark timed out waiting for this scan. Try again.";
}

export function timeoutActionsForCommand(
  command: ClarkCommandName | null,
  address?: string | null,
): Array<{ label: string; prompt?: string; href?: string; kind: "prompt" | "link" }> {
  const href = address
    ? `/terminal/token-scanner?address=${encodeURIComponent(address)}`
    : "/terminal/token-scanner";
  if (command === "deployer") {
    return [
      { label: "Retry Deployer", prompt: address ? `/deployer ${address}` : "/deployer", kind: "prompt" },
      { label: "Open Token Scanner", href, kind: "link" },
    ];
  }
  if (command === "holders") {
    return [
      { label: "Retry Holders", prompt: address ? `/holders ${address}` : "/holders", kind: "prompt" },
      { label: "Open Token Scanner", href, kind: "link" },
    ];
  }
  if (command === "lp" || command === "explain") {
    return [
      { label: "Retry LP", prompt: address ? `/lp ${address}` : "/lp", kind: "prompt" },
      { label: "Open Token Scanner", href, kind: "link" },
    ];
  }
  if (command === "wallet") {
    return [
      { label: "Retry Wallet Scan", prompt: address ? `/wallet ${address}` : "/wallet", kind: "prompt" },
      { label: "Open Wallet Scanner", href: "/terminal/wallet-scanner", kind: "link" },
    ];
  }
  return [
    { label: "Retry Token Scan", prompt: address ? `/token ${address}` : "/token", kind: "prompt" },
    { label: "Open Token Scanner", href, kind: "link" },
  ];
}

export function responseModeFromText(text: string): ClarkCommandFormat {
  const head = String(text ?? "").split("\n")[0] ?? "";
  if (/^DEPLOYER READ/i.test(head)) return "DEPLOYER READ";
  if (/^HOLDERS READ/i.test(head)) return "HOLDERS READ";
  if (/^LIQUIDITY CHECK|^LP (?:READ|CHECK)/i.test(head)) return "LIQUIDITY CHECK";
  if (/^WALLET READ/i.test(head)) return "WALLET READ";
  if (/^TOKEN READ/i.test(head)) return "TOKEN READ";
  if (/^BASE MARKET READ/i.test(head)) return "BASE MARKET READ";
  return "GENERIC";
}

/** True when a command must never be rewritten as TOKEN READ, even on timeout. */
export function commandForbidsTokenReadFallback(command: ClarkCommandName | null): boolean {
  return command === "deployer" || command === "holders" || command === "lp" || command === "explain";
}
