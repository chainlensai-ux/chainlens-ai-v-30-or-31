# Token Outcome Tracking — V1

Started from clean `origin/main` at `dd5943268cb235793ceaa16cbb7231345e93bdc1`.

## File inventory

Added:

- `app/api/token-outcomes/route.ts`
- `app/terminal/track/page.tsx`
- `components/outcomes/TrackOutcomeButton.tsx`
- `components/outcomes/OutcomeCard.tsx`
- `components/outcomes/outcomes.module.css`
- `lib/tokenOutcomes.ts`
- `lib/tokenOutcomeProof.ts`
- `lib/server/tokenOutcomeReceipt.ts`
- `lib/server/solanaOutcomeReceipt.ts`
- `lib/server/tokenOutcomeService.ts`
- `docs/migrations/20260914_tracked_token_outcomes.sql`
- `docs/token-outcome-tracking.md`
- `tests/token-outcomes.test.ts`
- `tests/token-outcomes-db.test.ts`

Modified only the additive scanner response/button and navigation wiring in `app/api/token/route.ts`, `app/terminal/token-scanner/page.tsx`, `app/terminal/layout.tsx`, and `components/FeatureBar.tsx`.

## Deployment prerequisite

Apply `docs/migrations/20260914_tracked_token_outcomes.sql` to the project's Supabase database **before deploying the feature**. This change was validated with an isolated PostgreSQL engine, not applied to production from this checkout. No production database credentials were available here.

Apply `docs/migrations/20260914_token_outcome_price_integrity.sql` after the base migration. It repairs legacy zero-price observations and prevents unresolved prices from being stored as economic zero.

