// SOLANA SUPPLY CONTROL, DISCLOSED (Dev Intelligence "Supply Control" tab follow-up task).
//
// Replaces a placeholder tab that simply repeated the Mint Authority stat with a real supply
// analysis: current/max supply, whether future inflation is possible, whether supply is
// permanently fixed, and every Token-2022 extension that can affect supply or transfer behavior —
// each with an explicit, evidence-cited WHY, never a bare verdict. Every field here is derived
// from mintAnalyzer.ts's real getAccountInfo/getTokenSupply reads — no new RPC calls are made.

import type { SolanaMintAnalysis } from './mintAnalyzer.ts'
import { parseSolanaTokenExtensions, explainSolanaTokenExtension, type SolanaTokenExtension } from './tokenExtensions.ts'

export type SolanaSupplyControl = {
  currentSupply: number | null
  /** Equal to currentSupply only when supply is proven permanently fixed (mint authority revoked). Null otherwise — SPL mints carry no separate "max supply" field; an active mint authority means there is no ceiling to report. */
  maxSupply: number | null
  /** Null when the authority read itself failed (unknown, not "no"). */
  inflationPossible: boolean | null
  inflationReason: string
  supplyPermanentlyFixed: boolean | null
  supplyFixedReason: string
  mintAuthority: string | null
  freezeAuthority: string | null
  tokenProgram: string | null
  extensions: SolanaTokenExtension[]
  extensionsResolved: boolean
  /** One human-readable, evidence-cited sentence per present extension — see tokenExtensions.ts. */
  extensionExplanations: string[]
}

export function buildSolanaSupplyControl(mint: SolanaMintAnalysis & { ok: true }): SolanaSupplyControl {
  const { authorityReadSucceeded, mintAuthority, freezeAuthority, totalSupply, tokenProgram } = mint

  let inflationPossible: boolean | null
  let inflationReason: string
  let supplyPermanentlyFixed: boolean | null
  let supplyFixedReason: string

  if (!authorityReadSucceeded) {
    inflationPossible = null
    inflationReason = 'Mint authority could not be read from the Solana RPC for this mint — whether new supply can be minted is unknown, not confirmed either way.'
    supplyPermanentlyFixed = null
    supplyFixedReason = 'Supply fixedness cannot be determined without a successful mint authority read.'
  } else if (mintAuthority) {
    inflationPossible = true
    inflationReason = `Mint authority ${mintAuthority} is still active on this mint — that wallet can mint additional supply at any time, with no on-chain limit enforced by the token program.`
    supplyPermanentlyFixed = false
    supplyFixedReason = 'Supply is not fixed — an active mint authority can increase total supply beyond the current amount at any time.'
  } else {
    inflationPossible = false
    inflationReason = 'Mint authority has been revoked (set to null) — no wallet, including the original deployer, can mint additional supply. This is verified directly from the mint account, not inferred.'
    supplyPermanentlyFixed = true
    supplyFixedReason = `Supply is permanently fixed at ${totalSupply != null ? totalSupply.toLocaleString('en-US') : 'the current total'} — mint authority is revoked, so no further tokens can ever be created.`
  }

  const maxSupply = supplyPermanentlyFixed === true ? totalSupply : null

  const extensionsResolved = tokenProgram === 'spl-token-2022'
  const extensions = extensionsResolved ? parseSolanaTokenExtensions(mint.rawExtensions) : []
  const extensionExplanations = extensionsResolved
    ? (extensions.length > 0 ? extensions.map(explainSolanaTokenExtension) : ['Token Program is spl-token-2022, but no extensions are present on this mint — it behaves like a classic SPL token for supply/transfer purposes.'])
    : tokenProgram === 'spl-token'
      ? ['Token Program is spl-token (classic) — no extensions are possible on this mint; Token-2022 extensions do not exist in this program.']
      : ['Token Program could not be identified — extension support is unknown.']

  return {
    currentSupply: totalSupply,
    maxSupply,
    inflationPossible,
    inflationReason,
    supplyPermanentlyFixed,
    supplyFixedReason,
    mintAuthority,
    freezeAuthority,
    tokenProgram,
    extensions,
    extensionsResolved,
    extensionExplanations,
  }
}
