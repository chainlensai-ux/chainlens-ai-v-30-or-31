# Clark Release Audit and Upgrade Plan

## Task 1 — Current intelligence stack audit

### 1) What tools Clark can currently call

Current `/api/clark` supports feature dispatch to:
- `token-scanner`
- `wallet-scanner`
- `dev-wallet-detector`
- `liquidity-safety`
- `whale-alerts`
- `pump-alerts`
- `base-radar`
- `scan-token`
- `clark-ai`

Within `clark-ai`, the router can call internal endpoints/tooling such as:
- `/api/scan-token` for token contract/name resolution + market/security snapshot
- `/api/wallet` for wallet snapshot
- `/api/dev-wallet` for deployer-linked analysis
- `/api/liquidity-safety` for LP analysis
- `/api/trending` and `/api/proxy/gt` for Base market context
- direct route scanners (`scanTokenData`, `scanWalletData`, `scanLiquidityData`, `scanDevWalletData`, etc.)

### 2) What tools Clark cannot call yet (missing or incomplete)

Missing as first-class tools:
- `wallet.compare(addressA,addressB)`
- `token.fullReport(address)` orchestration across token+liquidity+dev+holder+market in one deterministic flow
- `market.getBaseMovers(options)` with pagination/filtering/ranking controls
- `market.explainMove(token)` with explicit multi-signal reasoning module
- `alerts.explain(walletOrToken)` (alerts API currently stubbed)
- `memory.getLastContext()` / `memory.saveSessionContext()` persistence layer for Clark
- tracked-wallet intelligence integration (watchlists influencing responses)

### 3) Tools that return enough data for real analysis (today)

Strongest current data surfaces:
- `wallet` snapshot returns total value, holdings, tx count, first tx date, wallet age days
- `scan-token` returns token-level market + pool + GoPlus data for Base contracts
- `liquidity-safety` provides LP scoring, pool breakdown, lock-provider attempts, risk tier
- `dev-wallet` provides likely deployer, linked wallets, supply control estimate (when holder data available), suspicious transfer heuristics
- `radar` returns fresh Base new-pool feed + honeypot/tax checks + Clark short verdict lines

### 4) Tools that are shallow/fallback only

Shallow/fallback-prone areas:
- `/api/alerts` is placeholder (`{ success: true }`) and provides no intelligence
- some Clark branches fall back to generic “feature backend not wired” style replies
- generalized intent router often runs one primary branch per request rather than deliberate multi-tool synthesis
- clark `general_market` mode currently ranks GT movers mostly by 24h change; no robust freshness/liq/vol scoring stack

### 5) User questions likely to fail or be weak

Currently weak:
- “compare these two wallets” (no compare tool)
- “which wallets are accumulating this token?” (no token->wallet accumulation index/tool)
- “what changed since yesterday?” (no time-diff persistence/index)
- “is this whale buying early or late?” (no cohort/entry-timing model)
- “full analyst report” exists only as prompt style, not deterministic multi-tool report builder
- “why is this token moving?” has no dedicated explain-move module and may return generic prose

### 6) Answers limited by data availability

Data limitations:
- LP lock/control and honeypot/tax not always available across all routes; some paths explicitly mark unavailable
- holder concentration can be unavailable depending on upstream fetch success
- realized PnL/win-rate/timing are not available in wallet snapshot route
- dev-wallet route currently sets liquidity/security availability false for its own computation path and warns accordingly
- no comprehensive onchain labels to justify “smart money” claims

### 7) Answers limited by prompt/formatter design

Prompt/format limits:
- default Clark normalization aggressively maps outputs into fixed Verdict/Confidence template, which can feel repetitive
- casual/education/market helper branches are partly regex-hardcoded and shallow by design
- enforce/normalize layer can truncate (`capWordsKeepBreaks`) and simplify nuanced model output
- analysis mode prioritizes strict structure over adaptive depth selection from user intent

### 8) Answers limited by missing storage/indexing

Storage/indexing gaps:
- no Clark conversation memory persistence in backend for reusable context
- no “yesterday vs today” state store for movers/holders/wallet deltas
- no tracked-wallet intelligence join in Clark route
- Supabase schema has `saved_wallets`, but Clark route does not read/write it

