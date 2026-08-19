// SOLANA AUTHORITY ANALYZER, DISCLOSED (Solana-native architecture task): interprets the raw
// mint/freeze authority facts mintAnalyzer.ts reads into a Solana-native risk signal. Mint
// authority controls supply inflation; freeze authority controls whether token accounts can be
// frozen — both native SPL-token concepts, not analogues of an EVM "owner" or "renounced" field.

export type SolanaAuthorityStatus = 'revoked' | 'active' | 'unknown'

export type SolanaAuthorityAnalysis = {
  mintStatus: SolanaAuthorityStatus
  freezeStatus: SolanaAuthorityStatus
  reasons: string[]
}

export function analyzeSolanaAuthority(input: {
  mintAuthority: string | null
  freezeAuthority: string | null
  authorityReadSucceeded: boolean
}): SolanaAuthorityAnalysis {
  const reasons: string[] = []
  if (!input.authorityReadSucceeded) {
    return { mintStatus: 'unknown', freezeStatus: 'unknown', reasons: ['Mint/freeze authority could not be read — treat authority status as unknown.'] }
  }
  const mintStatus: SolanaAuthorityStatus = input.mintAuthority ? 'active' : 'revoked'
  reasons.push(input.mintAuthority ? 'Mint authority is still active — supply can be increased.' : 'Mint authority is revoked.')
  const freezeStatus: SolanaAuthorityStatus = input.freezeAuthority ? 'active' : 'revoked'
  reasons.push(input.freezeAuthority ? 'Freeze authority is still active — token accounts can be frozen.' : 'Freeze authority is revoked.')
  return { mintStatus, freezeStatus, reasons }
}
