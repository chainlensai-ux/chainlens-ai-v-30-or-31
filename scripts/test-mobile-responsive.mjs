// Mobile/responsive layout contracts. Layout-only — no scanner/Clark/pricing/auth logic.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')

let passed = 0
function check(label, cond) {
  assert.ok(cond, label)
  passed++
}

const globals = read('app/globals.css')
const layout = read('app/terminal/layout.tsx')
const wallet = read('app/terminal/wallet-scanner/page.tsx')
const token = read('app/terminal/token-scanner/page.tsx')
const whale = read('app/terminal/whale-alerts/page.tsx')
const clarkCss = read('app/terminal/clark-ai/clarkAiPageCss.ts')
const auth = read('app/auth/page.tsx')
const drawer = read('components/MobileClarkDrawer.tsx')
const faq = read('components/FAQAccordion.tsx')
const history = read('components/ClarkHistoryPanel.tsx')
const chat = read('components/ClarkChat.tsx')
const watchlist = read('app/terminal/watchlist/page.tsx')
const screener = read('components/HomeTokenScreener.tsx')

check('hamburger spacer exists in terminal layout', /className="mob-top-spacer"/.test(layout))
check('terminal pages scroll in term-page-scroll', /className="term-page-scroll"/.test(layout))
check('sidebar collapses at 1023px not only 767px', /@media \(max-width: 1023px\)[\s\S]*\.mob-featurebar \{ display: none !important; \}/.test(globals))
check('verdict panels are not display:none on phones', !/\/\* Terminal: hide right verdict panels[\s\S]*\.mob-verdict-panel \{ display: none !important; \}/.test(globals))
check('wallet scanner shell stacks below 1280', /wallet-shell/.test(wallet) && /@media \(max-width: 1279px\)[\s\S]*\.wallet-shell/.test(globals))
check('wallet CORTEX rail is not hidden with md:flex', !/mob-verdict-panel hidden md:flex/.test(wallet))
check('token chain pills wrap or scroll', /chain-seg[\s\S]*flex-wrap: wrap/.test(globals) || /chain-seg[\s\S]*overflow-x: auto/.test(globals) || /chain-seg[\s\S]*flex-wrap: wrap/.test(token))
check('whale rows stack Ask Clark on mobile', /wa-row-main/.test(whale) && /wa-row-actions/.test(whale) && /wa-ask-clark/.test(whale))
check('Clark send button is 44px', /\.clk-send-btn \{ width:44px; height:44px/.test(clarkCss))
check('Clark thinking bubble has no 280px min-width', !/\.clk-thinking \{[^}]*min-width:280px/.test(clarkCss))
check('auth page is vertically scrollable', /overflowY:\s*'auto'/.test(auth) && /alignItems:\s*'flex-start'/.test(auth))
check('FAQ cards fit 390px', /minmax\(min\(100%, 440px\), 1fr\)/.test(faq))
check('history actions visible without hover on touch', /@media \(hover: none\)[\s\S]*clk-histpanel-item-actions \{ opacity:1/.test(history) || /clk-histpanel-item-actions \{ opacity: 1 !important/.test(globals))
check('ClarkChat composer is not sticky on mobile', /position: relative !important/.test(chat) && !/position: sticky !important/.test(chat))
check('MobileClarkDrawer hides on Clark AI and auth', /pathname === '\/terminal\/clark-ai'/.test(drawer) && /pathname === '\/auth'/.test(drawer) && /pathname === '\/pricing'/.test(drawer))
check('MobileClarkDrawer gates at 1023 not 1200', /innerWidth <= 1023/.test(drawer) && !/innerWidth <= 1200/.test(drawer))
check('watchlist metrics have a mobile class', /watchlist-metrics/.test(watchlist))
check('token screener hides extra columns on phones', /hts-col-chain/.test(screener) && /hts-col-vol/.test(globals))
check('token scanner mobile padding no longer fights hamburger with 36px', !/\.token-main\{padding:36px/.test(token))
check('pools table stays in a horizontal scroller', /pools-scroll/.test(token) && /minWidth:'940px'/.test(token))

console.log(`test-mobile-responsive.mjs: all ${passed} assertions passed`)
