// Feed value filters (moved verbatim from app/api/whale-alerts/route.ts so they can be tested).
type RawRow = Record<string, unknown>

// Returns true if a post-enrichment row meets the "All" quality floor.
// Shared by filterByValueFloor (feed) and countStatsFiltered (stats cards).
export function passesQualityFloor(row: RawRow): boolean {
  const usd  = row.amount_usd as number | null
  const sym  = ((row.token_symbol as string | null) ?? '').toUpperCase().trim()
  const amt  = row.amount_token as number | null
  const legs = (row.legs as number | null) ?? 1

  // Multi-leg swaps always pass — the swap itself is notable regardless of leg size.
  if (legs >= 2) return true

  // Primary check: known USD value must be >= $100.
  if (usd !== null) return usd >= 100

  // Fallback for rows where enrichment produced no USD (unknown tokens):
  // apply per-symbol token amount floors.
  if (sym === 'USDC' || sym === 'USDT' || sym === 'DAI' || sym === 'USDBC') return amt === null || amt >= 100
  if (sym === 'WETH' || sym === 'ETH') return amt === null || amt >= 0.01
  if (sym === 'CBBTC' || sym === 'WBTC') return amt === null || amt >= 0.0005

  // Unknown / other tokens: keep (amount > 0 guaranteed by meaningfulFilter).
  return true
}

// Parsed value range spec: null = "All" (quality floor), otherwise numeric bounds.
export type ValueRangeSpec = { min: number; max: number | null } | null

export function parseValueRange(value: string | null): ValueRangeSpec {
  if (!value || value === 'all') return null
  if (value === '10000+') return { min: 10000, max: null }
  const m = value.match(/^(\d+)-(\d+)$/)
  if (m) return { min: Number(m[1]), max: Number(m[2]) }
  return null
}

// Post-enrichment, post-grouping value filter.
// null ("All"): quality floor — hide known-tiny moves, keep unpriced rows.
//   skipFloor=true (feedMode=all): bypass the quality floor entirely, keep all rows.
// range: require known amount_usd within [min, max).
export function filterByValueRange(
  rows: RawRow[],
  range: ValueRangeSpec,
  skipFloor = false,
): { rows: RawRow[]; hiddenByFilter: number; hiddenAsDust: number } {
  if (range === null) {
    if (skipFloor) return { rows, hiddenByFilter: 0, hiddenAsDust: 0 }
    let hiddenAsDust = 0
    const result = rows.filter(row => {
      if (!passesQualityFloor(row)) { hiddenAsDust++; return false }
      return true
    })
    return { rows: result, hiddenByFilter: 0, hiddenAsDust }
  }
  let hiddenByFilter = 0
  const result = rows.filter(row => {
    const usd = row.amount_usd as number | null
    if (usd === null) { hiddenByFilter++; return false }
    if (usd < range.min) { hiddenByFilter++; return false }
    if (range.max !== null && usd >= range.max) { hiddenByFilter++; return false }
    return true
  })
  return { rows: result, hiddenByFilter, hiddenAsDust: 0 }
}