### 9) Can Clark call multiple tools for one answer?

Partially yes, but not as a formal orchestrator:
- it can fetch trending + GT + route-specific scanner context and send to Anthropic together
- however, routing still tends toward one intent branch and does not execute a deterministic multi-tool full-report pipeline with clear tool outputs and confidence accounting

### 10) Can Clark compare wallets/tokens?

- Wallet compare: No first-class compare implementation.
- Token compare: No dedicated compare implementation.

### 11) Can Clark use Supabase memory/tracked wallets?

- Not currently in Clark route.
- Supabase client/schema exist, including `saved_wallets`, but Clark API does not integrate them for memory or analyst personalization.

### 12) Can Clark explain “why” something is moving?

- Limited/implicit only.
- It can mention GT/trending context, but lacks a dedicated explain-move module that proves causal signal stack (volume/liquidity/age/rotation) and distinguishes evidence vs unknowns.

---

## Task 2+ — Release-level upgrade plan (no broad UI changes)

## Phase 1 — Central Clark tool layer + multi-tool routing

### Files to change
- `app/api/clark/route.ts`
- add `lib/clark/tools.ts` (tool registry + typed tool contracts)
- add `lib/clark/router.ts` (intent + plan compiler)
- add `lib/clark/types.ts` (tool IO schemas + evidence model)

### Scope
- Introduce explicit tool interface:
  - `wallet.getSnapshot`
  - `wallet.analyzeQuality`
  - `wallet.compare`
  - `token.resolve`
  - `token.scan`
  - `token.fullReport`
  - `market.getBaseMovers`
  - `market.explainMove`
  - `devWallet.analyze`
  - `liquidity.analyze`
  - `alerts.explain`
  - `memory.getLastContext`
  - `memory.saveSessionContext`
- Replace single-branch routing with plan-based execution (1..N tools per query)
- Keep existing endpoint wrappers as data adapters (do not break current scanners)
- Add safe error normalization so raw provider errors never leak

### Risk level
- Medium-high (touches main intelligence router)

### Expected user-facing improvement
- Clark can combine multiple data sources in one answer
- better follow-up behavior, less shallow one-route responses

### Acceptance tests
- Prompt classification + tool-plan unit tests
- “scan token + why moving” should execute token+market+liquidity tools in one response
- no raw upstream errors in response surface

---

## Phase 2 — Token full report flow

### Files to change
- `lib/clark/tools.ts`
- `lib/clark/reportBuilders.ts` (new)
- `app/api/clark/route.ts`
- reuse: `app/api/scan-token/route.ts`, `app/api/liquidity-safety/route.ts`, `app/api/dev-wallet/route.ts`, `app/api/trending/route.ts`, `app/api/proxy/gt/route.ts`

### Scope
- Implement deterministic `token.fullReport(addressOrQuery)` pipeline:
  1. `token.resolve`
  2. `token.scan`
  3. `liquidity.analyze`
  4. `devWallet.analyze`
  5. holder distribution availability check
  6. recent Base market context merge
- Render canonical deep report format:
  - Asset / Verdict / Confidence
  - Summary
  - Market
  - Contract
  - Liquidity
  - Dev wallet
  - Risks (max 5)
  - What’s missing
  - Clark’s read
  - Next action
- Strict evidence gates for claims (no fake holder/LP/honeypot claims)

### Risk level
- Medium

### Expected user-facing improvement
- “full report on brett/token” becomes reliable, consistent, deep, and evidence-bounded

### Acceptance tests
- `scan brett`
- `full report on brett`
- `scan this token 0x...`
- `is it safe?` follow-up uses remembered token context

---

## Phase 3 — Wallet intelligence + compare

### Files to change
- `lib/server/walletSnapshot.ts`
- add `lib/clark/walletIntel.ts`
- `app/api/clark/route.ts`
- optional add `app/api/wallet-compare/route.ts` (or keep internal)

### Scope
- Enrich `wallet.analyzeQuality` with:
  - portfolio value + token count + concentration
  - stablecoin dry powder
  - chain/exposure mix
  - activity proxies (tx count, age, recency where available)
  - explicit uncertainty language when smart-money evidence missing
