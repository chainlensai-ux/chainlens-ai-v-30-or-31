// SOLANA TOKEN SCANNER — BETA, DISCLOSED (Token Scanner Solana Beta task).
//
// SCOPE AND HONESTY CONTRACT — read this before adding anything here:
//
// This module collects ONLY evidence Solana actually supports through the RPC methods and market
// providers already available to this app. It deliberately does NOT attempt, and must never
// fabricate, the EVM-specific checks the Token Scanner performs on Base/Ethereum/BNB:
//   - no LP token lock/burn proof (an EVM ERC-20 LP-token concept; Solana AMM LP works differently)
//   - no honeypot buy/sell simulation
//   - no buy/sell tax simulation
//   - no contract owner / renounced-ownership read
//   - no deployer transaction-history reconstruction
// Every one of those is reported as an explicit unsupported check, never as a passed check.
//
// WHAT IS REAL HERE: mint identity (decimals, supply, mint/freeze authority, which SPL token
// program owns it) read straight from the mint account, top-ACCOUNT concentration derived from
// getTokenLargestAccounts, and market data from DexScreener (already a wired provider in this
// codebase — no new/paid API added). Anything that fails to resolve becomes an entry in
// `evidenceGaps`, never a zero or a default that could read as a real measurement.
//
// TOP-ACCOUNT vs HOLDER COUNT, DISCLOSED: getTokenLargestAccounts returns at most the top 20 TOKEN
// ACCOUNTS — not holders, and not a total holder count. Those accounts routinely include AMM pool
// vaults and exchange custody, so a high "top 1" share can be a liquidity pool rather than a whale.
// This module therefore reports `topAccountConcentration` and never emits a holder count or calls
// this a holder-distribution check.

import {
  SPL_TOKEN_PROGRAM_ID,
  SPL_TOKEN_2022_PROGRAM_ID,
  getSolanaRpcUrl,
  isSolanaBetaFeatureEnabled,
  isSolanaRpcConfigured,
} from './solanaChainConfig.ts'

// ── Types ────────────────────────────────────────────────────────────────────

export type SolanaUnsupportedCheck = {
  check: string
  reason: string
}

/** The EVM checks Token Scanner runs that have no valid Solana equivalent in Beta. */
export const SOLANA_UNSUPPORTED_CHECKS: readonly SolanaUnsupportedCheck[] = [
  { check: 'LP lock / burn proof', reason: 'Not applicable to EVM ERC-20 LP proof. Solana AMM pool authority verification is not fully supported in Solana Beta.' },
  { check: 'Honeypot simulation', reason: 'Honeypot simulation unavailable for Solana Beta.' },
  { check: 'Buy / sell tax simulation', reason: 'Tax simulation unavailable for Solana Beta.' },
  { check: 'Contract owner / renounced ownership', reason: 'EVM ownership model does not apply. Mint and freeze authority are checked instead where available.' },
  { check: 'Deployer transaction history', reason: 'Creator/deployer evidence unavailable in Solana Beta.' },
]

export type SolanaTopAccountShare = {
  /** Rank, 1-based, by balance descending. */
  rank: number
  /** Raw base-unit amount as returned by the RPC (string to avoid precision loss). */
  amountRaw: string
  /** Share of total supply, 0-100, rounded to 2dp. Null when supply is unknown. */
  percentOfSupply: number | null
}

export type SolanaMarketData = {
  priceUsd: number | null
  liquidityUsd: number | null
  volume24hUsd: number | null
  fdvUsd: number | null
  marketCapUsd: number | null
  primaryPoolAddress: string | null
  primaryDexLabel: string | null
  /**
   * MAPPING FIX, DISCLOSED (Token Scanner Solana UI parity task): the RPC mint account carries no
   * name/symbol — SPL mints don't store one on-chain. name/symbol below are read from the SAME
   * already-fetched DexScreener pair response (never a second/new call), matched to whichever side
   * of the pair is actually this mint. Null, honestly, when the deepest indexed pair doesn't carry
   * that field or the queried mint isn't cleanly identifiable as base or quote.
   */
  tokenName: string | null
  tokenSymbol: string | null
}

export type SolanaTokenScannerAudit = {
  enabled: boolean
  rpcConfigured: boolean
  mintAddress: string
  tokenProgram: string | null
  supplyResolved: boolean
  decimalsResolved: boolean
  largestAccountsResolved: boolean
  top1Percent: number | null
  top10Percent: number | null
  top20Percent: number | null
  marketProviderUsed: string | null
  marketDataResolved: boolean
  mintAuthorityResolved: boolean
  freezeAuthorityResolved: boolean
  unsupportedChecks: string[]
  evidenceGaps: string[]
}

