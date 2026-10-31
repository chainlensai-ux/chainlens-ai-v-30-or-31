# LP proof and private account history

The hosted migration was applied with explicit user approval at 2026-10-31T17:56:21Z. No deployment was performed by this workflow.

## Confirmed causes

- A bytes32 Uniswap pool ID could retain a V3 metadata label while V4 proof addresses appeared elsewhere. Proof identity now selects V4 for this shape, and V3 UI overrides cannot override V4 proof.
- Robinhood V4 ModifyLiquidity senders and Slipstream Mint/Burn owners identify callers or manager custody, not beneficial NFT owners. These fallback paths are no longer used as ownership proof.
- Bounded V3 position samples were promoted to full-pool ownership percentages. Samples now remain partial, with sample shares separate from unverified whole-pool control. Historical verified-cache restoration cannot override a failed current proof.
- NFT custody by a protocol manager or known locker does not by itself prove beneficial control or withdrawal restrictions. It remains unverified. V2 proof and Base V4's existing pool-ID-matched NFT index retain their applicable paths.
- Existing history was Preview-only, shared across users, and filtered by expiry. It cannot be safely reassigned to individual accounts.

## New account history

`supabase/cortex-account-scan-history.sql` creates a separate permanent table, keyed by verified user ID, canonical chain ID, canonical token, and scan request ID. It does not alter or delete legacy observations.

Completed server scans save validated evidence, the original timestamp, score/verdict (including Unrated), methodology, confidence and coverage. Confirmed save timestamps reach the UI. Cache reuse attaches the real original observation once per account with its original scan ID/time; repeated reuse deduplicates. History reads never insert observations. Duplicate saves are immutable. A signed, user-bound retry allows manual re-saving of the original observation without rerunning providers.

Authenticated clients have SELECT only, restricted by RLS to auth.uid(). Trusted server credentials may insert; clients cannot forge scores, update or delete history. There is no expiry or cleanup job. Account deletion is restricted until a separately authorised deletion policy exists.

History is available in production and Preview, with visible loading, bounded requests, user-scoped caching, auth-change invalidation, manual older-page loading, and explicit Unrated entries. Solana token case is preserved and its existing scorer/methodology are reused. Different methodology/scanner versions are not directly compared.

## Verification and hosted activation

Real local PostgreSQL tests applied the SQL only to a disposable fixture database. They verified disk reopen, separate account reads, concurrent duplicate prevention, and denial of authenticated INSERT/UPDATE/DELETE. They are not proof of a hosted migration or real multi-device login.

Before migration, zero-row hosted SELECT checks returned PGRST205 (table unavailable). An earlier HEAD returned 204, which was not sufficient schema proof. After explicit approval, only the reviewed SQL file was executed against the exact configured Supabase project. Management catalog checks confirmed RLS enabled/forced, auth.uid() = user_id SELECT policy, authenticated SELECT only, no anonymous SELECT, no authenticated INSERT/UPDATE/DELETE, server INSERT permission and no expiry column. The server REST schema check returned 200; anonymous REST access returned 401 / 42501. No artificial history observations or test accounts were created in the hosted database. Real browser logout/login and cross-device verification still require the updated app and two authenticated test accounts; they are not claimed by the local PostgreSQL proof.

Bounded live Base RPC reads confirmed matching V3 pool/manager factories and the configured V4 PoolManager. Ethereum returned HTTP 401; no repeated failed requests were made. BNB, Robinhood and Solana applicability use fixtures, without enabling disabled providers or chains.

Registry reference: https://developers.uniswap.org/docs/protocols/v4/deployments

The primary scoring v2 weights and Solana scoring semantics are unchanged. LP evidence corrections can change a score because previously unsupported ownership assertions are now correctly unverified.
