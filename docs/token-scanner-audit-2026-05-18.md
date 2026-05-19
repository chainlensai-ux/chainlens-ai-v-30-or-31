# Token Scanner Audit — May 18, 2026

## Scope

This audit reviewed the token scanner surface across:

- UI route used in terminal: `app/terminal/token-scanner/page.tsx`
- API scan endpoint: `app/api/scan-token/route.ts`
- Public token scanner UI: `app/token-scanner/page.tsx`
- Terminal command hook: `app/terminal/commands/scan-token.ts`

## Executive Summary

The token scanner has a strong base for market-data retrieval (GeckoTerminal + cache + GoPlus), but there are **functional gaps and consistency risks** that can cause user confusion and reliability issues.

Top risks:

1. **Broken terminal command integration**: terminal `scan-token` command is a placeholder and does not invoke scanner APIs.
2. **Fragmented scanner implementations**: there are two separate scanner UIs with diverging type contracts and formatting behavior.
3. **Partial chain UX vs Base-only backend reality**: public UI suggests multi-chain concepts, while API resolver/lookup is currently Base-specific.
4. **Opaque degradation modes**: cache fallback warnings are returned but not clearly surfaced in end-user interfaces.

## Detailed Findings

### 1) Terminal command is non-functional (High)

- `scanTokenCommand` currently returns a static placeholder message and never calls `/api/scan-token`.
- Impact: terminal users invoking scan-token command cannot actually scan tokens via command pipeline.

Recommendation:

- Implement command parser + fetch call into `/api/scan-token` and return normalized success/error payloads.

### 2) Scanner UI duplication and schema divergence (High)

- `app/terminal/token-scanner/page.tsx` defines a much richer `ScanResult` shape (valuation context, LP control, holder states, sections, price chart, etc.).
- `app/token-scanner/page.tsx` uses a narrower/older `ScanResult` shape and expects fields like `analysis`, `issues`, `aiSummary` that are not provided by `app/api/scan-token/route.ts`.
- Impact: likely dead UI sections, inconsistent panels, and hard-to-maintain feature drift.

Recommendation:

- Consolidate onto a shared scanner response type in `lib/`.
- Either enrich API to satisfy public UI expectations or simplify public UI to only render guaranteed fields.

### 3) Base-only backend behavior not reflected consistently (Medium)

- `resolveNameToContract` calls GeckoTerminal with `network=base` and only accepts Base pools.
- Contract path can still resolve any EVM address format, but pool fetching is done under `networks/base` endpoint.
- UI contains generic chain concepts (`getChainBadge` with Ethereum/Polygon/Solana), which can imply broader support than currently implemented.

Recommendation:

- Explicitly label scanner as Base-only in UI copy and API metadata, or extend route to true multi-chain support.

### 4) Error and warning observability gaps (Medium)

- API emits `warning` from cache fallback path but UIs do not clearly expose warning state to users.
- API returns 404 for both “not found” and “no pools” cases; the two are user-distinct scenarios.

Recommendation:

- Add typed status fields such as `status: 'not_found' | 'no_liquidity' | 'ok'`.
- Surface warning badges in scanner UI for stale cache usage and degraded security data.

### 5) Data quality edge cases in formatting/parsing (Low)

- Numeric conversion relies on `parseFloat`/`Number` in multiple places; large integer token balances can lose precision in JS `number` conversions.
- Public scanner uses exponential notation for tiny prices while terminal scanner uses fixed-decimal formatting, creating inconsistent price UX.

Recommendation:

- Standardize number formatting helpers and prefer bigint/decimal-safe parsing where raw balances are displayed.

## Prioritized Remediation Plan

1. **P0**: Implement `scanTokenCommand` end-to-end terminal integration.
2. **P0**: Define a canonical `ScanResult` type and align both UI routes.
3. **P1**: Clarify Base-only support in product copy and API response metadata.
4. **P1**: Add explicit degraded-state/warning rendering in both scanner UIs.
5. **P2**: Normalize number/price formatting and precision strategy.

## Quick Wins (1–2 days)

- Replace placeholder terminal command with real API call.
- Add a top-of-page “Base network only” badge in public scanner.
- Add warning banner when API returns `warning`.
- Add stricter empty-state messages for 404 causes.

## Suggested Regression Checklist

- Query by token alias with valid Base pool.
- Query by valid Base contract.
- Query with invalid contract format.
- Query token that exists but has no active pools.
- Simulate GeckoTerminal upstream failure and verify cached-warning UX.
- Verify terminal command returns same key metrics as UI scan.
