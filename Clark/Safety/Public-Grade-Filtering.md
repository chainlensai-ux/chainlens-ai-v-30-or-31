# Safety — Public-Grade Filtering

Public-grade filtering is the pattern of withholding or hedging a claim until enough verified evidence exists to support it, rather than showing a best-effort guess as if it were confirmed.

## Where it's implemented

| Location | Pattern |
|---|---|
| `lpProof.ts` (~lines 19–22) | `LpLockStatus = "locked" \| "burned" \| "unlocked" \| "unverified"` — no fifth "probably fine" state |
| `lpControllerIntel.ts` (~lines 139–150) | Concentrated pools say "Liquidity ownership is still being verified" instead of a false lock claim |
| `clarkRouting.ts` (~lines 504–506) | Evidence gaps always explicitly listed: "LP lock/control, holder concentration, and deployer history are not yet verified for these tokens" |
| `honeypotSecurity.ts` (~lines 85–150) | Maps raw simulation result to `verified` / `partial` / `unverified` — timeout or unavailable never becomes "passed" |
| `lpProof.ts` `concentratedPositionProof.samplingStatus` | `sampled_partial` is explicitly distinct from full-pool coverage — see [[Liquidity-LP-Proof]] |
| `clarkRouting.ts` PnL display modes | `verified_public` / `limited_sample` / `estimated_only` / `locked` — see [[PnL-Engine]] |

## The threshold pattern

Several capabilities use an explicit numeric threshold below which a claim is downgraded rather than shown at full confidence:

- PnL: `REQUIRED_PUBLIC_GRADE_LOTS = 10` closed lots
- Concentrated LP sampling: `SAMPLE_CANDIDATE_CAP = 20` candidates — and the result is always labeled "sampled," never "full-pool"

## Phrase vocabulary (use these, don't invent new hedging language)

- "sampled" vs. "full coverage"
- "confirmed" vs. "open check"
- "verified" vs. "unverified"
- "verified public PnL" vs. "estimated" vs. "limited sample"
- "Closed lots below threshold" (not "no profitability data")

## Why this is its own safety category, not just a UX choice

This is the mechanism that makes the bans in [[Guardrails-and-Refusal-Rules]] enforceable at the data layer instead of relying purely on the model following prompt instructions. See [[Evidence-Honesty-Patterns]] for the underlying design principle.
