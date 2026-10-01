// lib/walletAddressInput.ts — the Wallet Scanner's ONE client-side EVM wallet-address check, shared by
// every scan entry point (Scan, Deep Scan, Robinhood rescan), plus the error classification its banners use.
//
// Rule: exactly `0x` + 40 hexadecimal characters, any case. This matches the server routes
// (app/api/wallet-scan/route.ts and /robinhood use viem's isAddress, which in this viem version accepts
// any-case hex without enforcing the EIP-55 checksum), so the client never rejects an address the server
// would accept. The server keeps its own validation as defense in depth.
//
// An invalid input is answered locally: no scan request, no Robinhood request, no provider/RPC call, no
// loading state — one inline validation message, never "try again later".

export const EVM_WALLET_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

export const INVALID_WALLET_ADDRESS_MESSAGE = 'Invalid wallet address — enter the full 42-character 0x address.'

export function isValidEvmWalletAddress(input: string | null | undefined): boolean {
  return typeof input === 'string' && EVM_WALLET_ADDRESS_RE.test(input.trim())
}

/**
 * The guard every Wallet Scanner entry point runs BEFORE any request or state change:
 * empty input → do nothing; malformed → the validation message; valid → the trimmed address to scan.
 */
export type WalletScanInputCheck =
  | { action: 'ignore' }
  | { action: 'reject'; message: string }
  | { action: 'scan'; address: string }

export function checkWalletScanInput(input: string | null | undefined): WalletScanInputCheck {
  const address = String(input ?? '').trim()
  if (!address) return { action: 'ignore' }
  if (!EVM_WALLET_ADDRESS_RE.test(address)) return { action: 'reject', message: INVALID_WALLET_ADDRESS_MESSAGE }
  return { action: 'scan', address }
}

/**
 * What kind of failure a scan error is, so the banner says the right thing:
 *   - 'validation': the address itself (e.g. the server's "Invalid wallet address") — retrying never helps;
 *   - 'auth': session / sign-in — the existing auth wording, shown as-is;
 *   - 'retry': a real network/provider failure — the existing "try again later" wording.
 */
export type WalletScanErrorKind = 'validation' | 'auth' | 'retry'

export function classifyWalletScanError(message: string | null | undefined, httpStatus?: number | null): WalletScanErrorKind {
  const m = String(message ?? '')
  if (m === INVALID_WALLET_ADDRESS_MESSAGE || /invalid wallet address/i.test(m)) return 'validation'
  if (httpStatus === 401 || httpStatus === 403 || /\b(sign in|signed in|session|unauthori[sz]ed|not authenticated|log in)\b/i.test(m)) return 'auth'
  return 'retry'
}

/** The main scan's banner text for an error (one banner; validation and auth are never "try again later"). */
export function walletScanErrorBanner(message: string): string {
  const kind = classifyWalletScanError(message)
  if (kind === 'validation') return INVALID_WALLET_ADDRESS_MESSAGE
  if (kind === 'auth') return message
  return `Scan failed — try again later. (${message})`
}

/**
 * The Robinhood sidecar's banner text, or null when nothing should render: a validation failure is the
 * SAME address problem the main banner already shows, so it never renders a second banner.
 */
export function robinhoodScanErrorBanner(message: string | null | undefined): string | null {
  if (!message) return null
  const kind = classifyWalletScanError(message)
  if (kind === 'validation') return null
  if (kind === 'auth') return `Robinhood Chain: ${message}`
  return `Robinhood Chain scan failed — try again later. (${message})`
}
