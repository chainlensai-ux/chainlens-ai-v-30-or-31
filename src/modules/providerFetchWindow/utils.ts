// MODULE 1 — providerFetchWindow: provider-specific fetch helpers.
// These are the ONLY functions in the entire /src/modules tree permitted to make a network call
// (Architecture Step 8 §1/§3: "no component except recoveryPolicy triggers fetches" — at this
// foundation stage, recoveryPolicy does not exist yet, so providerFetchWindow is the sole fetch
// point). Every other module in this tree is a pure transform over already-fetched data.

import type {
  RawProviderEvent,
  SingleProviderFetchResult,
  SupportedChain,
} from './types'
import {
  MAX_RAW_EVENTS_PER_PROVIDER,
  PROVIDER_FETCH_WINDOW_DAYS_DEFAULT,
  PROVIDER_FETCH_WINDOW_DAYS_MAX,
  PROVIDER_FETCH_WINDOW_DAYS_MIN,
} from './types'
import { logRpcCall } from '@/lib/server/rpcDebug'
import { tryConsume, recordPageFetched } from '../providerCost/walletProviderCostLedger'
import { auditRPC } from '@/lib/server/alchemyAudit'
import { estimatedCuForMethod } from '@/lib/server/alchemyCallBudget'

// Env var resolution mirrors the project's existing convention (multiple accepted names, server
// vars checked before NEXT_PUBLIC_*). This module intentionally does not import from
// lib/server/walletSnapshot.ts — it is a standalone foundation module with its own key
// resolution, so it has no dependency on (and cannot be broken by changes to) the legacy scanner.
const ALCHEMY_BASE_KEY_NAMES = ['ALCHEMY_BASE_KEY', 'ALCHEMY_BASE_API_KEY', 'BASE_ALCHEMY_API_KEY', 'ALCHEMY_API_KEY', 'NEXT_PUBLIC_ALCHEMY_BASE_KEY']
const ALCHEMY_ETH_KEY_NAMES = ['ALCHEMY_ETHEREUM_KEY', 'ALCHEMY_ETH_KEY', 'ALCHEMY_ETH_API_KEY', 'ALCHEMY_API_KEY']
const ALCHEMY_ARBITRUM_KEY_NAMES = ['ALCHEMY_ARBITRUM_KEY', 'ALCHEMY_ARBITRUM_API_KEY', 'ARBITRUM_ALCHEMY_API_KEY', 'ALCHEMY_API_KEY']
// HyperEVM: env var reserved/documented (.env.example) for whenever Alchemy adds verified
// HyperEVM support, or for a future native-RPC fetcher (see HYPEREVM_RPC_URL /
// providerFetchWindow/types.ts's TODO). Not read by alchemyApiKey below — see
// ALCHEMY_VERIFIED_CHAINS: HyperEVM is deliberately excluded from the set of chains this function
// will ever build a request URL for, so an unused-but-configured key can never silently produce a
// broken request.
const ALCHEMY_HYPEREVM_KEY_NAMES = ['ALCHEMY_HYPEREVM_KEY', 'ALCHEMY_HYPEREVM_API_KEY']
// Reserved for a future native-RPC HyperEVM fetcher — not used by any function in this file yet.
const HYPEREVM_RPC_URL_NAMES = ['HYPEREVM_RPC_URL', 'HYPEREVM_RPC']

function resolveEnvKey(names: string[]): string {
  for (const name of names) {
    const value = process.env[name]
    if (value && value.trim().length > 0) return value.trim()
  }
  return ''
}

function goldrushApiKey(): string {
  return process.env.GOLDRUSH_API_KEY ?? process.env.COVALENT_API_KEY ?? ''
}

// Chains this file has a codebase-verified GoldRush (Covalent) URL slug / Alchemy subdomain for.
// HyperEVM is intentionally absent from both — no verified slug/subdomain exists for it, and
// guessing one risks silently hitting a wrong or nonexistent endpoint rather than honestly
// reporting "not supported by this provider yet" (see fetchGoldrushRawEvents / fetchAlchemyRawEvents
// below, which check membership here before ever building a URL).
const GOLDRUSH_VERIFIED_CHAIN_SLUGS: Partial<Record<SupportedChain, string>> = {
  eth: 'eth-mainnet',
  base: 'base-mainnet',
  arbitrum: 'arbitrum-mainnet',
}

const ALCHEMY_VERIFIED_CHAINS: Partial<Record<SupportedChain, { keyNames: string[]; networkSlug: string }>> = {
  eth: { keyNames: ALCHEMY_ETH_KEY_NAMES, networkSlug: 'eth-mainnet' },
  base: { keyNames: ALCHEMY_BASE_KEY_NAMES, networkSlug: 'base-mainnet' },
  arbitrum: { keyNames: ALCHEMY_ARBITRUM_KEY_NAMES, networkSlug: 'arb-mainnet' },
}

function alchemyApiKey(chain: SupportedChain): string {
  const verified = ALCHEMY_VERIFIED_CHAINS[chain]
  return verified ? resolveEnvKey(verified.keyNames) : ''
}

function alchemyBaseUrl(chain: SupportedChain): string | null {
  const verified = ALCHEMY_VERIFIED_CHAINS[chain]
  if (!verified) return null
  const key = alchemyApiKey(chain)
  return `https://${verified.networkSlug}.g.alchemy.com/v2/${key}`
}

function goldrushChainName(chain: SupportedChain): string | null {
  return GOLDRUSH_VERIFIED_CHAIN_SLUGS[chain] ?? null
}

// Exported so recoveryPolicy/holdings' own copies of this gate stay in sync in code review, even
// though (by the project's existing "no runtime coupling between modules" convention) they each
// keep an independent literal copy rather than importing this one.
export function isHyperEvmKeyReserved(): boolean {
  return resolveEnvKey(ALCHEMY_HYPEREVM_KEY_NAMES).length > 0 || resolveEnvKey(HYPEREVM_RPC_URL_NAMES).length > 0
}

