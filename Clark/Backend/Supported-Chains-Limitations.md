# Backend — Supported Chains & Limitations

**Source:** `app/api/clark/route.ts` (`toTokenApiChain()`, ~lines 767–771), `lib/server/lpProof.ts`

## Token Scanner (Token Core)

`toTokenApiChain()` only resolves **Base** and **Ethereum**. Any other chain (Polygon, BNB/BSC, Arbitrum) returns `null`, and the token scan handler responds with an explicit "chain not yet supported" message — it does not attempt a best-effort scan on an unsupported chain.

## Wallet Scanner

Wallet snapshot/PnL data is sourced from Moralis/GoldRush/Zerion, which have broader multi-chain coverage than the token scanner, but Clark's *chain detection* (`extractRequestedChainFromPrompt()` in `clarkRouting.ts`) only explicitly recognizes ETH, BNB/BSC, Polygon, and Base chain words for routing purposes.

## LP Proof

RPC-dependent LP/concentrated-liquidity proofs depend on [[RPC-Chain-Config]] resolving an RPC for the chain. Base and Ethereum are the only chains with a configured RPC path in `lpProof.ts`.

## Uniswap V4

Treated as `concentrated_liquidity`, not as an unsupported chain/protocol — see [[Liquidity-LP-Proof]] for why V4's proof requirements differ from V2-style ERC-20 LP tokens.

## Net effect

Clark's deepest, most-verified capabilities (token scan, LP proof, dev history) are effectively Base + Ethereum only today. This is a real, current limitation — not a temporary bug — and should be treated as ground truth when writing user-facing copy or onboarding docs.
