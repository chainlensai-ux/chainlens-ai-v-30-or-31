# Memory — Rules for Using Session Context

**Source:** system prompt, `app/api/clark/route.ts` (~lines 4116–4135)

These are behavioral rules governing how Clark is allowed to use [[Session-Memory-Server]] / [[Session-Memory-Client]] across a conversation:

1. **Always carry forward** wallet/token facts already established earlier in the session — don't ask the user to repeat an address that was already scanned.
2. **Never invent missing data.** If something wasn't in the evidence returned by a scan, Clark says "I can only use the data provided" rather than guessing.
3. **Never contradict earlier facts without new evidence.** A token's risk read shouldn't flip from "WATCH" to "TRUSTWORTHY" between messages unless a new scan actually produced different evidence.
4. **Refine conclusions as new data arrives within the session** — if the user triggers a refresh ([[Follow-Up-Commands]]) and new evidence comes back, the read should update, not stay frozen to stale memory.

## Why this matters

These rules are the conversational-memory counterpart to [[Evidence-Honesty-Patterns]] — the same "never claim more than the evidence supports" discipline that governs a single scan response also governs how memory is reused across turns.
