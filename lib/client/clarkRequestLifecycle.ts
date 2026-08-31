// Client-side Clark request gate: one in-flight request per send, latest wins,
// double-click of the same prompt is dropped, stale responses are ignored.

import { CLARK_FETCH_TIMEOUT_MS } from "./clarkAiLive";
import {
  extractClarkCommandAddress,
  formatCommandTimeoutPartial,
  parseClarkCommandName,
  timeoutActionsForCommand,
  type ClarkCommandName,
} from "../clark/commandFormats";

export function generateClarkRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `clk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function mergeClarkAbortSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const anyFn = (AbortSignal as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === "function") return anyFn([a, b]);
  const extra = new AbortController();
  const abort = () => extra.abort();
  if (a.aborted || b.aborted) {
    extra.abort();
    return extra.signal;
  }
  a.addEventListener("abort", abort, { once: true });
  b.addEventListener("abort", abort, { once: true });
  return extra.signal;
}

export function clarkFetchSignal(gateSignal: AbortSignal, timeoutMs = CLARK_FETCH_TIMEOUT_MS): AbortSignal {
  return mergeClarkAbortSignals(gateSignal, AbortSignal.timeout(timeoutMs));
}

export type ClarkBeginRequestResult =
  | {
      proceed: false;
      duplicatePrevented: true;
      requestId: string;
      reason: "duplicate_in_flight";
    }
  | {
      proceed: true;
      duplicatePrevented: false;
      requestId: string;
      abortSignal: AbortSignal;
      abortedPrevious: boolean;
      command: ClarkCommandName | null;
      address: string | null;
    };

export type ClarkRequestLifecycleAudit = {
  requestId: string;
  messageId: string;
  prompt: string;
  command: ClarkCommandName | null;
  address: string | null;
  chain: string | null;
  routeSelected: string | null;
  startedAt: number;
  firstUiFeedbackMs: number | null;
  sourcesStarted: string[];
  sourcesCompleted: string[];
  sourcesTimedOut: string[];
  finalResponseMode: string | null;
  staleResponseIgnored: boolean;
  duplicateClickBlocked: boolean;
  durationMs: number;
};

export function createClarkRequestGate(opts?: { duplicateWindowMs?: number }) {
  const duplicateWindowMs = opts?.duplicateWindowMs ?? 2_500;
  let latestRequestId: string | null = null;
  let inFlightText: string | null = null;
  let inFlightStartedAt = 0;
  let controller: AbortController | null = null;
  let ignoredStale = 0;
  let duplicatesBlocked = 0;

  function begin(text: string): ClarkBeginRequestResult {
    const now = Date.now();
    const trimmed = String(text ?? "").trim();
    const sameInFlight =
      Boolean(latestRequestId) &&
      inFlightText === trimmed &&
      now - inFlightStartedAt < duplicateWindowMs &&
      controller != null &&
      !controller.signal.aborted;
    if (sameInFlight && latestRequestId) {
      duplicatesBlocked += 1;
      return {
        proceed: false,
        duplicatePrevented: true,
        requestId: latestRequestId,
        reason: "duplicate_in_flight",
      };
    }
    const abortedPrevious = Boolean(controller && !controller.signal.aborted);
    if (controller) {
      try { controller.abort(); } catch { /* already aborted */ }
    }
    controller = new AbortController();
    const requestId = generateClarkRequestId();
    latestRequestId = requestId;
    inFlightText = trimmed;
    inFlightStartedAt = now;
    return {
      proceed: true,
      duplicatePrevented: false,
      requestId,
      abortSignal: controller.signal,
      abortedPrevious,
      command: parseClarkCommandName(trimmed),
      address: extractClarkCommandAddress(trimmed),
    };
  }

  function shouldApply(requestId: string): boolean {
    const match = requestId === latestRequestId;
    if (!match) ignoredStale += 1;
    return match;
  }

  function complete(requestId: string): boolean {
    if (requestId !== latestRequestId) return false;
    inFlightText = null;
    return true;
  }

  function bumpSession(): void {
    if (controller) {
      try { controller.abort(); } catch { /* already aborted */ }
    }
    controller = null;
    latestRequestId = null;
    inFlightText = null;
  }

  function getLatestRequestId(): string | null {
    return latestRequestId;
  }

  function snapshot(input: {
    requestId: string;
    prompt: string;
    command?: ClarkCommandName | null;
    address?: string | null;
    chain?: string | null;
    routeSelected?: string | null;
    startedAt: number;
    firstUiFeedbackMs?: number | null;
    finalResponseMode?: string | null;
    staleResponseIgnored?: boolean;
    duplicateClickBlocked?: boolean;
    sourcesStarted?: string[];
    sourcesCompleted?: string[];
    sourcesTimedOut?: string[];
  }): ClarkRequestLifecycleAudit {
    return {
      requestId: input.requestId,
      messageId: input.requestId,
      prompt: input.prompt,
      command: input.command ?? parseClarkCommandName(input.prompt),
      address: input.address ?? extractClarkCommandAddress(input.prompt),
      chain: input.chain ?? null,
      routeSelected: input.routeSelected ?? null,
      startedAt: input.startedAt,
      firstUiFeedbackMs: input.firstUiFeedbackMs ?? 0,
      sourcesStarted: input.sourcesStarted ?? [],
      sourcesCompleted: input.sourcesCompleted ?? [],
      sourcesTimedOut: input.sourcesTimedOut ?? [],
      finalResponseMode: input.finalResponseMode ?? null,
      staleResponseIgnored: input.staleResponseIgnored ?? false,
      duplicateClickBlocked: input.duplicateClickBlocked ?? false,
      durationMs: Date.now() - input.startedAt,
    };
  }

  function stats() {
    return { ignoredStale, duplicatesBlocked, latestRequestId };
  }

  return { begin, shouldApply, complete, bumpSession, getLatestRequestId, snapshot, stats };
}

export type ClarkRequestGate = ReturnType<typeof createClarkRequestGate>;

export function clientTimeoutReply(prompt: string): {
  text: string;
  intentBadge: string;
  actions: Array<{ label: string; prompt?: string; href?: string; kind: "prompt" | "link" }>;
} {
  const command = parseClarkCommandName(prompt);
  const address = extractClarkCommandAddress(prompt);
  const text = formatCommandTimeoutPartial(command, { address });
  const format = text.split("\n")[0] ?? "Clark";
  return {
    text,
    intentBadge: format.replace(/\s+—.*$/, "").trim() || "Clark",
    actions: timeoutActionsForCommand(command, address),
  };
}
