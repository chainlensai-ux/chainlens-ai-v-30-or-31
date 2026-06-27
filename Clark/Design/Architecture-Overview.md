# Design — Clark Architecture Overview

## Request flow

1. User message arrives at `app/api/clark/route.ts`.
2. Rate limit check — [[Rate-Limiting]].
3. Client + server session memory loaded — [[Session-Memory-Client]], [[Session-Memory-Server]].
4. `classifyClarkPrompt()` determines intent — [[Intent-Routing]].
5. Intent maps to a tool/handler — [[Tool-Call-Map]].
6. Handler calls exactly one ChainLens backend API route, which itself aggregates one or more external providers — [[Backend-Providers]].
7. Handler result is normalized into evidence objects with explicit gap/confidence fields — [[Evidence-Honesty-Patterns]].
8. Evidence is handed to the LLM (Claude, via Anthropic API) along with the system prompt — [[System-Prompt-and-Persona]] — which formats the final response per [[Output-Formats]].
9. Result is persisted back into session memory and (if authenticated) into Supabase chat history — [[Session-Memory-Server]].

## Layering principle

Clark itself (the LLM call) never talks to external providers directly. All provider calls happen in deterministic backend code (`lib/server/*.ts`, `app/api/*/route.ts`) that returns already-hedged evidence objects. The LLM's job is tone, synthesis, and formatting — not deciding what counts as "verified." This is why the safety rules in [[Public-Grade-Filtering]] are implementable as data-shape constraints rather than purely prompt instructions: by the time evidence reaches the model, the honesty constraints are already baked into the possible values.

## Folder map

See [[File-Map]] for the concrete file-to-responsibility list.
