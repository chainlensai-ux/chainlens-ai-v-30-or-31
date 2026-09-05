// Ticker picker identity: option buttons and "scan 1" must hit the displayed
// token, never a memory guess or a stale search.

import { TICKER_CHAIN_IDS, normalizeTickerChain } from "../tickerResolverCore.ts";

export type ClarkTickerPickerMatch = {
  name: string | null;
  symbol: string | null;
  chainSlug: string;
  chainId?: number;
  tokenAddress: string;
  pairAddress: string | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  volume24hUsd: number | null;
  confidence: number;
  tickerSearchId?: string;
  displayedIndex?: number;
};

export type TickerSelectionAudit = {
  tickerSearchId: string | null;
  selectedIndex: number | null;
  displayedTokenAddress: string | null;
  displayedChainId: number | null;
  scannerPayloadTokenAddress: string | null;
  scannerPayloadChainId: number | null;
  selectionMatchesDisplayedOption: boolean;
  staleSearchIgnored: boolean;
  finalStatus: "selected" | "stale_search" | "out_of_range" | "no_picker" | "direct_address" | "need_chain_choice";
};

export type ClarkRouteIntentAudit = {
  rawMessage: string;
  parsedIntent: string | null;
  command: string | null;
  requestedInput: string | null;
  activeTokenBefore: string | null;
  activeWalletBefore: string | null;
  selectedChain: string | null;
  finalRoute: string | null;
  reason: string | null;
};

