// "on free plan should show much u have like scans and limit u have" — Token Scanner scans are
// unlimited on every plan (lib/pricingPlans.ts), so there is no honest scan quota to display there.
// The one real daily cap on Free is Clark AI prompts (3/day). This adds a "Clark AI today: X / N"
// row to the shared sidebar account block (components/FeatureBar.tsx), visible on every terminal
// page including Token Scanner, reusing the exact same local usage counter the Clark AI page
// itself already reads/bumps — no new source of truth invented.
import fs from 'node:fs'

let passed = 0
let failed = 0
function check(label, cond) {
  if (cond) { passed++ } else { failed++; console.error(`FAIL: ${label}`) }
}

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const featureBarSrc = read('../components/FeatureBar.tsx')

console.log('\nSection 1: FeatureBar reuses the real Clark usage counter and plan limits, nothing fabricated')
{
  check('imports the existing readClarkUsage counter from clarkAiPageConfig (same source Clark AI page uses)',
    /import \{ readClarkUsage \} from '@\/app\/terminal\/clark-ai\/clarkAiPageConfig'/.test(featureBarSrc))
  check('imports CLARK_DAILY_LIMITS from the one source-of-truth pricing module',
    /import \{ CLARK_DAILY_LIMITS \} from '@\/lib\/pricingPlans'/.test(featureBarSrc))
  check('reads usage on mount / pathname change via readClarkUsage(), never a hardcoded number',
    /useEffect\(\(\) => \{ setClarkUsed\(readClarkUsage\(\)\) \}, \[pathname\]\)/.test(featureBarSrc))
  check('limit is looked up per the signed-in user\'s real plan, not hardcoded to free',
    /const clarkLimit = CLARK_DAILY_LIMITS\[plan\] \?\? CLARK_DAILY_LIMITS\.free/.test(featureBarSrc))
}

console.log('\nSection 2: the usage row renders in the shared sidebar (visible on Token Scanner and every terminal page)')
{
  check('usage row only renders for a signed-in account (never guesses for a signed-out visitor)',
    /\{accountEmail && !betaElite \? \(/.test(featureBarSrc))
  check('renders the "Clark AI today" label with the live used/limit counts',
    /<span>Clark AI today<\/span>/.test(featureBarSrc) && /\{clarkUsed\} \/ \{clarkLimit\}/.test(featureBarSrc))
}

console.log('\nSection 3: the account-row ternary chain stays valid JSX (undefined / signed-out / signed-in all handled, no dangling branch)')
{
  check('unknown-session skeleton branch still present', /accountEmail === undefined \? \(/.test(featureBarSrc))
  check('signed-out Sign In / Sign Up branch still present and now explicitly closed', /: !accountEmail \? \(/.test(featureBarSrc))
  check('ternary chain has a final null fallback (no missing else)', /Sign Up\s*<\/Link>\s*<\/div>\s*\) : null\}/.test(featureBarSrc))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
