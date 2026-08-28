// Client-safe Clark live-context helpers. No clarkRouting import — that file is 215k
// and is server-only. These functions are the surgical live-QA fixes for:
// wallet uiModeHint, honest fetch timeout, CONTEXT chain, LAST TOKEN display,
// and "what is the mint address?" answers from lastToken memory.

import { isValidSolanaMintAddress } from '../solanaAddress'

export const FALLBACK_ERROR_MESSAGE = 'Clark is unavailable right now. Try again in a moment.'
export const CLARK_TIMEOUT_MESSAGE = 'Clark timed out waiting for this scan. Try again.'
export const CLARK_FETCH_TIMEOUT_MS = 55_000

const PLACEHOLDER_VALUES = new Set(['', '?', 'available', 'none yet', 'unknown', 'n/a', 'na'])

export type ClarkContextRecord = Record<string, unknown>

function asRecord(value: unknown): ClarkContextRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as ClarkContextRecord
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (PLACEHOLDER_VALUES.has(trimmed.toLowerCase())) return null
  return trimmed
}

/** Address/mint from a lastToken object, string, or nested scanner summary. Never returns "?". */
export function extractTokenAddress(value: unknown): string | null {
  if (typeof value === 'string') return asNonEmptyString(value)
  const record = asRecord(value)
  if (!record) return null
  return (
    asNonEmptyString(record.address) ||
    asNonEmptyString(record.mint) ||
    asNonEmptyString(record.tokenAddress) ||
    asNonEmptyString(record.contract) ||
    asNonEmptyString(record.ca) ||
    null
  )
}

function extractWalletAddress(value: unknown): string | null {
  if (typeof value === 'string') return asNonEmptyString(value)
  const record = asRecord(value)
  if (!record) return null
  return asNonEmptyString(record.address) || asNonEmptyString(record.wallet) || null
}

function extractNamedChain(value: unknown): string | null {
  const record = asRecord(value)
  const direct = asNonEmptyString(value)
  const fromRecord = record
    ? asNonEmptyString(record.chain) || asNonEmptyString(record.chainId) || asNonEmptyString(record.network)
    : null
  return normalizeChainId(fromRecord || direct)
}

const CHAIN_LABELS: Record<string, { label: string; id: string }> = {
  base: { label: 'Base', id: '8453' },
  ethereum: { label: 'Ethereum', id: '1' },
  eth: { label: 'Ethereum', id: '1' },
  bnb: { label: 'BNB', id: '56' },
  bsc: { label: 'BNB', id: '56' },
  polygon: { label: 'Polygon', id: '137' },
  solana: { label: 'Solana', id: 'solana' },
  sol: { label: 'Solana', id: 'solana' },
}

export function normalizeChainId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value === 8453) return 'base'
    if (value === 1) return 'ethereum'
    if (value === 56) return 'bnb'
    if (value === 137) return 'polygon'
    return null
  }
  const raw = asNonEmptyString(value)
  if (!raw) return null
  const t = raw.toLowerCase()
  if (t === '8453' || t === 'base') return 'base'
  if (t === '1' || t === 'eth' || t === 'ethereum' || t === 'mainnet') return 'ethereum'
  if (t === '56' || t === 'bnb' || t === 'bsc') return 'bnb'
  if (t === '137' || t === 'polygon' || t === 'matic') return 'polygon'
  if (t === 'sol' || t === 'solana' || t === '101') return 'solana'
  if (CHAIN_LABELS[t]) return t
  return t
}

export function extractChainFromPrompt(prompt: string): string | null {
  const t = String(prompt ?? '')
  if (/\bon\s+sol(?:ana)?\b/i.test(t) || /\bsolana\s+(?:mint|token|wallet)\b/i.test(t)) return 'solana'
  if (/\bon\s+base\b/i.test(t) || /\bbase\s+wallet\b/i.test(t) || /\bbase\s+token\b/i.test(t)) return 'base'
  if (/\bon\s+eth(?:ereum)?\b/i.test(t) || /\beth(?:ereum)?\s+token\b/i.test(t)) return 'ethereum'
  if (/\bon\s+(?:bnb|bsc)\b/i.test(t) || /\b(?:bnb|bsc)\s+token\b/i.test(t)) return 'bnb'
  if (/\bon\s+polygon\b/i.test(t) || /\bpolygon\s+token\b/i.test(t)) return 'polygon'
  return null
}

