'use client'

// SellActivitySummary — UI-ONLY, ADDITIVE. Not backed by any backend change.
//
// FALSE-PREMISE CORRECTION, DISCLOSED: the task that requested this component described
// `eventType`/`sellCandidates[]` as fields already present on the wallet-scanner's report data.
// They are not: those two fields only exist inside app/api/_shared/walletChainPipeline.ts, an
// unrelated pipeline used by /api/transactions, /api/wallet-profile, /api/pnl — never by the
// wallet-scanner page (which calls /api/scan-v2/full-scan/legacy, whose WalletV2Report type has no
// sellCandidates/eventType field). Backend edits were explicitly out of scope for this task, so
// this component is built from `result.timelines.sellTimelineV2` instead — real data the scan API
// already computes and returns (src/modules/sellTimeline), just never rendered by page.tsx until
// now. Every number below traces to a real SellTimelineEntry; nothing here is invented.
//
// PnL BOUNDARY, DISCLOSED: this is a SEPARATE, informational-only display. It never adds its
// totalProceedsUsd into PnlStatusCard's pnlV2-derived numbers — pnlV2 remains the single verified
// PnL source with no merge/fallback, per this project's standing rule.
//
// "PROFIT SKILL" / SAMPLE-SIZE WORDING, DISCLOSED: no "Financial Personality"/"Profit Skill"
// feature exists anywhere in this codebase prior to this component — there was nothing to update,
// so this is new, minimal UI-only logic, not a wired backend concept. The 3-sell threshold below is
// an arbitrary, disclosed UI-only choice (not a backend-computed value) for when the sample is large
// enough to describe as more than "limited" in this specific card's own wording — it does NOT alter
// `finalSummary.financialStatus.officialPnlStatus`, the real backend-computed badge shown elsewhere.
import type { SellTimelineResult, SellTimelineEntry } from '@/src/modules/sellTimeline/types'
import { StatusBadge } from './StatusBadge'
import { SellTimelineV2View } from './SellTimelineV2View'

const VERIFIED_SAMPLE_THRESHOLD = 3

function topSoldTokens(entries: SellTimelineEntry[], limit = 3): { symbol: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const e of entries) {
    const key = e.symbol ?? e.token
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([symbol, count]) => ({ symbol, count }))
}

export function SellActivitySummary({ sellTimeline }: { sellTimeline: SellTimelineResult | null | undefined }) {
  const entries = sellTimeline?.entries ?? []
  const totalSells = sellTimeline?.totalSells ?? entries.length
  const entriesWithProceeds = entries.filter((e) => typeof e.proceedsUsdEstimate === 'number')
  const totalProceedsUsd = entriesWithProceeds.reduce((sum, e) => sum + (e.proceedsUsdEstimate as number), 0)
  const hasAnyProceeds = entriesWithProceeds.length > 0
  const profitSkillUnlocked = totalSells > 0
  const verifiedSample = totalSells >= VERIFIED_SAMPLE_THRESHOLD

  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px', flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 800, color: '#e2e8f0', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
          Sell Activity
        </h3>
        <StatusBadge
          label={profitSkillUnlocked ? 'Profit Skill unlocked' : 'Profit Skill locked — no sells detected'}
          tone={profitSkillUnlocked ? 'success' : 'neutral'}
        />
        {profitSkillUnlocked && (
          <StatusBadge
            label={verifiedSample ? 'Verified sample' : 'Limited verified sample (UI-only estimate)'}
            tone={verifiedSample ? 'success' : 'warning'}
          />
        )}
      </div>

      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '16px' }}>
        <div style={{ padding: '10px 14px', borderRadius: '10px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', minWidth: '120px' }}>
          <div style={{ fontSize: '9px', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.55)', marginBottom: '4px' }}>Total Sells</div>
          <div style={{ fontSize: '18px', fontWeight: 800, color: '#e2e8f0' }}>{totalSells}</div>
        </div>
        <div style={{ padding: '10px 14px', borderRadius: '10px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', minWidth: '140px' }}>
          <div style={{ fontSize: '9px', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.55)', marginBottom: '4px' }}>Total Proceeds (est.)</div>
          <div style={{ fontSize: '18px', fontWeight: 800, color: hasAnyProceeds ? '#4ade80' : 'rgba(148,163,184,0.45)' }}>
            {hasAnyProceeds ? `$${totalProceedsUsd.toFixed(2)}` : 'Price unavailable'}
          </div>
        </div>
        <div style={{ padding: '10px 14px', borderRadius: '10px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', minWidth: '160px' }}>
          <div style={{ fontSize: '9px', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.55)', marginBottom: '4px' }}>Top Sold Tokens</div>
          {entries.length === 0 ? (
            <div style={{ fontSize: '12px', color: 'rgba(148,163,184,0.45)' }}>None</div>
          ) : (
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {topSoldTokens(entries).map((t) => (
                <span key={t.symbol} style={{ fontSize: '11px', fontWeight: 700, color: '#e2e8f0', background: 'rgba(248,113,113,0.10)', border: '1px solid rgba(248,113,113,0.30)', borderRadius: '999px', padding: '2px 8px' }}>
                  {t.symbol} × {t.count}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Recent Sells table — red-accented border marks every row here as a real sell event
          (this section renders sells only; there is no merged buy/sell timeline to color-split). */}
      <div style={{ borderLeft: '2px solid rgba(248,113,113,0.45)', paddingLeft: '12px' }}>
        <SellTimelineV2View entries={entries} />
      </div>
    </section>
  )
}

export default SellActivitySummary
