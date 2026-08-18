// SOLANA CHAIN CONFIG, DISCLOSED (Token Scanner Solana Beta task): SERVER-ONLY — this module reads
// ALCHEMY_SOLANA_RPC_URL directly, which embeds an API key. It must never be imported from a
// 'use client' component. The frontend only ever learns booleans, via
// app/api/token/chain-status/route.ts — never the URL itself.
//
// Follows the exact shape of lib/server/robinhoodChainConfig.ts (this codebase's existing
// feature-flagged-chain precedent) so both gate the same way and neither becomes a special case.
//
// Scope, disclosed: no function in THIS module performs an RPC/network call — it only reports
// config presence. The real RPC reads live in lib/server/solanaTokenScannerBeta.ts.

export const SOLANA_CHAIN_SLUG = 'solana'
export const SOLANA_CHAIN_NAME = 'Solana Beta'
export const SOLANA_EXPLORER_URL = 'https://solscan.io'

// Public Solana mainnet RPC. Used ONLY as a last-resort fallback so the Beta is testable without a
// paid key; it is heavily rate-limited and is NOT suitable for production traffic, which is why
// isSolanaChainAvailable() below still requires an explicitly configured URL.
export const SOLANA_PUBLIC_RPC_URL = 'https://api.mainnet-beta.solana.com'

// The two SPL token programs. Token-2022 supports extensions (e.g. transfer fees) that the classic
// program does not, so which one a mint belongs to is real, checkable evidence — not a guess.
export const SPL_TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
export const SPL_TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'

export function isSolanaBetaFeatureEnabled(): boolean {
  return process.env.ENABLE_SOLANA_BETA === 'true'
}

export function getSolanaRpcUrl(): string | null {
  const url = process.env.ALCHEMY_SOLANA_RPC_URL
  return typeof url === 'string' && url.trim().length > 0 ? url.trim() : null
}

export function isSolanaRpcConfigured(): boolean {
  return getSolanaRpcUrl() != null
}

/**
 * Both the feature flag AND a configured RPC URL are required — the single source of truth the
 * frontend chain selector gates on (via /api/token/chain-status) for whether Solana Beta should
 * appear at all.
 *
 * DELIBERATE, DISCLOSED: the public RPC constant above is NOT accepted here. Enabling the flag
 * without configuring a real endpoint yields the honest "Solana Beta is not configured yet."
 * message the task specifies, rather than silently routing production traffic onto a public
 * endpoint that will rate-limit and produce misleading partial evidence.
 */
export function isSolanaChainAvailable(): boolean {
  return isSolanaBetaFeatureEnabled() && isSolanaRpcConfigured()
}

export interface SolanaChainConfigAudit {
  enabled: boolean
  rpcConfigured: boolean
  available: boolean
  selectedChain: string
}

// NEVER-LOG-SECRETS, DISCLOSED: returns only booleans and the caller-supplied selectedChain string
// — never the RPC URL (which embeds an API key) or any substring of it. Safe to log verbatim or
// return in an API response.
export function solanaChainConfigAudit(selectedChain: string): SolanaChainConfigAudit {
  return {
    enabled: isSolanaBetaFeatureEnabled(),
    rpcConfigured: isSolanaRpcConfigured(),
    available: isSolanaChainAvailable(),
    selectedChain,
  }
}