function chainFromAddress(address: string | null): string | null {
  if (!address) return null
  if (isValidSolanaMintAddress(address)) return 'solana'
  return null
}

export type ClarkMemoryLike = {
  lastToken?: unknown
  lastWallet?: unknown
  lastChain?: unknown
}

/** Last scanned chain from prompt, then lastToken/lastWallet/lastChain memory. Never defaults to Base. */
export function resolveClarkContextChain(memory: ClarkMemoryLike, prompt?: string): string | null {
  return (
    (prompt ? extractChainFromPrompt(prompt) : null) ||
    extractNamedChain(memory.lastToken) ||
    chainFromAddress(extractTokenAddress(memory.lastToken)) ||
    extractNamedChain(memory.lastWallet) ||
    chainFromAddress(extractWalletAddress(memory.lastWallet)) ||
    normalizeChainId(memory.lastChain) ||
    null
  )
}

export function formatChainDisplay(chain: string | null): { label: string; id: string | null } {
  if (!chain) return { label: 'Not set', id: null }
  const meta = CHAIN_LABELS[chain] || CHAIN_LABELS[chain.toLowerCase()]
  if (meta) return { label: meta.label, id: meta.id }
  return { label: chain, id: null }
}

/** LAST TOKEN panel: real mint/address, never "?" when an address exists. */
export function formatLastTokenDisplay(value: unknown): string {
  const address = extractTokenAddress(value)
  const record = asRecord(value)
  const symbol = record ? asNonEmptyString(record.symbol) : null
  const name = record ? asNonEmptyString(record.name) : null
  if (address && symbol) return `${symbol} · ${address}`
  if (address) return address
  if (symbol) return symbol
  if (name) return name
  if (typeof value === 'string') return asNonEmptyString(value) || 'None yet'
  if (!value) return 'None yet'
  return 'None yet'
}

export function formatLastWalletDisplay(value: unknown): string {
  const address = extractWalletAddress(value)
  if (address) return address
  if (!value) return 'None yet'
  return 'None yet'
}

const MINT_FOLLOWUP_RE = /\bwhat\s+is\s+the\s+mint(?:\s+address)?\b|\bwhat'?s\s+the\s+mint(?:\s+address)?\b|\bmint\s+address\b/i

/** True for identity follow-ups that must be answered from lastToken, not as generic chat. */
export function isMintAddressFollowup(prompt: string): boolean {
  const t = String(prompt ?? '').trim()
  if (!t) return false
  if (/\bwallet\b/i.test(t)) return false
  return MINT_FOLLOWUP_RE.test(t)
}

export function formatMintAddressFromLastToken(lastToken: unknown): string | null {
  const address = extractTokenAddress(lastToken)
  if (!address) return null
  const record = asRecord(lastToken)
  const symbol = record ? asNonEmptyString(record.symbol) : null
  const name = record ? asNonEmptyString(record.name) : null
  const chain = formatChainDisplay(extractNamedChain(lastToken) || chainFromAddress(address)).label
  const lines = ['TOKEN MEMORY', `Mint / contract: ${address}`, `Chain: ${chain}`]
  if (symbol) lines.push(`Symbol: ${symbol}`)
  if (name) lines.push(`Name: ${name}`)
  return lines.join('\n')
}

export function isWalletLanguagePrompt(prompt: string): boolean {
  return /\b(wallet|portfolio|holdings?|pnl)\b/i.test(String(prompt ?? ''))
}

const EVM_ADDRESS_RE = /\b0x[a-fA-F0-9]{40}\b/
const BASE58_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/

export type PromptEntity = {
  kind: 'wallet' | 'token' | null
  address: string | null
  chain: string | null
}

