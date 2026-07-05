// V2 SCANNER PREVIEW component — receives chainSelection (old) and chainActivityV2 (new) from the
// engine's report.
//
// V2-SAFE GUARD: `data.chains` defensively falls back to [] rather than crashing if the value is
// missing or malformed at runtime.
//
// CHAIN ACTIVITY V2 MIGRATION, DISCLOSED (added per a later task):
//
// COMPONENT-CHAIN CORRECTION: the task assumed a "ChainActivityCard.tsx" nested under
// WalletProfileHeader.tsx — neither is real. This component (ChainSelectionView.tsx) is the real
// one, rendered directly in app/terminal/wallet-scanner/page.tsx as a sibling of
// WalletProfileHeader, not a child of it. WalletProfileHeader.tsx was not touched.
//
// FIELD-NAME/SHAPE CORRECTIONS, DISCLOSED: the task's own pseudocode assumed an
// "OldChainSelectionType" with `chainId`/`label`/`activityLevel`/`txCount30d` fields — none of these
// exist on the real ChainSelectionEntry (src/modules/chainSelection/types.ts). The real old shape
// has `chain: SupportedChain` (a string like 'eth'/'base', not a numeric chainId), `status:
// 'active_intelligence' | 'dust_low_signal'` (not an activityLevel), and `wallet_side_transactions`
// (not txCount30d) — plus real `visible_value_usd`/`swapCandidateEvents` this component already
// rendered, which the task's assumed adapter shape would have silently dropped. The task's assumed
// target `activityLevel` type (`"low" | "medium" | "high" | "dust"`) also doesn't match the real
// ChainActivityRecord['activityLevel'] union (`"high" | "medium" | "low" | "dust-only"` — hyphenated
// "dust-only", not "dust"). All reconciled explicitly below via `selectChainActivity`, matching the
// task's own requested adapter shape (chainId/label/activityLevel/txCount30d) for the common,
// testable fields — with the real, richer per-chain detail (value/swaps/primary-use) rendered
// alongside it from the original data, not discarded, so the UI keeps showing what it already did.
//
// V1 APPROXIMATION, DISCLOSED: the old chainSelection data has no activityLevel/txCount30d concept
// at all — only a binary active/dust `status` and a raw `wallet_side_transactions` count (not
// scoped to a 30-day window the way the new engine's txCount30d is). When falling back to V1,
// `status === 'active_intelligence'` maps to `activityLevel: 'medium'` (a deliberate, disclosed
// middle-ground — the old data cannot distinguish "low" from "high" activity, only active-vs-dust)
// and `wallet_side_transactions` is reused as `txCount30d` (an approximation of a genuinely
// different real quantity, not the same 30-day-windowed count V2 actually computes). Chain IDs for
// the V1 fallback are assigned from the same real, well-known values used throughout this session's
// V2 engine modules (eth=1, base=8453); arbitrum/hyperevm (chains this component's old data can
// include but the V2 engine chain never processes) use their own real, well-known chain IDs
// (42161/999) for consistent display only — not a claim that V2 modules support them.
import type { ChainSelectionResult, ChainSelectionEntry } from '@/src/modules/chainSelection/types'
import type { ChainActivityRecord } from '@/lib/engine/modules/activity/types'
import type { SupportedChain } from '@/src/modules/providerFetchWindow/types'

export type SelectedChainActivityRow = {
  chainId: number
  label: string
  activityLevel: 'low' | 'medium' | 'high' | 'dust'
  txCount30d?: number
}

const CHAIN_STRING_TO_ID: Record<SupportedChain, number> = {
  eth: 1,
  base: 8453,
  arbitrum: 42161,
  hyperevm: 999,
}

// Real V2 activityLevel uses 'dust-only' (hyphenated); this component's own rendered union uses
// 'dust' — reconciled here, not silently assumed identical strings.
function normalizeV2ActivityLevel(level: ChainActivityRecord['activityLevel']): SelectedChainActivityRow['activityLevel'] {
  return level === 'dust-only' ? 'dust' : level
}

// Pure, exported for direct testing. Priority: chainActivityV2 > chainSelection > empty — matches
// the task's own stated priority ("use V2 when present").
export function selectChainActivity(params: {
  chainActivityV2?: ChainActivityRecord[] | null
  chainSelection?: ChainSelectionResult | null
}): { chains: SelectedChainActivityRow[]; usingV2: boolean } {
  const { chainActivityV2, chainSelection } = params

  if (Array.isArray(chainActivityV2) && chainActivityV2.length > 0) {
    return {
      chains: chainActivityV2.map((c) => ({
        chainId: c.chainId,
        label: String(c.chainId),
        activityLevel: normalizeV2ActivityLevel(c.activityLevel),
        txCount30d: c.txCount30d,
      })),
      usingV2: true,
    }
  }

  const chains = Array.isArray(chainSelection?.chains) ? chainSelection!.chains : []
  if (chains.length > 0) {
    return {
      chains: chains.map((c) => ({
        chainId: CHAIN_STRING_TO_ID[c.chain] ?? -1,
        label: c.chain,
        activityLevel: c.status === 'active_intelligence' ? 'medium' : 'dust',
        txCount30d: c.wallet_side_transactions,
      })),
      usingV2: false,
    }
  }

  return { chains: [], usingV2: false }
}

export function ChainSelectionView({
  data,
  chainActivityV2,
}: {
  data: ChainSelectionResult | null | undefined
  chainActivityV2?: ChainActivityRecord[] | null
}) {
  const { chains: selectedChains, usingV2 } = selectChainActivity({ chainActivityV2, chainSelection: data })
  // TEMPORARY, per this migration's own instructions — remove once chainActivityV2 is verified live
  // and this fallback path is no longer needed.
  // eslint-disable-next-line no-console
  console.debug('ChainActivity using V2:', usingV2)

  const activeChainCount = typeof data?.activeChainCount === 'number' ? data.activeChainCount : 0
  const dustChainCount = typeof data?.dustChainCount === 'number' ? data.dustChainCount : 0

  // Real, richer per-chain detail rendered alongside the adapter's common fields — never dropped,
  // per this file's own header disclosure. Looked up by the same key the adapter used to build each
  // row, from whichever real source is actually active.
  const v1EntryByChain = new Map<SupportedChain, ChainSelectionEntry>(
    (Array.isArray(data?.chains) ? data!.chains : []).map((c) => [c.chain, c]),
  )
  const v2RecordByChainId = new Map<number, ChainActivityRecord>(
    (Array.isArray(chainActivityV2) ? chainActivityV2 : []).map((c) => [c.chainId, c]),
  )

  return (
    <section style={{ marginBottom: 20 }}>
      <h3>Chain Selection</h3>
      <p>
        {activeChainCount} active / {dustChainCount} dust
      </p>
      <ul>
        {selectedChains.map((chain) => {
          const detail = usingV2
            ? (() => {
                const record = v2RecordByChainId.get(chain.chainId)
                return record ? `value $${record.valueHeldUsd.toFixed(2)}, primary use ${record.primaryUse}` : null
              })()
            : (() => {
                const entry = [...v1EntryByChain.values()].find((e) => CHAIN_STRING_TO_ID[e.chain] === chain.chainId)
                return entry ? `value $${entry.visible_value_usd.toFixed(2)}, swaps ${entry.swapCandidateEvents}` : null
              })()

          return (
            <li key={chain.chainId}>
              <strong>{chain.label}</strong> — {chain.activityLevel}
              {chain.txCount30d != null ? ` (txs ${chain.txCount30d})` : ''}
              {detail ? `, ${detail}` : ''}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export default ChainSelectionView
