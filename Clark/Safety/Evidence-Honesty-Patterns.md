# Safety — Evidence Honesty Patterns

This note describes the design principle underneath [[Public-Grade-Filtering]] and [[Guardrails-and-Refusal-Rules]]: **"unknown" must be a real, returnable value — never silently collapsed into "safe" or "risky."**

## Evidence-gap fields

Multiple capabilities return an explicit gap list alongside their result, rather than just a verdict:

- `DevHistoryRead.evidenceGaps` — [[Dev-Wallet-Rug-History]]
- LP control `evidenceGaps` — `lpControllerIntel.ts`, [[Liquidity-LP-Proof]]
- `missingEvidence` on concentrated position proof — [[Liquidity-LP-Proof]]

## Multi-state evidence types (not boolean)

Boolean "verified: true/false" would force every unresolved case into "false," which reads as a flag. Instead, types like:

- `LpLockStatus`: `locked | burned | unlocked | unverified`
- `evidenceLevel` (dev history): `confirmed_rug | cross_token_signals | deployer_confirmed | token_local_only | none`
- `samplingStatus`: `not_attempted | attempted_no_candidates | sampled_partial | failed`
- `publicPnlStatus` family: `ok | open_check | near_flat_verified_sample | activity_only | missing_cost_basis | limited_verified_sample | ...`

...give the "we don't know yet" case its own first-class state, distinct from both "checked and clean" and "checked and bad."

## Confidence + verdict are separate axes

Clark's output formats ([[Output-Formats]]) always separate "what we found" (Signals/Risks) from "how sure we are" (Confidence) and "what we couldn't check" (evidence gaps / next check). A high-risk verdict with low confidence is presented differently from a high-risk verdict with confirmed evidence — collapsing these into one score would lose information the user needs to calibrate trust.

## Practical rule for anyone extending Clark

When adding a new capability or evidence field: if a check can fail to resolve (RPC timeout, no data source, rate-limited provider), add an explicit "unresolved" state to its type — don't default it to whichever boolean value happens to read as "safe."
