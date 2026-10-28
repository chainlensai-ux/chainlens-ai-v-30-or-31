// Contract Flags evidence merge. Every flag keeps the source it came from, and the two independent sources
// never silently override each other:
//   - 'onchain'  : the token's own bytecode / RPC probes (EIP-1967 slot, paused()).
//   - 'indexed'  : GoldRush indexed contract intel.
//   - 'provider' : GoPlus security-provider contract analysis — used when the scan has no on-chain/indexed
//                  answer. (Public responses never name third-party providers, hence the neutral label.)
//   - 'conflict' : on-chain/indexed evidence and the provider disagree. The value is unresolved (null), never the
//                  safe side of the disagreement.
// A source with no answer is unknown (null) — never "not detected".
//
// DISPLAY / EVIDENCE ONLY. The route keeps security.contractFlags (read by the CORTEX score, Clark and Base
// Radar) on the on-chain / indexed values alone, exactly as before; nothing here feeds a risk score.

import type { GoPlusContractFlags } from './goplusSecurity'

export type ContractFlagKey = 'mint' | 'proxy' | 'blacklist' | 'pause' | 'withdraw'
export type ContractFlagSource = 'onchain' | 'indexed' | 'provider' | 'conflict'
export type FlagConfidence = 'high' | 'medium' | 'low'
export type PrimaryFlagEvidence = { value: boolean | null; source: 'onchain' | 'indexed' | null; confidence: FlagConfidence | null }

export interface MergedContractFlags {
  flags: Record<ContractFlagKey, boolean | null>
  sources: Record<ContractFlagKey, ContractFlagSource | null>
  /** On-chain: the scan's own confidence; indexed: high; provider: medium (third-party analysis, not verified
   *  on-chain this scan); conflict: low; unknown: null. */
  confidence: Record<ContractFlagKey, FlagConfidence | null>
  conflicts: Array<{ flag: ContractFlagKey; primary: boolean; primarySource: 'onchain' | 'indexed'; provider: boolean }>
}

const KEYS: ContractFlagKey[] = ['mint', 'proxy', 'blacklist', 'pause', 'withdraw']

export function mergeContractFlagEvidence(
  primary: Record<ContractFlagKey, PrimaryFlagEvidence>,
  goplus: GoPlusContractFlags | null,
): MergedContractFlags {
  const flags = {} as MergedContractFlags['flags']
  const sources = {} as MergedContractFlags['sources']
  const confidence = {} as MergedContractFlags['confidence']
  const conflicts: MergedContractFlags['conflicts'] = []
  for (const k of KEYS) {
    const p = primary[k]
    const g = k === 'withdraw' ? null : (goplus?.[k] ?? null)
    if (p.value != null && p.source != null && g != null && p.value !== g) {
      flags[k] = null
      sources[k] = 'conflict'
      confidence[k] = 'low'
      conflicts.push({ flag: k, primary: p.value, primarySource: p.source, provider: g })
    } else if (p.value != null && p.source != null) {
      flags[k] = p.value
      sources[k] = p.source
      confidence[k] = p.confidence
    } else if (g != null) {
      flags[k] = g
      sources[k] = 'provider'
      confidence[k] = 'medium'
    } else {
      flags[k] = null
      sources[k] = null
      confidence[k] = null
    }
  }
  return { flags, sources, confidence, conflicts }
}

/** Primary (non-GoPlus) evidence for one flag: GoldRush intel first, then the on-chain status — exactly the
 *  precedence resolveContractFlags already used, with the source kept. Only 'verified' / 'not_detected' are
 *  answers; 'possible', 'partial' and 'inferred' are not. */
export function primaryFlagEvidence(indexedValue: boolean | null | undefined, onchain: { status: string; confidence: FlagConfidence }): PrimaryFlagEvidence {
  if (indexedValue != null) return { value: indexedValue, source: 'indexed', confidence: 'high' }
  if (onchain.status === 'verified') return { value: true, source: 'onchain', confidence: onchain.confidence }
  if (onchain.status === 'not_detected') return { value: false, source: 'onchain', confidence: onchain.confidence }
  return { value: null, source: null, confidence: null }
}

/** The pre-existing security.contractFlags values: on-chain / indexed only, provider data never included. */
export function primaryFlagValues(primary: Record<ContractFlagKey, PrimaryFlagEvidence>): Record<ContractFlagKey, boolean | null> {
  return { mint: primary.mint.value, proxy: primary.proxy.value, blacklist: primary.blacklist.value, pause: primary.pause.value, withdraw: primary.withdraw.value }
}
