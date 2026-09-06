# Backend — Supported Chains & Limitations

**Source:** `app/api/clark/route.ts` (`toTokenApiChain()`), `lib/server/clarkRouting.ts` (`normalizeFollowupChain()`), `lib/server/lpProof.ts`

Docs in this vault are **not** source of truth for runtime logic — re-read the functions named above before changing product behavior.

## Token Scanner (Token Core)

`toTokenApiChain()` resolves **Base**, **Ethereum** (`eth`), **BNB**, and **Robinhood**. It returns `null` for chains Token Core cannot scan (Polygon, Solana, Arbitrum, unknown). Callers must surface that as an explicit "chain not yet supported" / unsupported-follow-up message — they must **not** fall through to a Base scan.

Clark's local `SupportedChain` for GoldRush/GoPlus is `"base" | "ethereum" | "bnb"`. Robinhood is a separate `ForcedTokenScanChain` (and `toTokenApiChain`) member, not a GoldRush map key. Polygon is a named identity used only for honest rejection.

## Wallet Scanner

Wallet snapshot/PnL data is sourced from Moralis/GoldRush/Zerion, which have broader multi-chain coverage than the token scanner, but Clark's *chain detection* (`extractRequestedChainFromPrompt()` in `clarkRouting.ts`) only explicitly recognizes ETH, BNB/BSC, Polygon, and Base chain words for routing purposes. Robinhood wallet PnL is a separate lane (`robinhoodWalletScanner`) and is never blended into EVM realized totals.

## Pump Intelligence

Pump Intelligence list/API chain slugs are `base | eth | robinhood`. Solana/BNB pump prompts return Unsupported rather than scanning Base. Base remains the product default only when no identity carried a chain.

## LP Proof

RPC-dependent LP/concentrated-liquidity proofs depend on [[RPC-Chain-Config]] resolving an RPC for the chain. Base and Ethereum are the only chains with a configured RPC path in `lpProof.ts`.

## Uniswap V4

Treated as `concentrated_liquidity`, not as an unsupported chain/protocol — see [[Liquidity-LP-Proof]] for why V4's proof requirements differ from V2-style ERC-20 LP tokens.

## Net effect

Token scans run on Base, Ethereum, BNB, and Robinhood. LP proof and the deepest concentrated-liquidity checks remain effectively Base + Ethereum. Polygon/Solana/Arbitrum token scans are honest-unsupported, not a silent Base fallback. Treat the runtime helpers as ground truth when writing user-facing copy.
