# Track intelligence V1

Additive receipt sections: Since Scan, Scan vs Now, What Changed. Existing outcome
classification, refresh schedules, frozen evidence, hypothetical returns and sharing are unchanged.

## Storage and providers

- No new table, column, migration, provider or provider call.
- Existing mutable market_observation_json optionally holds trackIntelligence:
  version 1, current snapshot, and at most 99 deduplicated change events plus scan creation.
- New scanner receipts optionally freeze trackComparison measurement identities.
  Unknown definitions stay null; historical receipts are not backfilled or rewritten.
- Databases without market_observation_json retain the existing compatibility fallback:
  receipt rendering works, but timeline persistence requires that existing optional column.
- Scanner evidence reuses the cache already read by manual/stale Track refresh. Live
  market ticks never trigger a scanner request. Cached scores/concentration expire after
  the existing 15-minute scanner freshness window; their original timestamp is shown.

## Comparison policy

Pure compareTrackReceipt(original, current) returns changes, four comparisons,
timeline events, materialChangeCount and criticalChangeCount. No wall-clock reads.
Missing/nonfinite values are unavailable. Exact liquidity measurement identity and
holder denominator definitions must match. Both risk methodologies must be known and
equal; neither snapshot version nor score direction is a methodology version.

Legacy liquidity measurements generally lack scope, so their deltas are withheld.
Current values can still display. Existing scanner output does not guarantee a risk
methodology or holder denominator, so a new risk score is not automatically comparable.

Liquidity: 10% bands; top-10: 3 percentage-point bands. Price uses the existing ±50%
Track outcome window; market-cap crossings are informational only. Price/cap event
colors remain neutral and never establish a rug. Only accepted post-scan rug proof
can create a critical rug outcome event.

Dev evidence requires a confirmed creator, creation transaction proof, and the
scanner's direct token_supply_transfer record (explicit fromAddress query), with
transaction hash and timestamp after the scan. Ordinary holder/graph edges do not
qualify. Linked-wallet aggregate amounts are never presented as a transaction amount.
Missing transfer coverage never means zero activity.

## Timeline

scan_created, price_change, market_cap_change, liquidity_change,
holder_concentration_change, deployer_transfer, outcome_change.
IDs use receipt identity + threshold band/state or transaction identity, not refresh
time. First observed values/timestamps win; repeated ticks within a band add nothing.
This is a bounded first-observation timeline, not reconstructed chain history. It does
not claim every intervening transition, repeated crossing or transaction was captured.
Persistence uses the existing observation write and its existing concurrency behavior;
no new append-only history service, alerting or background monitor is introduced.

## Validation

tests/track-intelligence.test.ts covers frozen receipt preservation, missing values,
liquidity/holder incompatibility, methodology changes, deterministic event IDs,
deduplication, noise thresholds, verified transfers, rejection of ordinary holder
links, price-only rug rejection, legacy receipt data and additive UI placement,
bounded history, real refresh integration, failure retention, and scanner freshness.
