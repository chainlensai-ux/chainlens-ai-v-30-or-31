'use client'

// ScanDiagnosticsCard — UI-ONLY, ADDITIVE. Informational only; no engine/retry-logic change.
//
// FALSE-PREMISE CORRECTION, DISCLOSED: the task that requested this component described real
// `totalMs`/`stagesMs`/`slowProviderDetected`/`jitterDetected`/`heavyWallet` fields as already
// returned by the scan API. None exist anywhere in WalletV2Report/FinalReport (verified by search
// of src/modules/finalReportAssembler/types.ts) — there is no per-stage timing breakdown
// (providerFetchWindow/dustSuppression/priceLotsForWallet/pricingAtTime) anywhere in this codebase.
// Rather than invent those numbers, this card uses two REAL signals instead:
//   1. `scanDurationMs` — the wallet-scanner page's own measured wall-clock time around the
//      scanWalletV2() call (a real Date.now() delta — see page.tsx). No per-stage breakdown is
//      possible from this alone, so none is shown (never fabricated).
//   2. `providerDiagnostics` — real, already-returned per-chain provider call results
//      (ok/errorReason/eventCount for GoldRush and Alchemy independently,
//      src/modules/finalReportAssembler/types.ts's ProviderDiagnosticsEntry). A "Degraded pricing"
//      note is shown only when a real diagnostics entry reports `ok: false` — never a synthetic
//      slowProviderDetected/jitterDetected flag that doesn't exist in the data.
import type { ProviderDiagnosticsEntry } from '@/src/modules/finalReportAssembler/types'
import { StatusBadge } from './StatusBadge'

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

export function ScanDiagnosticsCard({
  scanDurationMs,
  providerDiagnostics,
}: {
  scanDurationMs: number | null | undefined
  providerDiagnostics: ProviderDiagnosticsEntry[] | null | undefined
}) {
  const diagnostics = providerDiagnostics ?? []
  const failedEntries = diagnostics.filter((d) => !d.goldrush.ok || !d.alchemy.ok)
  const degraded = failedEntries.length > 0

  if (scanDurationMs == null && diagnostics.length === 0) return null

  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px', flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 800, color: '#e2e8f0', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
          Scan Diagnostics
        </h3>
        {degraded && <StatusBadge label="Degraded pricing" tone="warning" glow />}
      </div>

      {scanDurationMs != null && (
        <p style={{ margin: '0 0 8px', fontSize: '13px', color: '#e2e8f0' }}>
          Total scan time: <strong>{fmtMs(scanDurationMs)}</strong>
          <span style={{ fontSize: '11px', color: 'rgba(148,163,184,0.5)', marginLeft: '8px' }}>
            (measured client-side — no per-stage breakdown is available from the scan API)
          </span>
        </p>
      )}

      {degraded && (
        <p style={{ fontSize: '12px', color: '#fbbf24', margin: '0 0 8px' }}>
          Pricing engines were slow or partially timed out; some prices may be missing or unreliable.
        </p>
      )}

      {diagnostics.length > 0 && (
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {diagnostics.map((d) => (
            <span
              key={d.chain}
              style={{
                fontSize: '11px', padding: '4px 10px', borderRadius: '999px',
                background: d.goldrush.ok && d.alchemy.ok ? 'rgba(74,222,128,0.08)' : 'rgba(248,113,113,0.10)',
                border: `1px solid ${d.goldrush.ok && d.alchemy.ok ? 'rgba(74,222,128,0.30)' : 'rgba(248,113,113,0.30)'}`,
                color: d.goldrush.ok && d.alchemy.ok ? '#4ade80' : '#f87171',
              }}
            >
              {d.chain}: goldrush {d.goldrush.ok ? 'ok' : (d.goldrush.errorReason ?? 'failed')}, alchemy {d.alchemy.ok ? 'ok' : (d.alchemy.errorReason ?? 'failed')}
            </span>
          ))}
        </div>
      )}
    </section>
  )
}

export default ScanDiagnosticsCard
