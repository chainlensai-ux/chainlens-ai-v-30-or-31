# Design — File Map

Authoritative source-file index. If a note in this vault and this table disagree, trust the actual file.

| File | Responsibility |
|---|---|
| `app/api/clark/route.ts` | System prompt, intent→tool dispatch, all `scan*Data()` handlers, session memory shape |
| `lib/server/clarkRouting.ts` | `classifyClarkPrompt()`, follow-up classification/formatting, dev-history derivation, PnL read building |
| `lib/server/lpProof.ts` | LP lock/burn proof, concentrated-liquidity position-owner sampling, RPC chain resolution |
| `lib/server/lpControllerIntel.ts` | LP controller label/status synthesis, public-grade LP wording |
| `lib/server/riskScore.ts` | Composite 0–100 risk score, risk label tiers |
| `lib/server/honeypotSecurity.ts` | Honeypot/tax simulation via honeypot.is |
| `lib/server/walletIntelligence.ts` | Wallet personality/quality scoring, profit-skill lock conditions |
| `lib/server/moralis.ts` | Moralis provider integration |
| `lib/server/clarkHistory.ts` | Supabase-backed chat history persistence |
| `lib/server/rateLimit.ts` | Plan-based rate limiting |
| `lib/client/clarkMemory.ts` | Client-side session/cache state |
| `app/api/clark/history/route.ts` | Chat history API (Supabase: `clark_chats`, `clark_chat_messages`, `clark_chat_folders`) |
| `app/api/token/route.ts` | Token Core scan endpoint (LP, dev, holder, security evidence) |
| `app/api/liquidity-safety/...` | LP safety endpoint backing `liquidity_analyze` |
| `app/api/base-radar/...` | Base Radar snapshot endpoint |
| `scripts/test-concentrated-position-proof.mjs` | Regression tests for concentrated LP position-owner sampling |

See [[Architecture-Overview]] for how these files connect at request time.