export function clampWindowDays(days?: number): number {
  const value = typeof days === 'number' && Number.isFinite(days) ? days : PROVIDER_FETCH_WINDOW_DAYS_DEFAULT
  return Math.max(PROVIDER_FETCH_WINDOW_DAYS_MIN, Math.min(PROVIDER_FETCH_WINDOW_DAYS_MAX, value))
}

// ── Env-controlled window override ──────────────────────────────────────────────────────────────
//
// FABRICATED-NAME DISCLOSURE: a task requested `validateWindow()`/`computeWindow()`/
// `enforceWindowBounds()` in index.ts — none of those exist, and this module's real bounds-checking
// function is `clampWindowDays` above (already existed before this change, already accepted an
// optional override and clamped it into [PROVIDER_FETCH_WINDOW_DAYS_MIN, ...MAX]). The two functions
// below are new and additive; they do not replace or modify clampWindowDays — they build the
// "read an opt-in env override, log if it's out of range, then hand it to the existing clamp" flow
// on top of it.
//
// SPEC-AMBIGUITY DISCLOSURE: the requesting task also asked for env vars
// `PROVIDER_FETCH_WINDOW_DAYS_MIN`/`_MAX` themselves, with a 3-way rule ("if OVERRIDE set -> use it;
// else -> use MIN/MAX range; else -> fall back to 90-day default") that doesn't resolve to a single
// window value on its own — "use the MIN/MAX range" isn't itself a number. Implemented here as the
// closest safe, unambiguous reading: `PROVIDER_FETCH_WINDOW_DAYS_MIN`/`_MAX` env vars, if set, only
// NARROW (never widen) the fixed code-level bounds in types.ts — they can raise the effective floor
// or lower the effective ceiling for this deployment, but can never push the effective range outside
// [80, 365], since that range is the actual architecture invariant enforced in code, not something
// a misconfigured env var should be able to silently override wider. `PROVIDER_FETCH_WINDOW_OVERRIDE`
// (if set) is then the requested window value, clamped into that (possibly narrowed) effective
// range; if it isn't set at all, this falls back to PROVIDER_FETCH_WINDOW_DAYS_DEFAULT (90), exactly
// per the task's stated final fallback rule.
function parseEnvInt(name: string): number | undefined {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

// Effective [min, max] for this deployment: the env vars may only narrow the fixed code bounds
// (PROVIDER_FETCH_WINDOW_DAYS_MIN/MAX from types.ts), never widen past them. An invalid narrowing
// (env min > env max, or either outside the fixed bounds) is logged and ignored, falling back to the
// fixed bounds unnarrowed — never silently producing a broken/inverted range.
function getWindowBoundsFromEnv(): { min: number; max: number } {
  const envMinRaw = parseEnvInt('PROVIDER_FETCH_WINDOW_DAYS_MIN')
  const envMaxRaw = parseEnvInt('PROVIDER_FETCH_WINDOW_DAYS_MAX')

  const envMin = envMinRaw !== undefined
    ? Math.max(PROVIDER_FETCH_WINDOW_DAYS_MIN, Math.min(PROVIDER_FETCH_WINDOW_DAYS_MAX, envMinRaw))
    : PROVIDER_FETCH_WINDOW_DAYS_MIN
  const envMax = envMaxRaw !== undefined
    ? Math.max(PROVIDER_FETCH_WINDOW_DAYS_MIN, Math.min(PROVIDER_FETCH_WINDOW_DAYS_MAX, envMaxRaw))
    : PROVIDER_FETCH_WINDOW_DAYS_MAX

  if (envMin > envMax) {
    console.warn('[providerFetchWindow] PROVIDER_FETCH_WINDOW_DAYS_MIN/MAX env vars produce an invalid (min > max) range after clamping — ignoring both and using the fixed code bounds', {
      envMinRaw, envMaxRaw, fixedMin: PROVIDER_FETCH_WINDOW_DAYS_MIN, fixedMax: PROVIDER_FETCH_WINDOW_DAYS_MAX,
    })
    return { min: PROVIDER_FETCH_WINDOW_DAYS_MIN, max: PROVIDER_FETCH_WINDOW_DAYS_MAX }
  }
  return { min: envMin, max: envMax }
}

// Reads PROVIDER_FETCH_WINDOW_OVERRIDE only — returns undefined if unset/unparseable (caller decides
// the fallback). Does not clamp; getEffectiveFetchWindow() does that against the effective bounds.
export function getWindowFromEnv(): number | undefined {
  return parseEnvInt('PROVIDER_FETCH_WINDOW_OVERRIDE')
}

// Public entry point walletChainPipeline.ts now uses in place of its previous hardcoded 90-day
// constant. Opt-in: with no PROVIDER_FETCH_WINDOW_OVERRIDE set, this returns exactly
// PROVIDER_FETCH_WINDOW_DAYS_DEFAULT (90) — identical behavior to before this change existed.
export function getEffectiveFetchWindow(): number {
  const override = getWindowFromEnv()
  if (override === undefined) return PROVIDER_FETCH_WINDOW_DAYS_DEFAULT

  const { min, max } = getWindowBoundsFromEnv()
  if (override < min || override > max) {
    console.warn('[providerFetchWindow] PROVIDER_FETCH_WINDOW_OVERRIDE is outside the effective [min, max] range — clamping', {
      override, min, max,
    })
  }
  return Math.max(min, Math.min(max, override))
}

function windowCutoffMs(windowDays: number): number {
  return Date.now() - windowDays * 24 * 60 * 60 * 1000
}

// Canonical native-asset pseudo-address, DISCLOSED. Covalent's `transfers` resource on
// transactions_v3 (read below) is ERC20-log-derived only — a wallet's own native ETH send (e.g.
// "swap ETH for TOKEN" via a router, msg.value > 0, no ERC20 Transfer log for the ETH leg itself) is
// never present in `transfers` at all. That same already-fetched transaction OBJECT (not a new
// request — see `tx` below) also carries the standard Covalent top-level `value`/`from_address`/
// `to_address` fields describing exactly this native transfer. Synthesizing one RawProviderEvent
// from those fields — using this widely-recognized native-asset placeholder address so it passes
// normalization's isValidContract check (which requires a 0x+40-hex address and would otherwise
// discard a null contract with `missing_contract`) — surfaces data that was already paid for and
// already sitting in this same HTTP response, at zero additional provider calls.
export const NATIVE_ASSET_ADDRESS = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'

// Positive-integer decimal string check — Covalent's `value` field is a base-10 wei string.
function isPositiveDecimalString(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]+$/.test(value) && value !== '0' && !/^0+$/.test(value)
}

