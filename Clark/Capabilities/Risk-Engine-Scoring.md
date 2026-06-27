# Capability — Risk Engine & Scoring

**Source:** `lib/server/riskScore.ts` (~lines 108–299)

## Scoring formula (0–100 total)

| Section | Max | Components |
|---|---|---|
| Market Maturity | 30 | Market cap tier (0–10) + liquidity tier (0–10) + FDV age (0–10) |
| Liquidity Safety | 30 | LP lock/burn proof (0–15) + holder concentration (0–10) + liquidity depth (0–5) |
| Contract Safety | 25 | Honeypot status (0–15) + contract flags/audit (0–10) |
| Behavioral Risk | 15 | Early buyer concentration (0–10) + sniper clustering (0–5) |

## Risk labels

- `extreme` — 0–20
- `high` — 21–40
- `moderate` — 41–60
- `low` — 61–80
- `very_low` — 81–100

## Inputs

Market cap, FDV, liquidity, holder concentration (top1/5/10), LP control status (from [[Liquidity-LP-Proof]]), contract flags (mint/blacklist/pause), honeypot tax, deployer profile (from [[Dev-Wallet-Rug-History]]), sniper activity, holder intelligence, supply control/cluster influence.

## Relationship to other capabilities

This is not a standalone tool — it's a scoring layer consumed by [[Token-Scanner]] to produce the verdict shown in [[Output-Formats]]. The Liquidity Safety section depends directly on the LP proof status from [[Liquidity-LP-Proof]] — an unverified/open LP check caps that section's score rather than defaulting to a mid-range guess.

## Holder concentration

Parsed from `holderDistribution` (top1%, top5%, top10%); a high-risk flag triggers when concentration crosses internal thresholds (e.g., top10 > 50% or top5 > 35%, exact thresholds vary by code path in `riskScore.ts`).
