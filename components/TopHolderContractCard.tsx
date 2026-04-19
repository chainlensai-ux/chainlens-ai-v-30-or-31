'use client'

// ─── Types ────────────────────────────────────────────────────────────────────

interface HolderScan {
  is_proxy: boolean
  is_upgradeable: boolean
  is_router: boolean
  is_locker: boolean
  is_lp_manager: boolean
  has_withdraw: boolean
  has_sweep: boolean
  has_mint: boolean
  has_burn: boolean
  has_rescue: boolean
  has_external_calls: boolean
}

interface Props {
  topHolderAddress?: string
  topHolderPercent?: number
  holderScan?: HolderScan | null
  isLoading?: boolean
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function shorten(addr: string): string {
  if (addr.length < 12) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

// ─── Badge variants ───────────────────────────────────────────────────────────

type BadgeVariant = 'safe' | 'warn' | 'danger' | 'neutral' | 'info'

const VARIANT_STYLES: Record<BadgeVariant, React.CSSProperties> = {
  safe:    { color: '#34d399', background: 'rgba(52,211,153,0.08)',  border: '1px solid rgba(52,211,153,0.22)'  },
  warn:    { color: '#fbbf24', background: 'rgba(251,191,36,0.08)',  border: '1px solid rgba(251,191,36,0.22)'  },
  danger:  { color: '#f87171', background: 'rgba(248,113,113,0.10)', border: '1px solid rgba(248,113,113,0.28)' },
  neutral: { color: '#64748b', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' },
  info:    { color: '#2DD4BF', background: 'rgba(45,212,191,0.08)',  border: '1px solid rgba(45,212,191,0.22)'  },
}

function Badge({ label, variant }: { label: string; variant: BadgeVariant }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: '5px',
      padding: '3px 10px', borderRadius: '999px',
      fontSize: '9px', fontWeight: 700, letterSpacing: '0.12em',
      textTransform: 'uppercase',
      fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
      ...VARIANT_STYLES[variant],
    }}>
      <span style={{
        width: 5, height: 5, borderRadius: '50%',
        background: VARIANT_STYLES[variant].color as string,
        boxShadow: `0 0 5px ${VARIANT_STYLES[variant].color as string}`,
        flexShrink: 0,
      }} />
      {label}
    </span>
  )
}

// ─── Row ─────────────────────────────────────────────────────────────────────

function Row({ label, value, variant }: { label: string; value: string; variant: BadgeVariant }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.04)',
    }}>
      <span style={{
        fontSize: '11px', color: 'rgba(255,255,255,0.38)',
        fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
      }}>
        {label}
      </span>
      <Badge label={value} variant={variant} />
    </div>
  )
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function SkeletonLine({ width = '100%' }: { width?: string }) {
  return (
    <div style={{
      height: '12px', borderRadius: '6px', width,
      background: 'rgba(255,255,255,0.05)',
      animation: 'pulse 1.6s ease-in-out infinite',
    }} />
  )
}

// ─── Component ────────────────────────────────────────────────────────────────

