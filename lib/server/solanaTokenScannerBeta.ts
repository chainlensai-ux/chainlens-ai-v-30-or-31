// SOLANA TOKEN SCANNER — NATIVE INTELLIGENCE ENGINE, DISCLOSED (Solana-native architecture task).
//
// This file is now a thin, backward-compatible FACADE. The real engine lives in
// lib/server/solana/ as independent, focused analyzer modules — see that directory's own files
// for what each one does:
//   rpcClient.ts        — shared Alchemy JSON-RPC transport (timeout + one transient-only retry)
//   mintAnalyzer.ts      — mint identity, decimals, supply, mint/freeze authority (Alchemy)
//   authorityAnalyzer.ts — interprets mint/freeze authority into a Solana-native risk signal
//   holderAnalyzer.ts    — top-account concentration (Alchemy) + real holder-account count (Helius)
//   poolAnalyzer.ts       — on-chain-verified pool-program identity (Pump.fun/PumpSwap/Raydium/
//                           Orca/Meteora/unrecognized) — Solana-native LP classification
//   marketAnalyzer.ts    — live price/liquidity/volume/txns/pair-age/socials (DexScreener) + real
//                           OHLCV candles (GeckoTerminal)
//   metadataResolver.ts  — token identity (Jupiter first, DexScreener fallback)
//   creatorAnalyzer.ts    — real on-chain activity signal (Helius); documents what creator/deployer
//                           identity is NOT attempted, and why
//   riskEngine.ts         — Solana-native risk read, built only from evidence this engine collects
//   scoreEngine.ts         — re-exports the Confidence Score engine (lib/solanaConfidenceScore.ts)
//   providerMerge.ts       — orchestrates all of the above into one result + one provider audit
//
// This module exists so `import { scanSolanaTokenBeta, ... } from '@/lib/server/solanaTokenScannerBeta'`
// keeps working everywhere it's already used (app/api/token/route.ts, the Token Scanner UI, this
// module's own test suite) without every call site needing to know the internal file layout.
//
// HONESTY CONTRACT — unchanged from the engine's first version: every value here is real,
// provider-sourced evidence or an explicit, honest gap — never a placeholder, never a guess.
// Solana concepts are scored on Solana's own terms (mint/freeze authority, top-account
// concentration, on-chain-verified pool program, real market data) — this is NOT an EVM engine
// with Solana values patched in. EVM-only concepts with no Solana equivalent (honeypot/tax
// simulation, ERC-20 LP lock/burn proof, contract-owner renouncement, deployer transaction
// history) are listed in SOLANA_UNSUPPORTED_CHECKS and never presented as passed checks.
//
// STRUCTURAL GUARANTEE: this file and everything under lib/server/solana/ import zero EVM
// scanner/LP-proof/honeypot/tax/deployer helpers — a Solana mint can never be pushed through EVM
// contract logic, by construction.

export {
  SOLANA_UNSUPPORTED_CHECKS,
  type SolanaUnsupportedCheck,
  type SolanaTopAccountShare,
  type SolanaMarketData,
  type SolanaTokenScannerAudit,
  type SolanaProviderWiringAudit,
  type SolanaPoolProgram,
  type SolanaBetaScanResult,
  type SolanaBetaScanFailure,
} from './solana/types.ts'

export { scoreSolanaBeta } from './solana/riskEngine.ts'

import { runSolanaProviderMerge } from './solana/providerMerge.ts'
import type { RpcFetch } from './solana/rpcClient.ts'
import type { SolanaBetaScanResult, SolanaBetaScanFailure } from './solana/types.ts'

/**
 * The ONLY Solana scan entry point. See this module's header and lib/server/solana/providerMerge.ts
 * for the full pipeline. `fetchImpl`/`rpcUrl` overrides exist purely so tests can exercise the real
 * logic without network access.
 */
export async function scanSolanaTokenBeta(
  mintAddress: string,
  opts: { fetchImpl?: RpcFetch; rpcUrl?: string | null } = {},
): Promise<SolanaBetaScanResult | SolanaBetaScanFailure> {
  return runSolanaProviderMerge(mintAddress, opts)
}