Existing server environment: `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. Optional server-only `TOKEN_OUTCOME_SIGNING_SECRET` overrides the service-role key for receipt signing. Never put either secret in a public environment variable. Rotating the signing key invalidates unsubmitted receipts, not saved outcomes.

Missing storage fails explicitly; it never creates an in-memory fake saved outcome. A missing signing key does not fail Token Scanner. The tracking action instead requests a rescan/configuration check.

## Routes and ownership

- `/terminal/track`: private outcome cards, full receipt, frozen evidence, X compose.
- `GET /api/token-outcomes`: compact current-user list; `?id=<uuid>` loads one owned frozen receipt.
- `POST /api/token-outcomes`: validates signed scan and current session, atomically creates/deduplicates.
- `POST /api/token-outcomes` with `{ "action": "refresh" }`: bounded stale refresh.
- Table: `public.tracked_token_outcomes`.
- `create_tracked_outcome`: service-role-only SQL function; per-user transaction lock enforces limits and duplicate safety.
- `preserve_outcome_baseline`: trigger rejects baseline/identity mutations even from service role.

RLS grants authenticated users SELECT on their own rows only. No client INSERT/UPDATE/DELETE or RPC execution. Creation through the server is always for the authenticated user, never a submitted user ID. GET detail and refresh updates additionally constrain `user_id`. No public sharing route and no changes to Watchlist tables or endpoints.

## Snapshot semantics

Risk threshold is **50 inclusive**, applied in both UI and signed server snapshot validation. Existing canonical risk scoring is untouched. EVM responses gain one optional `outcomeReceipt` field after existing public sanitation/plan gating; it is never stored in the shared scanner cache. Solana uses the same `computeSolanaCortexRisk` output already displayed by its Overview and Risk Engine, with a separate snapshot adapter.

Receipt payloads are HMAC-signed and account-bound. Snapshot evidence is copied at scan completion and saved unchanged when Track Outcome is clicked. `scannedAt` identifies the original observation; DB `tracked_at` records the tracking action. A later scan never changes the baseline. Duplicate identity: user + chain + token + scan ID. FDV is not substituted for absent market cap. Evidence missing in the original canonical result stays missing.

Central policy: `lib/tokenOutcomes.ts`. Initial capacities: Free 5, Pro 50, Elite 200; existing server-verified plan authority supplies the plan.

## Classification and math

- Pumped: price change ≥ +50%; medium confidence (market estimate).
- Dumped: price change ≤ −50% without stronger proof; medium confidence.
- Watching: valid price within that window.
- Unavailable: invalid/missing baseline or current price, including zero provider quotes; low confidence.
- Rugged: independently verified after-scan drain/sell-block evidence, or ≥99% comparable liquidity collapse with baseline liquidity ≥$10,000 **and independently verified pool death**.

Provider audit found existing market adapters mix selected-pool liquidity and aggregate token reserves. Thus V1 intentionally withholds liquidity percentage comparisons and does **not** use market reserve decline alone as rug proof. It shows baseline liquidity in the snapshot and latest absolute liquidity with source. Missing pools are not assumed dead.

The live corroboration path can reuse a subsequent fresh, exact-chain/address server Token Scanner result confirming a honeypot, only when the baseline had a successful sell simulation and the later scan occurred after tracking. It retains that observed event and source. No extra scanner call is made. V1 market providers do not expose verified deployer drains or pool death, so those classifier inputs are never fabricated or asserted by refresh. Solana market-only tracking cannot currently corroborate a rugged status.

Hypothetical value = `$1,000 × currentPrice / baselinePrice`; PnL = value − $1,000; potential loss avoided = max(0, −PnL). Missing, zero, negative or nonfinite prices produce unavailable, not $0. This is illustrative, not executable, and excludes fees/slippage/sellability. Share text uses the frozen score and latest observed market values; it never includes an account identifier or private receipt link.

## Refresh bounds

Saved cards load first. One page-load POST refreshes at most four stale rows (lease-guarded). While the Track page is visible, a separate live scheduler POSTs `action: "live"` about every 20 seconds for the next four receipts in rotation (open receipt excluded; its own 20s loop owns it). Live ids resolve in parallel inside a 40s server budget so sequential Dex+Gecko timeouts cannot stall the whole batch past the 55s client abort. Manual refresh uses the stale/force path. Polling stops when the tab is hidden.

Observation freshness for display/proof is 3 minutes (`priceStaleMs`). Live ticks stamp server `now` on `last_checked_at` (never a reused provider `fetchedAt`) so quote reuse cannot roll cards backwards. Rate limit: 10 write/live/refresh POSTs per user per minute (`OUTCOME_POLICY.postLimiterMax`). Providers: DexScreener then GeckoTerminal (7s timeouts), plus short live-quote coalescing. Wrong-chain/address quotes are rejected. Storage errors are distinct from confirmed empty lists.

## Verification

`node --import tsx --test tests/token-outcomes.test.ts tests/token-outcomes-db.test.ts`

For the database tests, install `@electric-sql/pglite@0.5.8` in an isolated test directory and set `OUTCOME_PGLITE_MODULE` to its `dist/index.js` absolute path. Without it the database test explicitly skips; it does not claim to have tested RLS. This pass executed the database tests with that module and no production connection.

Tests cover thresholds, immutable deep snapshots, HMAC/account tampering, duplicate and capacity behavior, actual PostgreSQL RLS/privileges/triggers, hypothetical positive/negative/missing values, price-only dumps, stronger rug proof, subsequent scan corroboration, wrong-chain caches, provider fallback/cache behavior, private sharing, and unchanged Watchlist wiring. Also run TypeScript, ESLint, production build, and `git diff --check`.

Validation this pass: 22 tests passed with zero skips, including the PostgreSQL tests. Isolated Chrome fixture checks at 1440px, 768px and 390px passed: locked/enabled tracking CTA, horizontal overflow, receipt math, original evidence expansion, X compose URL, Escape, close button and outside click. The fixture uses explicit test data, not a production account or a claim of live provider validation. New-file ESLint and TypeScript passed. Repository-wide ESLint completed with zero errors and existing warnings; production build passed with network access for the existing Google Fonts.
