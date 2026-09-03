// Server-side Clark request identity, singleflight, and command-fallback audits.
// Pure enough for unit tests (tsx). Does not import Next.js or route.ts.

import {
  commandForbidsTokenReadFallback,
  extractClarkCommandAddress,
  formatCommandTimeoutPartial,
  formatDeployerTimeoutPartial,
  formatHoldersTimeoutPartial,
  formatLpTimeoutPartial,
  intendedFormatForCommand,
  parseClarkCommandName,
  responseModeFromText,
  timeoutActionsForCommand,
  type ClarkCommandFormat,
  type ClarkCommandName,
} from "../clark/commandFormats.ts";
import {
  classifyClarkPrompt,
  extractRequestedChainFromPrompt,
  isDeployerCheckPrompt,
  isForcedLiquidityCheckPrompt,
  isHoldersCheckPrompt,
  parseClarkSlashCommand,
} from "./clarkRouting.ts";

export const CLARK_SINGLEFLIGHT_TTL_MS = 4_000;
// TIMEOUT-MISMATCH FIX, DISCLOSED (reported live: "/holders 0x...4a01" reliably returned "Holder
// source timed out" — reproduced). Root cause: app/api/clark/route.ts's /holders handler races
// resolveTokenForFollowup() against this constant, but resolveTokenForFollowup() internally calls
// fetchTokenEvidence(), which itself waits up to TOKEN_CORE_TIMEOUT_MS (18_000ms, app/api/clark/
// route.ts) for the real /api/token call — the ONE place in this file using Promise.race() to
// wrap an operation with its own longer internal timeout. At the old 12_000ms value, the outer
// race timer fired before the inner 18s token-evidence timeout ever had a chance to resolve on
// its own, so a normal, still-succeeding scan (12s–18s) was reported as "timed out" every time —
// never a genuinely broken source. Raised to comfortably exceed TOKEN_CORE_TIMEOUT_MS with margin
// for the (fast, ~3.5s-capped) honeypot call this same fetchTokenEvidence() call runs in parallel.
// /api/dev-wallet (used by /deployer) is provisioned for up to 60s (vercel.json's own
// maxDuration:60 for that route) — the same class of premature-timeout risk applied there at the
// old 12s value, just less consistently reproduced; raised to the same value for consistency.
export const CLARK_DEPLOYER_SOURCE_TIMEOUT_MS = 20_000;
export const CLARK_HOLDERS_SOURCE_TIMEOUT_MS = 20_000;

export {
  formatCommandTimeoutPartial,
  formatDeployerTimeoutPartial,
  formatHoldersTimeoutPartial,
  formatLpTimeoutPartial,
  timeoutActionsForCommand,
  commandForbidsTokenReadFallback,
  responseModeFromText,
  intendedFormatForCommand,
  parseClarkCommandName,
};