const NUMBERED_TICKER_RE = /^(?:scan\s*)?(\d+)(?:\s+#?clkts_[a-z0-9]+)?$/i;
const NAMED_CHAIN_RE = /^(?:scan\s+)?(?:the\s+)?(base|ethereum|eth|bnb|bsc|robinhood|solana)(?:\s+one)?(?:\s+#?clkts_[a-z0-9]+)?$/i;
const TOKEN_CA_RE = /^\/token\s+(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})\b/i;
const SEARCH_ID_RE = /#?(clkts_[a-z0-9]+)/i;

export function createTickerSearchId(): string {
  return `clkts_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function tickerChainPromptSlug(chainSlug: string): string {
  const n = normalizeTickerChain(chainSlug);
  if (n === "eth") return "ethereum";
  if (n === "bnb") return "bnb";
  if (n === "robinhood") return "robinhood";
  if (n === "solana") return "solana";
  return "base";
}

export function tickerChainId(chainSlug: string, chainId?: number | null): number {
  if (typeof chainId === "number" && Number.isFinite(chainId)) return chainId;
  const n = normalizeTickerChain(chainSlug);
  return n ? TICKER_CHAIN_IDS[n] : TICKER_CHAIN_IDS.base;
}

export function extractTickerSearchId(prompt: string): string | null {
  return String(prompt ?? "").match(SEARCH_ID_RE)?.[1] ?? null;
}

export function stampTickerPickerMatches(
  matches: ClarkTickerPickerMatch[],
  tickerSearchId: string,
): ClarkTickerPickerMatch[] {
  return matches.slice(0, 6).map((match, index) => ({
    ...match,
    tickerSearchId,
    displayedIndex: index + 1,
    chainId: tickerChainId(match.chainSlug, match.chainId),
  }));
}

export function buildTickerPickerScanPrompt(match: ClarkTickerPickerMatch, tickerSearchId?: string): string {
  const id = tickerSearchId ?? match.tickerSearchId;
  const base = `/token ${match.tokenAddress} on ${tickerChainPromptSlug(match.chainSlug)}`;
  return id ? `${base} #${id}` : base;
}

export function buildTickerPickerActions(matches: ClarkTickerPickerMatch[], tickerSearchId: string) {
  return stampTickerPickerMatches(matches, tickerSearchId).map((match) => ({
    label: `Scan ${match.displayedIndex}`,
    prompt: buildTickerPickerScanPrompt(match, tickerSearchId),
    kind: "prompt" as const,
    tokenAddress: match.tokenAddress,
    chainId: match.chainId as number,
    chainSlug: match.chainSlug,
    tickerSearchId,
    selectedIndex: match.displayedIndex as number,
  }));
}

export function parseTickerSelectionPrompt(prompt: string): {
  selectedIndex: number | null;
  namedChain: string | null;
  tokenAddress: string | null;
  chainSlug: string | null;
  tickerSearchId: string | null;
} {
  const t = String(prompt ?? "").trim();
  const numbered = t.match(NUMBERED_TICKER_RE);
  const named = NAMED_CHAIN_RE.exec(t);
  const ca = t.match(TOKEN_CA_RE);
  const wantedChain = named
    ? (named[1].toLowerCase() === "ethereum" ? "eth" : named[1].toLowerCase() === "bsc" ? "bnb" : named[1].toLowerCase())
    : null;
  const onChain = t.match(/\bon\s+(base|ethereum|eth|bnb|bsc|robinhood|solana)\b/i);
  const promptChain = onChain
    ? (onChain[1].toLowerCase() === "ethereum" ? "eth" : onChain[1].toLowerCase() === "bsc" ? "bnb" : onChain[1].toLowerCase())
    : null;
  return {
    selectedIndex: numbered ? Number(numbered[1]) : null,
    namedChain: wantedChain,
    tokenAddress: ca?.[1] ?? null,
    chainSlug: promptChain,
    tickerSearchId: extractTickerSearchId(t),
  };
}

function emptyAudit(
  status: TickerSelectionAudit["finalStatus"],
  parsed: ReturnType<typeof parseTickerSelectionPrompt>,
  currentId: string | null,
  extra?: Partial<TickerSelectionAudit>,
): TickerSelectionAudit {
  return {
    tickerSearchId: currentId,
    selectedIndex: parsed.selectedIndex,
    displayedTokenAddress: null,
    displayedChainId: null,
    scannerPayloadTokenAddress: parsed.tokenAddress,
    scannerPayloadChainId: parsed.chainSlug ? tickerChainId(parsed.chainSlug) : null,
    selectionMatchesDisplayedOption: false,
    staleSearchIgnored: status === "stale_search",
    finalStatus: status,
    ...extra,
  };
}

export function resolveTickerPickerSelection(input: {
  prompt: string;
  matches: ClarkTickerPickerMatch[] | null | undefined;
  tickerSearchId?: string | null;
  incomingSearchId?: string | null;
}): {
  picked: ClarkTickerPickerMatch | null;
  chainMatches: ClarkTickerPickerMatch[];
  audit: TickerSelectionAudit;
  rewritePrompt: string | null;
  stale: boolean;
  outOfRange: boolean;
  isPickerCommand: boolean;
} {
  const parsed = parseTickerSelectionPrompt(input.prompt);
  const matches = (input.matches ?? []).filter((row) => Boolean(row?.tokenAddress));
  const currentId = input.tickerSearchId ?? matches[0]?.tickerSearchId ?? null;
  const incomingId = input.incomingSearchId ?? parsed.tickerSearchId;
  const isNumbered = parsed.selectedIndex != null;
  const isNamed = Boolean(parsed.namedChain);
  const isCaFromPicker = Boolean(parsed.tokenAddress) && matches.some((row) => row.tokenAddress.toLowerCase() === parsed.tokenAddress!.toLowerCase());
  const isPickerCommand = isNumbered || isNamed || Boolean(incomingId && (isNumbered || isNamed || isCaFromPicker));

  const none = {
    picked: null as ClarkTickerPickerMatch | null,
    chainMatches: [] as ClarkTickerPickerMatch[],
    rewritePrompt: null as string | null,
    stale: false,
    outOfRange: false,
    isPickerCommand,
  };

  if (incomingId && currentId && incomingId !== currentId && (isNumbered || isNamed || isCaFromPicker)) {
    return { ...none, isPickerCommand: true, stale: true, audit: emptyAudit("stale_search", parsed, currentId) };
  }

  if (!isNumbered && !isNamed && !isCaFromPicker) {
    return {
      ...none,
      isPickerCommand: false,
      audit: emptyAudit(parsed.tokenAddress ? "direct_address" : "no_picker", parsed, currentId),
    };
  }

  if (!matches.length) {
    return { ...none, isPickerCommand: isNumbered || isNamed, audit: emptyAudit("no_picker", parsed, currentId) };
  }

  if (parsed.namedChain) {
    const chainMatches = matches.filter((row) => {
      const slug = normalizeTickerChain(row.chainSlug) ?? row.chainSlug;
      return slug === parsed.namedChain || row.chainSlug === parsed.namedChain;
    });
    if (chainMatches.length > 1) {
      return {
        picked: null,
        chainMatches,
        rewritePrompt: null,
        stale: false,
        outOfRange: false,
        isPickerCommand: true,
        audit: emptyAudit("need_chain_choice", parsed, currentId, {
          displayedTokenAddress: chainMatches[0].tokenAddress,
          displayedChainId: tickerChainId(chainMatches[0].chainSlug, chainMatches[0].chainId),
        }),
      };
    }
    if (chainMatches.length === 1) {
      const picked = chainMatches[0];
      return {
        picked,
        chainMatches,
        rewritePrompt: buildTickerPickerScanPrompt(picked, currentId ?? picked.tickerSearchId),
        stale: false,
        outOfRange: false,
        isPickerCommand: true,
        audit: {
          tickerSearchId: currentId,
          selectedIndex: picked.displayedIndex ?? 1,
          displayedTokenAddress: picked.tokenAddress,
          displayedChainId: tickerChainId(picked.chainSlug, picked.chainId),
          scannerPayloadTokenAddress: picked.tokenAddress,
          scannerPayloadChainId: tickerChainId(picked.chainSlug, picked.chainId),
          selectionMatchesDisplayedOption: true,
          staleSearchIgnored: false,
          finalStatus: "selected",
        },
      };
    }
    return { ...none, isPickerCommand: true, outOfRange: true, audit: emptyAudit("out_of_range", parsed, currentId) };
  }

  let picked: ClarkTickerPickerMatch | null = null;
  if (parsed.tokenAddress) {
    picked = matches.find((row) => row.tokenAddress.toLowerCase() === parsed.tokenAddress!.toLowerCase()) ?? null;
  } else if (parsed.selectedIndex != null) {
    picked = matches[parsed.selectedIndex - 1] ?? null;
    if (!picked) {
      return { ...none, isPickerCommand: true, outOfRange: true, audit: emptyAudit("out_of_range", parsed, currentId) };
    }
  }

  if (!picked) {
    return { ...none, isPickerCommand: true, outOfRange: true, audit: emptyAudit("out_of_range", parsed, currentId) };
  }

  return {
    picked,
    chainMatches: [],
    rewritePrompt: `/token ${picked.tokenAddress} on ${tickerChainPromptSlug(picked.chainSlug)}`,
    stale: false,
    outOfRange: false,
    isPickerCommand: true,
    audit: {
      tickerSearchId: currentId,
      selectedIndex: parsed.selectedIndex ?? picked.displayedIndex ?? null,
      displayedTokenAddress: picked.tokenAddress,
      displayedChainId: tickerChainId(picked.chainSlug, picked.chainId),
      scannerPayloadTokenAddress: picked.tokenAddress,
      scannerPayloadChainId: tickerChainId(picked.chainSlug, picked.chainId),
      selectionMatchesDisplayedOption: true,
      staleSearchIgnored: false,
      finalStatus: "selected",
    },
  };
}

export function buildClarkRouteIntentAudit(input: {
  rawMessage: string;
  parsedIntent?: string | null;
  command?: string | null;
  requestedInput?: string | null;
  activeTokenBefore?: string | null;
  activeWalletBefore?: string | null;
  selectedChain?: string | null;
  finalRoute?: string | null;
  reason?: string | null;
}): ClarkRouteIntentAudit {
  return {
    rawMessage: input.rawMessage,
    parsedIntent: input.parsedIntent ?? null,
    command: input.command ?? null,
    requestedInput: input.requestedInput ?? null,
    activeTokenBefore: input.activeTokenBefore ?? null,
    activeWalletBefore: input.activeWalletBefore ?? null,
    selectedChain: input.selectedChain ?? null,
    finalRoute: input.finalRoute ?? null,
    reason: input.reason ?? null,
  };
}
