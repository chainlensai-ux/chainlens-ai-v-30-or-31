export type PumpChainSlug = 'base' | 'eth' | 'robinhood'

export type MomentumWindow = '1h' | '6h' | '24h'

export interface MomentumWindowRead {
  title: 'Momentum Window' | '24h Momentum'
  label: 'Early momentum' | 'Strong momentum' | 'Cooling' | 'Unknown'
  strongestWindow: MomentumWindow
  strongestChange: number
  windows: Array<{ window: MomentumWindow; change: number }>
}

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Pure display model. It never substitutes a longer or shorter window for a missing one. */
export function buildMomentumWindow(input: {
  change1h: number | null
  change6h: number | null
  change24h: number | null
}): MomentumWindowRead | null {
  const windows: MomentumWindowRead['windows'] = [
    { window: '1h', change: input.change1h },
    { window: '6h', change: input.change6h },
    { window: '24h', change: input.change24h },
  ].filter((row): row is { window: MomentumWindow; change: number } => finite(row.change))
  if (windows.length === 0) return null

  // "Strongest" means the largest observed move by magnitude, preserving its direction.
  const strongest = [...windows].sort((a, b) => Math.abs(b.change) - Math.abs(a.change))[0]
  const shortWindowCooling = (finite(input.change1h) && input.change1h < 0)
    || (finite(input.change6h) && input.change6h < 0)
  const longerWindowPositive = (finite(input.change24h) && input.change24h > 0)
    || (finite(input.change6h) && input.change6h > 0)

  let label: MomentumWindowRead['label'] = 'Unknown'
  if (shortWindowCooling && longerWindowPositive) label = 'Cooling'
  else if (windows.every(row => row.change <= 0)) label = 'Cooling'
  else if (windows.some(row => row.change >= 15) && !shortWindowCooling) label = 'Strong momentum'
  else if ((finite(input.change1h) && input.change1h > 0) || (finite(input.change6h) && input.change6h > 0)) label = 'Early momentum'

  return {
    title: windows.length === 1 && windows[0].window === '24h' ? '24h Momentum' : 'Momentum Window',
    label,
    strongestWindow: strongest.window,
    strongestChange: strongest.change,
    windows,
  }
}

function canonicalPart(value: string): string {
  return value.trim().toLowerCase()
}

export function pumpReportCacheKey(chainSlug: string, tokenAddress: string): string {
  return `pumpReport:${canonicalPart(chainSlug)}:${canonicalPart(tokenAddress)}`
}

export function pumpCandidateCacheKey(chainSlug: string, tokenAddress: string, pairAddress: string | null): string {
  return `pumpCandidate:${canonicalPart(chainSlug)}:${canonicalPart(tokenAddress)}:${canonicalPart(pairAddress || 'no-pair')}`
}

export function matchesPumpCacheIdentity(
  value: unknown,
  expected: { chainSlug: string; tokenAddress: string; pairAddress?: string | null },
): boolean {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  const chain = typeof row.chain === 'string' ? row.chain : typeof row.chainSlug === 'string' ? row.chainSlug : ''
  const token = typeof row.contract === 'string' ? row.contract : typeof row.tokenAddress === 'string' ? row.tokenAddress : ''
  if (canonicalPart(chain) !== canonicalPart(expected.chainSlug)) return false
  if (canonicalPart(token) !== canonicalPart(expected.tokenAddress)) return false
  if (expected.pairAddress) {
    const pair = typeof row.pairAddress === 'string' ? row.pairAddress : ''
    if (canonicalPart(pair) !== canonicalPart(expected.pairAddress)) return false
  }
  return true
}