export function normalizeClarkRequestId(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value.trim().slice(0, 80);
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `clk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export type ClarkCommandIdentity = {
  command: ClarkCommandName | null;
  intent: string;
  address: string | null;
  chain: string | null;
  intendedFormat: ClarkCommandFormat;
  routeSelected: string;
};

export function resolveClarkCommandIdentity(prompt: string, chainHint?: string | null): ClarkCommandIdentity {
  const raw = String(prompt ?? "");
  const slash = parseClarkSlashCommand(raw);
  const classified = (() => {
    try { return classifyClarkPrompt(raw); }
    catch { return { intent: "none", address: null, symbol: null }; }
  })();
  const command = slash?.command ?? parseClarkCommandName(raw);
  const address = slash?.address ?? classified.address ?? extractClarkCommandAddress(raw);
  const chain = extractRequestedChainFromPrompt(raw) ?? chainHint ?? null;
  const intent = slash?.intent ?? classified.intent ?? "none";
  const intendedFormat = intendedFormatForCommand(command);
  const routeSelected =
    command === "deployer" || intent === "deployer_check" ? "deployer_check"
    : command === "holders" || intent === "holders_check" ? "holders_check"
    : command === "lp" || command === "explain" || intent === "liquidity_scan" || intent === "lp_lock_check" ? "liquidity_scan"
    : command === "wallet" || intent === "wallet_scan" ? "wallet_scan"
    : command === "token" || intent === "token_scan" ? "token_scan"
    : intent;
  return { command, intent: String(intent), address, chain, intendedFormat, routeSelected };
}

export function clarkSingleflightKey(command: string | null, address: string | null, chain: string | null): string | null {
  if (!command || !address) return null;
  return `${command.toLowerCase()}|${address.toLowerCase()}|${String(chain ?? "").toLowerCase()}`;
}

type FlightEntry<T> = {
  promise: Promise<T>;
  value?: T;
  completedAt?: number;
};

const flights = new Map<string, FlightEntry<unknown>>();

export type ClarkSingleflightResult<T> = {
  value: T;
  duplicatePrevented: boolean;
  cacheHit: boolean;
};

function cloneValue<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    try { return JSON.parse(JSON.stringify(value)) as T; }
    catch { return value; }
  }
}

export async function runClarkSingleflight<T>(
  key: string | null,
  fn: () => Promise<T>,
): Promise<ClarkSingleflightResult<T>> {
  if (!key) {
    return { value: await fn(), duplicatePrevented: false, cacheHit: false };
  }
  const now = Date.now();
  const existing = flights.get(key) as FlightEntry<T> | undefined;
  if (existing) {
    if (existing.completedAt && existing.value !== undefined && now - existing.completedAt < CLARK_SINGLEFLIGHT_TTL_MS) {
      return { value: cloneValue(existing.value), duplicatePrevented: true, cacheHit: true };
    }
    if (!existing.completedAt) {
      const value = await existing.promise;
      return { value: cloneValue(value), duplicatePrevented: true, cacheHit: false };
    }
  }
  const entry: FlightEntry<T> = { promise: fn() };
  flights.set(key, entry as FlightEntry<unknown>);
  try {
    const value = await entry.promise;
    entry.value = value;
    entry.completedAt = Date.now();
    setTimeout(() => {
      const cur = flights.get(key);
      if (cur === (entry as FlightEntry<unknown>)) flights.delete(key);
    }, CLARK_SINGLEFLIGHT_TTL_MS);
    return { value, duplicatePrevented: false, cacheHit: false };
  } catch (err) {
    flights.delete(key);
    throw err;
  }
}

export function resetClarkSingleflightForTests(): void {
  flights.clear();
}

export type ClarkRequestLifecycleAudit = {
  requestId: string;
  messageId: string;
  prompt: string;
  command: ClarkCommandName | null;
  address: string | null;
  chain: string | null;
  routeSelected: string;
  startedAt: number;
  firstUiFeedbackMs: number | null;
  sourcesStarted: string[];
  sourcesCompleted: string[];
  sourcesTimedOut: string[];
  finalResponseMode: string;
  staleResponseIgnored: boolean;
  duplicateClickBlocked: boolean;
  durationMs: number;
};

export type ClarkCommandFallbackAudit = {
  command: ClarkCommandName | null;
  primaryRoute: string;
  fallbackRoutesAttempted: string[];
  fallbackAllowed: boolean;
  finalResponseMode: string;
  fallbackReason: string | null;
};

export function buildClarkRequestLifecycleAudit(input: {
  requestId: string;
  prompt: string;
  identity: ClarkCommandIdentity;
  startedAt: number;
  finalText: string;
  duplicatePrevented?: boolean;
  cacheHit?: boolean;
  timedOut?: boolean;
  sourcesStarted?: string[];
  sourcesCompleted?: string[];
  sourcesTimedOut?: string[];
}): ClarkRequestLifecycleAudit {
  const durationMs = Date.now() - input.startedAt;
  return {
    requestId: input.requestId,
    messageId: input.requestId,
    prompt: input.prompt,
    command: input.identity.command,
    address: input.identity.address,
    chain: input.identity.chain,
    routeSelected: input.identity.routeSelected,
    startedAt: input.startedAt,
    firstUiFeedbackMs: input.cacheHit || input.duplicatePrevented ? durationMs : Math.min(durationMs, 80),
    sourcesStarted: input.sourcesStarted ?? [],
    sourcesCompleted: input.sourcesCompleted ?? [],
    sourcesTimedOut: input.sourcesTimedOut ?? (input.timedOut ? [input.identity.routeSelected] : []),
    finalResponseMode: responseModeFromText(input.finalText) || input.identity.intendedFormat,
    staleResponseIgnored: false,
    duplicateClickBlocked: Boolean(input.duplicatePrevented),
    durationMs,
  };
}

export function buildClarkCommandFallbackAudit(input: {
  identity: ClarkCommandIdentity;
  finalText: string;
  timedOut?: boolean;
  fallbackReason?: string | null;
  fallbackRoutesAttempted?: string[];
}): ClarkCommandFallbackAudit {
  const finalResponseMode = responseModeFromText(input.finalText) || input.identity.intendedFormat;
  const tokenFallback = finalResponseMode === "TOKEN READ" && commandForbidsTokenReadFallback(input.identity.command);
  return {
    command: input.identity.command,
    primaryRoute: input.identity.routeSelected,
    fallbackRoutesAttempted: input.fallbackRoutesAttempted ?? [],
    fallbackAllowed: !commandForbidsTokenReadFallback(input.identity.command),
    finalResponseMode,
    fallbackReason: tokenFallback
      ? "blocked_token_read_fallback"
      : (input.fallbackReason ?? (input.timedOut ? "timeout_partial" : null)),
  };
}

export type ClarkTimeoutFallback = {
  intentBadge: string;
  reply: string;
  actions: Array<{ label: string; prompt?: string; href?: string; kind: "prompt" | "link" }>;
  kind: "deployer" | "holders" | "liquidity" | "token" | "wallet" | "market" | "generic";
};

export function resolveClarkTimeoutFallback(prompt: string, opts?: {
  isTimeout?: boolean;
  errMsg?: string;
  chain?: string | null;
  symbol?: string | null;
  routeHint?: "token" | "wallet" | "ambiguous" | "none";
  classifiedIntent?: string;
}): ClarkTimeoutFallback {
  const identity = resolveClarkCommandIdentity(prompt, opts?.chain ?? null);
  const isTimeout = opts?.isTimeout !== false;
  const addr = identity.address;
  const chain = identity.chain ?? opts?.chain ?? null;

  if (
    identity.command === "deployer" ||
    identity.intent === "deployer_check" ||
    isDeployerCheckPrompt(prompt)
  ) {
    return {
      kind: "deployer",
      intentBadge: "deployer_check",
      reply: formatDeployerTimeoutPartial({ address: addr, chain }),
      actions: timeoutActionsForCommand("deployer", addr),
    };
  }
  if (
    identity.command === "holders" ||
    identity.intent === "holders_check" ||
    isHoldersCheckPrompt(prompt)
  ) {
    return {
      kind: "holders",
      intentBadge: "holders_check",
      reply: formatHoldersTimeoutPartial({ address: addr, chain }),
      actions: timeoutActionsForCommand("holders", addr),
    };
  }
  if (
    identity.command === "lp" ||
    identity.command === "explain" ||
    identity.intent === "liquidity_scan" ||
    identity.intent === "lp_lock_check" ||
    isForcedLiquidityCheckPrompt(prompt)
  ) {
    return {
      kind: "liquidity",
      intentBadge: "liquidity_scan",
      reply: formatLpTimeoutPartial({ address: addr, symbol: opts?.symbol ?? null }),
      actions: timeoutActionsForCommand("lp", addr),
    };
  }

  const classified = opts?.classifiedIntent ?? identity.intent;
  const TOKEN_INTENTS = new Set(["token_scan", "token_safety", "dev_rug_check", "risk_explanation"]);
  const WALLET_INTENTS = new Set(["wallet_scan", "wallet_pnl_followup", "wallet_compare", "wallet_dig_deeper"]);
  const MARKET_INTENTS = new Set(["base_radar", "base_market_discovery", "whale_alert"]);
  const rh = opts?.routeHint ?? "none";

  if (TOKEN_INTENTS.has(classified) || (rh === "token" && !WALLET_INTENTS.has(classified))) {
    return {
      kind: "token",
      intentBadge: "token_scan",
      reply: formatCommandTimeoutPartial("token", { address: addr, symbol: opts?.symbol ?? null, chain }),
      actions: timeoutActionsForCommand("token", addr),
    };
  }
  if (WALLET_INTENTS.has(classified) || rh === "wallet") {
    return {
      kind: "wallet",
      intentBadge: "Wallet Scan",
      reply: formatCommandTimeoutPartial("wallet"),
      actions: timeoutActionsForCommand("wallet", addr),
    };
  }
  if (MARKET_INTENTS.has(classified)) {
    return {
      kind: "market",
      intentBadge: "base_radar",
      reply: [
        "BASE MARKET READ — could not complete",
        `- Reason: ${isTimeout ? "timed out before live market data returned" : (opts?.errMsg ?? "market read failed")}.`,
        "",
        "CTA: Open Base Radar / Refresh Market Data",
      ].join("\n"),
      actions: [
        { label: "Open Base Radar", href: "/terminal/base-radar", kind: "link" },
        { label: "Refresh Market Data", prompt: "what's pumping on Base?", kind: "prompt" },
      ],
    };
  }
  void isTimeout;
  return {
    kind: "generic",
    intentBadge: classified || "unknown",
    reply: formatCommandTimeoutPartial(identity.command, { address: addr, chain }),
    actions: timeoutActionsForCommand(identity.command, addr),
  };
}

export function assertCommandStayedOnFormat(command: ClarkCommandName | null, text: string): boolean {
  if (!commandForbidsTokenReadFallback(command)) return true;
  const mode = responseModeFromText(text);
  if (command === "deployer") return mode === "DEPLOYER READ";
  if (command === "holders") return mode === "HOLDERS READ";
  if (command === "lp" || command === "explain") return mode === "LIQUIDITY CHECK";
  return true;
}