export type SolanaBetaScanResult = {
  solanaBeta: true
  chain: 'solana'
  mintAddress: string
  /** 'spl-token' | 'spl-token-2022' | null when the owning program could not be read. */
  tokenProgram: string | null
  decimals: number | null
  /** Total supply in whole tokens (decimals applied). Null when unresolved. */
  totalSupply: number | null
  /**
   * null means "no authority" (revoked) ONLY when authorityReadSucceeded is true. When the read
   * failed, both fields are null and the corresponding evidence gap is present — so a caller can
   * never mistake "couldn't check" for "revoked".
   */
  mintAuthority: string | null
  freezeAuthority: string | null
  authorityReadSucceeded: boolean
  holderConcentrationAvailable: boolean
  topAccountConcentration: {
    /** Always labelled as ACCOUNTS, never holders — see module header. */
    accountsSampled: number
    top1Percent: number | null
    top10Percent: number | null
    top20Percent: number | null
    accounts: SolanaTopAccountShare[]
  } | null
  marketDataAvailable: boolean
  marketData: SolanaMarketData | null
  /** Reduced-confidence beta score. Never 'SAFE'/'verified'. */
  betaRisk: {
    verdict: 'OPEN_CHECK' | 'CAUTION' | 'HIGH_RISK'
    confidence: 'LOW' | 'MEDIUM'
    reasons: string[]
  }
  solanaEvidenceGaps: string[]
  unsupportedChecks: SolanaUnsupportedCheck[]
  solanaTokenScannerAudit: SolanaTokenScannerAudit
}

export type SolanaBetaScanFailure = {
  solanaBeta: true
  chain: 'solana'
  status: 'not_enabled' | 'not_configured' | 'mint_not_found' | 'rpc_error'
  error: string
  solanaTokenScannerAudit: SolanaTokenScannerAudit
}

// ── RPC plumbing ─────────────────────────────────────────────────────────────

type RpcFetch = typeof fetch

async function solanaRpc<T>(
  rpcUrl: string,
  method: string,
  params: unknown[],
  fetchImpl: RpcFetch,
  timeoutMs = 9000,
): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
  try {
    const res = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return { ok: false, error: `rpc_http_${res.status}` }
    const json = await res.json().catch(() => null) as { result?: T; error?: { message?: string } } | null
    if (!json) return { ok: false, error: 'rpc_bad_json' }
    if (json.error) return { ok: false, error: `rpc_error:${json.error.message ?? 'unknown'}` }
    if (json.result === undefined || json.result === null) return { ok: false, error: 'rpc_null_result' }
    return { ok: true, result: json.result }
  } catch {
    return { ok: false, error: 'rpc_unreachable' }
  }
}

function tokenProgramLabel(owner: string | null): string | null {
  if (owner === SPL_TOKEN_PROGRAM_ID) return 'spl-token'
  if (owner === SPL_TOKEN_2022_PROGRAM_ID) return 'spl-token-2022'
  return owner ? 'unknown-program' : null
}

// ── Market data (DexScreener — already a wired provider, no new/paid API) ─────

