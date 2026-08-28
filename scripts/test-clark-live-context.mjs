import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  formatLastTokenDisplay,
  formatMintAddressFromLastToken,
  intentBadgeForPrompt,
  isMintAddressFollowup,
  resolveClarkContextChain,
  uiModeHintForPrompt,
} from '../lib/client/clarkAiLive.ts'

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const DEAD = '0x000000000000000000000000000000000000dEaD'

assert.equal(uiModeHintForPrompt(`scan this wallet ${DEAD} on base`, 'token'), 'wallet')
assert.equal(intentBadgeForPrompt(`scan this wallet ${DEAD} on base`), 'WALLET READ')
assert.equal(isMintAddressFollowup('what is the mint address?'), true)
assert.equal(isMintAddressFollowup(`scan this wallet ${DEAD}`), false)

const lastToken = { address: USDC, chain: 'solana', symbol: 'USDC', name: 'USD Coin' }
const reply = formatMintAddressFromLastToken(lastToken)
assert.ok(reply && reply.includes(USDC), 'mint follow-up answers from lastToken')
assert.ok(reply.includes('Solana'), 'mint follow-up keeps last chain')
assert.equal(formatMintAddressFromLastToken(null), null, 'no lastToken => do not invent a mint')
assert.ok(formatLastTokenDisplay({ symbol: '?', address: USDC }).includes(USDC))
assert.equal(formatLastTokenDisplay({ symbol: '?' }), 'None yet')
assert.equal(resolveClarkContextChain({ lastToken }), 'solana')
assert.notEqual(resolveClarkContextChain({ lastToken }), 'base')
assert.equal(resolveClarkContextChain({}, `scan this wallet ${DEAD} on base`), 'base')
assert.equal(resolveClarkContextChain({ lastToken }, 'what is the mint address?'), 'solana')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pageSrc = fs.readFileSync(path.join(__dirname, '../app/terminal/clark-ai/page.tsx'), 'utf8')
assert.ok(pageSrc.includes('AbortSignal.timeout'), 'page fetch uses AbortSignal.timeout')
assert.ok(pageSrc.includes('CLARK_TIMEOUT_MESSAGE') || pageSrc.includes('Clark timed out waiting for this scan'))
assert.ok(pageSrc.includes('contextChain'))
assert.ok(pageSrc.includes('resolveClarkContextChain'))
assert.ok(pageSrc.includes('resolvedChain'))
assert.ok(!pageSrc.includes("clk-context-sub'>Chain ID: 8453"))
assert.ok(!pageSrc.includes("clk-context-value'>Base</div><div className='clk-context-sub'>Chain ID: 8453"))

console.log('test-clark-live-context.mjs: all assertions passed')
