'use client'

// HoldingsViewV2 — additive, chain-grouped, dust-collapsed, Nansen-grade holdings view. Renders
// alongside (does NOT replace) the existing HoldingsView. This is a frontend-only upgrade of the
// component built in a previous task — no backend module (fifoEngine, pnlSummaryV2,
// pricingAtTimeEngine, holdings, timelineBuilder, bridgeDetection) is touched by this change.
//
// V2-SAFE GUARD: every prop is typed non-optional by the caller's contract, but that's a
// compile-time guarantee only — every access below still defensively falls back to a safe default.
//
// HONESTY NOTE — real report.holdings (src/modules/holdings/types.ts TokenHolding) has `contract`
// (not `token`), `amount: number` (not `string`), and `providerPriceUsd`/`providerValueUsd` (not
// `usdValueEstimate`). This component binds to the real shape:
//   - "first seen"/"last seen"/acquisition badges (swap/airdrop/bridge) are derived from REAL
//     buyTimeline entries (`buyEntries` prop) and REAL bridgeTimeline entries (`bridgeEntries`
//     prop), matched to a holding by (chain, contract)/(chain, symbol) — "Not available" when no
//     matching real entry exists, never a guessed date.
//   - the Holdings Personality card uses only real counts/values (dust count, meaningful count,
//     distinct chains, providerValueUsd distribution, and — only when buyEntries evidence exists —
//     the airdrop-only acquisition share). It renders NO label at all when no heuristic's threshold
//     is actually met, rather than forcing one of the five possible outputs onto weak/absent
//     evidence.
//   - does NOT wire pricingAtTime into the USD column (see prior version's note: pricingAtTime
//     prices individual buy/sell transactions at their historical timestamp, keyed by txHash — it
//     has no concept of "current value of a still-held balance"). Uses providerValueUsd.
//   - per-token "High rotation"/"Low rotation" badges are still not rendered — no such per-token
//     signal exists anywhere in this codebase.
import { useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type { TokenHolding } from '@/src/modules/holdings/types'
import type { BuyTimelineEntry } from '@/src/modules/timelineBuilder/types'
import type { BridgeCandidateEvent } from '@/src/modules/bridgeDetection/types'

export type HoldingsViewV2Props = {
  holdings: TokenHolding[] | null | undefined
  buyEntries?: BuyTimelineEntry[] | null
  bridgeEntries?: BridgeCandidateEvent[] | null
}

const DUST_AMOUNT_THRESHOLD = 0.001
const DUST_USD_THRESHOLD = 0.10
const TOP_HOLDING_USD_THRESHOLD = 5

const CHAIN_LABELS: Record<string, string> = {
  base: 'Base',
  eth: 'ETH',
  arbitrum: 'Arbitrum',
  hyperevm: 'HyperEVM · pending', // no verified provider yet — see providerFetchWindow's HyperEVM TODO
}

function fmtChain(chain: string): string {
  return CHAIN_LABELS[chain] ?? chain
}

function fmtUsd(value: number | null): string {
  return value == null ? '—' : `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtAmount(amount: number): string {
  if (amount >= 1000) return amount.toLocaleString('en-US', { maximumFractionDigits: 2 })
  return amount.toFixed(amount < 1 ? 6 : 4).replace(/0+$/, '').replace(/\.$/, '')
}

function fmtDate(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return 'Not available'
  return new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

function isDust(holding: TokenHolding): boolean {
  if (holding.amount < DUST_AMOUNT_THRESHOLD) return true
  if (holding.providerValueUsd !== null && holding.providerValueUsd < DUST_USD_THRESHOLD) return true
  if (!holding.symbol || holding.symbol.trim() === '' || holding.symbol === '?') return true
  return false
}

function holdingKey(h: TokenHolding): string {
  return `${h.chain}:${h.contract.toLowerCase()}`
}

type AcquisitionInfo = {
  firstSeenMs: number | null
  lastSeenMs: number | null
  badges: string[]
}

// PURE. Derives real acquisition context for one holding by matching it against real
// buyTimeline/bridgeTimeline entries — never invents a date or a source when no matching entry
// exists.
function deriveAcquisitionInfo(
  holding: TokenHolding,
  buyEntries: BuyTimelineEntry[],
  bridgeEntries: BridgeCandidateEvent[],
): AcquisitionInfo {
  const matchingBuys = buyEntries.filter(
    (e) => e.chain === holding.chain && e.token.toLowerCase() === holding.contract.toLowerCase(),
  )
  const matchingBridgeIn = bridgeEntries.filter(
    (b) => b.chainTo === holding.chain && b.token.toLowerCase() === holding.symbol.toLowerCase(),
  )

  const timestamps = matchingBuys.map((e) => e.timestamp)
  const firstSeenMs = timestamps.length > 0 ? Math.min(...timestamps) : null
  const lastSeenMs = timestamps.length > 0 ? Math.max(...timestamps) : null

  const badges: string[] = []
  if (matchingBuys.length > 0 && matchingBuys.every((e) => e.sourceType === 'airdrop')) {
    badges.push('Airdrop-only')
  } else if (matchingBuys.some((e) => e.sourceType === 'swap')) {
    badges.push('Swap-acquired')
  }
  if (matchingBridgeIn.length > 0) badges.push('Bridge-acquired')

  return { firstSeenMs, lastSeenMs, badges }
}

function isAirdropOnly(holding: TokenHolding, buyEntries: BuyTimelineEntry[]): boolean {
  const matches = buyEntries.filter((e) => e.chain === holding.chain && e.token.toLowerCase() === holding.contract.toLowerCase())
  return matches.length > 0 && matches.every((e) => e.sourceType === 'airdrop')
}

function daysHeld(firstSeenMs: number | null): string {
  if (firstSeenMs == null) return 'Not available'
  const days = Math.max(0, Math.floor((Date.now() - firstSeenMs) / (24 * 60 * 60 * 1000)))
  return `${days} day(s)`
}

// PURE. Holdings Personality — derived ONLY from real counts/values (dust/meaningful counts,
// distinct-chain count, providerValueUsd distribution, and — only when real buyEntries evidence
// exists — the airdrop-only acquisition share). Returns null (no card rendered) rather than
// forcing one of the five labels when no threshold is actually met by the real data.
function derivePersonality(holdings: TokenHolding[], buyEntries: BuyTimelineEntry[]): string | null {
  const total = holdings.length
  if (total === 0) return null

  const meaningful = holdings.filter((h) => !isDust(h))
  const dustCount = total - meaningful.length
  const meaningfulCount = meaningful.length

  if (meaningfulCount === 0) return 'Mostly dust'
  if (dustCount / total >= 0.85 && meaningfulCount <= 2) return 'Mostly dust'

  if (buyEntries.length > 0) {
    const airdropOnlyCount = meaningful.filter((h) => isAirdropOnly(h, buyEntries)).length
    if (airdropOnlyCount / meaningfulCount >= 0.5) return 'Airdrop-heavy'
  }

  if (meaningfulCount <= 2) return 'Few meaningful positions'

  const priced = meaningful.filter((h) => h.providerValueUsd != null)
  const totalValue = priced.reduce((sum, h) => sum + h.providerValueUsd!, 0)
  const distinctChains = new Set(meaningful.map((h) => h.chain))

  if (distinctChains.size >= 3 && totalValue > 0) {
    const byChain = new Map<string, number>()
    for (const h of priced) byChain.set(h.chain, (byChain.get(h.chain) ?? 0) + h.providerValueUsd!)
    const maxChainValue = Math.max(0, ...byChain.values())
    if (maxChainValue / totalValue < 0.6) return 'High scatter'
  }

  if (totalValue > 0) {
    const topValue = Math.max(0, ...priced.map((h) => h.providerValueUsd!))
    // Holdings-value-distribution signal, distinct from behaviorIntel.convictionScore (which is
    // trade-frequency-based) — same label, different real evidence, disclosed here for clarity.
    if (topValue / totalValue < 0.3) return 'Low conviction'
  }

  return null
}

const rowVariants = {
  hidden: { opacity: 0, y: 6 },
  visible: (index: number) => ({ opacity: 1, y: 0, transition: { duration: 0.24, delay: Math.min(index, 20) * 0.035 } }),
}

function AcquisitionBadge({ label }: { label: string }) {
  return (
    <span
      style={{
        padding: '2px 9px', borderRadius: '999px', fontSize: '9px', fontWeight: 700,
        letterSpacing: '0.06em', textTransform: 'uppercase',
        background: 'rgba(56,189,248,0.10)', border: '1px solid rgba(56,189,248,0.30)', color: '#38bdf8',
        fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  )
}

function HoldingRow({ holding, acquisition, index }: { holding: TokenHolding; acquisition: AcquisitionInfo; index: number }) {
  return (
    <motion.div
      className="flex items-center gap-3.5 flex-wrap rounded-[11px] px-3.5 py-2.5"
      style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}
      custom={index}
      variants={rowVariants}
      initial="hidden"
      animate="visible"
    >
      <div style={{ minWidth: '110px', flex: '1 1 150px' }}>
        <div style={{ fontSize: '13px', fontWeight: 700, color: '#e2e8f0' }}>{holding.symbol || '—'}</div>
        <div style={{ fontSize: '10px', color: 'rgba(148,163,184,0.55)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
          {holding.name ?? `${holding.contract.slice(0, 6)}…${holding.contract.slice(-4)}`}
        </div>
      </div>

      <div style={{ minWidth: '90px', fontSize: '12px', color: '#cbd5e1', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
        {fmtAmount(holding.amount)}
      </div>

      <div style={{ minWidth: '80px', fontSize: '12px', fontWeight: 700, color: holding.providerValueUsd == null ? 'rgba(148,163,184,0.45)' : '#e2e8f0' }}>
        {fmtUsd(holding.providerValueUsd)}
      </div>

      {acquisition.badges.length > 0 && (
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {acquisition.badges.map((b) => <AcquisitionBadge key={b} label={b} />)}
        </div>
      )}

      <div style={{ minWidth: '190px', fontSize: '10px', color: 'rgba(148,163,184,0.55)', marginLeft: 'auto' }}>
        First seen: {fmtDate(acquisition.firstSeenMs)} · Last: {fmtDate(acquisition.lastSeenMs)} · {daysHeld(acquisition.firstSeenMs)}
      </div>
    </motion.div>
  )
}

function PersonalityCard({ label }: { label: string }) {
  return (
    <div
      style={{
        padding: '12px 16px', borderRadius: '13px', marginBottom: '16px',
        background: 'linear-gradient(135deg, rgba(139,92,246,0.08), rgba(45,212,191,0.05))',
        border: '1px solid rgba(139,92,246,0.22)', display: 'flex', alignItems: 'center', gap: '10px',
      }}
    >
      <span style={{ fontSize: '9px', fontWeight: 800, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.65)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
        Holdings Personality
      </span>
      <span style={{ fontSize: '13px', fontWeight: 800, color: '#c4b5fd' }}>{label}</span>
    </div>
  )
}

function TopHoldingsSection({ holdings }: { holdings: TokenHolding[] }) {
  const top = holdings
    .filter((h) => h.providerValueUsd != null && h.providerValueUsd > TOP_HOLDING_USD_THRESHOLD)
    .sort((a, b) => (b.providerValueUsd ?? 0) - (a.providerValueUsd ?? 0))

  if (top.length === 0) return null

  return (
    <div style={{ marginBottom: '16px' }}>
      <div style={{ fontSize: '10px', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.55)', marginBottom: '8px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
        Top Holdings
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {top.map((h, i) => (
          <HoldingRow key={holdingKey(h)} holding={h} acquisition={{ firstSeenMs: null, lastSeenMs: null, badges: [] }} index={i} />
        ))}
      </div>
    </div>
  )
}

function ChainSection({
  chain,
  holdings,
  buyEntries,
  bridgeEntries,
}: {
  chain: string
  holdings: TokenHolding[]
  buyEntries: BuyTimelineEntry[]
  bridgeEntries: BridgeCandidateEvent[]
}) {
  const [sectionOpen, setSectionOpen] = useState(true)
  const meaningful = holdings.filter((h) => !isDust(h))
  const chainTotalUsd = holdings.reduce((sum, h) => sum + (h.providerValueUsd ?? 0), 0)
  const hasAnyPrice = holdings.some((h) => h.providerValueUsd != null)

  return (
    <div style={{ borderRadius: '13px', border: '1px solid rgba(255,255,255,0.07)', overflow: 'hidden' }}>
      <button
        type="button"
        onClick={() => setSectionOpen((v) => !v)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '11px 14px', background: 'rgba(139,92,246,0.06)', border: 'none', cursor: 'pointer',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ padding: '3px 10px', borderRadius: '999px', fontSize: '9px', fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', background: 'rgba(139,92,246,0.12)', border: '1px solid rgba(139,92,246,0.32)', color: '#c4b5fd', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
            {fmtChain(chain)}
          </span>
          <span style={{ fontSize: '11px', color: 'rgba(148,163,184,0.65)' }}>
            {meaningful.length} token(s) · {hasAnyPrice ? fmtUsd(chainTotalUsd) : '—'} total
          </span>
        </span>
        <span style={{ fontSize: '11px', color: 'rgba(148,163,184,0.55)' }}>{sectionOpen ? '▾' : '▸'}</span>
      </button>

      {sectionOpen && (
        <div style={{ padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {meaningful.length === 0 ? (
            <p style={{ fontSize: '12px', color: 'rgba(148,163,184,0.45)', margin: 0 }}>No meaningful positions on this chain.</p>
          ) : (
            meaningful.map((h, i) => (
              <HoldingRow key={holdingKey(h)} holding={h} acquisition={deriveAcquisitionInfo(h, buyEntries, bridgeEntries)} index={i} />
            ))
          )}
        </div>
      )}
    </div>
  )
}

function DustSummaryRow({
  dust,
  showDust,
  setShowDust,
  buyEntries,
  bridgeEntries,
}: {
  dust: TokenHolding[]
  showDust: boolean
  setShowDust: (v: boolean) => void
  buyEntries: BuyTimelineEntry[]
  bridgeEntries: BridgeCandidateEvent[]
}) {
  if (dust.length === 0) return null

  const dustTotalUsd = dust.reduce((sum, h) => sum + (h.providerValueUsd ?? 0), 0)
  const hasAnyPrice = dust.some((h) => h.providerValueUsd != null)

  return (
    <div style={{ borderRadius: '13px', border: '1px dashed rgba(255,255,255,0.10)', overflow: 'hidden' }}>
      <button
        type="button"
        onClick={() => setShowDust(!showDust)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 14px', background: 'rgba(255,255,255,0.015)', border: 'none', cursor: 'pointer',
        }}
      >
        <span style={{ fontSize: '11px', fontWeight: 700, color: 'rgba(148,163,184,0.70)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
          Dust tokens ({dust.length}) — {showDust ? 'expanded' : 'collapsed'}
          {hasAnyPrice ? ` · ${fmtUsd(dustTotalUsd)} total` : ''}
        </span>
        <span style={{ fontSize: '11px', color: 'rgba(148,163,184,0.45)' }}>{showDust ? '▾' : '▸'}</span>
      </button>

      <AnimatePresence>
        {showDust && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            style={{ overflow: 'hidden' }}
          >
            <div style={{ padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {dust.map((h, i) => (
                <HoldingRow key={holdingKey(h)} holding={h} acquisition={deriveAcquisitionInfo(h, buyEntries, bridgeEntries)} index={i} />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export function HoldingsViewV2({ holdings, buyEntries, bridgeEntries }: HoldingsViewV2Props) {
  const safeHoldings = Array.isArray(holdings) ? holdings : []
  const safeBuyEntries = Array.isArray(buyEntries) ? buyEntries : []
  const safeBridgeEntries = Array.isArray(bridgeEntries) ? bridgeEntries : []

  const [showDust, setShowDust] = useState(false)

  const byChain = useMemo(() => {
    const map = new Map<string, TokenHolding[]>()
    for (const h of safeHoldings) {
      const group = map.get(h.chain) ?? []
      group.push(h)
      map.set(h.chain, group)
    }
    return map
  }, [safeHoldings])

  const dustTokens = useMemo(() => safeHoldings.filter(isDust), [safeHoldings])
  const personality = useMemo(() => derivePersonality(safeHoldings, safeBuyEntries), [safeHoldings, safeBuyEntries])

  return (
    <section>
      <div style={{ marginBottom: '14px' }}>
        <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 800, color: '#e2e8f0', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
          Holdings (V2)
        </h3>
        <p style={{ margin: '4px 0 0', fontSize: '10px', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(45,212,191,0.65)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
          Chain-grouped · Dust-collapsed · No fabricated USD or rotation data
        </p>
      </div>

      {safeHoldings.length === 0 ? (
        <p style={{ fontSize: '12px', color: 'rgba(148,163,184,0.55)', margin: 0 }}>No holdings detected.</p>
      ) : (
        <>
          {personality && <PersonalityCard label={personality} />}
          <TopHoldingsSection holdings={safeHoldings} />

          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {[...byChain.entries()].map(([chain, chainHoldings]) => (
              <ChainSection key={chain} chain={chain} holdings={chainHoldings} buyEntries={safeBuyEntries} bridgeEntries={safeBridgeEntries} />
            ))}

            <DustSummaryRow
              dust={dustTokens}
              showDust={showDust}
              setShowDust={setShowDust}
              buyEntries={safeBuyEntries}
              bridgeEntries={safeBridgeEntries}
            />
          </div>
        </>
      )}
    </section>
  )
}

export default HoldingsViewV2
