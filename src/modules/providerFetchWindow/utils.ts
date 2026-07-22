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
import { auditRPC } from '@/lib/server/alchemyAudit'

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
  const rpc = async (params: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
    try {
      logRpcCall({ route: 'providerFetchWindow', chain, method: 'alchemy_getAssetTransfers' })
      auditRPC('alchemy_getAssetTransfers', params)
      const res = await fetch(url, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'alchemy_getAssetTransfers', params: [params] }),
        signal: AbortSignal.timeout(12_000),
      })
      if (!res.ok) return null
      const json = await res.json()
      return (json?.result as Record<string, unknown>) ?? null
    } catch {
      return null
    }
  }
  try {
    const [fromResult, toResult] = await Promise.all([
      rpc({ fromBlock: '0x0', category: ['erc20'], withMetadata: true, maxCount: '0xC8', order: 'desc', fromAddress: walletAddress }),
      rpc({ fromBlock: '0x0', category: ['erc20'], withMetadata: true, maxCount: '0xC8', order: 'desc', toAddress: walletAddress }),
    ])
    if (!fromResult && !toResult) {
      return { provider: 'alchemy', ok: false, events: [], errorReason: 'no_usable_response' }
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
    return { provider: 'alchemy', ok: true, events, errorReason: null }
  } catch (err) {
    return { provider: 'alchemy', ok: false, events: [], errorReason: err instanceof Error ? err.message : 'unknown_error' }
  }
}

export function dedupeRawEventKey(event: RawProviderEvent): string {
  return `${event.txHash ?? ''}|${(event.contract ?? '').toLowerCase()}|${(event.fromAddress ?? '').toLowerCase()}|${(event.toAddress ?? '').toLowerCase()}|${event.amountRaw ?? ''}`
}
