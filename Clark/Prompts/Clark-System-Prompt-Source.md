# Prompt Source — Clark System Prompt

**Location in code:** `app/api/clark/route.ts`, system prompt constant, ~lines 4051–4189 (also referenced ~line 6594)

This note is the engineering reference for where the actual prompt text lives. It intentionally does not re-paste the full literal prompt string here (that string lives in source and should be edited in one place — the source file — to avoid drift between docs and code).

## What's in the real prompt, structurally

1. **Persona block** — identity as "the onchain intelligence analyst inside ChainLens" → documented in [[Identity-and-Tone]]
2. **Knowledge scope block** — DeFi/Base ecosystem specifics → [[Identity-and-Tone]]
3. **Behavioral bans block** — no buy/sell language, no fake safety claims, no provider name exposure, etc. → [[Guardrails-and-Refusal-Rules]]
4. **Output format block** — Token Scan / Wallet Read / Whale Signal templates, word-count caps → [[Output-Formats]], [[Output-Format-Templates]]
5. **Memory rules block** (~lines 4116–4135) — carry-forward rules → [[Memory-Rules]]

## Editing process

If the prompt text in `route.ts` changes, update the corresponding linked notes above in the same PR. Do not let this vault drift from source — these notes describe behavior, they do not define it.
