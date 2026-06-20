# Wallet Scanner production validation attempt — 2026-06-20

Wallet: `0xe896465b95d5edb49e26de47b6718442227c980f`

## Scope

Requested validation was against the real production environment that previously generated:

| Counter | Expected prior production value |
| --- | ---: |
| `walletSwapSummary.totalEvidenceEvents` | 147 |
| `swapCandidateEvents` | 15 |
| `unknownEvents` | 131 |
| `closedLots` | 0 |

This note records only evidence from this workspace/session. No local sandbox wallet validation was run.

## Environment-key evidence

`node scripts/env-check.js` was run in this workspace before any wallet scan attempt. It reported all required provider/runtime keys missing from `process.env`, including `GOLDRUSH_API_KEY`, `ALCHEMY_BASE_KEY`, and the Supabase keys required to authenticate/use the Wallet Scanner API locally. Because of that, this workspace was not a valid substitute for the production environment with working provider keys.

## Production API attempt

A direct POST was attempted against the documented production deployment:

```bash
curl -sS -D /tmp/wallet_headers.txt -o /tmp/wallet_resp.json -X POST 'https://chainlens-vthirty.vercel.app/api/wallet?debug=true' -H 'content-type: application/json' --data '{"address":"0xe896465b95d5edb49e26de47b6718442227c980f","deepScan":true,"deepActivity":true,"historicalCoverage":true,"refresh":true,"chainMode":"base"}'
```

The request failed before reaching the application route:

```text
curl: (56) CONNECT tunnel failed, response 403
HTTP/1.1 403 Forbidden
server: envoy
```

No production Wallet Scanner JSON body was returned, so the requested live counters could not be validated from this session.

## Requested counter dump

Because neither a local real-key environment nor reachable authenticated production API response was available in this session, the requested live dump is unavailable:

| Counter | Live value from this session |
| --- | --- |
| `totalEvidenceEvents` | unavailable — production request blocked before app response |
| `walletSideEvents` | unavailable — production request blocked before app response |
| `swapCandidateEvents` | unavailable — production request blocked before app response |
| `routerSwapCandidateEvents` | unavailable — production request blocked before app response |
| `unknownEvents` | unavailable — production request blocked before app response |
| `pricedEvents` | unavailable — production request blocked before app response |
| `openedLots` | unavailable — production request blocked before app response |
| `closedLots` | unavailable — production request blocked before app response |
| `unmatchedBuys` | unavailable — production request blocked before app response |
| `unmatchedSells` | unavailable — production request blocked before app response |

## Conditional dumps

### `routerSwapCandidateEvents === 0`

Not evaluated in this session because the production scan response was unavailable. Therefore, no current `swapCandidateEvents` rows, `tx hash`, `txTo`, `protocol`, `confidence`, or router-detection failure reasons were available from a live production run.

### `closedLots === 0`

Not evaluated in this session because the production scan response was unavailable. Therefore, no current unmatched sell rows, token, tx hash, timestamp, amount, or per-sell no-match reason were available from a live production run.

## Evidence-only root-cause ranking for this session

1. **Production environment was not reachable from the container network** — the direct production HTTPS request failed with `CONNECT tunnel failed, response 403` before application code returned JSON.
2. **Local workspace did not have the required real provider/auth keys** — `scripts/env-check.js` reported missing GoldRush, Alchemy, Supabase, Anthropic, Zerion, and webhook keys, so running the wallet scanner locally would have violated the requested constraint to avoid missing-key environments.
3. **No fresh production scan artifact was produced** — without a live production response, the requested event counters and conditional transaction-level dumps could not be revalidated in this session.

## Prior audit context, not a fresh production validation

A previous audit for the same wallet exists at `docs/audits/wallet-0xe896465b95d5edb49e26de47b6718442227c980f-swap-reconstruction-audit.md`. That file records earlier observed counters and explains a collapse between normalized transfer evidence and swap/FIFO reconstruction, but it is not a fresh 2026-06-20 production validation.
