// V2 SCANNER PREVIEW component — receives ONLY windowCoverage from the new engine's report.
//
// V2-SAFE GUARD: every field defensively falls back to a safe default rather than crashing if
// `data` is missing at runtime.
import type { WindowCoverage } from '@/src/modules/behaviorIntel/types'

export function WindowCoverageView({ data }: { data: WindowCoverage | null | undefined }) {
  const realDataDays = data?.realDataDays ?? 0
  const inferredDays = data?.inferredDays ?? 0
  const recoveredExtraDays = data?.recoveredExtraDays ?? 0
  const coverageBasis = data?.coverageBasis ?? 'partial_window'

  return (
    <section style={{ marginBottom: 20 }}>
      <h3>Window Coverage</h3>
      <p>
        {realDataDays} real days · {inferredDays} inferred days · {recoveredExtraDays} recovered days
      </p>
      <p>Basis: {coverageBasis}</p>
    </section>
  )
}

export default WindowCoverageView
