# Clark — Capabilities Overview

**Source:** `app/api/clark/route.ts` (ClarkToolName type, ~lines 593–600, and handler functions)

Clark's capabilities are implemented as a fixed set of callable tools, not an open-ended agent loop. Each tool maps to one backend handler and one ChainLens API route.

| Tool (ClarkToolName) | Handler | Backend route | Note |
|---|---|---|---|
| `market_get_base_movers` | `scanBasePumpMap()` / pump handler | Base movers feed | [[Market-Intelligence-Base-Radar-Whale-Pump]] |
| `token_resolve` | symbol → contract resolution | — | runs before `token_scan` |
| `token_scan` | `scanTokenData()` | `/api/token` | [[Token-Scanner]] |
| `wallet_get_snapshot` | `scanWalletData()` | `/api/wallet` (wallet snapshot) | [[Wallet-Scanner]] |
| `wallet_analyze_quality` | wallet personality/quality scoring | `walletIntelligence.ts` | [[Wallet-Scanner]] |
| `dev_wallet_analyze` | `scanDevWalletData()` | deployer/dev-history lookup | [[Dev-Wallet-Rug-History]] |
| `liquidity_analyze` | `scanLiquidityData()` | `/api/liquidity-safety` | [[Liquidity-LP-Proof]] |

## Related, non-tool capabilities

These run as part of the above handlers, not as separately callable tools:

- **Risk scoring** — [[Risk-Engine-Scoring]] (`lib/server/riskScore.ts`)
- **PnL evaluation** — [[PnL-Engine]] (`lib/server/clarkRouting.ts`, `walletIntelligence.ts`)
- **Honeypot/security simulation** — `lib/server/honeypotSecurity.ts`, feeds into `token_scan`
- **LP controller intelligence** — `lib/server/lpControllerIntel.ts`, feeds into `liquidity_analyze`

## Known unsupported / partial capabilities

See [[Known-Gaps-and-Stubs]] for the authoritative list (wallet compare, Uniswap V4 LP-burn proof, non-Base/ETH chains, copy-trade advice).
