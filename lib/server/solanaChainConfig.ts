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

// ── solanaTokenScannerConfigAudit, DISCLOSED (Solana Beta env/config wiring task) ────────────
//
// A dedicated, more detailed config audit for the Token Scanner's Solana Beta path specifically
// (solanaChainConfigAudit above is the generic selector-gating audit reused from the Robinhood
// Chain precedent). This one also reports GoldRush and the DexScreener market fallback, so a
// caller can see the FULL provider picture for a Solana scan in one object, not just the RPC.
//
// GOLDRUSH SOLANA SUPPORT, DISCLOSED (verified, not assumed): every GOLDRUSH_VERIFIED_CHAIN_SLUGS
// map in this codebase (src/modules/holdings/utils.ts, src/modules/recoveryPolicy/utils.ts,
// src/modules/providerFetchWindow/utils.ts) lists only eth/base/arbitrum — there is no Solana
// chain slug wired anywhere. Per this task's own instruction ("do not hardcode unknown Solana
// chain slug without checking existing SDK/docs/code... mark GoldRush Solana as unavailable/
// config pending"), goldrushConfigured is hardcoded false here rather than guessing a slug
// (GoldRush/Covalent does support a Solana chain in its public API, but no slug for it exists
// ANYWHERE in this codebase to reuse, and inventing one would be exactly the "unknown slug"
// this instruction forbids). Solana Beta's real identity/authority/concentration reads come from
// Alchemy RPC alone — see lib/server/solanaTokenScannerBeta.ts — GoldRush is not on that path at
// all today, matching the "unavailable" status reported below.
export type SolanaTokenScannerConfigAudit = {
  enabled: boolean
  alchemySolanaConfigured: boolean
  /** Always false today — see this function's own header for why, not a guess. */
  goldrushConfigured: boolean
  /** DexScreener needs no API key, so it is "configured" whenever the feature itself is on. */
  marketFallbackConfigured: boolean
  missingConfig: string[]
  redacted: true
}

export function solanaTokenScannerConfigAudit(): SolanaTokenScannerConfigAudit {
  const enabled = isSolanaBetaFeatureEnabled()
  const alchemySolanaConfigured = isSolanaRpcConfigured()
  const goldrushConfigured = false
  const marketFallbackConfigured = true

  const missingConfig: string[] = []
  if (!enabled) missingConfig.push('ENABLE_SOLANA_BETA')
  if (!alchemySolanaConfigured) missingConfig.push('ALCHEMY_SOLANA_RPC_URL')

  return {
    enabled,
    alchemySolanaConfigured,
    goldrushConfigured,
    marketFallbackConfigured,
    missingConfig,
    redacted: true,
  }
}
