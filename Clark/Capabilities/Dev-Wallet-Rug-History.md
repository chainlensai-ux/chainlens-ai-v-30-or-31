# Capability — Dev Wallet / Rug History

**Tool name:** `dev_wallet_analyze`
**Handler:** `scanDevWalletData()` in `app/api/clark/route.ts`
**Core logic:** `deriveDevHistoryFromTokenEvidence()`, `lib/server/clarkRouting.ts` (~lines 2801–2877)

## What it does

Given a token's deployer/origin wallet, checks for prior rug behavior across linked wallets and previously launched tokens.

## Evidence levels (`DevHistoryRead.evidenceLevel`)

- `confirmed_rug` — direct prior rug evidence in linked wallets or previous tokens
- `cross_token_signals` — risky cross-token or linked-wallet behavior, not a confirmed rug
- `deployer_confirmed` — deployer identified, no risky history found
- `token_local_only` — only current-token risk signals available, deployer history not resolvable
- `none` — no useful evidence

## Output fields

`evidenceLevel`, `status`, `statusReason`, `inputType`, `chain`, `deployer`, `linkedWallets`, `previousLaunchedTokens`, `repeatedRiskyPatterns`, `linkedWalletClusterSignals`, `suspiciousFundingPatterns`, `priorConfirmedRugEvidence`, `evidenceGaps`.

The presence of an explicit `evidenceGaps` field on every response is intentional — see [[Evidence-Honesty-Patterns]].

## Routing

`dev_rug_history` ("has dev ever rugged before", "check dev history") is a distinct intent from `dev_rug_check` ("can dev rug", "does dev control") in `classifyClarkPrompt()`. The former asks about past behavior; the latter asks about current technical control. Both are checked ahead of the generic `token_scan` fallback. See [[Intent-Routing]].

## Output discipline

Clark is explicitly banned from claiming a deployer is "clean" without live Dev Control data (system prompt rule — see [[Guardrails-and-Refusal-Rules]]). Absence of evidence is reported as `evidenceLevel: "none"` or `"token_local_only"`, never collapsed into "no history = safe."
