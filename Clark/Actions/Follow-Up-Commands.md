# Actions — Follow-Up Command Handling

**Source:** `lib/server/clarkRouting.ts` (~lines 122–211, 976–1086)

## Token follow-ups

`isTokenFollowupPrompt()` (~lines 194–199) matches `TOKEN_FOLLOWUP_RE`: "is it safe", "safe?", "explain lp", "can dev rug", "why high risk", "bull case", "explain holders". These resolve against `lastToken` in session memory ([[Session-Memory-Server]]) unless an explicit wallet override phrase is present (`EXPLICIT_WALLET_OVERRIDE_RE`).

Sub-intent classification — `classifyTokenFollowupKind()` (~lines 204–211): `safety`, `dev_rug`, `lp_lock`, `risk`, `analyst`.

## Wallet follow-ups

`isWalletFollowupPrompt()` (~lines 150–157) matches `WALLET_FOLLOWUP_RE` (~line 52): "dig deeper", "why no pnl", "why pnl missing", "recover history", "what about this wallet", "top holdings", "active chains". Resolved against `lastWallet` in session memory.

Sub-intent classification — `classifyWalletFollowupKind()` (~lines 159–171): `wallet_pnl_explanation`, `wallet_profitability`, `wallet_holdings`, `wallet_chains`, `wallet_deep_scan_advice`, `wallet_evidence_gaps`, `wallet_risk`, `wallet_profile`, `wallet_quality`, `wallet_summary`.

Formatter: `formatWalletFollowupFromMemory()` (~lines 976–1086) returns a tailored read per sub-intent without re-running a scan.

## Wallet compare

`isWalletComparePrompt()` (~lines 173–178): "compare wallet A vs B". See [[Wallet-Scanner]] for why this routes to an "unsupported, scan separately" response rather than a real comparison.

## Refresh vs. follow-up

`WALLET_REFRESH_RE` (~line 144) distinguishes "refresh" / "rescan" / "deep scan now" (triggers a real new scan) from "should I deep scan?" / "deep scan?" (treated as an advice question answered from existing memory, not a re-scan).

## Why this distinction exists

Re-running a full scan on every follow-up would be slow and would burn rate-limit budget (see [[Rate-Limiting]]) for questions that don't need fresh data. Memory-resolved follow-ups are the default; explicit refresh language is required to force a new fetch.