// Fetches a SINGLE bounded page from GoldRush (Covalent) transactions_v3. Never pages further —
// "never deep-page" (Architecture Step 1/8). Never throws: any failure resolves to
// { ok: false, events: [], errorReason }.
export async function fetchGoldrushRawEvents(
  chain: SupportedChain,
  walletAddress: string,
  windowDays: number,
): Promise<SingleProviderFetchResult> {
  const chainSlug = goldrushChainName(chain)
  if (!chainSlug) {
    return { provider: 'goldrush', ok: false, events: [], errorReason: 'chain_not_verified_for_provider' }
  }
  const apiKey = goldrushApiKey()
  if (!apiKey) {
    return { provider: 'goldrush', ok: false, events: [], errorReason: 'no_api_key_configured' }
  }
  try {
    const url = new URL(`https://api.covalenthq.com/v1/${chainSlug}/address/${walletAddress}/transactions_v3/`)
    url.searchParams.set('page-size', '200')
    url.searchParams.set('page-number', '0')
    url.searchParams.set('with-logs', 'true')
    url.searchParams.set('no-spam', 'true')
    // SHARED LEDGER, DISCLOSED (cost-audit task): counted against the one scan-wide GoldRush
    // budget. This is the scan's single structural history fetch per chain (already singleflighted
    // by fetchProviderWindow), so it is expected to always fit — recording it is what makes the
    // [wallet-provider-cost-audit] diagnostic reconcile exactly against real invocations.
    if (!tryConsume({ provider: 'goldrush', endpoint: 'goldrush_transactions_v3', chain, stage: 'transaction_history' })) {
      return { provider: 'goldrush', ok: false, events: [], errorReason: 'provider_budget_exhausted' }
    }
    recordPageFetched('goldrush')
    logRpcCall({ route: 'providerFetchWindow', chain, method: 'goldrush_transactions_v3' })
    const res = await fetch(url.toString(), {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(12_000),
    })
    if (!res.ok) return { provider: 'goldrush', ok: false, events: [], errorReason: `http_${res.status}` }
    const json = await res.json()
    const items: unknown[] = Array.isArray(json?.data?.items) ? json.data.items : []
    const cutoff = windowCutoffMs(windowDays)
    const events: RawProviderEvent[] = []
    for (const it of items) {
      const tx = it as Record<string, unknown>
      const txHash = typeof tx.tx_hash === 'string' ? tx.tx_hash : null
      const timestamp = typeof tx.block_signed_at === 'string' ? tx.block_signed_at : null
      if (timestamp && Date.parse(timestamp) < cutoff) continue // shallow window only
      // UNDISCLOSED PER-TX TRUNCATION FIX, DISCLOSED (confirmed bug): this loop previously capped
      // itself to the first 12 transfer legs per transaction (`transfers.slice(0, 12)`) with no
      // comment explaining the number and no relation to MAX_RAW_EVENTS_PER_PROVIDER (the real,
      // already-disclosed total cap enforced by the break below). A wallet whose window contains a
      // complex multi-hop/aggregator swap with more than 12 ERC20 legs in one transaction silently
      // lost legs 13+ even when nowhere near the 400-event total cap, with no error/partial signal
      // raised (the provider call still reported ok: true). Removed: every transfer already present
      // in this same, already-fetched HTTP response is now considered, still bounded by the existing
      // MAX_RAW_EVENTS_PER_PROVIDER check inside the loop below — zero added provider calls or cost.
      // NATIVE-VALUE SYNTHESIS, DISCLOSED (see NATIVE_ASSET_ADDRESS above for the full trace): only
      // constructed when this SAME already-fetched `tx` object's own top-level fields describe a
      // real native transfer — never a new request, never a guess. `tx.from_address`/`tx.to_address`
      // are the transaction's own signer/recipient, exactly as reliable as `tr.from_address`/
      // `tr.to_address` are for an ERC20 leg below.
      if (
        isPositiveDecimalString(tx.value) &&
        typeof tx.from_address === 'string' &&
        typeof tx.to_address === 'string' &&
        events.length < MAX_RAW_EVENTS_PER_PROVIDER
      ) {
        events.push({
          provider: 'goldrush',
          chain,
          txHash,
          timestamp,
          fromAddress: (tx.from_address as string).toLowerCase(),
          toAddress: (tx.to_address as string).toLowerCase(),
          contract: NATIVE_ASSET_ADDRESS,
          symbol: 'ETH',
          amountRaw: tx.value as string,
          tokenDecimals: 18,
        })
      }
      if (events.length >= MAX_RAW_EVENTS_PER_PROVIDER) break
      const transfers: unknown[] = Array.isArray(tx.transfers) ? tx.transfers : []
      for (const transfer of transfers) {
        if (events.length >= MAX_RAW_EVENTS_PER_PROVIDER) break
        const tr = transfer as Record<string, unknown>
        events.push({
          provider: 'goldrush',
          chain,
          txHash,
          timestamp,
          fromAddress: typeof tr.from_address === 'string' ? tr.from_address.toLowerCase() : null,
          toAddress: typeof tr.to_address === 'string' ? tr.to_address.toLowerCase() : null,
          contract: typeof tr.contract_address === 'string' ? tr.contract_address.toLowerCase() : null,
          symbol: typeof tr.contract_ticker_symbol === 'string' ? tr.contract_ticker_symbol : null,
          amountRaw: typeof tr.delta === 'string' ? tr.delta : null,
          tokenDecimals: typeof tr.contract_decimals === 'number' ? tr.contract_decimals : null,
        })
      }
      if (events.length >= MAX_RAW_EVENTS_PER_PROVIDER) break
    }
    return { provider: 'goldrush', ok: true, events, errorReason: null }
  } catch (err) {
    return { provider: 'goldrush', ok: false, events: [], errorReason: err instanceof Error ? err.message : 'unknown_error' }
  }
}

