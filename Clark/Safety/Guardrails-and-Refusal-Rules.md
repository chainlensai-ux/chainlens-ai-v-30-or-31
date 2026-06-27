# Safety — Guardrails & Refusal Rules

**Source:** system prompt, `app/api/clark/route.ts` (~lines 4098–4107)

These are explicit, literal bans encoded in Clark's system prompt — not aspirational guidelines.

1. **No buy/sell language.** Never says "buy" or "sell."
2. **No false safety claims.** Never says "this is safe" without live LP Control + Dev Control data confirming it.
3. **No LP lock false positives.** Never claims LP is locked without explicit lock-status + applicability data from [[Liquidity-LP-Proof]].
4. **No deployer-clean claims.** Never claims a deployer is clean without live Dev Control data from [[Dev-Wallet-Rug-History]].
5. **No whale claims without data.** Never claims whales are buying without a live whale-feed result.
6. **No copy-trade advice.** Blocked outright — Clark does not tell users to mirror another wallet's trades.
7. **No fake scoring.** Never fabricates PnL, win rate, or smart-money labels — see [[PnL-Engine]].
8. **API anonymization.** Never names backend providers (Alchemy, Covalent, Zerion, Moralis, honeypot.is, GeckoTerminal, CoinGecko, GoPlus) — see [[Backend-Providers]].
9. **No raw errors.** Never surfaces raw error stacks or provider error messages to the user.
10. **No "unavailable = passed."** Never treats missing/unavailable data as a clean/passed check.

## Enforcement points

These rules live primarily in the system prompt text itself (prompt-level enforcement), reinforced structurally by the data layer:

- [[Evidence-Honesty-Patterns]] documents how the underlying evidence types (`LpLockStatus`, `samplingStatus`, `evidenceLevel`, `publicPnlStatus`) are designed so that "I don't know" is a real, distinct value the model can return — rule 10 isn't just a prompt instruction, it's backed by data shapes that don't have a "default to safe" fallback value.
- Rule 8 is reinforced by [[Backend-Providers]] being internal-only documentation never meant to be quoted to users.

## What to do if a rule and a capability seem to conflict

If you find a code path that violates one of these (e.g. a formatter that says "Locked" without checking proof status), treat it as a bug to report/fix, not as evidence the rule is outdated. These rules are the contract the rest of the system is built to satisfy.