async function fetchSolanaMarketData(
  mintAddress: string,
  fetchImpl: RpcFetch,
): Promise<{ data: SolanaMarketData | null; provider: string | null }> {
  try {
    const res = await fetchImpl(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`, {
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return { data: null, provider: 'dexscreener' }
    const json = await res.json().catch(() => null) as { pairs?: unknown } | null
    const pairs = Array.isArray(json?.pairs) ? json!.pairs as Array<Record<string, unknown>> : []
    // Solana-only pairs, highest liquidity first — the primary pool is the deepest one.
    const solPairs = pairs
      .filter((p) => String(p.chainId ?? '').toLowerCase() === 'solana')
      .sort((a, b) => {
        const la = Number((a.liquidity as Record<string, unknown> | undefined)?.usd ?? 0)
        const lb = Number((b.liquidity as Record<string, unknown> | undefined)?.usd ?? 0)
        return lb - la
      })
    if (solPairs.length === 0) return { data: null, provider: 'dexscreener' }
    const top = solPairs[0]
    const num = (v: unknown): number | null => {
      const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
      return Number.isFinite(n) ? n : null
    }
    // Identify which side of the pair is the mint we scanned — never assume it's always "base".
    const baseToken = top.baseToken as Record<string, unknown> | undefined
    const quoteToken = top.quoteToken as Record<string, unknown> | undefined
    const matchedToken = String(baseToken?.address ?? '').toLowerCase() === mintAddress.toLowerCase()
      ? baseToken
      : String(quoteToken?.address ?? '').toLowerCase() === mintAddress.toLowerCase()
        ? quoteToken
        : null
    const tokenName = typeof matchedToken?.name === 'string' ? matchedToken.name : null
    const tokenSymbol = typeof matchedToken?.symbol === 'string' ? matchedToken.symbol : null
    // Liquidity/volume are summed across every Solana pair — a token's real depth is not just its
    // deepest pool. Price/FDV/marketCap are read from the deepest pool only (summing those would
    // be meaningless).
    const liquidityUsd = solPairs.reduce((sum, p) => sum + (num((p.liquidity as Record<string, unknown> | undefined)?.usd) ?? 0), 0)
    const volume24hUsd = solPairs.reduce((sum, p) => sum + (num((p.volume as Record<string, unknown> | undefined)?.h24) ?? 0), 0)
    return {
      provider: 'dexscreener',
      data: {
        priceUsd: num(top.priceUsd),
        liquidityUsd: liquidityUsd > 0 ? Math.round(liquidityUsd) : null,
        volume24hUsd: volume24hUsd > 0 ? Math.round(volume24hUsd) : null,
        fdvUsd: num(top.fdv),
        marketCapUsd: num(top.marketCap),
        primaryPoolAddress: typeof top.pairAddress === 'string' ? top.pairAddress : null,
        primaryDexLabel: typeof top.dexId === 'string' ? top.dexId : null,
        tokenName,
        tokenSymbol,
      },
    }
  } catch {
    return { data: null, provider: 'dexscreener' }
  }
}

// ── Beta risk scoring ────────────────────────────────────────────────────────

/**
 * BETA SCORING, DISCLOSED: deliberately cannot return a "safe"/"verified" verdict. The best
 * available outcome is OPEN_CHECK — because with honeypot, tax, LP-control and deployer evidence
 * all unavailable on this path, no amount of the evidence we CAN collect is sufficient to call a
 * Solana token clean. Confidence is capped at MEDIUM and drops to LOW as evidence gaps accumulate.
 */
export function scoreSolanaBeta(input: {
  mintAuthority: string | null
  freezeAuthority: string | null
  authorityReadSucceeded: boolean
  top1Percent: number | null
  marketDataAvailable: boolean
  liquidityUsd: number | null
  evidenceGapCount: number
}): SolanaBetaScanResult['betaRisk'] {
  const reasons: string[] = []
  let verdict: SolanaBetaScanResult['betaRisk']['verdict'] = 'OPEN_CHECK'

  if (input.authorityReadSucceeded) {
    if (input.mintAuthority) {
      reasons.push('Mint authority is still active — supply can be increased.')
      verdict = 'CAUTION'
    } else {
      reasons.push('Mint authority is revoked.')
    }
    if (input.freezeAuthority) {
      reasons.push('Freeze authority is still active — token accounts can be frozen.')
      verdict = 'HIGH_RISK'
    } else {
      reasons.push('Freeze authority is revoked.')
    }
  } else {
    reasons.push('Mint/freeze authority could not be read — treat authority status as unknown.')
  }

  if (input.top1Percent != null && input.top1Percent >= 50) {
    reasons.push(`Top account holds ${input.top1Percent}% of supply (may be an AMM pool vault — not necessarily a single whale).`)
    if (verdict === 'OPEN_CHECK') verdict = 'CAUTION'
  }

  if (!input.marketDataAvailable) {
    reasons.push('No Solana market data found — token may be unlaunched, illiquid, or not indexed.')
  } else if (input.liquidityUsd != null && input.liquidityUsd < 5_000) {
    reasons.push(`Liquidity is thin (${input.liquidityUsd} USD across indexed Solana pools).`)
    if (verdict === 'OPEN_CHECK') verdict = 'CAUTION'
  }

  // Confidence is capped by construction: MEDIUM only when authority read succeeded AND market
  // data resolved AND gaps are few. Everything else is LOW.
  const confidence: 'LOW' | 'MEDIUM' =
    input.authorityReadSucceeded && input.marketDataAvailable && input.evidenceGapCount <= 2 ? 'MEDIUM' : 'LOW'

  reasons.push('Solana Beta: honeypot, tax, LP-control and deployer checks are not available on this path.')
  return { verdict, confidence, reasons }
}

// ── Main entry ───────────────────────────────────────────────────────────────

function emptyAudit(mintAddress: string): SolanaTokenScannerAudit {
  return {
    enabled: isSolanaBetaFeatureEnabled(),
    rpcConfigured: isSolanaRpcConfigured(),
    mintAddress,
    tokenProgram: null,
    supplyResolved: false,
    decimalsResolved: false,
    largestAccountsResolved: false,
    top1Percent: null,
    top10Percent: null,
    top20Percent: null,
    marketProviderUsed: null,
    marketDataResolved: false,
    mintAuthorityResolved: false,
    freezeAuthorityResolved: false,
    unsupportedChecks: SOLANA_UNSUPPORTED_CHECKS.map((u) => u.check),
    evidenceGaps: [],
  }
}

/**
 * The ONLY Solana scan entry point. Never calls any EVM scanner, LP-proof, honeypot, tax, or
 * deployer helper — by construction, since it imports none of them.
 *
 * `fetchImpl` is injectable purely so tests can exercise the real logic without network access.
 */
export async function scanSolanaTokenBeta(
  mintAddress: string,
  opts: { fetchImpl?: RpcFetch; rpcUrl?: string | null } = {},
): Promise<SolanaBetaScanResult | SolanaBetaScanFailure> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const audit = emptyAudit(mintAddress)

  if (!isSolanaBetaFeatureEnabled()) {
    return { solanaBeta: true, chain: 'solana', status: 'not_enabled', error: 'Solana Beta is not enabled.', solanaTokenScannerAudit: audit }
  }
  const rpcUrl = opts.rpcUrl !== undefined ? opts.rpcUrl : getSolanaRpcUrl()
  if (!rpcUrl) {
    return { solanaBeta: true, chain: 'solana', status: 'not_configured', error: 'Solana Beta is not configured yet.', solanaTokenScannerAudit: audit }
  }

  const evidenceGaps: string[] = []

  // ── 1. Mint identity ───────────────────────────────────────────────────────
  type ParsedMint = {
    value?: {
      data?: { parsed?: { info?: Record<string, unknown>; type?: string }; program?: string }
      owner?: string
    } | null
  }
  const mintInfo = await solanaRpc<ParsedMint>(rpcUrl, 'getAccountInfo', [mintAddress, { encoding: 'jsonParsed' }], fetchImpl)

  if (!mintInfo.ok) {
    audit.evidenceGaps = ['Mint account could not be read from the Solana RPC.']
    return { solanaBeta: true, chain: 'solana', status: 'rpc_error', error: 'Could not reach the Solana RPC. Try again shortly.', solanaTokenScannerAudit: audit }
  }
  if (!mintInfo.result?.value) {
    audit.evidenceGaps = ['Mint account does not exist on Solana mainnet.']
    return { solanaBeta: true, chain: 'solana', status: 'mint_not_found', error: 'No Solana mint found at that address.', solanaTokenScannerAudit: audit }
  }

  const accountValue = mintInfo.result.value
  const parsedInfo = accountValue.data?.parsed?.info ?? {}
  const parsedType = accountValue.data?.parsed?.type ?? null
  const owner = typeof accountValue.owner === 'string' ? accountValue.owner : null
  const tokenProgram = tokenProgramLabel(owner)
  audit.tokenProgram = tokenProgram

  // A 32-byte account that exists but is not a token mint (e.g. a wallet) must not be scanned as one.
  if (parsedType !== null && parsedType !== 'mint') {
    audit.evidenceGaps = [`Account exists but is not a token mint (parsed type: ${parsedType}).`]
    return { solanaBeta: true, chain: 'solana', status: 'mint_not_found', error: 'That address is a Solana account, but not a token mint.', solanaTokenScannerAudit: audit }
  }

  const decimalsRaw = parsedInfo.decimals
  const decimals = typeof decimalsRaw === 'number' && Number.isFinite(decimalsRaw) ? decimalsRaw : null
  audit.decimalsResolved = decimals != null
  if (decimals == null) evidenceGaps.push('Token decimals could not be read.')

  // authorityReadSucceeded distinguishes "revoked" (real, valuable evidence) from "unread".
  const authorityReadSucceeded = accountValue.data?.parsed != null
  const mintAuthority = typeof parsedInfo.mintAuthority === 'string' ? parsedInfo.mintAuthority : null
  const freezeAuthority = typeof parsedInfo.freezeAuthority === 'string' ? parsedInfo.freezeAuthority : null
  audit.mintAuthorityResolved = authorityReadSucceeded
  audit.freezeAuthorityResolved = authorityReadSucceeded
  if (!authorityReadSucceeded) evidenceGaps.push('Mint/freeze authority could not be parsed — authority status unknown, not proven revoked.')

  // ── 2. Supply ──────────────────────────────────────────────────────────────
  type SupplyResp = { value?: { amount?: string; decimals?: number; uiAmount?: number | null } }
  const supplyRes = await solanaRpc<SupplyResp>(rpcUrl, 'getTokenSupply', [mintAddress], fetchImpl)
  let totalSupply: number | null = null
  let rawSupply: number | null = null
  if (supplyRes.ok && supplyRes.result?.value) {
    const v = supplyRes.result.value
    const uiAmount = typeof v.uiAmount === 'number' && Number.isFinite(v.uiAmount) ? v.uiAmount : null
    totalSupply = uiAmount
    const amt = typeof v.amount === 'string' ? Number(v.amount) : NaN
    rawSupply = Number.isFinite(amt) ? amt : null
    audit.supplyResolved = totalSupply != null
  }
  if (totalSupply == null) evidenceGaps.push('Total supply could not be read.')

  // ── 3. Top-ACCOUNT concentration (never a holder count — see module header) ─
  type LargestResp = { value?: Array<{ address?: string; amount?: string; uiAmount?: number | null }> }
  const largestRes = await solanaRpc<LargestResp>(rpcUrl, 'getTokenLargestAccounts', [mintAddress], fetchImpl)
  let concentration: SolanaBetaScanResult['topAccountConcentration'] = null

  if (largestRes.ok && Array.isArray(largestRes.result?.value) && largestRes.result.value.length > 0) {
    const rows = largestRes.result.value
    audit.largestAccountsResolved = true
    const pct = (sumRaw: number): number | null =>
      rawSupply != null && rawSupply > 0 ? Math.round((sumRaw / rawSupply) * 10000) / 100 : null
    const rawAmounts = rows.map((r) => {
      const n = typeof r.amount === 'string' ? Number(r.amount) : NaN
      return Number.isFinite(n) ? n : 0
    })
    const sumOf = (n: number) => rawAmounts.slice(0, n).reduce((s, v) => s + v, 0)
    const top1 = pct(sumOf(1))
    const top10 = pct(sumOf(10))
    const top20 = pct(sumOf(20))
    audit.top1Percent = top1
    audit.top10Percent = top10
    audit.top20Percent = top20
    concentration = {
      accountsSampled: rows.length,
      top1Percent: top1,
      top10Percent: top10,
      top20Percent: top20,
      accounts: rows.slice(0, 20).map((r, i) => ({
        rank: i + 1,
        amountRaw: typeof r.amount === 'string' ? r.amount : '0',
        percentOfSupply: pct(rawAmounts[i] ?? 0),
      })),
    }
    if (rawSupply == null) evidenceGaps.push('Top-account shares could not be expressed as a percent — supply unknown.')
    evidenceGaps.push('Concentration reflects the top token ACCOUNTS only (max 20), not a full holder count. AMM pool vaults and exchange custody accounts are included.')
  } else {
    evidenceGaps.push('Top token accounts could not be read — concentration unavailable.')
  }

  // ── 4. Market data ─────────────────────────────────────────────────────────
  const market = await fetchSolanaMarketData(mintAddress, fetchImpl)
  audit.marketProviderUsed = market.provider
  audit.marketDataResolved = market.data != null
  if (!market.data) evidenceGaps.push('No Solana market/pool data found via DexScreener — price, liquidity and volume unavailable.')

  // ── 5. Beta risk ───────────────────────────────────────────────────────────
  const betaRisk = scoreSolanaBeta({
    mintAuthority,
    freezeAuthority,
    authorityReadSucceeded,
    top1Percent: concentration?.top1Percent ?? null,
    marketDataAvailable: market.data != null,
    liquidityUsd: market.data?.liquidityUsd ?? null,
    evidenceGapCount: evidenceGaps.length,
  })

  audit.evidenceGaps = evidenceGaps

  return {
    solanaBeta: true,
    chain: 'solana',
    mintAddress,
    tokenProgram,
    decimals,
    totalSupply,
    mintAuthority,
    freezeAuthority,
    authorityReadSucceeded,
    holderConcentrationAvailable: concentration != null,
    topAccountConcentration: concentration,
    marketDataAvailable: market.data != null,
    marketData: market.data,
    betaRisk,
    solanaEvidenceGaps: evidenceGaps,
    unsupportedChecks: [...SOLANA_UNSUPPORTED_CHECKS],
    solanaTokenScannerAudit: audit,
  }
}
