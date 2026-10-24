// Card-style presentation of one real TokenHolding. Replaces the previous row layout.
// Layout: left = symbol + chain badge, center = amount, right = USD value, bottom = acquisition
// badges (only rendered when real evidence produced at least one — see
// app/frontend/lib/holdingsHeuristics.deriveAcquisitionInfo).
import { motion } from 'framer-motion'
import type { TokenHolding } from '@/src/modules/holdings/types'
import { fmtAmount, fmtDate, fmtUsd, daysHeld, type AcquisitionInfo } from '@/app/frontend/lib/holdingsHeuristics'
import { ChainBadge } from './ChainBadge'

export type TokenCardProps = {
  holding: TokenHolding
  acquisition: AcquisitionInfo
  index: number
}

const cardVariants = {
  hidden: { opacity: 0, y: 10 },
  visible: (index: number) => ({ opacity: 1, y: 0, transition: { duration: 0.24, delay: Math.min(index, 20) * 0.035 } }),
}

export function TokenCard({ holding, acquisition, index }: TokenCardProps) {
  return (
    <motion.div
      custom={index}
      variants={cardVariants}
      initial="hidden"
      animate="visible"
      whileHover={{ y: -2, borderColor: 'rgba(31,214,220,0.28)' }}
      style={{
        borderRadius: '14px', padding: '14px 16px',
        background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)',
        transition: 'border-color 0.15s',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: '140px' }}>
          <div>
            <div style={{ fontSize: '14px', fontWeight: 800, color: '#e4e7ea' }}>{holding.symbol || '—'}</div>
            <div style={{ fontSize: '10px', color: 'rgba(158,161,164,0.55)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
              {holding.name ?? `${holding.contract.slice(0, 6)}…${holding.contract.slice(-4)}`}
            </div>
          </div>
          <ChainBadge chain={holding.chain} />
        </div>

        <div style={{ fontSize: '13px', color: '#d1d4d7', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', textAlign: 'center', minWidth: '90px' }}>
          {fmtAmount(holding.amount)}
        </div>

        <div style={{ fontSize: '14px', fontWeight: 800, textAlign: 'right', minWidth: '90px', color: holding.providerValueUsd == null ? 'rgba(158,161,164,0.45)' : '#e4e7ea' }}>
          {fmtUsd(holding.providerValueUsd)}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginTop: '10px', flexWrap: 'wrap' }}>
        {acquisition.badges.length > 0 ? (
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {acquisition.badges.map((b) => (
              <span
                key={b}
                style={{
                  padding: '2px 9px', borderRadius: '999px', fontSize: '9px', fontWeight: 700,
                  letterSpacing: '0.06em', textTransform: 'uppercase',
                  background: 'rgba(169,233,236,0.10)', border: '1px solid rgba(169,233,236,0.30)', color: '#a9e9ec',
                  fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', whiteSpace: 'nowrap',
                }}
              >
                {b}
              </span>
            ))}
          </div>
        ) : <span />}

        <span style={{ fontSize: '10px', color: 'rgba(158,161,164,0.50)' }}>
          First seen: {fmtDate(acquisition.firstSeenMs)} · {daysHeld(acquisition.firstSeenMs)}
        </span>
      </div>
    </motion.div>
  )
}

export default TokenCard
