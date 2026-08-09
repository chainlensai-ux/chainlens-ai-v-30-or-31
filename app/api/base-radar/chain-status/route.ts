import { NextResponse, type NextRequest } from 'next/server'
import { isRobinhoodChainAvailable, robinhoodChainConfigAudit } from '@/lib/server/robinhoodChainConfig'

// CHAIN STATUS, DISCLOSED (env verification + feature flag wiring task): this route makes ZERO
// provider/RPC calls of its own — it only reports whether Robinhood Chain support is turned on
// (ENABLE_ROBINHOOD_CHAIN) and configured (ALCHEMY_ROBINHOOD_RPC_URL present), so the frontend
// chain selector (app/terminal/base-radar/page.tsx) can decide whether to even show Robinhood as
// an option. The RPC URL itself (which embeds an Alchemy API key) never leaves the server — this
// response and the audit log below only ever contain booleans/chainId/the selectedChain string.
export async function GET(req: NextRequest) {
  const selectedChain = req.nextUrl.searchParams.get('selectedChain') ?? 'base'
  const audit = robinhoodChainConfigAudit(selectedChain)
  // Safe to log verbatim: no secret value is ever part of this object.
  console.info('[robinhood-chain] robinhoodChainConfigAudit', audit)
  return NextResponse.json({
    robinhood: {
      available: isRobinhoodChainAvailable(),
      enabled: audit.enabled,
      rpcConfigured: audit.rpcConfigured,
      chainId: audit.chainId,
    },
  })
}
