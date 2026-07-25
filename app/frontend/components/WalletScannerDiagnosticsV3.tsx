'use client'

// WalletScannerDiagnosticsV3 — collapsible "Advanced Diagnostics" section for the Wallet Scanner V3
// layout: Wallet Personality, Wallet Condition, Recovery Health, Window Coverage, Scan Diagnostics,
// and module errors, all moved out of the always-visible main flow (Stage 5, "safe clutter
// reduction") without deleting any of the underlying components or the data they read.
//
// SAFE REUSE, DISCLOSED: every panel below is an EXISTING, already-tested component
// (FinalSummaryView/RecoveryHealthCard/CoverageTimelineCard/ScanDiagnosticsCard) rendered with its
// EXISTING props unchanged. The collapsed summary line uses selectDiagnosticsSummary() (see that
// file's own header) — real counts only, never a fabricated score.
import { useState } from 'react'
import type { WalletV2Report } from '@/app/terminal/wallet-scanner/page'
import { selectDiagnosticsSummary } from '@/app/frontend/lib/walletScannerDiagnosticsSelector'
import { FinalSummaryView } from './FinalSummaryView'
import { RecoveryHealthCard } from './RecoveryHealthCard'
import { CoverageTimelineCard } from './CoverageTimelineCard'
import { ScanDiagnosticsCard } from './ScanDiagnosticsCard'
import { BehaviorIntelView } from './BehaviorIntelView'

export type WalletScannerDiagnosticsV3Props = {
  report: WalletV2Report
  scanDurationMs: number | null
  moduleErrors: Record<string, string> | null
}

export function WalletScannerDiagnosticsV3({ report, scanDurationMs, moduleErrors }: WalletScannerDiagnosticsV3Props) {
  const [expanded, setExpanded] = useState(false)
  const summary = selectDiagnosticsSummary({
    walletConditionMessages: report.walletConditionMessages,
    recoveryPolicy: report.recoveryPolicy,
    windowCoverage: report.windowCoverage,
    moduleErrors,
  })

  return (
    <div className="ws-card" style={{ padding: 0, overflow: 'hidden' }}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px',
          padding: '14px 18px', background: 'transparent', border: 'none', cursor: 'pointer',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '13px', fontWeight: 800, color: '#e2e8f0', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>Advanced Diagnostics</span>
          <span style={{ fontSize: '11px', color: 'rgba(148,163,184,0.55)' }}>
            {summary.recoveryEvaluatedCount > 0 && `${summary.recoveryTriggeredCount}/${summary.recoveryEvaluatedCount} recovery evaluation(s) triggered`}
            {summary.windowCoverageBasis && ` · Coverage: ${summary.windowCoverageBasis.replace(/_/g, ' ')}`}
            {summary.walletConditionCount > 0 && ` · ${summary.walletConditionCount} condition note(s)`}
            {summary.moduleErrorCount > 0 && ` · ${summary.moduleErrorCount} module fallback(s)`}
          </span>
        </div>
        <span style={{ fontSize: '11px', color: 'rgba(148,163,184,0.45)' }}>{expanded ? '▾ Collapse' : '▸ Expand'}</span>
      </button>

      {expanded && (
        <div style={{ padding: '4px 18px 18px', display: 'flex', flexDirection: 'column', gap: '18px' }}>
          <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '16px' }}>
            <FinalSummaryView summary={report.finalSummary} sellTimeline={report.timelines?.sellTimelineV2} />
          </div>

          {report.walletConditionMessages && report.walletConditionMessages.length > 0 && (
            <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '16px' }}>
              <div style={{ fontSize: '12px', fontWeight: 800, color: '#e2e8f0', marginBottom: '10px' }}>Wallet Condition</div>
              <ul style={{ display: 'flex', flexDirection: 'column', gap: '8px', margin: 0, padding: 0, listStyle: 'none' }}>
                {report.walletConditionMessages.map((section) => (
                  <li key={section.id} style={{ fontSize: '0.9rem', lineHeight: 1.5, color: '#cbd5e1' }}>{section.text}</li>
                ))}
              </ul>
            </div>
          )}

          <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '16px' }}>
            <BehaviorIntelView data={report.behaviorIntel} />
          </div>

          <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '16px' }}>
            <RecoveryHealthCard data={report.recoveryPolicy} />
          </div>

          <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '16px' }}>
            <CoverageTimelineCard data={report.windowCoverage} />
          </div>

          <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '16px' }}>
            <ScanDiagnosticsCard scanDurationMs={scanDurationMs} providerDiagnostics={report.providerDiagnostics} />
          </div>

          {moduleErrors && Object.keys(moduleErrors).length > 0 && (
            <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '16px', color: '#facc15', fontSize: '12px' }}>
              Some modules did not complete in time and used fallback data:
              <ul style={{ margin: '6px 0 0', paddingLeft: '18px' }}>
                {Object.entries(moduleErrors).map(([moduleName, message]) => (
                  <li key={moduleName}>{moduleName}: {message}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default WalletScannerDiagnosticsV3
