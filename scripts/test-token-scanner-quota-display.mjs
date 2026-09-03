// "on free plan should show much u have like scans and limit u have" — after
// origin/main merged a real Free weekly Token Scanner quota (lib/tokenScanQuota.ts, 3/week,
// enforced server-side in /api/token's POST handler), the Token Scanner page had no way to show
// the user how much of it they'd used. This adds a read-only GET /api/token/quota peek (mirroring
// the existing /api/wallet-scan/quota pattern) and wires a live "X / N scans this week" pill into
// the Token Scanner page, refreshed after every scan — never a fabricated or hardcoded number.
import fs from 'node:fs'

let passed = 0
let failed = 0
function check(label, cond) {
  if (cond) { passed++ } else { failed++; console.error(`FAIL: ${label}`) }
}

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const quotaRouteSrc = read('../app/api/token/quota/route.ts')
const pageSrc = read('../app/terminal/token-scanner/page.tsx')

console.log('\nSection 1: GET /api/token/quota peeks the real quota without consuming it')
{
  check('reads from the real snapshotTokenScan (never consumeTokenScan — a peek must not burn a scan)',
    /import \{ snapshotTokenScan \} from '@\/lib\/tokenScanQuota'/.test(quotaRouteSrc) && !/consumeTokenScan/.test(quotaRouteSrc))
  check('derives plan from the same bearer-token flow as every other quota/plan endpoint',
    /getCurrentUserPlanFromBearerToken/.test(quotaRouteSrc))
  check('keys the snapshot by plan + IP — the exact same actor key /api/token\'s POST handler consumes against',
    /snapshotTokenScan\(plan, ip\)/.test(quotaRouteSrc))
}

console.log('\nSection 2: Token Scanner page fetches and displays the live quota, never a hardcoded number')
{
  check('page fetches /api/token/quota', /fetch\('\/api\/token\/quota'/.test(pageSrc))
  check('quota state seeded from the fetched response fields, not fabricated', /setTokenScanQuota\(\{ limit: json\.limit \?\? null, remaining: json\.remaining \?\? null, used: json\.used \?\? 0 \}\)/.test(pageSrc))
  check('quota is refetched on mount', /useEffect\(\(\) => \{ refreshTokenScanQuota\(\) \}, \[refreshTokenScanQuota\]\)/.test(pageSrc))
  check('quota is refetched again after every scan completes (loading true → false transition)',
    /if \(wasLoadingRef\.current && !loading\) refreshTokenScanQuota\(\)/.test(pageSrc))
}

console.log('\nSection 3: the pill only renders a real, known limit and reflects the signed-in user\'s actual plan')
{
  check('pill is gated on a non-null limit (Pro/Elite are unlimited — snapshotTokenScan returns limit: null — so no pill is fabricated for them)',
    /tokenScanQuota && tokenScanQuota\.limit != null/.test(pageSrc))
  check('pill renders the live used/limit counts and the real plan label', /\{tokenScanQuota\.used\} \/ \{tokenScanQuota\.limit\} scans this week \(\{plan\.toUpperCase\(\)\}\)/.test(pageSrc))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