// PURE. Exported for direct unit testing.
//
// CROSS-PROVIDER DEDUPE FIX, DISCLOSED (confirmed bug): Alchemy's rawContract.value is a hex-string
// raw amount (e.g. "0xde0b6b3a7640000"), while GoldRush's `delta` (fetchGoldrushRawEvents above) is a
// plain decimal string for the identical real transfer. dedupeRawEventKey/normalizedDedupeKey
// compare amountRaw as a raw string, so leaving this un-normalized made the same on-chain transfer
// produce two different-looking dedupe keys depending on which provider reported it — defeating
// mergeProviderResults' own documented "deduplicating by (txHash, contract, fromAddress, toAddress,
// amountRaw)" contract, and double-counting every transfer both providers successfully report.
// Normalized to the same decimal-string format GoldRush already uses so both providers' keys for the
// same real transfer now match.
export function alchemyHexAmountToDecimalString(hexValue: string | null): string | null {
  if (hexValue == null) return null
  try {
    return BigInt(hexValue).toString()
  } catch {
    return null // malformed hex — honestly unparseable, never guessed
  }
}

// PURE. Exported for direct unit testing.
//
// TOKEN-DECIMALS FIX, DISCLOSED (confirmed bug): rawContract.decimal (a hex string, e.g. "0x12") is
// a real, documented field on this same Alchemy response (already read elsewhere in this codebase —
// see app/api/token/route.ts's AlchemyTransfer type) that was never read here, hardcoding
// tokenDecimals to null instead — normalization/utils.ts's parseAmount then silently defaulted to 18
// for every Alchemy-sourced event, producing a wrong (often near-zero) `amount` for any non-18-
// decimal token (USDC/USDT=6, WBTC=8, etc.) whenever this event wasn't also matched/overridden by a
// GoldRush copy of the same transfer.
export function alchemyHexDecimalToNumber(hexDecimal: string | null): number | null {
  if (hexDecimal == null) return null
  const parsed = Number(hexDecimal)
  return Number.isFinite(parsed) ? parsed : null
}

// ── Alchemy transaction-history concurrency limiter + bounded 429 retry, DISCLOSED ────────────
//
// Production proof (429-burst regression task): Base from/to and ETH from/to — all 4 of this
// job's structural transaction-history calls — fired concurrently (Promise.all within each chain,
// and each chain's own fetchAlchemyRawEvents call not otherwise coordinated with the other chain's)
// and all 4 came back HTTP 429. GoldRush, a different provider/infra, was unaffected — this is a
// burst-concurrency problem on Alchemy's side, not a malformed-request or budget problem.
//
// Fix: a single MODULE-LEVEL mutex (concurrency = 1) serializing every real
// alchemy_getAssetTransfers HTTP call across BOTH chains — not per-chain, since Base's and ETH's
// calls are exactly what burst together in the production trace. "Request-scoped" per this task's
// requirement #1 means scoped to one wallet job: state is reset by
// resetAlchemyHistoryConcurrencyState(), called from providerFetchWindow/index.ts's own
// resetProviderFetchWindowRequestCache() (the same per-job reset point already used for this
// module's other request-scoped state), not left to accumulate across unrelated jobs.
export const ALCHEMY_HISTORY_MAX_CONCURRENCY = 1
// Short pause after ANY 429 before the next QUEUED call gets its turn — deliberately short since
// the goal is de-bursting, not stalling a normal 4-call job for seconds.
const ALCHEMY_HISTORY_429_COOLDOWN_MS = 400
// Deterministic (not randomized — avoids a second, harder-to-reproduce source of test flakiness)
// fallback retry delay, kept only for the (currently disabled — see below) retry path.
const ALCHEMY_HISTORY_DEFAULT_RETRY_DELAY_MS = 875

// RETRY DISABLED BY DEFAULT, DISCLOSED (429-persistent-rate-limit task — production proof): a
// prior task added exactly-one-retry-per-429. Production then showed all 4 initial calls AND all 4
// retries returning 429 — 8 calls / 1,200 CU spent for 0 events, a 0% retry recovery rate. When
// Alchemy is genuinely, persistently rate-limiting this API key/project (not a one-off blip), a
// bounded retry does not recover anything — it just doubles the wasted spend. Retries are now off
// by default; the circuit breaker below (which reacts to real, observed 429s, not a fixed retry
// count) is what actually stops the waste.
export const ALCHEMY_HISTORY_429_RETRY_ENABLED = false

// CIRCUIT BREAKER, DISCLOSED (this task's core fix): after CIRCUIT_OPEN_THRESHOLD *consecutive*
// 429s (any chain, any direction — Alchemy's rate limit is per API key/project, not per chain), no
// further Alchemy transaction-history calls are attempted for the REST OF THIS JOB. GoldRush is a
// fully separate code path (fetchGoldrushRawEvents) and is never touched by this breaker.
export const ALCHEMY_RATE_LIMIT_CIRCUIT_OPEN_THRESHOLD = 2

let alchemyHistoryQueueTail: Promise<void> = Promise.resolve()
let alchemyHistoryCooldownUntil = 0
let alchemyConsecutive429s = 0
let alchemyRateLimitCircuitOpen = false

type AlchemyRateLimitAudit = {
  queuedRequests: number
  initialCalls: number
  retryCalls: number
  http429Count: number
  retryAfterMsSeen: number
  cooldownMsApplied: number
  requestsRecoveredAfter429: number
  finalFailedRequests: number
}

function freshRateLimitAudit(): AlchemyRateLimitAudit {
  return {
    queuedRequests: 0, initialCalls: 0, retryCalls: 0, http429Count: 0,
    retryAfterMsSeen: 0, cooldownMsApplied: 0, requestsRecoveredAfter429: 0, finalFailedRequests: 0,
  }
}

let alchemyRateLimitAudit: AlchemyRateLimitAudit = freshRateLimitAudit()

