// MODULE — single source of truth for which chains this application actually has Alchemy
// integration/API keys for.
//
// CU-LEAK AUDIT, DISCLOSED (this task): the reported incident (eth_getBalance spread near-evenly
// across Scroll, Polygon, OP, Avalanche, BNB, Base, Ethereum, Arbitrum, zkSync, Linea) was searched
// for exhaustively across every .ts/.tsx source file in this repository — no call site, chain
// constant, hook, or loop was found that queries balances (or anything else) against Scroll,
// Optimism, Avalanche, zkSync, or Linea. This repo's own .env.example only documents Alchemy keys
// for base/eth/polygon/bnb/arbitrum (+ hyperevm, reserved/not-yet-wired) — 5 of the 10 reported
// chains have NO corresponding API key, RPC URL, or code path anywhere in this codebase. This
// module makes that boundary an enforced invariant (not just documentation/convention) so any
// future code that tries to call Alchemy for a chain this app doesn't actually support fails
// loudly and immediately, rather than silently succeeding via some other unaudited path.
//
// See the CU-leak investigation report (this task's commit message) for the full disclosure of
// what was and wasn't found, and what would still be needed (Alchemy dashboard app-level
// attribution, Vercel env var audit) to conclusively identify the incident's real source.

export const ALCHEMY_SUPPORTED_CHAINS = ['base', 'eth', 'ethereum', 'polygon', 'bnb', 'bsc', 'arbitrum', 'hyperevm'] as const
export type AlchemySupportedChain = (typeof ALCHEMY_SUPPORTED_CHAINS)[number]

export function isAlchemySupportedChain(chain: string): chain is AlchemySupportedChain {
  return (ALCHEMY_SUPPORTED_CHAINS as readonly string[]).includes(chain.toLowerCase())
}

export class UnsupportedAlchemyChainError extends Error {
  constructor(public readonly chain: string, public readonly route: string) {
    super(`Alchemy call rejected: chain "${chain}" is not supported by this application (route: ${route})`)
    this.name = 'UnsupportedAlchemyChainError'
  }
}

// Throws (never silently returns/skips) so a caller that forgets to check first still fails
// closed — the same "never a silent fallback into a wider path" discipline required by this task.
export function assertAlchemyChainAllowed(chain: string, route: string): void {
  if (!isAlchemySupportedChain(chain)) {
    throw new UnsupportedAlchemyChainError(chain, route)
  }
}
