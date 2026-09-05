// CLARK TICKER OPTION SELECTION, DISCLOSED (bug report: "/token cashcat" showed CASHCAT matches,
// but clicking/typing "scan 1" scanned an unrelated token, Base Juice/BASEJUICE).
//
// ROOT CAUSE: app/api/clark/route.ts had THREE independent places that built a ticker-match picker
// (the "/token <symbol>" ambiguous-resolution branch, the executeClarkToolPlan tokenResolve branch,
// and a chain-filter re-picker), all writing the SAME session-memory slot
// (ClarkSessionMemory.lastTickerMatches) with no identifier tying a specific rendered picker to the
// matches a later "scan N" reply should resolve against. Two problems followed from that:
//   1. The "Scan N" buttons sent nothing but the literal text "scan 1" — the server had no way to
//      confirm the button click belonged to the search whose options are still on screen; it just
//      trusted whatever `lastTickerMatches` happened to hold in session memory at the moment the
//      reply arrived.
//   2. Two concurrent Clark requests for the same session (e.g. a user tapping quickly, or a
//      client retry racing the original request) could interleave: an OLDER search's matches could
//      still be in session memory when a NEWER search's own resolution hadn't finished writing yet,
//      or a stale "scan 1" click for a search the user has since replaced with a new "/token"
//      command could still resolve against whatever is CURRENTLY in memory, even if that's a
//      different token's match list. Session memory in this file is a single mutable slot with no
//      generation/identity check, so nothing rejected a request that belonged to an OLDER search.
//
// FIX: every ticker match list gets a unique, unguessable `tickerSearchId` the moment it is shown.
// Session memory stores exactly ONE (matches, searchId) pair — always replaced atomically together,
// never one without the other. A "Scan N" button click carries that exact searchId + optionIndex +
// tokenAddress + chainId back to the server; resolveTickerSelection here is the single, pure
// arbiter that verifies the click is for the CURRENT search (never an older one) and that the
// option it names is EXACTLY the option at that index in the current match list (defense in depth
// against a tampered/stale payload) before anything is allowed to scan. This module never reads
// activeToken/lastToken — ticker option selection is deliberately independent of whatever token was
// scanned before, so an option click can never be redirected by leftover "active token" context.

export type ClarkTickerMatch = {
  name: string | null
  symbol: string | null
  chainSlug: string
  tokenAddress: string
  pairAddress: string | null
  liquidityUsd: number | null
  marketCapUsd: number | null
  fdvUsd: number | null
  volume24hUsd: number | null
  confidence: number
}

// Mirrors lib/server/clarkContextResolver.ts's CLARK_CHAIN_IDS — kept as an independent, narrow
// copy here (rather than importing that module) so this module stays a small, single-purpose,
// dependency-free unit exactly like clarkContextResolver.ts itself.
const CLARK_TICKER_CHAIN_IDS: Record<string, number | null> = {
  base: 8453,
  eth: 1,
  ethereum: 1,
  bnb: 56,
  bsc: 56,
  robinhood: 4663,
  solana: null,
}

export function tickerChainId(chainSlug: string | null | undefined): number | null {
  if (!chainSlug) return null
  return CLARK_TICKER_CHAIN_IDS[chainSlug.toLowerCase()] ?? null
}

let tickerSearchIdCounter = 0

// A fresh, unguessable id per rendered ticker-match list. Uses crypto.randomUUID() when available
// (every real Node/Edge runtime this route ships on has it); falls back to a monotonic counter +
// timestamp so this never throws in an environment without it (e.g. an older test runner).
export function generateTickerSearchId(): string {
  try {
    const g = globalThis as unknown as { crypto?: { randomUUID?: () => string } }
    if (typeof g.crypto?.randomUUID === 'function') return `ticker_${g.crypto.randomUUID()}`
  } catch {
    // fall through to the deterministic fallback below
  }
  tickerSearchIdCounter += 1
  return `ticker_${Date.now()}_${tickerSearchIdCounter}`
}

export type ClarkTickerPickerOption = {
  label: string
  prompt: string
  kind: 'prompt'
  tickerSearchId: string
  optionIndex: number
  tokenAddress: string
  chainId: number | null
}

// Builds the exact button payload for one option — every field the button carries is read
// straight off the displayed match, so the button can never advertise a different token/chain
// than what the option row shows next to it.
export function buildTickerPickerOptions(matches: ClarkTickerMatch[], tickerSearchId: string, max = 6): ClarkTickerPickerOption[] {
  return matches.slice(0, max).map((match, index) => ({
    label: `Scan ${index + 1}`,
    prompt: `scan ${index + 1}`,
    kind: 'prompt' as const,
    tickerSearchId,
    optionIndex: index,
    tokenAddress: match.tokenAddress,
    chainId: tickerChainId(match.chainSlug),
  }))
}

