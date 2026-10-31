import React from 'react'

export default function TokenRiskEvidenceNotice({ coverage, confidence }: { coverage?: number | null; confidence?: string | null }) {
  const percent = typeof coverage === 'number' && Number.isFinite(coverage) && coverage >= 0 && coverage <= 100 ? coverage : null
  const limited = percent == null || percent < 100 || confidence !== 'high'
  return (
    <div role="note" style={{ margin: '10px 0', padding: '10px 12px', border: '1px solid #fbbf2466', borderRadius: 8, color: '#fde68a', background: '#fbbf2412', fontSize: 12, lineHeight: 1.6 }}>
      <strong>{limited ? 'LIMITED EVIDENCE' : 'EVIDENCE COVERAGE'} · {percent == null ? 'Coverage unavailable' : `${percent}% coverage`} · {confidence === 'high' || confidence === 'medium' ? confidence : 'low'} confidence</strong>
      <div>A low score, including 0, is not a guarantee of safety. Review unverified LP, simulation and developer checks before relying on this assessment.</div>
    </div>
  )
}
