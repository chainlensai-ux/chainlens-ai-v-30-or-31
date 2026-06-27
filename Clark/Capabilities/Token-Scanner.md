# Capability — Token Scanner

**Tool name:** `token_scan` (preceded by `token_resolve` when input is a symbol, not an address)
**Handler:** `scanTokenData()` in `app/api/clark/route.ts`
**Backend route:** `/api/token`

## What it does

Given a contract address (or a resolvable ticker like `$AERO`, `BRETT`), runs the full Token Core scan and returns:

- Contract analysis (mint/blacklist/pause flags, audit signals)
- LP control state — see [[Liquidity-LP-Proof]]
- Dev/deployer history — see [[Dev-Wallet-Rug-History]]
- Holder distribution (top1/5/10 concentration)
- Honeypot/tax simulation (via `lib/server/honeypotSecurity.ts`)
- A composite risk score — see [[Risk-Engine-Scoring]]

## Chain support

`toTokenApiChain()` (route.ts) only resolves **Base** and **Ethereum**. Polygon, BNB, and Arbitrum tokens return a "chain not yet supported" response — Clark does not silently degrade or guess for unsupported chains. See [[Supported-Chains-Limitations]].

## Routing into this capability

`classifyClarkPrompt()` in `lib/server/clarkRouting.ts` routes to `token_scan` when:

- The prompt explicitly says "token scan", or
- An address is present together with "on base" / "on eth", or
- A known Base ticker is named

It is the lowest-precedence intent in the routing order — more specific intents (`token_safety`, `dev_rug_check`, `lp_lock_check`, `liquidity_scan`, `token_ape_risk`) are checked first. See [[Intent-Routing]].

## Output discipline

Token scan results are never presented as flat "safe"/"not safe." The verdict format (`WATCH` / `AVOID` / `SCAN DEEPER` / `TRUSTWORTHY` / `UNKNOWN`) and the underlying evidence-gap pattern are described in [[Output-Formats]] and [[Evidence-Honesty-Patterns]].
