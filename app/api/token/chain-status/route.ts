import { NextResponse, type NextRequest } from 'next/server'
import { isSolanaChainAvailable, solanaChainConfigAudit, solanaTokenScannerConfigAudit, isHeliusConfigured, isJupiterConfigured } from '@/lib/server/solanaChainConfig'

// TOKEN SCANNER CHAIN STATUS, DISCLOSED (Solana Beta task): makes ZERO provider/RPC calls of its
// own — it only reports whether Solana Beta is turned on (ENABLE_SOLANA_BETA) and configured
// (ALCHEMY_SOLANA_RPC_URL present), so the Token Scanner chain selector can decide whether to show
// Solana Beta at all. Mirrors app/api/base-radar/chain-status/route.ts, this codebase's existing
// pattern for exactly this question.
//
// NEVER-LEAK, DISCLOSED: the RPC URL (which embeds an API key) never leaves the server — this
// response contains only booleans.
export async function GET(req: NextRequest) {
  const selectedChain = req.nextUrl.searchParams.get('selectedChain') ?? 'base'
  const audit = solanaChainConfigAudit(selectedChain)
  // Also surface per-provider coverage (Helius/Jupiter opt-in) so the UI can flag a "partial
  // provider coverage" scan rather than silently varying evidence depth between scans — this
  // detail was previously computed (solanaTokenScannerConfigAudit) but only ever logged
  // server-side, never exposed through the endpoint the chain selector actually polls.
  const providerAudit = solanaTokenScannerConfigAudit()
  return NextResponse.json({
    solana: {
      available: isSolanaChainAvailable(),
      enabled: audit.enabled,
      rpcConfigured: audit.rpcConfigured,
      providers: {
        alchemy: providerAudit.alchemySolanaConfigured,
        goldrush: providerAudit.goldrushConfigured,
        marketFallback: providerAudit.marketFallbackConfigured,
        helius: isHeliusConfigured(),
        jupiter: isJupiterConfigured(),
      },
    },
  })
}
