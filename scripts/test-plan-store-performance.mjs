// Tests for the plan/account store performance + UX work (performance optimization task).
//
// WHAT THIS LOCKS IN, DISCLOSED:
//  1. There is exactly ONE `/api/user-settings` fetch, ONE onAuthStateChange subscription and ONE
//     elite-pass interval in the whole app. Before this work there were four independent copies
//     (lib/usePlan.tsx x2, components/FeatureBar.tsx, components/Navbar.tsx), so a single terminal
//     page load fired the same request 2-3x and every auth event re-fired all of them.
//  2. No page renders a full-screen "Loading plan access…" text wall any more — and, critically,
//     none of them render the LockedPanel paywall while the plan is still unknown (which would
//     flash "Pro or Elite required" at a paying Elite user during SSR/first paint).
//
// Style: source-level assertions against the real files, matching this repo's existing convention
// (scripts/test-wallet-scan-orchestrator.mjs, scripts/test-button-responsiveness.mjs).

import assert from 'node:assert/strict'
import fs from 'node:fs'

let passed = 0
function check(label, condition) { assert.ok(condition, label); passed++ }

function read(relPath) {
  return fs.readFileSync(new URL(`../${relPath}`, import.meta.url), 'utf8')
}

/** Strip line comments so a disclosure comment mentioning an API never counts as a call site. */
function code(src) {
  return src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

function countMatches(src, pattern) {
  return (code(src).match(pattern) ?? []).length
}

function run() {
  const planSrc = read('lib/usePlan.tsx')
  const featureBarSrc = read('components/FeatureBar.tsx')
  const navbarSrc = read('components/Navbar.tsx')
  const globalsCss = read('app/globals.css')

  const gatedPages = [
    'app/terminal/wallet-scanner/page.tsx',
    'app/terminal/portfolio/page.tsx',
    'app/terminal/pump-alerts/page.tsx',
    'app/terminal/pump-alerts/report/page.tsx',
    'app/terminal/whale-alerts/page.tsx',
    'app/terminal/base-radar/page.tsx',
    'app/terminal/liquidity/page.tsx',
  ]

  // ── 1. Exactly one network path for plan/auth, app-wide ────────────────────────────────────────
  {
    const totalUserSettings = countMatches(planSrc, /fetch\('\/api\/user-settings'/g)
      + countMatches(featureBarSrc, /fetch\('\/api\/user-settings'/g)
      + countMatches(navbarSrc, /fetch\('\/api\/user-settings'/g)
    check('exactly ONE /api/user-settings fetch call site across the store + FeatureBar + Navbar (was 4)', totalUserSettings === 1)
    check('that one fetch lives in the shared store, not in a component', countMatches(planSrc, /fetch\('\/api\/user-settings'/g) === 1)

    const totalAuthSubs = countMatches(planSrc, /onAuthStateChange\(/g)
      + countMatches(featureBarSrc, /onAuthStateChange\(/g)
      + countMatches(navbarSrc, /onAuthStateChange\(/g)
    check('exactly ONE onAuthStateChange subscription app-wide (was 3 — one per component)', totalAuthSubs === 1)

    check('FeatureBar no longer runs its own auth/plan fetching at all', countMatches(featureBarSrc, /getSession\(\)|onAuthStateChange\(|fetch\('\/api\/user-settings'/g) === 0)
    check('Navbar no longer runs its own auth/plan fetching at all', countMatches(navbarSrc, /getSession\(\)|onAuthStateChange\(|fetch\('\/api\/user-settings'/g) === 0)
    check('FeatureBar reads the shared store instead', featureBarSrc.includes("useAccount") && featureBarSrc.includes("from '@/lib/usePlan'"))
    check('Navbar reads the shared store instead', navbarSrc.includes("useAccount") && navbarSrc.includes("from '@/lib/usePlan'"))
  }

  // ── 2. Request coalescing + stale-while-revalidate ─────────────────────────────────────────────
  {
    check('concurrent callers share a single in-flight promise (no duplicate requests under load)', /if \(store\.inFlight\) return store\.inFlight/.test(planSrc))
    check('a fresh result inside the cache TTL short-circuits the network entirely', /Date\.now\(\) - store\.lastFetchedAt < PLAN_CACHE_MAX_AGE_MS/.test(planSrc))
    check('the cached plan is surfaced BEFORE the network call resolves (stale-while-revalidate)', /const cached = readCachedPlan\(userId, email\)\s*\n\s*if \(cached\) setSnapshot/.test(planSrc))
    check('a failed refresh never downgrades a plan the user can already see', /error: cached \? null : 'plan_fetch_failed'/.test(planSrc))
    check('there is ONE app-wide elite-pass ticker, not one interval per component', countMatches(planSrc, /setInterval\(/g) === 1)
  }

  // ── 3. No unnecessary re-renders: referentially-equal snapshots are dropped ────────────────────
  {
    check('setSnapshot bails out when nothing actually changed, so subscribers do not re-render on a no-op background refresh', /\) return\s*\n\s*store\.snapshot = next/.test(planSrc))
    check('the store is read through useSyncExternalStore (tear-free, SSR-safe)', planSrc.includes('useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)'))
    check('getServerSnapshot returns a single frozen object — a fresh object there is an infinite-render bug', /const SERVER_SNAPSHOT: AccountSnapshot = Object\.freeze\(/.test(planSrc) && /function getServerSnapshot\(\): AccountSnapshot \{ return SERVER_SNAPSHOT \}/.test(planSrc))
  }

  // ── 4. The "Loading plan access…" wall is gone everywhere ──────────────────────────────────────
  {
    for (const page of gatedPages) {
      const src = read(page)
      check(`${page} no longer renders a full-screen "Loading plan access…"/"Loading access…" text wall`, !/>\s*Loading (plan )?access…\s*</.test(src))
      check(`${page} renders the shared skeleton while the plan is unknown`, src.includes('<PlanGateSkeleton />'))
      check(`${page} imports PlanGateSkeleton from the shared store`, /import \{[^}]*PlanGateSkeleton[^}]*\} from '@\/lib\/usePlan'/.test(src))
    }
  }

  // ── 5. An unknown plan must never render the paywall (the regression this work found) ──────────
  {
    check(
      'usePlanWithLoading reports an unknown (null) plan as loading, so a gated page shows the skeleton rather than flashing "Pro or Elite required" at a paying user during SSR/first paint',
      /loading: loading \|\| plan == null/.test(planSrc),
    )
    check('PlanGate applies the same rule', /if \(plan == null \|\| loading\) return <PlanGateSkeleton \/>/.test(planSrc))
    check('the server snapshot starts with an unknown plan, never a guessed free', /plan: null,/.test(planSrc.slice(planSrc.indexOf('const SERVER_SNAPSHOT'))))
  }

  // ── 6. Skeleton + touch targets: GPU-friendly, accessible, reduced-motion aware ────────────────
  {
    check('.cl-skeleton exists', globalsCss.includes('.cl-skeleton {'))
    check('the skeleton animates opacity only — never width/height/top/left (no layout thrash)', (() => {
      // Extract JUST the @keyframes cl-skeleton-pulse block (up to its own closing brace at column
      // 0) — an unbounded [\s\S]*? here would leak into unrelated later rules and false-fail.
      const start = globalsCss.indexOf('@keyframes cl-skeleton-pulse')
      if (start === -1) return false
      const block = globalsCss.slice(start, globalsCss.indexOf('\n}', start) + 2)
      return /opacity:/.test(block) && !/(^|[^-])\b(width|height|top|left)\s*:/.test(block)
    })())
    check('the skeleton stops animating under prefers-reduced-motion but stays visible', /@media \(prefers-reduced-motion: reduce\) \{\s*\.cl-skeleton \{ animation: none;/.test(globalsCss))
    check('the skeleton is announced to screen readers (aria-busy + an sr-only label)', planSrc.includes('aria-busy="true"') && planSrc.includes('Checking plan access') && globalsCss.includes('.sr-only {'))
    check('mobile navigation touch targets meet the 44px minimum', /@media \(max-width: 767px\) \{[\s\S]*?\.mob-featurebar nav a,[\s\S]*?min-height: 44px !important/.test(globalsCss))
    check('coarse-pointer tablets get the same 44px minimum even above 767px', /@media \(pointer: coarse\) \{[\s\S]*?min-height: 44px !important/.test(globalsCss))
  }

  // ── 7. Public API preserved — no caller had to change to get the benefit ───────────────────────
  {
    for (const name of ['usePlan', 'usePlanWithLoading', 'readCachedPlan', 'writeCachedPlan', 'clearPlanCache', 'peekCachedPlan', 'LockedPanel', 'canAccessFeature', 'ensurePlanLoaded', 'subscribeToSharedPlan']) {
      check(`${name} is still exported (back-compat preserved)`, new RegExp(`export (function|const|\\{)[^\\n]*\\b${name}\\b`).test(planSrc))
    }
    check('the access decision still runs through canAccessFeature, unchanged', planSrc.includes("import { canAccessFeature, type UserPlan } from '@/lib/planFeatures'"))
    check('the cache key and TTL are unchanged', planSrc.includes("PLAN_CACHE_KEY = 'chainlens_cached_plan'") && planSrc.includes('PLAN_CACHE_MAX_AGE_MS = 1000 * 60 * 30'))
  }

  console.log(`test-plan-store-performance.mjs: all ${passed} assertions passed`)
}

run()
