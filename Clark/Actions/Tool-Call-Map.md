# Actions — Tool Call Map

**Source:** `app/api/clark/route.ts` (ClarkToolName, ~lines 593–600 + handlers)

Maps each routed intent (from [[Intent-Routing]]) to the tool/handler that actually executes it.

| Intent | Tool | Handler function | Doc |
|---|---|---|---|
| `token_scan`, `token_safety`, `token_ape_risk`, `risk_explanation` | `token_resolve` → `token_scan` | `scanTokenData()` | [[Token-Scanner]] |
| `wallet_scan`, `wallet_pnl_followup` | `wallet_get_snapshot`, `wallet_analyze_quality` | `scanWalletData()` | [[Wallet-Scanner]] |
| `wallet_compare` | — (unsupported) | `formatWalletCompareUnsupported()` | [[Wallet-Scanner]], [[Known-Gaps-and-Stubs]] |
| `liquidity_scan`, `lp_lock_check` | `liquidity_analyze` | `scanLiquidityData()` | [[Liquidity-LP-Proof]] |
| `dev_rug_check`, `dev_rug_history` | `dev_wallet_analyze` | `scanDevWalletData()` | [[Dev-Wallet-Rug-History]] |
| `base_radar` | `market_get_base_movers` | `scanBaseRadarData()` | [[Market-Intelligence-Base-Radar-Whale-Pump]] |
| `base_market_discovery` | `market_get_base_movers` | `scanPumpData()` | [[Market-Intelligence-Base-Radar-Whale-Pump]] |
| `whale_alert` | — | `scanWhaleData()` | [[Market-Intelligence-Base-Radar-Whale-Pump]] |
| `none` | — | falls through to general conversational response, governed by system prompt only | [[System-Prompt-and-Persona]] |

## One handler, one route

Each handler calls exactly one ChainLens API route internally — Clark does not chain multiple tool calls together for a single user turn. Multi-faceted answers (e.g. a token scan that also references dev history) come from a single route already returning combined evidence (Token Core's `/api/token` includes LP, dev, and holder data in one payload), not from Clark orchestrating several sequential tool calls.
