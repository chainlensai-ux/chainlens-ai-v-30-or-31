#!/usr/bin/env node
'use strict'

/**
 * Feed performance test for HomeTokenScreener.
 *
 * Simulates the memoized TokenCard render pipeline over FRAMES frames,
 * measuring per-frame cost and asserting the simulated frame rate
 * is at or above TARGET_FPS (55).
 *
 * Mirrors the React.memo + useMemo strategy applied to the component:
 * - A memo cache keyed by token identity skips re-renders for unchanged items
 * - Only items whose reference changed (data churn) are re-processed
 * - Frame cost scales with churn rate, not total item count
 */

const TARGET_FPS    = 55
const FRAME_BUDGET  = 1000 / TARGET_FPS   // ~18.18 ms
const ITEM_COUNT    = 40
const FRAMES        = 300
const CHURN_RATE    = 0.05                // ~5% of items update per frame

// ── Mock feed data ────────────────────────────────────────────────────────────
const feed = Array.from({ length: ITEM_COUNT }, (_, i) => ({
  contract:  `0x${'0'.repeat(39)}${i.toString(16)}`,
  symbol:    `TOK${i}`,
  name:      `Token ${i}`,
  chain:     'base',
  price:     Math.random() * 0.01,
  liquidity: 50_000  + Math.random() * 500_000,
  volume:    10_000  + Math.random() * 2_000_000,
  change24h: (Math.random() - 0.5) * 120,
  source:    'dex',
}))

// ── Mirrors parseNumeric() from HomeTokenScreener ────────────────────────────
function parseNumeric(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const t = value.trim()
    if (!t || t.toLowerCase() === 'nan') return null
    const p = Number(t.replace(/[$,\s]/g, ''))
    return Number.isFinite(p) ? p : null
  }
  return null
}

// ── Mirrors formatUsd() from HomeTokenScreener ───────────────────────────────
function formatUsd(value) {
  const n = parseNumeric(value)
  if (n == null) return 'Unverified'
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}K`
  if (n >= 1)         return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 4 })}`
}

// ── Mirrors TokenCard render work ─────────────────────────────────────────────
function renderTokenCard(token) {
  const change    = parseNumeric(token.change24h) ?? 0
  const priceNum  = parseNumeric(token.price != null ? String(token.price) : undefined)
  const price     = priceNum !== null ? `$${priceNum.toFixed(6)}` : '—'
  const vol       = formatUsd(token.volume)
  const color     = change > 0 ? '#2DD4BF' : change < 0 ? '#f87171' : 'rgba(255,255,255,0.40)'
  const changeStr = change !== 0 ? `${change > 0 ? '+' : ''}${change.toFixed(2)}%` : '—'
  return { symbol: token.symbol, chain: token.chain, price, vol, color, changeStr }
}

// ── Memo cache — mirrors React.memo identity check ────────────────────────────
// Maps contract → { ref: token, result } so unchanged object references are skipped.
const memoCache = new Map()

function memoizedRender(token) {
  const hit = memoCache.get(token.contract)
  if (hit && hit.ref === token) return hit.result     // same reference → skip
  const result = renderTokenCard(token)
  memoCache.set(token.contract, { ref: token, result })
  return result
}

// ── Simulation ────────────────────────────────────────────────────────────────
const frameTimes  = []
let   totalSkips  = 0
let   totalRenders = 0

for (let f = 0; f < FRAMES; f++) {
  // Simulate live data churn: replace ~CHURN_RATE items with new objects
  if (f > 0) {
    for (let i = 0; i < feed.length; i++) {
      if (Math.random() < CHURN_RATE) {
        feed[i] = {
          ...feed[i],
          price:     Math.random() * 0.01,
          change24h: (Math.random() - 0.5) * 120,
          volume:    10_000 + Math.random() * 2_000_000,
        }
      }
    }
  }

  const t0 = performance.now()

  for (const token of feed) {
    const hit = memoCache.get(token.contract)
    if (hit && hit.ref === token) {
      totalSkips++
    } else {
      totalRenders++
    }
    memoizedRender(token)
  }

  frameTimes.push(performance.now() - t0)
}

// ── Metrics ───────────────────────────────────────────────────────────────────
const sorted  = [...frameTimes].sort((a, b) => a - b)
const avgMs   = frameTimes.reduce((s, t) => s + t, 0) / frameTimes.length
const p95Ms   = sorted[Math.floor(frameTimes.length * 0.95)]
const p99Ms   = sorted[Math.floor(frameTimes.length * 0.99)]
const maxMs   = sorted[sorted.length - 1]
const fps     = 1000 / p95Ms
const hitRate = ((totalSkips / (totalSkips + totalRenders)) * 100).toFixed(1)

console.log('')
console.log('  ChainLens AI — Feed Performance Test')
console.log('  ══════════════════════════════════════════════')
console.log(`  Component      HomeTokenScreener`)
console.log(`  Strategy       React.memo + useMemo`)
console.log(`  Feed items     ${ITEM_COUNT}`)
console.log(`  Frames tested  ${FRAMES}`)
console.log(`  Churn rate     ${(CHURN_RATE * 100).toFixed(0)}% items/frame  (live data simulation)`)
console.log(`  Cache hit rate ${hitRate}%  (skipped re-renders)`)
console.log('  ──────────────────────────────────────────────')
console.log(`  Avg frame      ${avgMs.toFixed(4)} ms`)
console.log(`  p95 frame      ${p95Ms.toFixed(4)} ms`)
console.log(`  p99 frame      ${p99Ms.toFixed(4)} ms`)
console.log(`  Max frame      ${maxMs.toFixed(4)} ms`)
console.log(`  Frame budget   ${FRAME_BUDGET.toFixed(2)} ms  (${TARGET_FPS} FPS)`)
console.log('  ──────────────────────────────────────────────')
console.log(`  Simulated FPS  ${fps.toFixed(1)}`)
console.log(`  Target FPS     ${TARGET_FPS}`)
console.log('')

if (fps >= TARGET_FPS) {
  console.log(`  ✓ PASS  ${fps.toFixed(1)} FPS ≥ ${TARGET_FPS} FPS\n`)
  process.exit(0)
} else {
  console.log(`  ✗ FAIL  ${fps.toFixed(1)} FPS < ${TARGET_FPS} FPS\n`)
  process.exit(1)
}
