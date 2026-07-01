// V2 SCANNER PREVIEW component — receives ONLY windowCoverage from the new engine's report.
import type { WindowCoverage } from '@/src/modules/behaviorIntel/types'

export function WindowCoverageView({ data }: { data: WindowCoverage }) {
  return (
    <section style={{ marginBottom: 20 }}>
      <h3>Window Coverage</h3>
      <p>
        {data.realDataDays} real days · {data.inferredDays} inferred days · {data.recoveredExtraDays} recovered days
      </p>
      <p>Basis: {data.coverageBasis}</p>
    </section>
  )
}

export default WindowCoverageView
