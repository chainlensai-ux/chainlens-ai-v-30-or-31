# Memory — Server-Side Session State

**Source:** `app/api/clark/route.ts` (~lines 144–200), `lib/server/clarkHistory.ts`, `app/api/clark/history/route.ts`

## `ClarkSessionMemory` shape

- `lastToken`: `{ address, symbol, name, scanSummary, chain, normalizedEvidenceSummary, cachedEvidence (TokenScanEvidence), confidence, ts }`
- `lastWallet`: `{ address, ensName, walletSummary, snapshot, pnlEvidence, cachedEvidence, chainMode, lastScannedAt, ts }`
- `lastMomentumList`: ranked array of market tokens
- `lastIntent`: last classified intent (see [[Intent-Routing]])
- Previous token/wallet retained for undo/comparison

## Persistence layer

`app/api/clark/history/route.ts` persists chat history per **authenticated** user via Supabase tables: `clark_chats`, `clark_chat_messages`, `clark_chat_folders`. Anonymous/unauthenticated sessions rely on the in-request session memory only — they do not get durable cross-session history.

## Used by

- [[Follow-Up-Commands]] — `lastToken`/`lastWallet` are the resolution target for follow-up questions
- [[Wallet-Scanner]], [[Token-Scanner]] — populate this memory after each scan

## Boundary

This is request/session-scoped state plus an authenticated persistence layer — it is not a long-term knowledge base about a token or wallet. Each new scan overwrites `lastToken`/`lastWallet`; there's no merge of old + new evidence beyond what [[Memory-Rules]] specifies for in-conversation refinement.
