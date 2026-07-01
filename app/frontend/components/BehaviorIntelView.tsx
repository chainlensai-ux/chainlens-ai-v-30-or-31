// V2 SCANNER PREVIEW component — receives ONLY behaviorIntel from the new engine's report.
//
// V2-SAFE GUARD: every nested field (`multiChainParticipation.activeChains`,
// `automationSignals.signals`, etc.) defensively falls back to a safe default rather than crashing
// if `data` or any nested object is missing/malformed at runtime.
import type { BehaviorIntelResult } from '@/src/modules/behaviorIntel/types'

export function BehaviorIntelView({ data }: { data: BehaviorIntelResult | null | undefined }) {
  const rotationStyle = data?.rotationStyle?.value ?? 'unknown'
  const riskOnOff = data?.riskOnOff?.value ?? 'unknown'
  const confidence = data?.confidence ?? 'low'
  const activeChains = Array.isArray(data?.multiChainParticipation?.activeChains) ? data!.multiChainParticipation.activeChains : []
  const primaryChain = data?.multiChainParticipation?.primaryChain ?? null
  const concentrationSignals = data?.concentrationSignals ?? null
  const suspectedBot = data?.automationSignals?.suspectedBot ?? false
  const signals = Array.isArray(data?.automationSignals?.signals) ? data!.automationSignals.signals : []

  return (
    <section style={{ marginBottom: 20 }}>
      <h3>Behavior Intel</h3>
      <p>Rotation style: {rotationStyle}</p>
      <p>Risk posture: {riskOnOff}</p>
      <p>Confidence: {confidence}</p>
      <p>
        Chains: {activeChains.join(', ') || 'none'} (primary: {primaryChain ?? '—'})
      </p>
      {concentrationSignals ? (
        <p>
          Top holding: {concentrationSignals.topHoldingSymbol} ({concentrationSignals.topHoldingPercent.toFixed(1)}%, {concentrationSignals.concentrationLabel})
        </p>
      ) : (
        <p>Concentration: not available (no holdings data)</p>
      )}
      <p>
        Automation: {suspectedBot ? 'suspected bot' : 'no automation signal'} — {signals.join(', ')}
      </p>
    </section>
  )
}

export default BehaviorIntelView
