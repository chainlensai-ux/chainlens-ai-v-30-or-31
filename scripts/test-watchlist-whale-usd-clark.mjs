// Watchlist USD + whale-alert USD + Ask Clark token scan.
// Reported live:
//   1. Saving a ~$150k wallet stored ~$20k (EVM-only V2 total, not the merged USD hero total)
//   2. Whale Alerts showed "10.00 UMIA" instead of USD
//   3. Ask Clark on a whale-alert row ran Wallet Scanner instead of scanning the token
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  classifyClarkPrompt,
  classifyClarkToolIntent,
  parseClarkSlashCommand,
} from '../lib/server/clarkRouting.ts'
import { computeMergedTotalValueUsd } from '../app/frontend/lib/mergedWalletView.ts'

const TOKEN = '0xabcdef1234567890abcdef1234567890abcdef12'

let passed = 0
function check(label, cond) {
  assert.ok(cond, label)
  passed++
}

const scannerSrc = fs.readFileSync(new URL('../app/terminal/wallet-scanner/page.tsx', import.meta.url), 'utf8')
const watchlistApiSrc = fs.readFileSync(new URL('../app/api/watchlist/wallets/route.ts', import.meta.url), 'utf8')
const whaleApiSrc = fs.readFileSync(new URL('../app/api/whale-alerts/route.ts', import.meta.url), 'utf8')
const whalePageSrc = fs.readFileSync(new URL('../app/terminal/whale-alerts/page.tsx', import.meta.url), 'utf8')

// ── 1. Watchlist save uses the same merged USD as the hero total ──────────
{
  check('watchlist helper exists', /function watchlistPortfolioValueUsd\(/.test(scannerSrc))
  check('watchlist save calls watchlistPortfolioValueUsd(result, robinhoodResult)', /portfolio_value:\s*watchlistPortfolioValueUsd\(result,\s*robinhoodResult\)/.test(scannerSrc))
  check('watchlist helper uses computeMergedTotalValueUsd', /computeMergedTotalValueUsd\(stats\.totalValueUsd, robinhood, deriveCanonicalMergeOverride\(report\)\)/.test(scannerSrc))
  check('watchlist save no longer writes raw portfolioV2.totalValueUsd', !/portfolio_value:\s*result\.portfolioV2\?\.totalValueUsd/.test(scannerSrc))
  const merged = computeMergedTotalValueUsd(
    20070,
    { ok: true, holdings: { status: 'ok', portfolioTotalUsd: 129930 } },
  )
  check('EVM 20k + Robinhood 130k merges to ~150k USD', merged.totalValueUsd === 150000)
  check('merged total is USD not a token count', merged.totalValueUsd > 1000)
}

{
  check('re-save updates portfolio_value on existing wallet', /update\(\{\s*portfolio_value: portfolioValue\s*\}\)/.test(watchlistApiSrc))
  check('alreadyExists still returned after update', /alreadyExists: true, updated: true/.test(watchlistApiSrc))
  check('insert stores the finite USD number', /portfolio_value: portfolioValue/.test(watchlistApiSrc))
}

// ── 2. Whale alerts price in USD, not token amounts ───────────────────────
{
  check('DexScreener token price lookup exists', /fetchDexScreenerTokenPrices/.test(whaleApiSrc))
  check('DexScreener is tried before GeckoTerminal for memes', whaleApiSrc.indexOf('await fetchDexScreenerTokenPrices(randomAddresses)') < whaleApiSrc.indexOf('await batchFetchTokenPrices(stillMissing)') && whaleApiSrc.includes('await fetchDexScreenerTokenPrices(randomAddresses)'))
  check('amount_token string values are coerced to numbers', /function asPositiveNumber/.test(whaleApiSrc))
  check('feed no longer uses token amount as the primary value slot', !/amtShow = amtU \?\? \(amtTNum \? `\$\{amtTNum\} \$\{primarySym\}`/.test(whalePageSrc))
  check('USD is the primary amount shown', /const amtShow = amtU \?\? \(amtUnverified \?/.test(whalePageSrc) && !/amtShow = amtU \?\? \(amtTNum/.test(whalePageSrc))
  check('token quantity is secondary context', /tokenAmtShow && \(/.test(whalePageSrc))
}

// ── 3. Ask Clark on a whale row token-scans, never wallet-scans ───────────
{
  const prompt = [
    `/token ${TOKEN}`,
    '',
    '[ChainLens Whale Alert — Row Context]',
    'Chain: Base',
    'Trader: Cross-Chain Grinder (0x566bd9…db60dc)',
    'Action: buy · Token: UMIA',
    'Value (USD): unverified',
    'Scan this token. Do not scan the trader wallet.',
  ].join('\n')

  const slash = parseClarkSlashCommand(prompt)
  check('row prompt is a /token slash command', slash?.command === 'token' && slash?.address?.toLowerCase() === TOKEN)
  const routed = classifyClarkPrompt(prompt)
  check('row prompt routes to token_scan', routed.intent === 'token_scan')
  check('row prompt scans the token contract', routed.address?.toLowerCase() === TOKEN)
  check('row prompt is not wallet_scan', routed.intent !== 'wallet_scan')
  check('whale tool intent does not swallow /token', classifyClarkToolIntent(prompt).intent === 'none')
}

{
  const noToken = [
    'Explain this whale alert.',
    '',
    '[ChainLens Whale Alert — Row Context]',
    'Trader: Cross-Chain Grinder (0x566bd9…db60dc)',
    'Action: buy · Token: UMIA',
    'No token contract on this row — do not scan the trader wallet.',
  ].join('\n')
  const routed = classifyClarkPrompt(noToken)
  check('row without contract is whale_alert, not wallet_scan', routed.intent === 'whale_alert')
  check('truncated trader address is not extracted as a scan target', routed.address == null)
}

{
  check('Ask Clark builder starts with /token when a contract exists', /\/token \$\{tokenAddr\}/.test(whalePageSrc))
  check('Ask Clark does not put Wallet address: 0x in the row prompt', !/Wallet address: \$\{alert\.wallet_address\}/.test(whalePageSrc))
  check('trader address is truncated so it cannot be extracted', /function shortWallet/.test(whalePageSrc))
  check('row prompt tells Clark not to scan the trader wallet', /Do not scan the trader wallet/.test(whalePageSrc))
}

console.log(`test-watchlist-whale-usd-clark.mjs: all ${passed} assertions passed`)
