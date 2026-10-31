import React from 'react'

export default function TokenRiskEvidenceNotice({ coverage, confidence, methodology, missingChecks = [] }: { coverage?: number | null; confidence?: string | null; methodology?: string | null; missingChecks?: string[] }) {
  const percent = typeof coverage === 'number' && Number.isFinite(coverage) && coverage >= 0 && coverage <= 100 ? coverage : null
  const limited = percent == null || percent < 100 || confidence !== 'high'
  return (
    <div style={{ marginTop: 10, fontSize: 12, lineHeight: 1.6 }}>
      {limited && <p role="note" style={{ color: '#fbbf24', margin: '4px 0' }}>{confidence === 'medium' ? 'Medium' : 'Low'} confidence · Limited evidence — unverified checks remain. A low score is not a safety clearance.</p>}
      <details>
        <summary style={{ cursor: 'pointer', color: '#aeb4bf' }}>Evidence &amp; Confidence</summary>
        <div style={{ color: '#aeb4bf', paddingTop: 8 }}>
          <strong>{limited ? 'LIMITED EVIDENCE' : 'EVIDENCE COVERAGE'} · {percent == null ? 'Coverage unavailable' : `${percent}% coverage`} · {confidence === 'high' || confidence === 'medium' ? confidence : 'low'} confidence</strong>
          <div>Methodology: {methodology ?? 'Not recorded'}</div>
          {missingChecks.length > 0 && <ul aria-label="Unverified checks">{missingChecks.map(check => <li key={check}>{check}</li>)}</ul>}
          <div>A low score, including 0, is not a guarantee of safety. Review unverified LP, simulation and developer checks before relying on this assessment.</div>
        </div>
      </details>
    </div>
  )
}
