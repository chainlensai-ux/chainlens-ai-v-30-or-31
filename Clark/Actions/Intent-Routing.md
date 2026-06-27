# Actions — Intent Routing

**Source:** `lib/server/clarkRouting.ts`, core function `classifyClarkPrompt()` (~lines 238–357)

Clark uses deterministic regex/keyword routing, not an LLM classification step, to decide which capability handles a message.

## Pipeline

1. **Keyword extraction:** pulls `0x...` addresses, ticker symbols (`$AERO`, `BRETT`), explicit chain names (base/eth/bnb/polygon).
2. **Chain extraction:** `extractRequestedChainFromPrompt()` using `ETH_CHAIN_WORD_RE`, `BNB_CHAIN_WORD_RE`, `POLYGON_CHAIN_WORD_RE`, `BASE_CHAIN_WORD_RE`.
3. **Address route hint:** `getClarkAddressRouteHint()` (~lines 112–120) returns `"token"`, `"wallet"`, `"ambiguous"`, or `"none"` based on signal words near the address (token signals: "token", "coin", "contract", "CA", "ticker", "on base", "rug", "lp locked", "honeypot", "tax"; wallet signals: "wallet", "portfolio", "holdings", "pnl", "profit", "trades").
4. **Intent classification**, checked in this exact precedence order:

| Order | Intent | Trigger |
|---|---|---|
| 1 | `wallet_compare` | `WALLET_COMPARE_RE` match + ≥1 address |
| 2 | `wallet_pnl_followup` | PnL/history follow-up phrasing, resolved from memory |
| 3 | `token_ape_risk` | "safe to ape", "full risk breakdown" |
| 4 | `dev_rug_history` | "has dev ever rugged before", "check dev history" |
| 5 | `liquidity_scan` | LP/liquidity checks with address or symbol |
| 6 | `wallet_scan` | plain EOA address, or "scan wallet" + address |
| 7 | `base_radar` | contains "radar" |
| 8 | `base_market_discovery` | "what's pumping on base", "trending tokens", "base movers" |
| 9 | `whale_alert` | "whales", "whale alerts", "big wallet", "smart money" |
| 10 | `token_safety` | `TOKEN_SAFETY_RE` — "is this token safe", "is it a rug" |
| 11 | `dev_rug_check` | `DEV_RUG_RE` — "can dev rug", "does dev control" |
| 12 | `lp_lock_check` | `LP_LOCK_RE` — "is lp locked", "liquidity control" |
| 13 | `risk_explanation` | `RISK_EXPL_RE` — "why is this risky", "explain the score" |
| 14 | `token_scan` | explicit "token scan", or address + "on base"/"on eth", or named ticker |
| — | `none` | no match |

## Why order matters

More specific intents are always checked before the generic `token_scan` fallback. This prevents, e.g., "can the dev rug this?" from being misrouted to a flat token scan instead of the dev-control-specific formatter.

## Related

- [[Follow-Up-Commands]] — how multi-turn context overrides this routing
- [[Tool-Call-Map]] — intent → tool/handler mapping
