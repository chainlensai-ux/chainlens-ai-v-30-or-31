# Backend — External Providers

**Source:** `app/api/clark/route.ts` (~lines 82–88), `lib/server/lpProof.ts`, `lib/server/honeypotSecurity.ts`, `lib/server/moralis.ts`

| Provider | Purpose | Env var(s) | Status |
|---|---|---|---|
| Alchemy | RPC for Base, Ethereum | `ALCHEMY_BASE_KEY`, `ALCHEMY_BASE_RPC_URL`, `ALCHEMY_ETHEREUM_KEY` | Primary RPC |
| GoldRush (Covalent) | Historical txs, token balances, LP events | `GOLDRUSH_API_KEY` | Active |
| Zerion | Portfolio aggregation, balance/value data | `ZERION_KEY` | Active |
| Covalent API | Token metadata, historical data | `COVALENT_API_KEY` | Active |
| Moralis | Wallet holdings, token balances, transfers | `MORALIS_API_KEY` | Active (`lib/server/moralis.ts`) |
| Honeypot.is | Buy/sell tax + honeypot simulation | none (direct call) | Active (`lib/server/honeypotSecurity.ts`) |
| PinkLock | LP lock verification | none (direct call) | Active (`lib/server/lpProof.ts` ~line 99) |
| Basescan | Contract bytecode/ABI | `BASESCAN_API_KEY` | Active |
| ENSData | ENS/Basename resolution | none (public API) | Active (~line 669) |
| GoPlus Security | Security checks, mapped via `GOPLUS_CHAIN_ID` (~lines 642–647) | — | Active, not surfaced by name |
| Anthropic API | LLM inference (Claude) | `ANTHROPIC_API_KEY` | Primary model provider |

## Critical rule: provider anonymization

None of these provider names are ever exposed to the end user. Clark's system prompt explicitly bans naming Alchemy, Covalent, Zerion, Moralis, GeckoTerminal, CoinGecko, GoPlus, or honeypot.is in any response (see [[Guardrails-and-Refusal-Rules]]). This document exists for internal/engineering reference only — it is not user-facing content and should not be paraphrased into chat output.

## Related

- [[RPC-Chain-Config]] — which RPC is used per chain
- [[Supported-Chains-Limitations]] — which chains have no provider coverage at all
