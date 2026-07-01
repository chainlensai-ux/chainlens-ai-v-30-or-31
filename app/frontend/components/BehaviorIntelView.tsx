// V2 SCANNER PREVIEW component — receives ONLY behaviorIntel from the new engine's report.
import type { BehaviorIntelResult } from '@/src/modules/behaviorIntel/types'

export function BehaviorIntelView({ data }: { data: BehaviorIntelResult }) {
  return (
    <section style={{ marginBottom: 20 }}>
      <h3>Behavior Intel</h3>
      <p>Rotation style: {data.rotationStyle.value}</p>
      <p>Risk posture: {data.riskOnOff.value}</p>
      <p>Confidence: {data.confidence}</p>
      <p>
        Chains: {data.multiChainParticipation.activeChains.join(', ') || 'none'} (primary: {data.multiChainParticipation.primaryChain ?? '—'})
      </p>
      {data.concentrationSignals ? (
        <p>
          Top holding: {data.concentrationSignals.topHoldingSymbol} ({data.concentrationSignals.topHoldingPercent.toFixed(1)}%, {data.concentrationSignals.concentrationLabel})
        </p>
      ) : (
        <p>Concentration: not available (no holdings data)</p>
      )}
      <p>
        Automation: {data.automationSignals.suspectedBot ? 'suspected bot' : 'no automation signal'} — {data.automationSignals.signals.join(', ')}
      </p>
    </section>
  )
}

export default BehaviorIntelView
