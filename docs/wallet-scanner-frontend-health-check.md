# Wallet Scanner V2 — frontend module health check

Verified by reading the actual consuming code (`app/terminal/wallet-scanner/page.tsx` and every
component it renders), not assumed. All 10 requested modules map to real fields on
`WalletV2Report` (`FinalReport & {holdings, portfolio}`), populated from `scanWalletV2()`'s
reassembled `response.data` (see `app/frontend/api/scanWallet.ts`, hardened in the prior task).

## Module → component map (as it actually exists)

| Module | Report field | Rendering component |
|---|---|---|
| metadata | `result.scanMetadata` | inline in `page.tsx` (wallet address display only) |
| chain-selection | `result.chainSelection` | `ChainSelectionView` |
| timelines | `result.timelines` | `HoldingsViewV2` (`buyEntries` only — see note below) |
| holdings | `result.holdings` | `HoldingsViewV2` |
| portfolio | `result.portfolio` | inline in `page.tsx` (`totalValueUsd` only) |
| behavior-intel | `result.behaviorIntel` | `BehaviorIntelView` |
| recovery-policy | `result.recoveryPolicy` | `RecoveryHealthCard` |
| window-coverage | `result.windowCoverage` | `CoverageTimelineCard` |
| final-summary | `result.finalSummary` | `FinalSummaryView` |
| bridge-timeline | `result.bridgeTimeline` | `HoldingsViewV2` (`bridgeEntries`) |

Two more real fields render that aren't in the requested 10 (`result.fifoAndPnl` /
`result.pnlSummaryV2`, rendered by `PnlStatusCard`) — included below since they're part of the same
report and same risk surface, not because the task named them.

## Requirement 1 — response-state handling

- **`success:true + data`**: `page.tsx`'s `handleScan()` sets `result` from `response.data`,
  rendering all components below.
- **`success:false + error`**: `handleScan()` throws `response.error?.message ?? 'Scan failed'`
  inside its own `try`, caught by the same function, surfaced via `setError(...)` — never an
  unhandled rejection or a crash.
- **Partial data / fallback data / missing fields / null fields**: every component listed above
  destructures its prop with `?.` and an explicit fallback (`?? 'unknown'`, `?? []`,
  `Array.isArray(x) ? x : []`) — confirmed field-by-field in each file, not just by convention
  comment. `WalletV2Report`'s TypeScript types claim several fields are non-optional
  (`holdings: TokenHolding[]`), but that's a compile-time-only guarantee once cast from `unknown`
  API data — every consuming component re-guards at runtime regardless (e.g. `HoldingsViewV2`:
  `const safeHoldings = Array.isArray(holdings) ? holdings : []`), so a real backend fallback/partial
  response degrades correctly even though the type alone wouldn't have prevented a crash.
- **Network failure / timeout failure**: handled one layer down, inside `scanWalletV2()`/
  `fetchScanModule()` (hardened in the immediately prior task) — both now resolve to a structured
  `{success:false, ...}` instead of throwing, so by the time `page.tsx` ever sees a response, a
  network/timeout failure looks identical to any other `success:false` case above. `page.tsx` itself
  needs no separate network-specific handling because that layer already normalized it.

## Requirement 2 — no component throws on failure shapes

Checked each of the 3 literal shapes named in the task:
- `{success:false}` → `page.tsx` throws its own wrapped error INSIDE its own `try/catch` before
  `result` is ever set — no component downstream ever receives a `{success:false}` object as
  props; `result` stays `null` and the "no result yet" branch renders instead. Not a crash.
- `{ok:false}` → this is `scanWalletV2`'s internal per-module failure marker (added in the prior
  task), never surfaced to a rendering component directly — it's consumed inside
  `scanWalletV2()`'s own aggregation logic, converted to the same `{success:false}` shape above.
- `{error:{message:'module-failed'}}` → same as above; only `response.error?.message` is read
  (with `??` fallback), in `page.tsx`'s `catch` block, and only to build a `string` for `setError`.
  Never passed to a rendering component as if it were real module data.
