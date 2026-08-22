// SOLANA TOKEN-2022 EXTENSIONS, DISCLOSED (Supply Control follow-up task).
//
// Parses the `extensions` array that Solana's own `jsonParsed` RPC encoding already returns for a
// spl-token-2022 mint's getAccountInfo response — mintAnalyzer.ts already makes that exact RPC
// call for authority/decimals; this module only reads a field of the SAME response, no new call.
// A classic spl-token mint has no `extensions` field at all (the program doesn't support them),
// so `[]` is returned for it honestly, not as an absence of evidence.
//
// SCOPE, DISCLOSED: this reports which extensions are PRESENT and their real parsed state fields
// as Solana's own RPC parser returns them — it does not re-derive or validate those fields against
// raw account bytes. If the RPC's parser omits a field (older RPC versions, or an extension type
// added to spl-token-2022 after this codebase's own knowledge), that specific field is null, never
// guessed.

export type SolanaTokenExtensionType =
  | 'transferFeeConfig'
  | 'permanentDelegate'
  | 'metadataPointer'
  | 'transferHook'
  | 'interestBearingConfig'
  | 'confidentialTransferMint'
  | 'mintCloseAuthority'
  | 'nonTransferable'
  | 'defaultAccountState'
  | string

export type SolanaTokenExtension = {
  type: SolanaTokenExtensionType
  label: string
  /** Real parsed state from the RPC's own jsonParsed encoding, kept as-is — never re-derived. */
  state: Record<string, unknown> | null
}

const EXTENSION_LABELS: Record<string, string> = {
  transferFeeConfig: 'Transfer Fee',
  permanentDelegate: 'Permanent Delegate',
  metadataPointer: 'Metadata Pointer',
  transferHook: 'Transfer Hook',
  interestBearingConfig: 'Interest Bearing',
  confidentialTransferMint: 'Confidential Transfer',
  mintCloseAuthority: 'Mint Close Authority',
  nonTransferable: 'Non-Transferable',
  defaultAccountState: 'Default Account State',
}

/**
 * Parses the raw `extensions` array from a jsonParsed mint account. Returns `[]` for anything that
 * isn't a well-formed array (classic spl-token mints, or a malformed/missing field) — never throws,
 * never fabricates an extension that wasn't actually present in the response.
 */
export function parseSolanaTokenExtensions(rawExtensions: unknown): SolanaTokenExtension[] {
  if (!Array.isArray(rawExtensions)) return []
  const out: SolanaTokenExtension[] = []
  for (const raw of rawExtensions) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const type = typeof r.extension === 'string' ? r.extension : null
    if (!type) continue
    const state = r.state && typeof r.state === 'object' ? (r.state as Record<string, unknown>) : null
    out.push({ type, label: EXTENSION_LABELS[type] ?? type, state })
  }
  return out
}

/** Human, non-overclaiming, evidence-cited explanation of what a present extension actually does. */
export function explainSolanaTokenExtension(ext: SolanaTokenExtension): string {
  switch (ext.type) {
    case 'transferFeeConfig': {
      const bps = ext.state?.newerTransferFee && typeof ext.state.newerTransferFee === 'object'
        ? (ext.state.newerTransferFee as Record<string, unknown>).transferFeeBasisPoints
        : null
      const pct = typeof bps === 'number' ? (bps / 100).toFixed(2) : null
      return pct != null
        ? `Transfer Fee extension is active — a ${pct}% fee is deducted from every transfer of this token, on-chain, by the token program itself.`
        : 'Transfer Fee extension is present — a fee is deducted from every transfer; the exact rate could not be parsed from this RPC response.'
    }
    case 'permanentDelegate': {
      const delegate = typeof ext.state?.delegate === 'string' ? ext.state.delegate : null
      return delegate
        ? `Permanent Delegate extension is active — wallet ${delegate} can transfer or burn tokens from ANY holder's account without their signature, permanently, by design of this extension.`
        : 'Permanent Delegate extension is present — some wallet can transfer or burn tokens from any holder\'s account without their signature; the delegate address could not be parsed.'
    }
    case 'metadataPointer':
      return 'Metadata Pointer extension is present — the mint points to an on-chain or off-chain metadata account; this affects name/symbol/URI resolution, not supply or transfer behavior.'
    case 'transferHook': {
      const programId = typeof ext.state?.programId === 'string' ? ext.state.programId : null
      return programId
        ? `Transfer Hook extension is active — every transfer invokes external program ${programId}, which can add custom logic (including blocking transfers) outside this engine's visibility.`
        : 'Transfer Hook extension is present — every transfer invokes an external program that can add custom logic, including blocking transfers.'
    }
    case 'interestBearingConfig':
      return 'Interest Bearing extension is present — displayed balances accrue a configured interest rate over time; this does not mint new on-chain supply, only affects the UI-displayed amount.'
    case 'confidentialTransferMint':
      return 'Confidential Transfer extension is present — transfer amounts can be encrypted, which limits what on-chain evidence (like holder concentration) can be verified for this token.'
    case 'mintCloseAuthority': {
      const authority = typeof ext.state?.closeAuthority === 'string' ? ext.state.closeAuthority : null
      return authority
        ? `Mint Close Authority extension is active — wallet ${authority} can close this mint account once supply reaches zero.`
        : 'Mint Close Authority extension is present — some wallet can close this mint account once supply reaches zero.'
    }
    case 'nonTransferable':
      return 'Non-Transferable extension is present — tokens cannot be transferred between accounts once minted (soulbound-style behavior).'
    case 'defaultAccountState':
      return 'Default Account State extension is present — new token accounts for this mint may be created in a frozen state by default.'
    default:
      return `${ext.label} extension is present — this engine does not have a specific explanation wired for this extension type yet; see the raw state for details.`
  }
}