- implement `wallet.compare(addressA,addressB)`:
  - size
  - overlap
  - concentration
  - activity level
  - who is more actionable to monitor
- include safe policy response for “should I copy trade it?” (no financial advice)

### Risk level
- Medium

### Expected user-facing improvement
- Wallet analysis shifts from “rich wallet” to behavior-aware watch-quality calls
- compare-wallet queries become first-class

### Acceptance tests
- `0xwallet tell me the balance`
- `is it a good wallet?`
- `should I copy trade it?`
- `compare these two wallets 0x... 0x...`

---

## Phase 4 — Deeper market discovery + pagination

### Files to change
- `app/api/proxy/gt/route.ts`
- `app/api/trending/route.ts`
- add `app/api/market/base-movers/route.ts`
- `lib/clark/tools.ts`
- `app/api/clark/route.ts`

### Scope
- Implement `market.getBaseMovers(options)` with:
  - page/per_page cursor support
  - stablecoin filtering
  - ranking score = f(volume, liquidity, momentum, freshness)
- Implement `market.explainMove(token)`:
  - evidence sections: price/vol/liquidity/age/context
  - “what we know / what we don’t know” split
- Support “give me more” continuation using pagination cursor in memory context

### Risk level
- Medium

### Expected user-facing improvement
- “what’s pumping on Base?” and “give me more” become robust feed exploration, not one-shot list
- “why moving?” responses become evidence-driven

### Acceptance tests
- `what’s pumping on Base?`
- `give me more`
- `what should I watch today?`
- `why is this token moving?`

---

## Phase 5 — Supabase memory + tracked wallets

### Files to change
- add `lib/server/clarkMemory.ts`
- `app/api/clark/route.ts`
- potentially new migration SQL for:
  - `clark_session_context`
  - `tracked_wallets` (if distinct from existing `saved_wallets`)
- wire existing Supabase setup (`lib/supabaseClient.ts`) for authenticated memory where possible

### Scope
- `memory.getLastContext()` and `memory.saveSessionContext()` with compact records only
- map “saved wallets” into “tracked/watch wallets” signals if available
- add day-over-day snapshot keys for “what changed since yesterday?” where data exists

### Risk level
- Medium-high (auth/data model + privacy boundaries)

### Expected user-facing improvement
- Strong follow-up continuity (“is it safe?”, “what changed?”, “this token”) without user repetition
- watchlist-aware strategy responses

### Acceptance tests
- `hi`
- `what can you do?`
- `what changed since yesterday?`
- follow-up with omitted subject resolves from memory safely

---

## Response mode strategy (Task 3 + 4)

Implement hidden auto-mode selection in router (no visible UI toggle required):
- casual
- education
- market
- wallet_balance
- wallet_quality
- token_scan
- full_report
- comparison
- strategy
- follow_up

Depth policy:
- short: 2–5 sentences
- normal: structured bullets
- deep: canonical analyst report format

Rules:
- verdict template only for scan/quality/report contexts
- do not force verdict structure for simple educational/casual queries
- always include “What’s missing” when key evidence unavailable

---

## Data honesty guardrails (Task 7)

Hard-guard all generated claims behind evidence flags:
- no fabricated balances, pnl, win-rate, smart-money labels, holder concentration, LP lock, honeypot/tax, dev links, mover claims
- if data missing: explicitly say missing field + what can still be inferred + next tool to run
- normalize provider errors to user-safe language

---

## End-to-end acceptance matrix (Task 9)

Target prompts to pass after phased rollout:
1. hi
2. what can you do?
3. what’s pumping on Base?
4. give me more
5. what should I watch today?
6. scan brett
7. full report on brett
8. scan this token 0x...
9. is it safe?
10. dev wallet for this token
11. liquidity risk on this token
12. 0xwallet tell me the balance
13. is it a good wallet?
14. should I copy trade it?
15. compare these two wallets 0x... 0x...
16. why is this token moving?
17. explain liquidity risk deeply

Each prompt should map to a deterministic tool-plan with evidence-backed output and no raw provider errors.
