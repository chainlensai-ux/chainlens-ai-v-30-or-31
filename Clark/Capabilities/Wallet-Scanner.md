# Capability — Wallet Scanner

**Tool names:** `wallet_get_snapshot`, `wallet_analyze_quality`
**Handler:** `scanWalletData()` in `app/api/clark/route.ts`
**Backend route:** wallet snapshot endpoint (`/api/wallet`)

## What it does

For an EOA address, returns:

- Holdings snapshot (token balances, value)
- Transaction history (via Moralis / GoldRush — see [[Backend-Providers]])
- PnL evidence — see [[PnL-Engine]]
- Wallet personality / quality classification (`walletIntelligence.ts` → `computeWalletPersonality()`)

## Routing into this capability

`classifyClarkPrompt()` routes a plain EOA address, or an address plus "scan wallet", into `wallet_scan` intent. Wallet-specific signal words used for disambiguation against token intent: "wallet", "portfolio", "holdings", "pnl", "profit", "trades", "scan wallet", "wallet pnl" (`getClarkAddressRouteHint()`, `lib/server/clarkRouting.ts` ~lines 112–120).

## Wallet Compare — explicitly unsupported as a real feature

`wallet_compare` intent exists in the router (`WALLET_COMPARE_RE` + ≥1 address), and `formatWalletCompareUnsupported()` exists as a formatter, but there is no real side-by-side comparison engine wired in. Clark's response for this intent recommends scanning each wallet separately rather than fabricating a comparison. See [[Known-Gaps-and-Stubs]].

## Follow-ups

Wallet follow-up questions ("dig deeper", "why no pnl", "top holdings", "active chains") are resolved against the session's `lastWallet` memory rather than re-running a scan, unless the user explicitly says "refresh" / "rescan" / "deep scan now". Full behavior: [[Follow-Up-Commands]].

## Output discipline

Wallet reads never assert profitability without verified PnL data — see [[PnL-Engine]] and [[Public-Grade-Filtering]].
