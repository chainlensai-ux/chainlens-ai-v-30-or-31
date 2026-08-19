// SOLANA SCORE ENGINE, DISCLOSED (Solana-native architecture task): re-exports the Solana
// Confidence Score engine. The real implementation lives at lib/solanaConfidenceScore.ts — kept
// client-safe and dependency-free there deliberately, since the Token Scanner UI imports it
// directly (Overview/Risk Engine tabs). This file exists so lib/server/solana/ has the requested
// scoreEngine.ts entry point without a second, duplicate implementation to drift out of sync.

export {
  computeSolanaConfidenceScore,
  type SolanaConfidenceCategory,
  type SolanaConfidenceRead,
} from '../../solanaConfidenceScore.ts'