/** Pull a wallet or token address out of the prompt so CONTEXT/follow-ups do not wait on memoryEcho. */
export function extractPromptEntities(prompt: string): PromptEntity {
  const text = String(prompt ?? '')
  const chain = extractChainFromPrompt(text)
  const evm = text.match(EVM_ADDRESS_RE)?.[0] ?? null
  let sol: string | null = null
  for (const match of text.match(BASE58_RE) ?? []) {
    if (isValidSolanaMintAddress(match)) { sol = match; break }
  }
  if (isWalletLanguagePrompt(text) && evm) {
    return { kind: 'wallet', address: evm, chain: chain || 'base' }
  }
  if (sol) {
    return { kind: 'token', address: sol, chain: chain || 'solana' }
  }
  if (evm) {
    return { kind: 'token', address: evm, chain }
  }
  return { kind: null, address: null, chain }
}

const LAST_WALLET_KEY = 'chainlens:clark:last-wallet'
const LAST_TOKEN_KEY = 'chainlens:clark:last-token'
const LAST_CHAIN_KEY = 'chainlens:clark:last-chain'

export type ClarkUiMode = 'token' | 'wallet' | 'contract' | 'radar'

/** Write last wallet/token/chain from the prompt itself. Server memoryEcho is best-effort. */
export function persistEntitiesFromPrompt(prompt: string, modeHint?: ClarkUiMode): void {
  if (typeof window === 'undefined') return
  const entity = extractPromptEntities(prompt)
  const text = String(prompt ?? '')
  const evm = text.match(EVM_ADDRESS_RE)?.[0] ?? null
  let kind = entity.kind
  let address = entity.address
  let chain = entity.chain
  if (modeHint === 'wallet' && evm) {
    kind = 'wallet'
    address = evm
    chain = chain || extractChainFromPrompt(text) || 'base'
  }
  if (!address || !kind) return
  try {
    if (kind === 'wallet') {
      sessionStorage.setItem(LAST_WALLET_KEY, JSON.stringify({ address, chain }))
    } else {
      sessionStorage.setItem(LAST_TOKEN_KEY, JSON.stringify({ address, chain }))
    }
    if (chain) sessionStorage.setItem(LAST_CHAIN_KEY, chain)
  } catch { /* sessionStorage unavailable */ }
}

export function intentBadgeForPrompt(prompt: string): string {
  if (isWalletLanguagePrompt(prompt)) return 'WALLET READ'
  if (isMintAddressFollowup(prompt)) return 'TOKEN READ'
  const entity = extractPromptEntities(prompt)
  if (entity.kind === 'wallet') return 'WALLET READ'
  return 'TOKEN READ'
}

/** Prefer this prompt's badge over a sticky server WALLET READ from the previous scan. */
export function resolveIntentBadge(prompt: string, serverBadge?: string | null): string {
  const clientBadge = intentBadgeForPrompt(prompt)
  if (clientBadge === 'TOKEN READ' && typeof serverBadge === 'string' && /wallet/i.test(serverBadge)) return clientBadge
  return (typeof serverBadge === 'string' && serverBadge.trim()) ? serverBadge : clientBadge
}

export function uiModeHintForPrompt(prompt: string, activeMode: ClarkUiMode): 'token' | 'wallet' | 'contract' | 'radar' {
  if (isWalletLanguagePrompt(prompt)) return 'wallet'
  if (isMintAddressFollowup(prompt)) return 'token'
  const entity = extractPromptEntities(prompt)
  if (entity.kind === 'wallet') return 'wallet'
  if (entity.kind === 'token') return 'token'
  // Do not keep a previous wallet mode for a non-wallet prompt (bare mint, follow-up, etc).
  if (activeMode === 'wallet') return 'token'
  return activeMode
}

export function isClarkTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const name = (err as { name?: string }).name
  if (name === 'TimeoutError') return true
  if (name === 'AbortError') return true
  const msg = String((err as { message?: string }).message ?? '').toLowerCase()
  return msg.includes('timeout') || msg.includes('timed out') || msg.includes('aborted')
}
