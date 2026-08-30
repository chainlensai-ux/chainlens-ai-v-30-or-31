// SOLANA RISK ENGINE, DISCLOSED (Solana-native architecture task): a Solana-native risk read —
// built from authority status, top-account concentration, and market health, the real evidence
// this pipeline actually collects. Not the EVM risk model reused: EVM's engine scores honeypot
// simulation, tax simulation, LP lock/burn proof, and ownership renouncement, none of which exist
// as concepts here. This engine only ever scores what Solana Beta genuinely has evidence for.
//
// BEST-CASE CEILING, DISCLOSED: deliberately cannot return a "safe"/"verified" verdict. The best
// available outcome is OPEN_CHECK — because with honeypot, tax, LP-control and deployer evidence
// all unavailable on this path, no amount of the evidence we CAN collect is sufficient to call a
// Solana token clean. Confidence is capped at MEDIUM and drops to LOW as evidence gaps accumulate.
// Per this engine's own design contract: unsupported checks lower CONFIDENCE only, never treated
// as a risk finding by themselves — see analyzeSolanaAuthority/analyzeSolanaHolders for where the
// real risk-relevant facts come from.

import { analyzeSolanaAuthority } from './authorityAnalyzer.ts'

export type SolanaRiskRead = {
  verdict: 'OPEN_CHECK' | 'CAUTION' | 'HIGH_RISK'
  confidence: 'LOW' | 'MEDIUM'
  reasons: string[]
}

export function scoreSolanaBeta(input: {
  mintAuthority: string | null
  freezeAuthority: string | null
  authorityReadSucceeded: boolean
  top1Percent: number | null
  marketDataAvailable: boolean
  liquidityUsd: number | null
  evidenceGapCount: number
  // RELIABILITY FIX, DISCLOSED (Solana holder-concentration reliability task, hard rule: "do not
  // treat unsupported as confirmed bad... final verdict should say evidence limited if holder data
  // missing"): optional so every existing caller/test that doesn't pass it is unaffected — when
  // omitted, behavior is byte-identical to before this field existed (no holder-specific reason
  // added, confidence still governed by evidenceGapCount alone, same as always). When explicitly
  // `false`, this ONLY ever adds a reason string and, together with the evidenceGapCount check
  // below, can only ever LOWER confidence — never raises verdict to CAUTION/HIGH_RISK by itself,
  // since missing evidence is not itself a risk finding.
  holderConcentrationAvailable?: boolean
}): SolanaRiskRead {
  let verdict: SolanaRiskRead['verdict'] = 'OPEN_CHECK'

  const authority = analyzeSolanaAuthority(input)
  const reasons: string[] = [...authority.reasons]
  if (authority.mintStatus === 'active') verdict = 'CAUTION'
  if (authority.freezeStatus === 'active') verdict = 'HIGH_RISK'

  if (input.top1Percent != null && input.top1Percent >= 50) {
    reasons.push(`Top account holds ${input.top1Percent}% of supply (may be an AMM pool vault — not necessarily a single whale).`)
    if (verdict === 'OPEN_CHECK') verdict = 'CAUTION'
  }

  if (!input.marketDataAvailable) {
    reasons.push('No Solana market data found — token may be unlaunched, illiquid, or not indexed.')
  } else if (input.liquidityUsd != null && input.liquidityUsd < 5_000) {
    reasons.push(`Liquidity is thin (${input.liquidityUsd} USD across indexed Solana pools).`)
    if (verdict === 'OPEN_CHECK') verdict = 'CAUTION'
  }

  // Confidence is capped by construction: MEDIUM only when authority read succeeded AND market
  // data resolved AND gaps are few. Everything else is LOW.
  const confidence: SolanaRiskRead['confidence'] =
    input.authorityReadSucceeded && input.marketDataAvailable && input.evidenceGapCount <= 2 ? 'MEDIUM' : 'LOW'

  reasons.push('Solana: honeypot, tax, LP-control and deployer checks are not available on this path.')
  if (input.holderConcentrationAvailable === false) {
    reasons.push('Evidence limited — holder concentration is unavailable for this mint, so supply-distribution risk could not be assessed.')
  }
  return { verdict, confidence, reasons }
}