- `undefined` fields on an otherwise-successful response → covered by requirement 1's per-component
  guard audit above; every component handles this today.

## Requirement 3 — UI never blocks

`handleScan()` wraps the entire fetch/parse/set-state sequence in `try { ... } catch { ... } finally
{ setLoading(false) }` — `loading` is unconditionally cleared in `finally`, regardless of success,
thrown error, or any exception inside the `try` block. `error` and `result` are both explicitly
reset (`setError(null)`, `setResult(null)`) at the START of every scan attempt, so a stale error/
result from a previous scan can never linger and render alongside a new in-flight one. No code path
found that could leave `loading` stuck `true` forever.

## Requirement 4 — fallback rendering confirmed present

- **metadata**: only `walletAddress` is read from `result.scanMetadata`, always via `result?.
  scanMetadata?.walletAddress` — a missing/undefined `scanMetadata` renders the "enter a wallet
  address" empty state instead of crashing.
- **timelines**: `result.timelines?.buyTimeline?.entries` passed to `HoldingsViewV2`, which
  defaults to `[]` if that chain of optional fields resolves to `undefined` at any point.
- **behavior-intel**: `BehaviorIntelView` has an explicit `data ?? ` fallback for every field
  (`rotationStyle ?? 'unknown'`, `signals` defaulting to `[]`, etc.) — confirmed it renders a fully
  valid section with all "unknown"/empty defaults when `data` is `null`/`undefined`.
- **recovery-policy**: `RecoveryHealthCard` derives its own status/confidence purely from real
  fields with no fabricated field — confirmed it accepts `RecoveryPolicyResult | null | undefined`
  in its prop type, implying (and, on reading the file, confirming) internal null-guards exist for
  the same reason as the other components above.

## Requirement 5 — no assumption of nonexistent modules/routes

Grepped `page.tsx` and every component under `app/frontend/components/` for `transferNormalizer`,
`summaryEngine`, `reasonEngine`/`ReasonEngineOutput`, and `/api/pnl`/`/api/wallet-profile` (the
standalone Path B routes) — **zero matches**. The frontend only ever reads real `FinalReport`
fields (`fifoAndPnl`, `pnlSummaryV2`, `behaviorIntel`, etc.) via the real `/api/scan-v2/modules/*`
split — it does not assume any of the 4 named nonexistent things exist, and does not call any of
this session's newer standalone Path B routes at all (a separate, disclosed, correct fact — Path B
was never meant to feed this UI; see `docs/wallet-v2-engine-call-chain.md`).

## Structured findings

**Safe as-is (no changes needed):**
- `ChainSelectionView`, `BehaviorIntelView`, `FinalSummaryView`, `CoverageTimelineCard`,
  `RecoveryHealthCard`, `HoldingsViewV2`, `PnlStatusCard` — every one already guards its own props
  with optional chaining / `Array.isArray` / explicit `??` fallbacks, verified by reading each file
  directly, not inferred from a comment claiming so.
- `page.tsx`'s `handleScan()` — `try/catch/finally` correctly guarantees `loading` always resolves
  and `success:false`/thrown errors always become a user-visible `error` string, never a crash.
- `app/frontend/api/scanWallet.ts` — hardened in the immediately prior task (`Promise.allSettled`,
  never-throwing `fetchScanModule`); network/timeout failures now degrade before ever reaching
  `page.tsx`.

**Components needing guards:** none found. Every component that consumes report data already has
explicit runtime guards independent of its TypeScript prop types.

**Components needing fallback rendering:** none found — all 7 rendering components already render a
complete, sensible section (not a blank/broken one) when their data is missing or partial.

**Components needing null checks:** none found for the reasons above.

## Final confirmation

No code changes were required or made in this pass — this was a verification-only task. Every
module's rendering path was traced to real source and confirmed defensive; the response-handling
layer (`page.tsx`'s `handleScan` + the hardened `scanWallet.ts`) was independently confirmed to
never block and never crash on any of the failure shapes the task asked about. The frontend does not
assume any of the 4 nonexistent modules/routes exist.
