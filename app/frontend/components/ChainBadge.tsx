// Shared chain badge — used by HoldingsViewV2, PnLTab, WalletProfileHeader. Purely presentational;
// the label mapping (including "HyperEVM · pending") lives in app/frontend/lib/holdingsHeuristics.
import { fmtChainLabel } from '@/app/frontend/lib/holdingsHeuristics'

export function ChainBadge({ chain }: { chain: string }) {
  return (
    <span
      style={{
        padding: '3px 10px', borderRadius: '999px', fontSize: '9px', fontWeight: 800,
        letterSpacing: '0.08em', textTransform: 'uppercase', whiteSpace: 'nowrap',
        background: 'rgba(139,92,246,0.10)', border: '1px solid rgba(139,92,246,0.30)', color: '#c4b5fd',
        fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
      }}
    >
      {fmtChainLabel(chain)}
    </span>
  )
}

export default ChainBadge
