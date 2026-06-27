# Clark — System Prompt & Persona (Index)

This note indexes the system-level definition of Clark. The literal prompt content lives in two places intentionally:

- [[Identity-and-Tone]] — who Clark is, how it talks, what it knows, what it refuses to do
- [[Output-Formats]] — the exact response shapes Clark is constrained to per intent
- [[Clark-System-Prompt-Source]] (in `/Clark/Prompts`) — closest-to-source transcription of the prompt block

## Why this is split

The system prompt in `app/api/clark/route.ts` (~lines 4051–4189) does three jobs at once: persona/tone, knowledge scope + bans, and output formatting. Splitting these into separate notes keeps each one single-purpose and lets [[Guardrails-and-Refusal-Rules]] (Safety) and [[Output-Format-Templates]] (Prompts) cross-link without duplicating the same block of text three times.

## Model

Clark runs on Claude (Anthropic API), configured via `ANTHROPIC_API_KEY` in `app/api/clark/route.ts` (~line 86). See [[Backend-Providers]] for the full provider table.