// [alchemy-rate-limit-circuit] backing state, DISCLOSED: request-scoped (reset per job, never
// across jobs — requirement #5, "do not cache this as a permanent provider failure across jobs").
type AlchemyRateLimitCircuitAudit = {
  consecutive429s: number
  circuitOpened: boolean
  callsPrevented: number
  wastedCuPrevented: number
  first429Chain: SupportedChain | null
  first429Direction: 'from' | 'to' | null
}

function freshCircuitAudit(): AlchemyRateLimitCircuitAudit {
  return { consecutive429s: 0, circuitOpened: false, callsPrevented: 0, wastedCuPrevented: 0, first429Chain: null, first429Direction: null }
}

let alchemyRateLimitCircuitAudit: AlchemyRateLimitCircuitAudit = freshCircuitAudit()

// Exported test/reset hook — mirrors the pattern used by walletProviderCostLedger's own
// __resetForTest, and is wired into providerFetchWindow/index.ts's per-job reset. This is the ONLY
// place the circuit closes — a new wallet job always starts with a fully closed circuit
// (requirement: "next wallet job starts with circuit closed"), never inheriting a prior job's
// rate-limit state.
export function resetAlchemyHistoryConcurrencyState(): void {
  alchemyHistoryQueueTail = Promise.resolve()
  alchemyHistoryCooldownUntil = 0
  alchemyConsecutive429s = 0
  alchemyRateLimitCircuitOpen = false
  alchemyRateLimitAudit = freshRateLimitAudit()
  alchemyRateLimitCircuitAudit = freshCircuitAudit()
}

// Read-only test hook — lets tests assert circuit state without reaching into module internals.
export function isAlchemyRateLimitCircuitOpen(): boolean {
  return alchemyRateLimitCircuitOpen
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Simple FIFO mutex (concurrency 1): each queued task waits for the PREVIOUS task to fully settle
// (success or failure) before it runs — never partial overlap, exactly requirement #2's "at most 1
// alchemy_getAssetTransfers request at a time." A task's own queued wait time counts toward
// `queuedRequests` for the audit, not toward its own execution.
async function withAlchemyHistoryConcurrencyLimit<T>(task: () => Promise<T>): Promise<T> {
  alchemyRateLimitAudit.queuedRequests += 1
  const previous = alchemyHistoryQueueTail
  let releaseNext: () => void = () => {}
  alchemyHistoryQueueTail = new Promise((resolve) => { releaseNext = resolve })
  await previous
  // A cooldown set by an earlier 429 (this job, either chain) delays this task's turn, not just the
  // task that triggered it — requirement #8: the cooldown applies to "the next queued Alchemy
  // history call", whichever call that turns out to be.
  const waitMs = alchemyHistoryCooldownUntil - Date.now()
  if (waitMs > 0) {
    alchemyRateLimitAudit.cooldownMsApplied += waitMs
    await sleep(waitMs)
  }
  try {
    return await task()
  } finally {
    releaseNext()
  }
}

// Parses a Retry-After header per RFC 7231 §7.1.3: either a delay-seconds integer, or an HTTP-date.
// Returns null (never guessed) if the header is absent or unparseable — callers fall back to the
// deterministic default delay in that case.
function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const dateMs = Date.parse(header)
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - Date.now()
    return delta > 0 ? delta : 0
  }
  return null
}

