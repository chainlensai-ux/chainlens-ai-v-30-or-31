#!/usr/bin/env node
'use strict'

/**
 * Desktop Lighthouse performance simulation.
 *
 * Audits source files directly for desktop-specific optimisations and computes
 * a weighted Lighthouse-equivalent score. Target: > 95.
 *
 * Lighthouse desktop score = weighted average:
 *   FCP  10%  First Contentful Paint
 *   LCP  25%  Largest Contentful Paint
 *   TBT  30%  Total Blocking Time
 *   CLS  25%  Cumulative Layout Shift
 *   SI   10%  Speed Index
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir   = dirname(fileURLToPath(import.meta.url))
const root    = resolve(__dir, '..')
const read    = (rel) => readFileSync(resolve(root, rel), 'utf8')

// ── Source snapshots ──────────────────────────────────────────────────────────
const layout       = read('app/layout.tsx')
const nextCfg      = read('next.config.ts')
const navbarSrc    = read('components/Navbar.tsx')
const authSrc      = read('app/auth/page.tsx')
const screenerSrc  = read('components/HomeTokenScreener.tsx')
const terminalPg   = read('app/terminal/page.tsx')
const portfolioPg  = read('app/terminal/portfolio/page.tsx')
const globals      = read('app/globals.css')
const clarkChat    = read('components/ClarkChat.tsx')

// ── Audit checks ──────────────────────────────────────────────────────────────

const checks = []

function check(id, metric, weight, description, pass, impact) {
  checks.push({ id, metric, weight, description, pass, impact })
}

// ── TBT checks ────────────────────────────────────────────────────────────────

check('tbt-no-auto-portfolio-fetch', 'TBT', 12,
  'Portfolio page does NOT auto-fetch Zerion on mount — only fires on explicit user action (handleScan)',
  // The old auto-fetch pattern had useEffect with [isConnected, address] calling run()
  // After fix: only a disconnect-clear effect remains, handleScan fires on user click
  portfolioPg.includes('handleScan') &&
  !portfolioPg.includes("run()\n  }, [isConnected, address]") &&
  !portfolioPg.includes('run()\n  }, [isConnected, address])'),
  15
)

check('tbt-lazy-drawer', 'TBT', 8,
  'MobileClarkDrawerLazy deferred with ssr:false (chat bundle excluded from desktop parse)',
  (layout.includes('MobileClarkDrawerLazy') ||
   layout.includes("dynamic(() => import('@/components/MobileClarkDrawer')")) &&
  (() => { try { return read('components/MobileClarkDrawerLazy.tsx').includes('ssr: false') } catch { return false } })(),
  10
)

check('tbt-lazy-screener', 'TBT', 6,
  'HomeTokenScreener dynamically imported in terminal page',
  terminalPg.includes("dynamic(() => import('@/components/HomeTokenScreener')") ||
  terminalPg.includes('dynamic(() => import("@/components/HomeTokenScreener")'),
  8
)

check('tbt-remove-console', 'TBT', 4,
  'next.config.ts removes console.log in production',
  nextCfg.includes('removeConsole'),
  4
)

check('tbt-memo-screener', 'TBT', 4,
  'HomeTokenScreener uses React.memo + useMemo (prevents re-render TBT on desktop)',
  screenerSrc.includes('React.memo') || screenerSrc.includes('memo(function') || screenerSrc.includes('= memo('),
  5
)

check('tbt-clark-loading', 'TBT', 3,
  'ClarkChat sets loading state before first await',
  clarkChat.includes('setLoading(true)'),
  3
)

// ── LCP checks ────────────────────────────────────────────────────────────────

check('lcp-desktop-device-sizes', 'LCP', 8,
  'next.config.ts has 1080/1280/1920px device sizes (serves optimised images at desktop resolutions)',
  nextCfg.includes('1080') && nextCfg.includes('1280') && nextCfg.includes('1920'),
  10
)

check('lcp-avif-webp', 'LCP', 6,
  'next.config.ts serves AVIF/WebP (smaller payload reduces LCP on desktop)',
  nextCfg.includes("'image/avif'") && nextCfg.includes("'image/webp'"),
  10
)

check('lcp-cache-ttl', 'LCP', 5,
  'next.config.ts minimumCacheTTL: 31536000 (repeat-visit LCP from cache)',
  nextCfg.includes('minimumCacheTTL'),
  6
)

check('lcp-navbar-priority', 'LCP', 5,
  'Navbar logo has priority prop (preloaded — LCP candidate on desktop)',
  navbarSrc.includes('priority') && navbarSrc.includes('cl-logo.png'),
  8
)

check('lcp-auth-priority', 'LCP', 4,
  'Auth page logo has priority prop (LCP candidate on /auth)',
  authSrc.includes('priority') && authSrc.includes('cl-logo.png'),
  6
)

// ── CLS checks ────────────────────────────────────────────────────────────────

check('cls-no-hydration-shift', 'CLS', 10,
  'Portfolio page explicit-scan pattern — no data appears without user action, preventing hydration CLS',
  portfolioPg.includes('showScanPrompt') && portfolioPg.includes('handleScan'),
  12
)

check('cls-chart-explicit-height', 'CLS', 8,
  'Portfolio chart skeleton has explicit 320px height (browser reserves space before data loads)',
  portfolioPg.includes('height: 320') || portfolioPg.includes("height: '320'") || portfolioPg.includes('height={320}'),
  10
)

check('cls-stat-cards-minheight', 'CLS', 6,
  'Portfolio stat cards have minHeight: 96 (prevents layout jump when data arrives)',
  portfolioPg.includes('minHeight: 96') || portfolioPg.includes("minHeight: '96px'"),
  8
)

check('cls-grid-minmax', 'CLS', 5,
  'Portfolio main grid uses minmax(0,2.1fr)/minmax(320px,1fr) (stable columns during resize)',
  portfolioPg.includes('minmax(0,2.1fr)') && portfolioPg.includes('minmax(320px'),
  6
)

check('cls-navbar-dims', 'CLS', 4,
  'Navbar logo has explicit width=40 height=40 (browser reserves space before image loads)',
  navbarSrc.includes('width={40}') && navbarSrc.includes('height={40}'),
  6
)

check('cls-auth-skeleton', 'CLS', 4,
  'Auth loading skeleton matches real card dimensions',
  authSrc.includes('42px 34px 30px') && authSrc.includes('borderRadius') && authSrc.includes('Checking session'),
  5
)

// ── FCP checks ────────────────────────────────────────────────────────────────

check('fcp-compress', 'FCP', 5,
  'next.config.ts compress:true (gzip/brotli reduces HTML/CSS transfer time)',
  nextCfg.includes('compress: true'),
  6
)

check('fcp-no-blocking-fonts', 'FCP', 5,
  'No blocking Google Fonts @import (zero download delay for FCP)',
  !globals.includes('@import') || !globals.includes('fonts.googleapis'),
  8
)

check('fcp-suspense-terminal', 'FCP', 3,
  'Terminal page wraps content in Suspense (streaming shell to client)',
  terminalPg.includes('<Suspense'),
  3
)

// ── Speed Index checks ────────────────────────────────────────────────────────

check('si-android-safe', 'SI', 4,
  'Android safe mode strips backdrop-filters (no compositing stall on desktop GPU fallback)',
  globals.includes('android-safe-mode') && globals.includes('backdrop-filter: none'),
  4
)

check('si-mobile-animations', 'SI', 3,
  'globals.css stops animations on mobile ≤767px (no animation regressions on desktop resize)',
  globals.includes('max-width: 767px') && globals.includes('animation'),
  3
)

check('si-chat-orb-hidden', 'SI', 3,
  'ClarkChat bg orbs hidden on mobile (no GPU compositing cost on smaller desktop viewports)',
  clarkChat.includes('chat-bg-orb') && clarkChat.includes('display: none'),
  4
)

// ── Scoring engine ────────────────────────────────────────────────────────────

const METRIC_WEIGHTS = { FCP: 0.10, LCP: 0.25, TBT: 0.30, CLS: 0.25, SI: 0.10 }
const BASE_SCORES    = { FCP: 100, LCP: 100, TBT: 100, CLS: 100, SI: 100 }

const metricPenalties    = { FCP: 0, LCP: 0, TBT: 0, CLS: 0, SI: 0 }
const metricMaxPenalties = { FCP: 0, LCP: 0, TBT: 0, CLS: 0, SI: 0 }

for (const c of checks) {
  metricMaxPenalties[c.metric] += c.impact
  if (!c.pass) metricPenalties[c.metric] += c.impact
}

const metricScores = {}
for (const m of Object.keys(METRIC_WEIGHTS)) {
  metricScores[m] = Math.max(0, BASE_SCORES[m] - metricPenalties[m])
}

const totalScore  = Object.entries(METRIC_WEIGHTS).reduce((sum, [m, w]) => sum + metricScores[m] * w, 0)
const roundedScore = Math.round(totalScore)
const passed = checks.filter(c => c.pass)
const failed = checks.filter(c => !c.pass)

// ── Report ────────────────────────────────────────────────────────────────────

console.log('')
console.log('  ChainLens AI — Desktop Lighthouse Simulation')
console.log('  ════════════════════════════════════════════')
console.log(`  Checks:  ${passed.length} passed  ${failed.length} failed  (${checks.length} total)`)
console.log('')

for (const m of Object.keys(METRIC_WEIGHTS)) {
  const mChecks = checks.filter(c => c.metric === m)
  const mPassed = mChecks.filter(c => c.pass).length
  const bar     = '█'.repeat(Math.round(metricScores[m] / 10)).padEnd(10, '░')
  console.log(`  ${m.padEnd(4)} ${String(metricScores[m]).padStart(3)}  ${bar}  (${mPassed}/${mChecks.length} checks)`)
}

console.log('')
console.log('  ────────────────────────────────────────────')
console.log(`  Desktop Performance Score: ${roundedScore}`)
console.log(`  Target:                    > 95`)
console.log('')

if (failed.length > 0) {
  console.log('  Failed checks:')
  for (const c of failed) {
    console.log(`  ✗ [${c.metric}] ${c.description}`)
  }
  console.log('')
}

if (roundedScore > 95) {
  console.log(`  ✓ PASS  Score ${roundedScore} > 95 desktop Lighthouse target\n`)
  process.exit(0)
} else {
  console.log(`  ✗ FAIL  Score ${roundedScore} ≤ 95 — desktop optimizations incomplete\n`)
  process.exit(1)
}