export type ClarkTickerSelectionPayload = {
  tickerSearchId: string
  optionIndex: number
  tokenAddress: string
  chainId: number | null
}

export type ClarkTickerSelectionStatus =
  | 'resolved'
  | 'no_active_search'
  | 'stale_search'
  | 'invalid_index'
  | 'mismatch'

export type ClarkTickerSelectionResolution = {
  status: ClarkTickerSelectionStatus
  selectedMatch: ClarkTickerMatch | null
  reason: string | null
}

// The single arbiter for "does this option click resolve to a real, currently-displayed option?"
// Deliberately takes no session object and no activeToken — pure data in, pure verdict out, so the
// exact same logic used by the live route can be exercised in a unit test with no server state.
export function resolveTickerSelection(params: {
  selection: ClarkTickerSelectionPayload
  currentSearchId: string | null
  currentMatches: ClarkTickerMatch[] | null
}): ClarkTickerSelectionResolution {
  const { selection, currentSearchId, currentMatches } = params
  if (!currentSearchId || !currentMatches || currentMatches.length === 0) {
    return { status: 'no_active_search', selectedMatch: null, reason: 'No ticker search is active in this session.' }
  }
  if (selection.tickerSearchId !== currentSearchId) {
    return { status: 'stale_search', selectedMatch: null, reason: 'This option is from an older ticker search that has since been replaced by a newer one.' }
  }
  if (selection.optionIndex < 0 || selection.optionIndex >= currentMatches.length) {
    return { status: 'invalid_index', selectedMatch: null, reason: `Option index ${selection.optionIndex} is outside the current ${currentMatches.length}-option list.` }
  }
  const match = currentMatches[selection.optionIndex]
  const addressMatches = match.tokenAddress.toLowerCase() === selection.tokenAddress.toLowerCase()
  const chainMatches = tickerChainId(match.chainSlug) === selection.chainId
  if (!addressMatches || !chainMatches) {
    return { status: 'mismatch', selectedMatch: null, reason: 'The selected option no longer matches the token/chain displayed at that position.' }
  }
  return { status: 'resolved', selectedMatch: match, reason: null }
}

// Parses a plain-text "scan N" / bare "N" reply into a zero-based option index — used only when the
// user TYPED a reply instead of clicking a button (no client-echoed tickerSearchId to verify, so
// this still resolves against whatever is CURRENTLY in session memory; the button-click path above
// is the one that can prove it isn't stale).
export function parseTypedTickerOptionIndex(prompt: string): number | null {
  const m = prompt.trim().match(/^(?:scan\s*)?#?(\d{1,2})$/i)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) && n >= 1 ? n - 1 : null
}

export type ClarkTickerSelectionAudit = {
  rawUserReply: string
  tickerSearchId: string | null
  selectedIndex: number | null
  displayedSymbol: string | null
  displayedTokenAddress: string | null
  displayedChainId: number | null
  scannerPayloadTokenAddress: string | null
  scannerPayloadChainId: number | null
  previousActiveToken: string | null
  selectionMatchesDisplayedOption: boolean
  staleSearchIgnored: boolean
  finalStatus: 'scanned' | 'ignored_stale' | 'ignored_invalid' | 'no_selection'
  failureReason: string | null
}

export function buildTickerSelectionAudit(params: {
  rawUserReply: string
  tickerSearchId: string | null
  selectedIndex: number | null
  resolution: ClarkTickerSelectionResolution | null
  previousActiveToken: string | null
}): ClarkTickerSelectionAudit {
  const { rawUserReply, tickerSearchId, selectedIndex, resolution, previousActiveToken } = params
  const match = resolution?.selectedMatch ?? null
  const resolved = resolution?.status === 'resolved' && match != null
  return {
    rawUserReply,
    tickerSearchId,
    selectedIndex,
    displayedSymbol: match?.symbol ?? null,
    displayedTokenAddress: match?.tokenAddress ?? null,
    displayedChainId: match ? tickerChainId(match.chainSlug) : null,
    scannerPayloadTokenAddress: resolved ? match!.tokenAddress : null,
    scannerPayloadChainId: resolved ? tickerChainId(match!.chainSlug) : null,
    previousActiveToken,
    selectionMatchesDisplayedOption: resolved,
    staleSearchIgnored: resolution?.status === 'stale_search',
    finalStatus: resolved ? 'scanned'
      : resolution?.status === 'stale_search' ? 'ignored_stale'
      : resolution == null ? 'no_selection'
      : 'ignored_invalid',
    failureReason: resolved ? null : (resolution?.reason ?? null),
  }
}
