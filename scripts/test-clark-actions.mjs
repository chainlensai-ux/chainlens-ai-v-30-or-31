import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { buildClarkContextActions, tokenScannerHref } from '../lib/server/clarkRouting.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const routeSrc = fs.readFileSync(path.join(__dirname, '../app/api/clark/route.ts'), 'utf8')
const pageSrc = fs.readFileSync(path.join(__dirname, '../app/terminal/clark-ai/page.tsx'), 'utf8')
const PROVIDER_RE = /goldrush|covalent|geckoterminal|coingecko|dexscreener|alchemy/i

// 1. Wallet context returns a Rescan Wallet href with the real address, plus Open Wallet Scanner.
const walletAddr = '0x' + 'a'.repeat(40)
{
  const { actions, omittedReasons } = buildClarkContextActions(
    { walletSummary: { address: walletAddr }, promptActionsEnabled: true },
    'wallet_analysis',
    null,
  )
  const rescan = actions.find((a) => a.label === 'Rescan Wallet')
  assert.ok(rescan, 'wallet intent includes a Rescan Wallet action')
  assert.equal(rescan.href, `/terminal/wallet-scanner?address=${walletAddr}`, 'Rescan Wallet href carries the real address')
  assert.equal(rescan.kind, 'link')
  assert.ok(actions.some((a) => a.label === 'Open Wallet Scanner' && a.href === '/terminal/wallet-scanner'), 'includes Open Wallet Scanner')
  assert.ok(actions.some((a) => a.kind === 'prompt' && a.prompt === 'why is pnl locked'), 'includes an Explain PnL Lock prompt action')
  assert.deepEqual(omittedReasons, [], 'no omissions when wallet address is present')
}

// 2. No wallet address in context means no fake Rescan Wallet CTA — omission is reported, not invented.
{
  const { actions, omittedReasons } = buildClarkContextActions({ walletSummary: null, promptActionsEnabled: true }, 'wallet_analysis', null)
  assert.ok(!actions.some((a) => a.label === 'Rescan Wallet'), 'no Rescan Wallet action without a real address')
  assert.ok(omittedReasons.includes('rescan_wallet_no_address'), 'omission reason recorded for missing wallet address')
}

// 3. Token context returns a Token Scanner href with chain + contract.
const tokenAddr = '0x' + 'b'.repeat(40)
{
  const { actions } = buildClarkContextActions(
    { tokenSummary: { address: tokenAddr, chain: 'base' }, promptActionsEnabled: true },
    'token_analysis',
    null,
  )
  const open = actions.find((a) => a.label === 'Open Token Scanner')
  assert.ok(open, 'token intent includes Open Token Scanner')
  assert.equal(open.href, tokenScannerHref(tokenAddr, 'base'))
  assert.ok(actions.some((a) => a.label === 'Rescan Token' && a.href === tokenScannerHref(tokenAddr, 'base')), 'includes Rescan Token with same href')
  assert.ok(actions.some((a) => a.kind === 'prompt' && a.prompt === 'what are the risks'), 'includes an Explain Risks prompt action')
}

// 4. Market context: top mover Token Scanner CTA only appears when a real scanTarget exists.
{
  const withTarget = buildClarkContextActions({ promptActionsEnabled: true }, 'market', { scanTarget: tokenAddr, symbol: 'PEPE2', chain: 'base' })
  const scanCta = withTarget.actions.find((a) => a.label.includes('Scan'))
  assert.ok(scanCta, 'market intent with a scan target includes a scan CTA')
  assert.equal(scanCta.href, tokenScannerHref(tokenAddr, 'base'))
  assert.ok(withTarget.actions.some((a) => a.label === 'Open Base Radar' && a.href === '/terminal/base-radar'))
  assert.ok(withTarget.actions.some((a) => a.label === 'Refresh Market Data' && a.href === '/terminal?refresh=market'))

  const withoutTarget = buildClarkContextActions({ promptActionsEnabled: true }, 'market', { scanTarget: null })
  assert.ok(!withoutTarget.actions.some((a) => a.label.includes('Scan ')), 'no scanTarget means no fake per-symbol scan CTA')
  assert.ok(withoutTarget.omittedReasons.includes('top_mover_no_scan_target'), 'omission reason recorded for missing scan target')
}

// 5. Prompt actions are omitted (not faked) when the caller says the frontend can't send them.
{
  const { actions, omittedReasons } = buildClarkContextActions(
    { walletSummary: { address: walletAddr }, promptActionsEnabled: false },
    'wallet_analysis',
    null,
  )
  assert.ok(!actions.some((a) => a.kind === 'prompt'), 'no prompt actions when prompt actions are disabled')
  assert.ok(omittedReasons.includes('explain_pnl_lock_prompt_actions_disabled'))
}

// 6. Every action is one of the normalized shapes — no raw JSON, no provider names.
{
  const { actions } = buildClarkContextActions(
    { walletSummary: { address: walletAddr }, tokenSummary: { address: tokenAddr, chain: 'base' }, promptActionsEnabled: true },
    'wallet_analysis token_analysis market',
    { scanTarget: tokenAddr, symbol: 'PEPE2', chain: 'base' },
  )
  for (const a of actions) {
    assert.equal(typeof a.label, 'string')
    assert.ok(a.kind === 'link' || a.kind === 'prompt')
    if (a.kind === 'link') assert.ok(typeof a.href === 'string' && a.href.startsWith('/'), `${a.label} has a real app href`)
    if (a.kind === 'prompt') assert.equal(typeof a.prompt, 'string')
    assert.ok(!PROVIDER_RE.test(JSON.stringify(a)), 'action names no providers')
  }
}

// 7. Backend wires buildClarkContextActions into the app-context follow-up dispatcher and market answers.
assert.ok(/buildClarkContextActions/.test(routeSrc), 'route.ts imports/uses buildClarkContextActions')
for (const field of ['clarkActionsBuilt', 'clarkActionsSource', 'clarkActionsOmittedReasons', 'clarkPromptActionsEnabled']) {
  assert.ok(routeSrc.includes(field), `route exposes debug field ${field}`)
}

// 8. Frontend renders prompt actions by resending the prompt, not by faking a link.
assert.ok(/action\.kind === 'prompt'/.test(pageSrc), 'frontend branches on action.kind to detect prompt actions')
assert.ok(/handleSendText\(action\.prompt/.test(pageSrc), 'prompt actions resend the prompt through handleSendText')

console.log('clark actions checks passed')
