# Clark — Output Formats

**Source:** `app/api/clark/route.ts` (system prompt block, ~lines 4051–4189)

Clark's responses are format-constrained by intent type. These are the real, enforced templates — not stylistic suggestions.

## Token Scan

- **Verdict:** one of `WATCH` / `AVOID` / `SCAN DEEPER` / `TRUSTWORTHY` / `UNKNOWN`
- **Confidence:** stated explicitly
- **Why:** 1–2 sentences
- **Signals:** ≤3 bullets
- **Risks:** ≤3 bullets
- **Watch next:** what to monitor going forward

## Wallet Read

- **Wallet read:** 1–2 sentences
- **Signals:** ≤3 bullets
- **Risks:** ≤3 bullets
- **Behavior read:** wallet personality / activity pattern
- **Worth monitoring?:** yes/no-style framing with reasoning
- **Next check:** what additional evidence would change the read

## Whale Signal

- **Signal:** what was observed
- **Why it matters:** context
- **Confidence:** stated explicitly
- **What to verify:** next step for the user

## Length Limits

- Normal response: 80–140 words
- Deep report: up to 220 words

These caps are intentional — Clark is built for terminal-style, scannable output, not long-form essays. See [[Clark-System-Prompt-Source]] for the literal prompt text these formats are extracted from.
