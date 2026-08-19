// SOLANA POOL ANALYZER, DISCLOSED (Solana-native architecture task): identifies which AMM
// program actually owns a pool account — real, cheap, on-chain evidence (a single getAccountInfo
// read), compared against a small set of known Solana AMM program IDs (Pump.fun bonding curve,
// PumpSwap, Raydium AMM V4, Orca Whirlpool, Meteora DLMM). This is Solana-native pool
// classification — not an attempt to map Solana AMMs onto an ERC-20 LP-token model.
//
// SCOPE, DISCLOSED: this identifies the pool's OWNING PROGRAM only. It does NOT parse any
// program's internal account layout (e.g. a Raydium pool's LP-mint field), which would require
// byte-offset struct parsing this codebase cannot safely verify without live testing — see this
// session's capability report for why that's explicitly not attempted. An unrecognized program's
// real owner address is still returned, never guessed into one of the known labels.

import { KNOWN_SOLANA_AMM_PROGRAMS } from '../solanaChainConfig.ts'
import { solanaRpc, type RpcFetch } from './rpcClient.ts'
import type { SolanaPoolProgram } from './types.ts'

/**
 * Human-readable, non-overclaiming description for each verdict — 'verified_official_pool' says
 * exactly what was verified (the owning program) and exactly what was NOT (withdrawal safety,
 * vault authority), so it can never be read as a safety claim.
 */
export function poolVerdictDescription(poolProgram: SolanaPoolProgram): string {
  if (poolProgram.verdict === 'verified_official_pool') {
    return `Verified Official Pool — the pool account's owning program is confirmed on-chain as ${poolProgram.label}. This confirms program identity only, not vault authority or withdrawal safety.`
  }
  if (poolProgram.verdict === 'unrecognized_program') {
    return `Unrecognized Program — the pool account's owner (${poolProgram.owner ? `${poolProgram.owner.slice(0, 4)}…${poolProgram.owner.slice(-4)}` : 'unknown'}) is not one of the AMM programs this engine recognizes.`
  }
  return poolProgram.poolAddress ? 'Unverified — the pool program could not be confirmed on-chain.' : 'No indexed pool to verify.'
}

export async function analyzeSolanaPool(params: {
  poolAddress: string | null
  rpcUrl: string
  fetchImpl: RpcFetch
}): Promise<{ poolProgram: SolanaPoolProgram; evidenceGaps: string[] }> {
  const { poolAddress, rpcUrl, fetchImpl } = params
  const evidenceGaps: string[] = []

  if (!poolAddress) {
    return {
      poolProgram: { resolved: false, poolAddress: null, owner: null, label: null, errorReason: 'No indexed pool address to verify.', verdict: 'unverified', migratedFromPumpFun: null },
      evidenceGaps,
    }
  }

  const poolInfo = await solanaRpc<{ value?: { owner?: string } | null }>(rpcUrl, 'getAccountInfo', [poolAddress, { encoding: 'base64' }], fetchImpl)
  if (poolInfo.ok && poolInfo.result?.value?.owner) {
    const owner = poolInfo.result.value.owner
    const label = KNOWN_SOLANA_AMM_PROGRAMS[owner] ?? null
    if (!label) evidenceGaps.push('Pool program is not one of the AMM programs this codebase recognizes — its identity is unverified, not claimed as any specific DEX.')
    // PumpSwap is exclusively Pump.fun's own post-graduation AMM — resolving to it IS the
    // migration fact, not an inference. Every other program stays null (see this module's header).
    const migratedFromPumpFun = label === 'PumpSwap AMM' ? true : null
    return {
      poolProgram: { resolved: true, poolAddress, owner, label, errorReason: null, verdict: label ? 'verified_official_pool' : 'unrecognized_program', migratedFromPumpFun },
      evidenceGaps,
    }
  }

  evidenceGaps.push('Pool program identity could not be verified on-chain — the DEX label shown is unverified market-data metadata, not a confirmed program read.')
  return {
    poolProgram: { resolved: false, poolAddress, owner: null, label: null, errorReason: poolInfo.ok ? 'pool_account_missing' : poolInfo.error, verdict: 'unverified', migratedFromPumpFun: null },
    evidenceGaps,
  }
}