// Fetches a SINGLE bounded pull from Alchemy (both from- and to-wallet batches, one page each).
// Never throws: any failure resolves to { ok: false, events: [], errorReason }.
export async function fetchAlchemyRawEvents(
  chain: SupportedChain,
  walletAddress: string,
  windowDays: number,
): Promise<SingleProviderFetchResult> {
  const url = alchemyBaseUrl(chain)
  if (!url) {
    return { provider: 'alchemy', ok: false, events: [], errorReason: 'chain_not_verified_for_provider' }
  }
  const apiKey = alchemyApiKey(chain)
  if (!apiKey) {
    return { provider: 'alchemy', ok: false, events: [], errorReason: 'no_api_key_configured' }
  }
  // TYPED PER-CALL OUTCOME, DISCLOSED (Alchemy-history-ingestion-regression task — root cause
  // confirmed): a budget refusal (tryConsume returning false) previously produced the exact same
  // `null` as a genuine malformed/HTTP-failure/empty response, so the aggregate check below
  // (`!fromResult && !toResult`) collapsed EVERY one of those distinct causes into the single
  // generic reason 'no_usable_response' — a self-imposed throttle indistinguishable, to every
  // caller, from "Alchemy genuinely has no data for this wallet". GoldRush's own sibling function
  // (fetchGoldrushRawEvents, above) already reports 'provider_budget_exhausted' distinctly; this
  // brings Alchemy to parity. Each sub-call now returns its own kind, and the diagnostics below
  // (liveCalls/budgetRefusals/malformedResponses/nullResponses) are real counts, never estimates —
  // this is what makes [alchemy-history-ingestion-audit] reconcile exactly against what actually
  // happened for this (chain, wallet) fetch.
  let liveCalls = 0
  let budgetRefusals = 0
  let malformedResponses = 0
  let nullResponses = 0
  let httpErrors = 0
  let jsonParseErrors = 0
  let jsonRpcErrors = 0
  let missingResultCount = 0
  let invalidTransfersShapeCount = 0

  // SAFE SHAPE LOGGING, DISCLOSED (malformed_response regression task): logs only the STRUCTURE of
  // the response, never its content — no addresses, tx hashes, amounts, or raw bodies. This is what
  // let this regression be diagnosed instead of just re-observed as an opaque 'malformed_response'
  // string.
  const logResponseShape = (direction: 'from' | 'to', shape: {
    httpStatus: number | null
    contentType: string | null
    jsonRpcErrorCode: number | null
    jsonRpcErrorMessage: string | null
    hasResult: boolean
    resultType: string
    hasTransfers: boolean
    transfersIsArray: boolean
    transferCount: number
    hasPageKey: boolean
    classification: string
  }) => {
    console.warn('[alchemy-response-shape]', { chain, direction, ...shape })
  }

  // Single raw HTTP attempt + classification. No retry/concurrency logic lives here — that's the
  // caller's (`rpc`, below) job — so this stays a pure "make the request, tell me what happened"
  // primitive reusable for both the initial attempt and its one bounded 429 retry.
  type AttemptOutcome =
    | { kind: 'success'; result: Record<string, unknown> }
    | { kind: 'http_429'; retryAfterMs: number | null }
    | { kind: 'http_error' }
    | { kind: 'json_parse_error' }
    | { kind: 'json_rpc_error' }
    | { kind: 'missing_result' }
    | { kind: 'invalid_transfers_shape' }
    | { kind: 'network_error' }

  const attemptOnce = async (direction: 'from' | 'to', params: Record<string, unknown>): Promise<AttemptOutcome> => {
    try {
      logRpcCall({ route: 'providerFetchWindow', chain, method: 'alchemy_getAssetTransfers' })
      auditRPC('alchemy_getAssetTransfers', params)
      const res = await fetch(url, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        // CONFIRMED, DISCLOSED (requirement #6): method is literally 'alchemy_getAssetTransfers' and
        // `params` is passed through untouched from the caller below — nothing in this function or
        // its caller builds a cache key from this object or mutates it before/after this call.
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'alchemy_getAssetTransfers', params: [params] }),
        signal: AbortSignal.timeout(12_000),
      })
      const contentType = res.headers.get('content-type')
      if (res.status === 429) {
        const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'))
        logResponseShape(direction, {
          httpStatus: res.status, contentType, jsonRpcErrorCode: null, jsonRpcErrorMessage: null,
          hasResult: false, resultType: 'n/a', hasTransfers: false, transfersIsArray: false,
          transferCount: 0, hasPageKey: false, classification: 'http_429',
        })
        return { kind: 'http_429', retryAfterMs }
      }
      if (!res.ok) {
        logResponseShape(direction, {
          httpStatus: res.status, contentType, jsonRpcErrorCode: null, jsonRpcErrorMessage: null,
          hasResult: false, resultType: 'n/a', hasTransfers: false, transfersIsArray: false,
          transferCount: 0, hasPageKey: false, classification: 'http_error',
        })
        return { kind: 'http_error' }
      }
      let json: Record<string, unknown>
      try {
        json = await res.json()
      } catch {
        logResponseShape(direction, {
          httpStatus: res.status, contentType, jsonRpcErrorCode: null, jsonRpcErrorMessage: null,
          hasResult: false, resultType: 'n/a', hasTransfers: false, transfersIsArray: false,
          transferCount: 0, hasPageKey: false, classification: 'json_parse_error',
        })
        return { kind: 'json_parse_error' }
      }
      // ACCEPTED SHAPE, DISCLOSED (requirement #2): the real Alchemy success shape is
      // { jsonrpc, id, result: { transfers: [], pageKey? } } — an empty `transfers` array IS a
      // valid, successful "no transfers on this page" answer, and a missing `pageKey` IS a valid
      // final page. Neither is ever treated as a failure below.
      const jsonRpcError = json?.error as { code?: unknown; message?: unknown } | undefined
      if (jsonRpcError) {
        logResponseShape(direction, {
          httpStatus: res.status, contentType,
          jsonRpcErrorCode: typeof jsonRpcError.code === 'number' ? jsonRpcError.code : null,
          jsonRpcErrorMessage: typeof jsonRpcError.message === 'string' ? jsonRpcError.message : null,
          hasResult: false, resultType: 'n/a', hasTransfers: false, transfersIsArray: false,
          transferCount: 0, hasPageKey: false, classification: 'json_rpc_error',
        })
        return { kind: 'json_rpc_error' }
      }
      const result = (json?.result as Record<string, unknown>) ?? null
      const hasResult = result !== null
      const resultType = result === null ? typeof json?.result : Array.isArray(result) ? 'array' : typeof result
      const hasTransfers = hasResult && 'transfers' in result
      const transfersIsArray = hasResult && Array.isArray(result.transfers)
      const transferCount = transfersIsArray ? (result.transfers as unknown[]).length : 0
      const hasPageKey = hasResult && typeof result.pageKey === 'string' && result.pageKey.length > 0
      if (!hasResult) {
        logResponseShape(direction, {
          httpStatus: res.status, contentType, jsonRpcErrorCode: null, jsonRpcErrorMessage: null,
          hasResult, resultType, hasTransfers, transfersIsArray, transferCount, hasPageKey,
          classification: 'missing_result',
        })
        return { kind: 'missing_result' }
      }
      // Result is present but does not carry a `transfers` array at all — an actual shape Alchemy
      // should never send for this method (as opposed to a real, empty `transfers: []`, which is a
      // valid success, handled by falling through to the return below without incrementing anything).
      if (!transfersIsArray) {
        logResponseShape(direction, {
          httpStatus: res.status, contentType, jsonRpcErrorCode: null, jsonRpcErrorMessage: null,
          hasResult, resultType, hasTransfers, transfersIsArray, transferCount, hasPageKey,
          classification: 'invalid_transfers_shape',
        })
        return { kind: 'invalid_transfers_shape' }
      }
      logResponseShape(direction, {
        httpStatus: res.status, contentType, jsonRpcErrorCode: null, jsonRpcErrorMessage: null,
        hasResult, resultType, hasTransfers, transfersIsArray, transferCount, hasPageKey,
        classification: 'success',
      })
      // WRAPPER RETURNS THE ORIGINAL PARSED RESULT, DISCLOSED (requirement #7): `result` is the raw
      // parsed `json.result` object, unwrapped and unmodified — never a diagnostic envelope, never a
      // cache-metadata wrapper. `collect()` below reads it exactly as Alchemy sent it.
      return { kind: 'success', result }
    } catch {
      return { kind: 'network_error' }
    }
  }

  // Records a non-429, non-success outcome into the shared counters (used for both the initial
  // attempt and, if it also fails, the one bounded retry).
  const recordFailureOutcome = (outcome: Exclude<AttemptOutcome, { kind: 'success' } | { kind: 'http_429' }>) => {
    switch (outcome.kind) {
      case 'http_error': httpErrors += 1; malformedResponses += 1; break
      case 'json_parse_error': jsonParseErrors += 1; malformedResponses += 1; break
      case 'json_rpc_error': jsonRpcErrors += 1; malformedResponses += 1; break
      case 'missing_result': missingResultCount += 1; malformedResponses += 1; break
      case 'invalid_transfers_shape': invalidTransfersShapeCount += 1; malformedResponses += 1; break
      case 'network_error': nullResponses += 1; break
    }
  }

  let http429Count = 0
  let circuitPreventedCount = 0

  const rpc = (direction: 'from' | 'to', params: Record<string, unknown>): Promise<Record<string, unknown> | null> =>
    withAlchemyHistoryConcurrencyLimit(async () => {
      // CIRCUIT BREAKER GATE, DISCLOSED (requirement #3): checked BEFORE the budget gate, and
      // BEFORE any HTTP call — an open circuit means ZERO further Alchemy calls for this job, not
      // "call but expect it to fail." No tryConsume() happens here, so no CU is spent on a call
      // this job already knows will be rate-limited.
      if (alchemyRateLimitCircuitOpen) {
        circuitPreventedCount += 1
        alchemyRateLimitCircuitAudit.callsPrevented += 1
        alchemyRateLimitCircuitAudit.wastedCuPrevented += estimatedCuForMethod('alchemy_getAssetTransfers')
        return null
      }
      // BUDGET GATE, DISCLOSED: checked BEFORE the real call, exactly as before.
      if (!tryConsume({ provider: 'alchemy', endpoint: 'alchemy_getAssetTransfers', chain, stage: 'transaction_history' })) {
        budgetRefusals += 1
        return null
      }
      liveCalls += 1
      alchemyRateLimitAudit.initialCalls += 1
      const outcome = await attemptOnce(direction, params)
      if (outcome.kind === 'success') {
        alchemyConsecutive429s = 0
        return outcome.result
      }
      if (outcome.kind !== 'http_429') {
        alchemyConsecutive429s = 0
        recordFailureOutcome(outcome)
        alchemyRateLimitAudit.finalFailedRequests += 1
        return null
      }

      // ── HTTP 429: typed distinctly, never counted as malformed (requirements #8/#9) ─────────
      http429Count += 1
      alchemyRateLimitAudit.http429Count += 1
      if (outcome.retryAfterMs !== null) alchemyRateLimitAudit.retryAfterMsSeen = outcome.retryAfterMs
      if (alchemyRateLimitCircuitAudit.first429Chain === null) {
        alchemyRateLimitCircuitAudit.first429Chain = chain
        alchemyRateLimitCircuitAudit.first429Direction = direction
      }
      alchemyConsecutive429s += 1
      alchemyRateLimitCircuitAudit.consecutive429s = alchemyConsecutive429s
      // Requirement #8: a short request-scoped cooldown applies to the NEXT queued call (any
      // direction/chain) after any 429 — whether or not it ends up being prevented by the circuit.
      alchemyHistoryCooldownUntil = Math.max(alchemyHistoryCooldownUntil, Date.now() + ALCHEMY_HISTORY_429_COOLDOWN_MS)

      if (alchemyConsecutive429s >= ALCHEMY_RATE_LIMIT_CIRCUIT_OPEN_THRESHOLD && !alchemyRateLimitCircuitOpen) {
        // OPEN THE CIRCUIT, DISCLOSED (requirement #3): stops every remaining Alchemy
        // transaction-history call for the REST OF THIS JOB, on any chain — set here, checked at
        // the top of this same function, so the very next queued call (already waiting behind this
        // one) is prevented rather than fired.
        alchemyRateLimitCircuitOpen = true
        alchemyRateLimitCircuitAudit.circuitOpened = true
      }

      // RETRY (disabled by default — ALCHEMY_HISTORY_429_RETRY_ENABLED), DISCLOSED: kept as dead
      // code behind the flag rather than deleted, so a future task can re-enable it for environments
      // where Alchemy's rate limit is known to be a brief blip rather than persistent — but the
      // production trace for THIS task showed 0% retry recovery, so it must never run by default.
      if (ALCHEMY_HISTORY_429_RETRY_ENABLED && !alchemyRateLimitCircuitOpen) {
        const retryDelayMs = outcome.retryAfterMs !== null ? outcome.retryAfterMs : ALCHEMY_HISTORY_DEFAULT_RETRY_DELAY_MS
        await sleep(retryDelayMs)
        if (!tryConsume({ provider: 'alchemy', endpoint: 'alchemy_getAssetTransfers', chain, stage: 'transaction_history' })) {
          budgetRefusals += 1
          alchemyRateLimitAudit.finalFailedRequests += 1
          return null
        }
        liveCalls += 1
        alchemyRateLimitAudit.retryCalls += 1
        const retry = await attemptOnce(direction, params)
        if (retry.kind === 'success') {
          alchemyConsecutive429s = 0
          alchemyRateLimitAudit.requestsRecoveredAfter429 += 1
          return retry.result
        }
        if (retry.kind === 'http_429') {
          http429Count += 1
          alchemyRateLimitAudit.http429Count += 1
          alchemyRateLimitAudit.finalFailedRequests += 1
          return null
        }
        recordFailureOutcome(retry)
        alchemyRateLimitAudit.finalFailedRequests += 1
        return null
      }

      alchemyRateLimitAudit.finalFailedRequests += 1
      return null
    })

  try {
    const [fromResult, toResult] = await Promise.all([
      rpc('from', { fromBlock: '0x0', category: ['erc20'], withMetadata: true, maxCount: '0xC8', order: 'desc', fromAddress: walletAddress }),
      rpc('to', { fromBlock: '0x0', category: ['erc20'], withMetadata: true, maxCount: '0xC8', order: 'desc', toAddress: walletAddress }),
    ])
    const diagnostics = {
      liveCalls, budgetRefusals, malformedResponses, nullResponses,
      httpErrors, jsonParseErrors, jsonRpcErrors, missingResult: missingResultCount, invalidTransfersShape: invalidTransfersShapeCount,
      http429Count, circuitPrevented: circuitPreventedCount,
    }
    // [alchemy-rate-limit-audit], DISCLOSED (429-burst regression task): logged once per real
    // fetchAlchemyRawEvents call (per chain) from the shared, request-scoped (reset per job)
    // counters above — real counts, not estimates.
    console.warn('[alchemy-rate-limit-audit]', {
      chain,
      queuedRequests: alchemyRateLimitAudit.queuedRequests,
      maxConcurrency: ALCHEMY_HISTORY_MAX_CONCURRENCY,
      initialCalls: alchemyRateLimitAudit.initialCalls,
      retryCalls: alchemyRateLimitAudit.retryCalls,
      http429Count: alchemyRateLimitAudit.http429Count,
      retryAfterMsSeen: alchemyRateLimitAudit.retryAfterMsSeen,
      cooldownMsApplied: alchemyRateLimitAudit.cooldownMsApplied,
      requestsRecoveredAfter429: alchemyRateLimitAudit.requestsRecoveredAfter429,
      finalFailedRequests: alchemyRateLimitAudit.finalFailedRequests,
      estimatedCu: liveCalls * estimatedCuForMethod('alchemy_getAssetTransfers'),
    })
    // [alchemy-rate-limit-circuit], DISCLOSED (this task's required diagnostic): logged once per
    // fetchAlchemyRawEvents call from the shared, request-scoped circuit-breaker state — real
    // counts, including calls this very invocation had prevented (circuitPreventedCount).
    console.warn('[alchemy-rate-limit-circuit]', {
      chain,
      consecutive429s: alchemyRateLimitCircuitAudit.consecutive429s,
      circuitOpened: alchemyRateLimitCircuitAudit.circuitOpened,
      callsPrevented: alchemyRateLimitCircuitAudit.callsPrevented,
      wastedCuPrevented: alchemyRateLimitCircuitAudit.wastedCuPrevented,
      first429Chain: alchemyRateLimitCircuitAudit.first429Chain,
      first429Direction: alchemyRateLimitCircuitAudit.first429Direction,
    })
    if (!fromResult && !toResult) {
      // TYPED REASON, DISCLOSED: distinguishes WHY both sub-calls failed instead of collapsing every
      // cause into one generic string. Priority: a self-imposed budget throttle is reported first
      // (it is this system's own decision, never Alchemy's fault); then the circuit breaker having
      // prevented this call outright (distinct from Alchemy having actually responded 429 — the
      // breaker is why NO call was even attempted); then a genuine observed 429 (requirement #8: a
      // 'http_429' reason, distinct from the generic 'http_error', so computeRateLimitFlag — see
      // src/pipeline/index.ts — reliably detects it); then a genuine non-429 HTTP transport failure;
      // then a body that couldn't be parsed as JSON at all; then a JSON-RPC-level error object
      // Alchemy itself returned; then a 200 with no `result` field whatsoever; then a `result`
      // present but with a non-array `transfers`; only falling back to the generic
      // 'no_usable_response' for a network error/timeout with none of the above (the `catch` path).
      const errorReason = budgetRefusals > 0
        ? 'provider_budget_exhausted'
        : circuitPreventedCount > 0
          ? 'alchemy_rate_limit_circuit_open'
          : http429Count > 0
            ? 'http_429'
            : httpErrors > 0
              ? 'http_error'
              : jsonParseErrors > 0
                ? 'json_parse_error'
                : jsonRpcErrors > 0
                  ? 'json_rpc_error'
                  : missingResultCount > 0
                    ? 'missing_result'
                    : invalidTransfersShapeCount > 0
                      ? 'invalid_transfers_shape'
                      : 'no_usable_response'
      return { provider: 'alchemy', ok: false, events: [], errorReason, diagnostics }
    }
    const cutoff = windowCutoffMs(windowDays)
    const events: RawProviderEvent[] = []
    const collect = (result: Record<string, unknown> | null) => {
      const transfers = Array.isArray(result?.transfers) ? (result!.transfers as Record<string, unknown>[]) : []
      for (const t of transfers) {
        if (events.length >= MAX_RAW_EVENTS_PER_PROVIDER) return
        const meta = t.metadata as Record<string, unknown> | undefined
        const timestamp = typeof meta?.blockTimestamp === 'string' ? meta.blockTimestamp : null
        if (timestamp && Date.parse(timestamp) < cutoff) continue // shallow window only
        const rawContract = t.rawContract as Record<string, unknown> | undefined
        const rawValueHex = typeof rawContract?.value === 'string' ? rawContract.value : null
        const rawDecimalHex = typeof rawContract?.decimal === 'string' ? rawContract.decimal : null
        events.push({
          provider: 'alchemy',
          chain,
          txHash: typeof t.hash === 'string' ? t.hash : null,
          timestamp,
          fromAddress: typeof t.from === 'string' ? t.from.toLowerCase() : null,
          toAddress: typeof t.to === 'string' ? (t.to as string).toLowerCase() : null,
          contract: typeof rawContract?.address === 'string' ? (rawContract.address as string).toLowerCase() : null,
          symbol: typeof t.asset === 'string' ? t.asset : null,
          amountRaw: alchemyHexAmountToDecimalString(rawValueHex),
          tokenDecimals: alchemyHexDecimalToNumber(rawDecimalHex),
        })
      }
    }
    collect(fromResult)
    collect(toResult)
    return { provider: 'alchemy', ok: true, events, errorReason: null, diagnostics }
  } catch (err) {
    return {
      provider: 'alchemy', ok: false, events: [], errorReason: err instanceof Error ? err.message : 'unknown_error',
      diagnostics: {
        liveCalls, budgetRefusals, malformedResponses, nullResponses,
        httpErrors, jsonParseErrors, jsonRpcErrors, missingResult: missingResultCount, invalidTransfersShape: invalidTransfersShapeCount,
        http429Count, circuitPrevented: circuitPreventedCount,
      },
    }
  }
}

export function dedupeRawEventKey(event: RawProviderEvent): string {
  return `${event.txHash ?? ''}|${(event.contract ?? '').toLowerCase()}|${(event.fromAddress ?? '').toLowerCase()}|${(event.toAddress ?? '').toLowerCase()}|${event.amountRaw ?? ''}`
}
