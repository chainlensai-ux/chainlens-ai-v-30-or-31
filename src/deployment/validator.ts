// DEPLOYMENT LAYER — validator
//
// Request-shape validation for the /scan endpoint. Never trusts a client-supplied field beyond
// the three the pipeline actually accepts (walletAddress, chains, scanMode) — sanitizeInput()
// strips everything else, so a request body can never smuggle in an extra field (e.g. an admin
// override, a client-supplied email, a fabricated confidence level) that any downstream module
// would honor. This mirrors the project-wide rule established for the wallet scanner: never trust
// client-supplied fields for anything the server itself is responsible for computing.

import { SUPPORTED_CHAINS } from '../pipeline/types'
import type { ScanModeInput } from '../pipeline/types'

const ADDRESS_RE = /^0x[a-f0-9]{40}$/i

export type FieldValidation = { valid: boolean; error: string | null }

export function validateWalletAddress(address: unknown): FieldValidation {
  if (typeof address !== 'string' || !ADDRESS_RE.test(address)) {
    return { valid: false, error: 'walletAddress must be a well-formed 0x-prefixed 40-hex-character address' }
  }
  return { valid: true, error: null }
}

export type ChainsValidation = { valid: boolean; error: string | null; sanitizedChains: string[] }

export function validateChains(chains: unknown): ChainsValidation {
  if (!Array.isArray(chains) || chains.length === 0) {
    return { valid: false, error: 'chains must be a non-empty array', sanitizedChains: [] }
  }
  const sanitizedChains = chains.filter((c): c is string => typeof c === 'string' && SUPPORTED_CHAINS.includes(c as (typeof SUPPORTED_CHAINS)[number]))
  if (sanitizedChains.length === 0) {
    return { valid: false, error: 'none of the requested chains are supported', sanitizedChains: [] }
  }
  return { valid: true, error: null, sanitizedChains }
}

export function validateScanMode(scanMode: unknown): FieldValidation {
  if (scanMode !== 'normal' && scanMode !== 'deep') {
    return { valid: false, error: "scanMode must be exactly 'normal' or 'deep'" }
  }
  return { valid: true, error: null }
}

export type SanitizedScanRequest = {
  walletAddress: string
  chains: string[]
  scanMode: ScanModeInput
}

export type RequestShapeValidation = {
  valid: boolean
  errors: string[]
  sanitized: SanitizedScanRequest | null
}

// PURE. Validates the full request body shape by composing the three field-level validators
// above. Never partially trusts an invalid body — if any field fails, `sanitized` is null so a
// caller can never accidentally proceed with a half-valid request.
export function validateRequestShape(body: unknown): RequestShapeValidation {
  const errors: string[] = []
  const record = (body ?? {}) as Record<string, unknown>

  const addressCheck = validateWalletAddress(record.walletAddress)
  if (!addressCheck.valid && addressCheck.error) errors.push(addressCheck.error)

  const chainsCheck = validateChains(record.chains)
  if (!chainsCheck.valid && chainsCheck.error) errors.push(chainsCheck.error)

  const scanModeCheck = validateScanMode(record.scanMode)
  if (!scanModeCheck.valid && scanModeCheck.error) errors.push(scanModeCheck.error)

  if (errors.length > 0) return { valid: false, errors, sanitized: null }

  return {
    valid: true,
    errors: [],
    sanitized: {
      walletAddress: (record.walletAddress as string).toLowerCase(),
      chains: chainsCheck.sanitizedChains,
      scanMode: record.scanMode as ScanModeInput,
    },
  }
}

// PURE. Strips any field beyond walletAddress/chains/scanMode from an arbitrary request body —
// this is the single choke point that guarantees no extra client-supplied field can ever reach
// runWalletScan(), regardless of what a request body contains.
export function sanitizeInput(body: unknown): { walletAddress: unknown; chains: unknown; scanMode: unknown } {
  const record = (body ?? {}) as Record<string, unknown>
  return {
    walletAddress: record.walletAddress,
    chains: record.chains,
    scanMode: record.scanMode,
  }
}
