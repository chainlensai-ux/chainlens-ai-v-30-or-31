# Wallet Scanner pricing & PnL audit

Status: in progress (code reading). Findings marked **confirmed in code** are proven by reading the
source; they still need confirming against the real wallet (0xd40e…b811) once provider keys are
available locally.

## Pipeline, in order

1. `providerFetchWindow` — raw transfers from GoldRush/Alchemy.
2. Normalization → `NormalizedEvent` (one row per token transfer, direction inbound/outbound).
3. Receipt decoding, sell receipt proof, recovery policy, dust suppression.
4. `priceLotsForWallet` — fills two price tables, `costUsd[txHash]` and `proceedsUsd[txHash]`, from
   (in order) accepted evidence, the at-trade-time engine, same-tx quote legs, native ETH resolver,
   Alchemy historical, receipt quotes, CoinPaprika (corroborated only).
5. Guards (pipeline): liquidity leg guard, then price outlier guard.
6. `fifoEngine` — matches buys to sells per token, prices each fragment from the tables.
7. `pnlReconciliation` — hydration/recovery from accepted evidence, outlier demotion, shared-side
   demotion, accepted-evidence seeding, canonical manifest selection, gates.
8. UI (`PnlStatusCard`).

## Findings

### F1 — Critical: price tables are keyed by transaction, not by token (fixed in eed3c6b6)

`costUsd` / `proceedsUsd` are `Record<txHash, number>`. The value is meant to be the USD value of
one token's side of a transaction, but nothing records *which* token.

- `src/modules/pricingAtTimeEngine/index.ts:164` — `usdByTxHash[r.txHash] = r.usd`: when one tx has
  two buy (or two sell) entries for different tokens, the last one priced wins.
- `src/lib/txSideEventAllocation.ts` `allocateTxSideValues` — `dict[group.txHash]` is applied to
  every token group of that direction in the tx.
- Same keying in every writer: `priceLotsForWallet.ts:1546-1547` (accepted evidence),
  `:2365/2369` (Alchemy), `:2688` (receipt quote), `:2900` (CoinPaprika), `pipeline/index.ts:3188`.

Effect: any transaction with two different tokens moving the same way gets one token's value on
both. Examples: a buy that also refunds some USDC (the 1-USDC refund is recorded as costing the whole
buy); a liquidity add (token + USDC out, both valued at the same proceeds). Produces large fake
gains/losses and is consistent with the −$1.35M sample.

Fix: key every table by `(txHash, token)`; each writer already knows the token it priced.

### F2 — High: USDC and WETH are matched as trades (stablecoins fixed; WETH kept as an asset)

Quote assets enter FIFO like any token (`lot_base_0x8335…`, `lot_base_0x4200…` lots in production).
Spending USDC on a buy closes a USDC "lot" with its own realized PnL. With F1, refund and quote legs
get wrong values; it also inflates the closed-lot count that coverage is measured against.

Fix: exclude stablecoins from realized trading PnL (value them at $1, never as trades); treat WETH/ETH
as the quote currency of a swap rather than a separate trade, or at least keep it out of the verified
trading sample.

### F3 — High: liquidity deposits/withdrawals become buys and sells (partly fixed)

The receipt check rejected all 25 sampled "sells" as `lp_add_or_remove`, but that classification runs
after trades are built. `src/lib/liquidityLegGuard.ts` (8d29ad5b) now stops their token legs being
priced; they are still structural lots in the coverage denominator and still consume FIFO inventory.

Fix: classify transactions (swap / liquidity add / liquidity remove / transfer) before FIFO and keep
non-swaps out of the trade set.

### F4 — High: same-tx quote pricing assigns a whole quote to dust legs

Same-tx stable/native quotes derive per-unit prices like $439,686/token for 0.00008-token legs (a
router refund priced with the full USDC paid). The outlier guard removes the worst cases afterwards,
but the derivation itself is wrong for multi-leg transactions.

Fix: only derive a same-tx quote when the transaction is a single in/single out swap after removing
refund legs of the same token.

### F5 — Medium: shared-side rule and accepted-evidence seeding disagree with the manifest

`demoteLotsOnIncompleteAcceptedSides` demotes every verified lot sharing a side with any unverified
sibling, while the manifest already allocates across the full sibling set. Relaxing it (d0204cff,
reverted in 5058e702) exposed F1–F4 lots. Revisit only after F1–F4 are fixed.

### F6 — Medium: logs are too large to read

A scan prints hundreds of multi-kB audit objects; Vercel drops the later ones, so reconciliation
diagnostics never appear. Compact them to one-line summaries.

### F7 — Medium: free price sources mostly fail

CoinPaprika 84/130 calls `402`; GeckoTerminal `429` on the first call; GoldRush resolves ~half.

### F8 — Medium: stored evidence may be contaminated

Accepted evidence and the canonical manifest were written by scans with F1–F4 present (and by the
reverted d0204cff scan). After fixes, purge this wallet's records so they are rebuilt.

## Next

- Confirm F1–F4 against the real wallet (needs `GOLDRUSH_API_KEY`, `ALCHEMY_BASE_KEY`,
  `ALCHEMY_ETHEREUM_KEY`, `COINGECKO_API_KEY` in this environment).
- Fix in order F1 → F2 → F3 → F4, with the wallet as a regression fixture; then F5, F8.
