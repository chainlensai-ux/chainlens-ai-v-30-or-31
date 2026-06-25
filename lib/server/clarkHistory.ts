// Pure helpers for Clark chat history: title generation, preview truncation, and metadata
// sanitization. No DB access, no provider calls, no AI calls — title/folder logic is
// rule-based only, per the no-extra-AI-calls requirement.

const ADDRESS_RE = /0x[a-fA-F0-9]{40}/;
const PROVIDER_RE = /goldrush|covalent|geckoterminal|coingecko|dexscreener|alchemy/i;

function shortenAddress(addr: string): string {
  return `${addr.slice(0, 6)}…`;
}

export type ClarkHistoryAppContextLike = {
  tokenSummary?: { address?: string | null } | null;
  walletSummary?: { address?: string | null } | null;
} | null | undefined;

/**
 * Rule-based chat title from the first user prompt — no AI call, no provider lookups.
 * Priority: explicit token/wallet address in the prompt > app context hints > market
 * phrasing > first 48 characters of the prompt.
 */
export function generateChatTitle(prompt: string, appContext?: ClarkHistoryAppContextLike): string {
  const text = String(prompt ?? "").trim();
  const addressMatch = text.match(ADDRESS_RE);
  if (addressMatch) {
    const isWalletWord = /\bwallet\b/i.test(text);
    return isWalletWord ? `Wallet read: ${shortenAddress(addressMatch[0])}` : `Token scan: ${shortenAddress(addressMatch[0])}`;
  }
  const tokenAddr = appContext?.tokenSummary?.address;
  if (typeof tokenAddr === "string" && tokenAddr) return `Token scan: ${shortenAddress(tokenAddr)}`;
  const walletAddr = appContext?.walletSummary?.address;
  if (typeof walletAddr === "string" && walletAddr) return `Wallet read: ${shortenAddress(walletAddr)}`;
  if (/\b(pumping|movers?|momentum|market|trending)\b/i.test(text) && /\bbase\b/i.test(text)) {
    return "Base market read";
  }
  if (/\bwallet\b/i.test(text)) return "Wallet read";
  if (text.length <= 48) return text || "New Clark Chat";
  return `${text.slice(0, 48)}…`;
}

/** Truncates a message for use as a chat-list preview. */
export function buildMessagePreview(text: string, maxLen = 140): string {
  const trimmed = String(text ?? "").trim().replace(/\s+/g, " ");
  if (trimmed.length <= maxLen) return trimmed;
  return `${trimmed.slice(0, maxLen)}…`;
}

export type ClarkSafeMessageMetadata = {
  intent?: string | null;
  chain?: string | null;
  feature?: string | null;
  address?: string | null;
  actions?: Array<{ label: string; href?: string; prompt?: string; kind?: string }>;
  marketContextSummary?: { count: number; topSymbol: string | null } | null;
};

/**
 * Picks only the safe, public fields off a Clark API response to persist as message
 * metadata — never raw provider/debug dumps, never internal field names.
 */
export function sanitizeMessageMetadata(payload: unknown): ClarkSafeMessageMetadata {
  const p = (payload && typeof payload === "object") ? payload as Record<string, unknown> : {};
  const out: ClarkSafeMessageMetadata = {};

  if (typeof p.intent === "string") out.intent = p.intent;
  if (typeof p.chain === "string") out.chain = p.chain;
  if (typeof p.feature === "string") out.feature = p.feature;

  const tokenSummary = (p.tokenSummary && typeof p.tokenSummary === "object") ? p.tokenSummary as Record<string, unknown> : null;
  const walletSummary = (p.walletSummary && typeof p.walletSummary === "object") ? p.walletSummary as Record<string, unknown> : null;
  const addr = (typeof tokenSummary?.address === "string" && tokenSummary.address)
    ?? (typeof walletSummary?.address === "string" && walletSummary.address)
    ?? null;
  if (typeof addr === "string") out.address = addr;

  const ui = (p.ui && typeof p.ui === "object") ? p.ui as Record<string, unknown> : null;
  const rawActions = Array.isArray(ui?.actions) ? ui.actions : null;
  if (rawActions) {
    out.actions = rawActions
      .filter((a): a is Record<string, unknown> => Boolean(a) && typeof a === "object")
      .map((a) => ({
        label: typeof a.label === "string" ? a.label : "",
        ...(typeof a.href === "string" ? { href: a.href } : {}),
        ...(typeof a.prompt === "string" ? { prompt: a.prompt } : {}),
        ...(typeof a.kind === "string" ? { kind: a.kind } : {}),
      }))
      .filter((a) => a.label && !PROVIDER_RE.test(a.label));
  }

  const marketContext = (p.marketContext && typeof p.marketContext === "object") ? p.marketContext as Record<string, unknown> : null;
  const items = Array.isArray(marketContext?.items) ? marketContext.items : null;
  if (items) {
    const first = items[0] as Record<string, unknown> | undefined;
    out.marketContextSummary = {
      count: items.length,
      topSymbol: typeof first?.symbol === "string" ? first.symbol : null,
    };
  }

  return out;
}
