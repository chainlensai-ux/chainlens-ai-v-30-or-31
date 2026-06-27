# Capability — Liquidity / LP Proof

**Tool name:** `liquidity_analyze`
**Handler:** `scanLiquidityData()` in `app/api/clark/route.ts`
**Backend route:** `/api/liquidity-safety`
**Core logic:** `lib/server/lpProof.ts`, `lib/server/lpControllerIntel.ts`

## What it does

Verifies whether a token's liquidity pool can be drained/manipulated by its controller. Produces:

- **LP status:** `wallet_controlled`, `locked`, `burned`, `protected`, `protocol_controlled`, `concentrated_liquidity`, `open_check`, or `no_pool`
- **Proof level:** `confirmed`, `open_check`, or `not_applicable`
- **Controller label, exit risk, liquidity depth tier, migration risk, confidence, signals, evidence gaps, next actions** (`buildLpControllerIntel()`, `lpControllerIntel.ts`)

`LpLockStatus` (`lpProof.ts` ~lines 19–22) is `"locked" | "burned" | "unlocked" | "unverified"` — there is no fifth state that silently means "probably fine." Unverified always stays unverified.

## Concentrated liquidity (Uniswap V3/V4, Aerodrome Slipstream)

Concentrated pools don't use ERC-20 LP tokens, so the standard burn/lock proof doesn't apply. Instead `attemptConcentratedPositionProof()` (`lpProof.ts`) resolves the position manager, confirms the pool is active via an RPC liquidity/slot0 probe, and — where a bounded candidate source exists — samples position owners (capped at `SAMPLE_CANDIDATE_CAP = 20`), classifying each via `classifyConcentratedOwnerType()` (burn / locker / protocol / contract / wallet / unknown).

Critically: a sample is never presented as full-pool coverage. `samplingStatus` values (`not_attempted`, `attempted_no_candidates`, `sampled_partial`, `failed`) and the public wording rules ("sampled position owner" vs. "Full-pool top liquidity owner not verified") are described in [[Public-Grade-Filtering]] and [[Evidence-Honesty-Patterns]].

V4 is explicitly handled as "concentrated_liquidity" with different proof requirements rather than being silently treated like a V2 pool — see [[Known-Gaps-and-Stubs]].

## External verification sources

- **PinkLock** — direct API check for known lock contracts (`lpProof.ts` ~line 99)
- On-chain RPC calls (liquidity/slot0/ownerOf/positions) via the chain's resolved RPC endpoint — see [[RPC-Chain-Config]]

## Routing

`liquidity_scan` / `lp_lock_check` intents are checked before the generic `token_scan` fallback in `classifyClarkPrompt()` — see [[Intent-Routing]].

## Output discipline

Clark is explicitly banned from claiming "LP locked" without explicit lock-status + applicability data (system prompt rule, see [[Guardrails-and-Refusal-Rules]]). Concentrated pools without verified ownership are described as "Liquidity ownership is still being verified," never as locked or safe.
