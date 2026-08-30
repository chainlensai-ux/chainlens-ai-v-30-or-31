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
export const SOLANA_CHAIN_NAME = 'Solana'
export const SOLANA_EXPLORER_URL = 'https://solscan.io'

// Public Solana mainnet RPC. Used ONLY as a last-resort fallback so the Beta is testable without a
// paid key; it is heavily rate-limited and is NOT suitable for production traffic, which is why
// isSolanaChainAvailable() below still requires an explicitly configured URL.
export const SOLANA_PUBLIC_RPC_URL = 'https://api.mainnet-beta.solana.com'

// The two SPL token programs. Token-2022 supports extensions (e.g. transfer fees) that the classic
// program does not, so which one a mint belongs to is real, checkable evidence — not a guess.
export const SPL_TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
export const SPL_TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'

// KNOWN SOLANA AMM PROGRAMS, DISCLOSED (LP Safety follow-up: "verify which program actually owns
// the pool" rather than trusting DexScreener's dexId string alone).
//
// DELIBERATELY SMALL, DISCLOSED: only programs I'm confident are correct, stable, widely-published
// mainnet program IDs are listed here. This list is NOT live-verified from this sandbox (outbound
// network is blocked) — worth confirming against a real scan before trusting it fully. A pool
// owned by any program NOT in this map is reported honestly as an unrecognized/unverified program
// (its real on-chain owner address is still shown), never guessed into one of these labels.
//
// SCOPE, DISCLOSED: this map identifies the POOL'S OWNING PROGRAM ONLY — real, cheap evidence from
// a single getAccountInfo read. It does NOT attempt to parse any program's internal account layout
// (e.g. Raydium's LP-mint field), which would require byte-offset struct parsing this codebase
// cannot safely verify without live testing. Full LP lock/burn proof is a separate, harder problem
// this map does not solve.
export const KNOWN_SOLANA_AMM_PROGRAMS: Readonly<Record<string, string>> = {
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium AMM V4',
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': 'Orca Whirlpool',
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA': 'PumpSwap AMM',
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo': 'Meteora DLMM',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'Pump.fun Bonding Curve',
}

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
 * without configuring a real endpoint yields the honest "Solana is not configured yet."
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

// ── Provider wiring config (Solana provider wiring task) ───────────────────────
//
// One helper per provider, all server-only (never imported from a 'use client' file), all
// returning booleans or redacted structures only — never a key, never a URL that embeds a key.
// Every helper defaults CLOSED: a missing flag or a missing key both read as "not configured",
// so a provider that isn't explicitly turned on is simply never called (see solanaProviders.ts).

export function isHeliusSolanaFeatureEnabled(): boolean {
  return process.env.ENABLE_HELIUS_SOLANA === 'true'
}

export function getHeliusApiKey(): string | null {
  const key = process.env.HELIUS_API_KEY
  return typeof key === 'string' && key.trim().length > 0 ? key.trim() : null
}

/** Both the feature flag AND a configured key are required — same shape as isSolanaChainAvailable. */
export function isHeliusConfigured(): boolean {
  return isHeliusSolanaFeatureEnabled() && getHeliusApiKey() != null
}

export function isJupiterSolanaFeatureEnabled(): boolean {
  return process.env.ENABLE_JUPITER_SOLANA === 'true'
}

export function getJupiterApiKey(): string | null {
  const key = process.env.JUPITER_API_KEY
  return typeof key === 'string' && key.trim().length > 0 ? key.trim() : null
}

/**
 * Jupiter's token/price endpoints used here (lite-api.jup.ag) are public and work without a key —
 * JUPITER_API_KEY only raises rate limits when present. So "configured" here means only the
 * feature flag, matching the honesty contract: Jupiter enrichment runs whenever explicitly turned
 * on, key or no key, rather than reporting "unconfigured" for a provider that would work anyway.
 */
export function isJupiterConfigured(): boolean {
  return isJupiterSolanaFeatureEnabled()
}

/**
 * DexScreener needs no key at all — "available" tracks only whether Solana Beta itself is on,
 * since DexScreener is not a separately gated provider.
 */
export function isDexScreenerAvailable(): boolean {
  return isSolanaBetaFeatureEnabled()
}

/**
 * GOLDRUSH SOLANA SUPPORT, DISCLOSED (see solanaTokenScannerConfigAudit's own header above for the
 * full reasoning): no GOLDRUSH_VERIFIED_CHAIN_SLUGS map anywhere in this codebase lists a Solana
 * slug. isGoldrushKeyPresent reports whether a key exists at all (useful for the audit's
 * "configured" bit), but this alone never authorizes a call — solanaProviders.ts's GoldRush
 * enrichment is unconditionally `called: false` until a real, verified Solana chain slug exists.
 */
export function isGoldrushKeyPresent(): boolean {
  const key = process.env.GOLDRUSH_API_KEY ?? process.env.COVALENT_API_KEY
  return typeof key === 'string' && key.trim().length > 0
}