export const TopHolderContractCard = ({
  topHolderAddress,
  topHolderPercent,
  holderScan,
  isLoading = false,
}: Props) => {

  const cardStyle: React.CSSProperties = {
    background: '#080c14',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: '16px',
    padding: '20px',
    position: 'relative',
    overflow: 'hidden',
    fontFamily: 'var(--font-inter, Inter, sans-serif)',
  }

  // Loading skeleton
  if (isLoading) {
    return (
      <div style={cardStyle}>
        <style>{`@keyframes pulse { 0%,100%{opacity:.4} 50%{opacity:.8} }`}</style>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <SkeletonLine width="60%" />
          <SkeletonLine width="40%" />
          <SkeletonLine />
          <SkeletonLine />
          <SkeletonLine />
        </div>
      </div>
    )
  }

  // No data
  if (!holderScan && !topHolderAddress) {
    return (
      <div style={{ ...cardStyle, padding: '18px 20px' }}>
        <p style={{
          fontSize: '11px', color: 'rgba(255,255,255,0.22)',
          fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
          margin: 0,
        }}>
          No holder contract data — scan a token to see analysis.
        </p>
      </div>
    )
  }

  // Derive role label
  let roleLabel = 'Unknown Contract'
  let roleVariant: BadgeVariant = 'neutral'
  if (holderScan?.is_locker)     { roleLabel = 'LP Locker';    roleVariant = 'safe'   }
  else if (holderScan?.is_lp_manager) { roleLabel = 'LP Manager';  roleVariant = 'info'  }
  else if (holderScan?.is_router)     { roleLabel = 'DEX Router';  roleVariant = 'info'  }
  else if (holderScan?.is_proxy)      { roleLabel = 'Proxy';       roleVariant = 'warn'  }
  else if (!holderScan)               { roleLabel = 'EOA / Wallet'; roleVariant = 'neutral' }

  // Risk flags — shown only when true
  type FlagDef = { label: string; key: keyof HolderScan; variant: BadgeVariant }
  const riskFlags: FlagDef[] = [
    { label: 'Proxy',           key: 'is_proxy',          variant: 'warn'   },
    { label: 'Upgradeable',     key: 'is_upgradeable',    variant: 'danger' },
    { label: 'Can Withdraw',    key: 'has_withdraw',      variant: 'danger' },
    { label: 'Can Sweep',       key: 'has_sweep',         variant: 'danger' },
    { label: 'Can Rescue',      key: 'has_rescue',        variant: 'warn'   },
    { label: 'Can Mint',        key: 'has_mint',          variant: 'danger' },
    { label: 'Can Burn',        key: 'has_burn',          variant: 'warn'   },
    { label: 'External Calls',  key: 'has_external_calls',variant: 'danger' },
  ]
  const activeRisks = holderScan
    ? riskFlags.filter(f => holderScan[f.key] === true)
    : []

  return (
    <div style={cardStyle}>
      {/* Top accent line */}
      <div style={{
        position: 'absolute', top: 0, left: '10%', right: '10%', height: '1px',
        background: 'linear-gradient(90deg, transparent, rgba(45,212,191,0.35), rgba(139,92,246,0.35), transparent)',
      }} />

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
        <span style={{
          width: 6, height: 6, borderRadius: '50%',
          background: '#2DD4BF', boxShadow: '0 0 8px rgba(45,212,191,0.8)',
          flexShrink: 0,
        }} />
        <p style={{
          fontSize: '10px', fontWeight: 700, letterSpacing: '0.20em',
          color: '#2DD4BF', textTransform: 'uppercase', margin: 0,
          fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
        }}>
          Top Holder Contract
        </p>
      </div>

      {/* Address + percent */}
      {topHolderAddress && (
        <div style={{ marginBottom: '14px' }}>
          <p style={{
            fontSize: '13px', fontWeight: 600, color: '#e2e8f0',
            fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
            margin: '0 0 4px',
            letterSpacing: '0.04em',
          }}>
            {shorten(topHolderAddress)}
          </p>
          {topHolderPercent != null && (
            <p style={{
              fontSize: '11px', color: 'rgba(255,255,255,0.35)', margin: 0,
              fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
            }}>
              {topHolderPercent.toFixed(2)}% of supply
            </p>
          )}
        </div>
      )}

      {/* Role badge */}
      <div style={{ marginBottom: '16px' }}>
        <Badge label={roleLabel} variant={roleVariant} />
      </div>

      {/* Contract flags table */}
      {holderScan && (
        <div style={{ marginBottom: '14px' }}>
          <Row label="Router"       value={holderScan.is_router     ? 'Yes' : 'No'} variant={holderScan.is_router     ? 'info'    : 'neutral'} />
          <Row label="LP Manager"   value={holderScan.is_lp_manager ? 'Yes' : 'No'} variant={holderScan.is_lp_manager ? 'info'    : 'neutral'} />
          <Row label="Locker"       value={holderScan.is_locker     ? 'Yes' : 'No'} variant={holderScan.is_locker     ? 'safe'    : 'neutral'} />
          <Row label="Proxy"        value={holderScan.is_proxy      ? 'Yes' : 'No'} variant={holderScan.is_proxy      ? 'warn'    : 'neutral'} />
          <Row label="Upgradeable"  value={holderScan.is_upgradeable? 'Yes' : 'No'} variant={holderScan.is_upgradeable? 'danger'  : 'neutral'} />
          <Row label="Can Withdraw" value={holderScan.has_withdraw  ? 'Yes' : 'No'} variant={holderScan.has_withdraw  ? 'danger'  : 'neutral'} />
          <Row label="Can Sweep"    value={holderScan.has_sweep     ? 'Yes' : 'No'} variant={holderScan.has_sweep     ? 'danger'  : 'neutral'} />
          <Row label="Can Mint"     value={holderScan.has_mint      ? 'Yes' : 'No'} variant={holderScan.has_mint      ? 'danger'  : 'neutral'} />
          <Row label="Can Burn"     value={holderScan.has_burn      ? 'Yes' : 'No'} variant={holderScan.has_burn      ? 'warn'    : 'neutral'} />
          <Row label="Can Rescue"   value={holderScan.has_rescue    ? 'Yes' : 'No'} variant={holderScan.has_rescue    ? 'warn'    : 'neutral'} />
          <div style={{ paddingBottom: '2px' }}>
            <Row label="Ext. Calls" value={holderScan.has_external_calls ? 'Yes' : 'No'} variant={holderScan.has_external_calls ? 'danger' : 'neutral'} />
          </div>
        </div>
      )}

      {/* Active risk flags summary */}
      {activeRisks.length > 0 && (
        <div style={{ marginBottom: '14px' }}>
          <p style={{
            fontSize: '9px', fontWeight: 700, letterSpacing: '0.16em',
            color: 'rgba(255,255,255,0.25)', textTransform: 'uppercase',
            fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
            marginBottom: '8px',
          }}>
            Active Risk Flags · {activeRisks.length}
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {activeRisks.map(f => (
              <Badge key={f.key} label={f.label} variant={f.variant} />
            ))}
          </div>
        </div>
      )}

      {/* Disclaimer */}
      <div style={{
        marginTop: '14px', padding: '10px 12px',
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.05)',
        borderRadius: '8px',
      }}>
        <p style={{
          fontSize: '9px', color: 'rgba(255,255,255,0.20)',
          fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
          lineHeight: 1.6, margin: 0, letterSpacing: '0.03em',
        }}>
          This panel is read‑only and based on on‑chain bytecode analysis.
          It does not interact with wallets or funds.
        </p>
      </div>
    </div>
  )
}

export default TopHolderContractCard
