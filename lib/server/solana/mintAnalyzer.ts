// SOLANA MINT ANALYZER, DISCLOSED (Solana-native architecture task): reads the SPL mint account
// directly — token program (spl-token vs spl-token-2022), decimals, total supply, mint authority,
// freeze authority. This is Alchemy RPC evidence, native to Solana's own account model — not an
// adaptation of any EVM concept. See authorityAnalyzer.ts for how mint/freeze authority get
// interpreted into a risk signal; this module only reads and reports the raw facts.

import { SPL_TOKEN_PROGRAM_ID, SPL_TOKEN_2022_PROGRAM_ID } from '../solanaChainConfig.ts'
import { solanaRpc, type RpcFetch } from './rpcClient.ts'

function tokenProgramLabel(owner: string | null): string | null {
  if (owner === SPL_TOKEN_PROGRAM_ID) return 'spl-token'
  if (owner === SPL_TOKEN_2022_PROGRAM_ID) return 'spl-token-2022'
  return owner ? 'unknown-program' : null
}

export type SolanaMintAnalysis =
  | {
      ok: true
      tokenProgram: string | null
      decimals: number | null
      totalSupply: number | null
      /** Raw base-unit supply, kept for holderAnalyzer's percent-of-supply math. May lose precision beyond 2^53 — prefer rawSupplyExact for math. */
      rawSupply: number | null
      /** Exact raw base-unit supply as returned by the RPC (u64 string) — use this, not rawSupply, for any BigInt-precision math. */
      rawSupplyExact: string | null
      mintAuthority: string | null
      freezeAuthority: string | null
      /** Distinguishes "revoked" (real evidence) from "couldn't parse" (unknown, not revoked). */
      authorityReadSucceeded: boolean
      /** Raw `extensions` field from the same jsonParsed response — null for spl-token (no such field), [] if spl-token-2022 but the field was absent/malformed. See tokenExtensions.ts for parsing. */
      rawExtensions: unknown[] | null
      evidenceGaps: string[]
    }
  | { ok: false; status: 'rpc_error' | 'mint_not_found'; error: string; evidenceGaps: string[] }

export async function analyzeSolanaMint(mintAddress: string, rpcUrl: string, fetchImpl: RpcFetch): Promise<SolanaMintAnalysis> {
  type ParsedMint = {
    value?: {
      data?: { parsed?: { info?: Record<string, unknown>; type?: string }; program?: string }
      owner?: string
    } | null
  }
  const mintInfo = await solanaRpc<ParsedMint>(rpcUrl, 'getAccountInfo', [mintAddress, { encoding: 'jsonParsed' }], fetchImpl)

  if (!mintInfo.ok) {
    return { ok: false, status: 'rpc_error', error: 'Could not reach the Solana RPC. Try again shortly.', evidenceGaps: ['Mint account could not be read from the Solana RPC.'] }
  }
  if (!mintInfo.result?.value) {
    return { ok: false, status: 'mint_not_found', error: 'No Solana mint found at that address.', evidenceGaps: ['Mint account does not exist on Solana mainnet.'] }
  }

  const accountValue = mintInfo.result.value
  const parsedInfo = accountValue.data?.parsed?.info ?? {}
  const parsedType = accountValue.data?.parsed?.type ?? null
  const owner = typeof accountValue.owner === 'string' ? accountValue.owner : null
  const tokenProgram = tokenProgramLabel(owner)

  // A 32-byte account that exists but is not a token mint (e.g. a wallet) must not be scanned as one.
  if (parsedType !== null && parsedType !== 'mint') {
    return {
      ok: false, status: 'mint_not_found', error: 'That address is a Solana account, but not a token mint.',
      evidenceGaps: [`Account exists but is not a token mint (parsed type: ${parsedType}).`],
    }
  }

  const evidenceGaps: string[] = []
  const decimalsRaw = parsedInfo.decimals
  const decimals = typeof decimalsRaw === 'number' && Number.isFinite(decimalsRaw) ? decimalsRaw : null
  if (decimals == null) evidenceGaps.push('Token decimals could not be read.')

  const authorityReadSucceeded = accountValue.data?.parsed != null
  const mintAuthority = typeof parsedInfo.mintAuthority === 'string' ? parsedInfo.mintAuthority : null
  const freezeAuthority = typeof parsedInfo.freezeAuthority === 'string' ? parsedInfo.freezeAuthority : null
  if (!authorityReadSucceeded) evidenceGaps.push('Mint/freeze authority could not be parsed — authority status unknown, not proven revoked.')

  type SupplyResp = { value?: { amount?: string; decimals?: number; uiAmount?: number | null } }
  const supplyRes = await solanaRpc<SupplyResp>(rpcUrl, 'getTokenSupply', [mintAddress], fetchImpl)
  let totalSupply: number | null = null
  let rawSupply: number | null = null
  let rawSupplyExact: string | null = null
  if (supplyRes.ok && supplyRes.result?.value) {
    const v = supplyRes.result.value
    totalSupply = typeof v.uiAmount === 'number' && Number.isFinite(v.uiAmount) ? v.uiAmount : null
    const amt = typeof v.amount === 'string' ? Number(v.amount) : NaN
    rawSupply = Number.isFinite(amt) ? amt : null
    rawSupplyExact = typeof v.amount === 'string' ? v.amount : null
  }
  if (totalSupply == null) evidenceGaps.push('Total supply could not be read.')

  const rawExtensions = tokenProgram === 'spl-token-2022' ? (Array.isArray(parsedInfo.extensions) ? parsedInfo.extensions as unknown[] : []) : null

  return { ok: true, tokenProgram, decimals, totalSupply, rawSupply, rawSupplyExact, mintAuthority, freezeAuthority, authorityReadSucceeded, rawExtensions, evidenceGaps }
}
