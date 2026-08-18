// SOLANA ADDRESS VALIDATION, DISCLOSED (Token Scanner Solana Beta task).
//
// SCOPE: pure, dependency-free, and safe to import from BOTH client and server — it reads no
// environment variable and holds no secret, unlike lib/server/solanaChainConfig.ts. The Token
// Scanner page needs the same validation the API enforces so it can reject a bad input before
// firing a request, and the API needs it because client-side validation is never a trust boundary.
// One shared implementation so the two can't drift apart.
//
// WHY NOT base58 DECODE: a Solana mint address is a base58-encoded 32-byte ed25519 public key.
// Fully verifying it requires decoding base58 and checking the byte length. That is exactly what
// this does — no external dependency (@solana/web3.js is not installed and this task forbids
// adding paid/new APIs), just the standard base58 alphabet and a length check. This is a real
// structural validation, not a regex approximation that would accept malformed input.

// Bitcoin/Solana base58 alphabet — deliberately excludes 0, O, I and l to avoid visual ambiguity.
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const BASE58_INDEX: Record<string, number> = (() => {
  const map: Record<string, number> = {}
  for (let i = 0; i < BASE58_ALPHABET.length; i += 1) map[BASE58_ALPHABET[i]] = i
  return map
})()

/** An EVM contract address (0x + 40 hex). Used to reject EVM input on the Solana path. */
const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

export function isEvmAddress(value: unknown): boolean {
  return typeof value === 'string' && EVM_ADDRESS_RE.test(value.trim())
}

/**
 * Decodes a base58 string to its byte length without allocating the full byte array beyond what's
 * needed. Returns null when the string contains a character outside the base58 alphabet.
 */
function base58ByteLength(value: string): number | null {
  if (value.length === 0) return null
  // Leading '1's in base58 each encode one leading zero byte.
  let leadingZeros = 0
  while (leadingZeros < value.length && value[leadingZeros] === '1') leadingZeros += 1

  const bytes: number[] = []
  for (let i = leadingZeros; i < value.length; i += 1) {
    const digit = BASE58_INDEX[value[i]]
    if (digit === undefined) return null
    let carry = digit
    for (let j = 0; j < bytes.length; j += 1) {
      carry += bytes[j] * 58
      bytes[j] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  return leadingZeros + bytes.length
}

/**
 * True for a structurally valid Solana mint address: base58-encoded, decoding to exactly 32 bytes.
 *
 * HONEST LIMIT, DISCLOSED: this proves the address is well-FORMED, not that the mint EXISTS on
 * chain or that it is a token mint rather than any other 32-byte account. Existence is only known
 * after the RPC read in scanSolanaTokenBeta, which reports it honestly rather than assuming it.
 */
export function isValidSolanaMintAddress(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  // Length pre-filter: a 32-byte base58 value is always 32-44 chars. Cheap reject before decoding.
  if (trimmed.length < 32 || trimmed.length > 44) return false
  if (isEvmAddress(trimmed)) return false
  return base58ByteLength(trimmed) === 32
}

export type SolanaMintInputRejection =
  | 'empty'
  | 'evm_address_on_solana'
  | 'not_base58'
  | 'wrong_length'

/**
 * Classifies WHY an input is not a usable Solana mint, so the UI/API can give a specific reason
 * instead of a generic "invalid". Returns null when the input is valid.
 */
export function classifySolanaMintInput(value: unknown): SolanaMintInputRejection | null {
  if (typeof value !== 'string' || value.trim().length === 0) return 'empty'
  const trimmed = value.trim()
  if (isEvmAddress(trimmed)) return 'evm_address_on_solana'
  if (trimmed.length < 32 || trimmed.length > 44) return 'wrong_length'
  if (base58ByteLength(trimmed) === null) return 'not_base58'
  if (base58ByteLength(trimmed) !== 32) return 'wrong_length'
  return null
}

export const SOLANA_MINT_REJECTION_MESSAGE: Record<SolanaMintInputRejection, string> = {
  empty: 'Paste a Solana mint address.',
  evm_address_on_solana: 'That is an EVM (0x…) address. Switch to Base, Ethereum, or BNB, or paste a Solana mint address.',
  not_base58: 'Solana mint addresses are base58 — that input contains unsupported characters.',
  wrong_length: 'That does not look like a Solana mint address (expected a 32-byte base58 value).',
}
