// FOMO Board Elite-only gate on Whale Alerts.
// Covers plan helper, locked UI copy, API 403, no fetch for Free/Pro, no "Loading plan" flash.

import assert from 'node:assert/strict'
import fs from 'node:fs'

const { canAccessFomoBoard } = await import('../lib/planFeatures.ts')
const { authorizeFomoLeaderboardRequest, FOMO_BOARD_ELITE_REQUIRED } = await import('../app/api/fomo/leaderboard/route.ts')
const { fetchFomoLeaderboard, clearFomoLeaderboardCache, normalizeFomoTrader } = await import('../lib/server/fomoApi.ts')

const panelSrc = fs.readFileSync(new URL('../components/whale-alerts/FomoBoardPanel.tsx', import.meta.url), 'utf8')
const pageSrc = fs.readFileSync(new URL('../app/terminal/whale-alerts/page.tsx', import.meta.url), 'utf8')
const routeSrc = fs.readFileSync(new URL('../app/api/fomo/leaderboard/route.ts', import.meta.url), 'utf8')
const usePlanSrc = fs.readFileSync(new URL('../lib/usePlan.tsx', import.meta.url), 'utf8')

let passed = 0
function check(label, condition) {
  assert.ok(condition, label)
  passed += 1
}

// ── Plan helper ────────────────────────────────────────────────────────────
check('Free cannot access FOMO Board', canAccessFomoBoard('free') === false)
check('Pro cannot access FOMO Board', canAccessFomoBoard('pro') === false)
check('Elite can access FOMO Board', canAccessFomoBoard('elite') === true)
check('null/undefined cannot access FOMO Board', canAccessFomoBoard(null) === false && canAccessFomoBoard(undefined) === false)

// ── API authorize ──────────────────────────────────────────────────────────
{
  const free = authorizeFomoLeaderboardRequest('free')
  const pro = authorizeFomoLeaderboardRequest('pro')
  const elite = authorizeFomoLeaderboardRequest('elite')
  check('Free API is denied', free.allowed === false)
  check('Pro API is denied', pro.allowed === false)
  check('Elite API is allowed', elite.allowed === true)
  if (!free.allowed) {
    check('Free 403 error is elite_required', free.body.error === 'elite_required')
    check('Free 403 message is exact', free.body.message === 'FOMO Board requires Elite.')
    check('Free 403 status is 403', free.status === 403)
  }
  if (!pro.allowed) {
    check('Pro 403 payload matches helper', pro.body.error === FOMO_BOARD_ELITE_REQUIRED.error && pro.body.message === FOMO_BOARD_ELITE_REQUIRED.message)
  }
}

check('route uses canAccessFomoBoard', /canAccessFomoBoard/.test(routeSrc))
check('route 403 happens before fetchFomoLeaderboard', routeSrc.indexOf('authorizeFomoLeaderboardRequest') < routeSrc.indexOf('fetchFomoLeaderboard(window'))
check('route 403 body uses elite_required', /error: "elite_required"/.test(routeSrc))
check('route 403 message is exact', /FOMO Board requires Elite\./.test(routeSrc))
check('403 response has no traders field', /NextResponse\.json\(access\.body, \{ status: access\.status \}\)/.test(routeSrc))

// ── Elite data path (authorized helper + live cached FOMO read) ────────────
{
  process.env.FOMO_API_KEY = process.env.FOMO_API_KEY || 'test-fomo-key'
  clearFomoLeaderboardCache()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ data: [
      { rank: 1, handle: 'alpha', wallets: { evm: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, holdings: 3 },
    ] }),
  })
  try {
    assert.equal(authorizeFomoLeaderboardRequest('elite').allowed, true)
    const result = await fetchFomoLeaderboard('24h', 10)
    check('Elite-authorized data path returns traders', result.ok === true && result.traders.length === 1)
    check('Elite data path keeps EVM add eligibility', result.traders[0].canAddToBaseTracker === true)
    check('normalize still works for Elite payload', normalizeFomoTrader({ handle: 'x', wallets: { evm: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' } }, 0).canAddToBaseTracker === true)
  } finally {
    globalThis.fetch = originalFetch
    clearFomoLeaderboardCache()
  }
}

// ── Locked UI copy ─────────────────────────────────────────────────────────
check('locked title is FOMO Board', /<p[^>]*>FOMO Board<\/p>/.test(panelSrc) && panelSrc.includes('FomoBoardLockedCard'))
check('locked badge is Elite only', panelSrc.includes('>Elite only<'))
check('locked description is exact', panelSrc.includes('Track high-velocity whale and momentum activity from one premium board.'))
check('locked extra copy is exact', panelSrc.includes('FOMO Board is an Elite-only feed for high-velocity whale and momentum activity.'))
check('locked CTA is Upgrade to Elite', panelSrc.includes('Upgrade to Elite'))
check('locked CTA links to pricing', /href="\/pricing"/.test(panelSrc))
check('page shows locked card when FOMO access is denied', /!hasFomoAccess && <FomoBoardLockedCard \/>/.test(pageSrc) || pageSrc.includes('!hasFomoAccess && <FomoBoardLockedCard'))

// ── Frontend does not fetch FOMO for non-Elite ─────────────────────────────
check('panel data fetches require hasAccess', /if \(!hasAccess\) return/.test(panelSrc))
check('leaderboard effect is skipped without access', /if \(!hasAccess \|\| planLoading\) return/.test(panelSrc))
check('page does not mount data panel for non-Elite', /fomoBoardMounted && hasFomoAccess/.test(pageSrc))
check('panel uses canAccessFomoBoard', /canAccessFomoBoard\(plan\)/.test(panelSrc))
check('page uses canAccessFomoBoard', /canAccessFomoBoard\(plan\)/.test(pageSrc))
check('admin/dev override uses betaEliteActive', /betaEliteActive/.test(panelSrc) && /betaEliteActive/.test(pageSrc))

// ── No Loading plan flash ──────────────────────────────────────────────────
check('FOMO panel has no Loading plan copy', !/Loading plan/i.test(panelSrc))
check('Whale Alerts page FOMO section has no Loading plan copy', !/Loading plan/i.test(pageSrc.split('ACTIVITY | FOMO BOARD')[1] ?? pageSrc))
check('usePlan still serves cached plan without a loading wall', /peekCachedPlan|cached plan is served synchronously/.test(usePlanSrc))
check('page uses PlanGateSkeleton only when planLoading', /if \(planLoading\) return <PlanGateSkeleton \/>/.test(pageSrc))
check('panel skeleton has no Loading plan text', /planLoading/.test(panelSrc) && !/Loading plan access/.test(panelSrc))

// ── Mobile layout ──────────────────────────────────────────────────────────
check('locked card wraps and has minWidth 0', /flexWrap: 'wrap'/.test(panelSrc) && /minWidth: 0/.test(panelSrc))
check('CTA is full width on small screens', /width: '100%'/.test(panelSrc) && /maxWidth: 320/.test(panelSrc) && /minHeight: 44/.test(panelSrc))
check('whale-alerts page prevents horizontal overflow', /overflow-x-hidden|overflowX: 'hidden'/.test(pageSrc))

console.log(`test-fomo-board-elite: ${passed} checks passed`)
