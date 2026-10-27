// Early Buyers UI: presentation helpers and server-rendered report markup. The engine and API are
// untouched; these tests pin how its response is displayed.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import EarlyBuyersReport from '../app/terminal/token-scanner/EarlyBuyersReport'
import { coverageCodes, formatTokenAmount, orderedGroups, reasonLabel, recipientsByAmount, sharedBlockGroups } from '../app/terminal/token-scanner/earlyBuyersView'
import { EARLY_BUYER_WINDOW_SCOPE, type BuyerGroup, type EarlyBuyer, type EarlyBuyerIntel } from '../lib/server/earlyBuyers/types'

const hex = (n: number, len: number) => `0x${n.toString(16).padStart(len, '0')}`
const wallet = (i: number) => hex(i + 1, 40)
const tx = (i: number) => hex(i + 1, 64)
const POOL = `0x${'2'.repeat(40)}`

function buyer(i: number, over: Partial<EarlyBuyer> = {}): EarlyBuyer {
  return { wallet: wallet(i), purchaseProven: false, boughtRaw: `${(i + 1) * 1_000}000000000000000000`, heldRaw: `${i * 500}000000000000000000`, transactions: [tx(i)], blocks: [100 + (i % 5)], evidence: [{ txHash: tx(i), pool: POOL, block: 100 + (i % 5), timestampSec: 1_760_000_000 + i, reason: 'pool_sourced_token_delivery_in_swap_transaction' }], ...over }
}

function intel(n: number, over: Partial<EarlyBuyerIntel> = {}): EarlyBuyerIntel {
  const buyers = Array.from({ length: n }, (_, i) => buyer(i))
  const groups: BuyerGroup[] = n > 1 ? [{ tier: 'T1', associationType: 'shared_transaction_delivery', wallets: buyers.map((b) => b.wallet), transactions: [tx(9999)], reason: 'One transaction delivered pool-sourced tokens to multiple recipients; payment or common ownership is not proven', boughtWithinEarlySetPct: 100, heldWithinEarlySetPct: 100 }] : []
  const base: EarlyBuyerIntel = {
    status: 'verified', evidenceStatus: 'verified', holdingsStatus: 'available',
    launch: { status: 'verified', block: 100, pool: POOL, creationTx: tx(5000), liquidityTx: tx(5001) },
    window: { startBlock: 100, endBlock: 119, pools: [POOL], buysObserved: n },
    buyers, groups, sameBlockCount: 0, launchDistributions: [],
    coverage: { capped: false, reasons: [], provisional: false, scope: EARLY_BUYER_WINDOW_SCOPE },
    budget: { calls: 30, cu: 971, externalRequests: 1, actualProviderCu: null },
    discovery: { earliestDiscoveredPool: POOL, earliestVerifiedPool: POOL, candidates: [{ pool: POOL, createdAt: 1, outcome: 'verified', reason: 'factory_creation_and_first_liquidity_events_verified' }], complete: true },
  }
  const merged = { ...base, ...over }
  merged.sameBlockCount = over.sameBlockCount ?? sharedBlockGroups(merged).walletCount
  return merged
}

const render = (i: EarlyBuyerIntel, decimals: number | null = 18) => renderToStaticMarkup(createElement(EarlyBuyersReport, { intel: i, chain: 'base', decimals, tokenSymbol: 'TKN' }))
const count = (html: string, needle: string | RegExp) => (html.match(typeof needle === 'string' ? new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g') : needle) ?? []).length

// ── Amount formatting ─────────────────────────────────────────────────────────────────────────────
test('amounts convert only with supplied decimals; without decimals the exact raw integer is shown and labelled raw', () => {
  assert.deepEqual(formatTokenAmount('1000000000000000000000', 18), { text: '1,000', exact: '1,000', unit: 'token' })
  assert.deepEqual(formatTokenAmount('1000000000000000000000', null), { text: '1,000,000,000,000,000,000,000', exact: '1,000,000,000,000,000,000,000', unit: 'raw' })
  assert.equal(formatTokenAmount('12345678900000000000000000', 18).text, '12.34M')
  assert.equal(formatTokenAmount('12345678900000000000000000', 18).exact, '12,345,678.9')
  assert.equal(formatTokenAmount('1500000', 6).text, '1.5')
  assert.equal(formatTokenAmount('1', 18).text, '0.000000000000000001', 'a non-zero amount never rounds to 0')
  assert.equal(formatTokenAmount('0', 18).text, '0')
  assert.equal(formatTokenAmount('5', 3.5 as unknown as number).unit, 'raw', 'non-integer decimals are not trusted')
  // 42 raw digits with 18 decimals = 999,999,999,999,999,999,999.99… tokens: compact in T, exact kept.
  assert.equal(formatTokenAmount('999999999999999999999999999999999999999999', 18).text, '999,999,999,999.99T')
  assert.equal(formatTokenAmount('999999999999999999999999999999999999999999', 18).exact, '999,999,999,999,999,999,999,999.999999999999999999', 'very long values keep exact BigInt precision')
})

test('recipients are ordered by amount received without precision loss', () => {
  const ordered = recipientsByAmount([buyer(0, { boughtRaw: '900719925474099300' }), buyer(1, { boughtRaw: '900719925474099301' }), buyer(2, { boughtRaw: '5' })])
  assert.deepEqual(ordered.map((b) => b.boughtRaw), ['900719925474099301', '900719925474099300', '5'])
})

// ── T3 regrouping ─────────────────────────────────────────────────────────────────────────────────
test('T3 per-block list is shown only when it reproduces the engine count', () => {
  const i = intel(6) // fixture recipients land in blocks 100..104, so only recipients 0 and 5 share block 100
  const t3 = sharedBlockGroups(i)
  assert.equal(t3.matchesEngine, true)
  assert.equal(t3.walletCount, 2)
  assert.deepEqual(t3.blocks, [{ block: 100, wallets: [wallet(0), wallet(5)] }])
  assert.equal(sharedBlockGroups({ ...i, sameBlockCount: 3 }).matchesEngine, false)
  const html = render({ ...i, sameBlockCount: 3 })
  assert.match(html, /could not be reproduced exactly/)
})

test('groups keep tier meaning: T1 first, then T2, larger first', () => {
  const g = (tier: 'T1' | 'T2', n: number): BuyerGroup => ({ tier, wallets: Array.from({ length: n }, (_, i) => wallet(i)), transactions: [tx(n)], reason: 'r', boughtWithinEarlySetPct: null, heldWithinEarlySetPct: null })
  assert.deepEqual(orderedGroups([g('T2', 9), g('T1', 2), g('T1', 5)]).map((x) => `${x.tier}${x.wallets.length}`), ['T1-5', 'T1-2', 'T2-9'].map((s) => s.replace('-', '')))
})

// ── Rendering at 1 / 5 / 32 / 100 recipients ─────────────────────────────────────────────────────
for (const n of [1, 5, 32, 100]) {
  test(`renders ${n} recipient(s) compactly with collapsed lists`, () => {
    const html = render(intel(n))
    const rows = count(html, /<tr><td data-label="Recipient">/g)
    assert.equal(rows, Math.min(n, 10), 'table starts with at most 10 rows')
    if (n > 10) assert.match(html, new RegExp(`Show all ${n} recipients \\(\\+${n - 10}\\)`))
    if (n > 1) {
      assert.match(html, /T1<\/span>Shared transaction delivery/)
      assert.match(html, new RegExp(`${n} recipients · 1 transaction`))
      if (n > 4) assert.match(html, new RegExp(`Show all ${n} recipients \\(\\+${n - 4}\\)`), 'group shows 4 recipients first')
    }
    assert.ok(html.length < 120_000, `markup stays bounded (${html.length} chars)`)
  })
}

test('collapse controls are buttons with aria-expanded and aria-controls', () => {
  const html = render(intel(32))
  const buttons = html.match(/<button[^>]*>/g) ?? []
  assert.ok(buttons.length > 3)
  for (const b of buttons) {
    assert.match(b, /type="button"/)
    assert.match(b, /aria-expanded="false"/)
    assert.match(b, /aria-controls="[^"]+"/)
  }
  assert.match(html, /<details class="eb-details"><summary>Evidence details<\/summary>/)
})

// ── Decimals, holdings states ────────────────────────────────────────────────────────────────────
test('missing decimals: quantities are raw and labelled as such', () => {
  const html = render(intel(2), null)
  assert.match(html, /raw on-chain units — token decimals not verified/)
  assert.match(html, /2,000,000,000,000,000,000,000<span class="eb-unit">raw<\/span>/)
  assert.doesNotMatch(html, /eb-unit">TKN</)
})

test('holdings: unavailable is never shown as zero; a measured zero stays zero', () => {
  const unavailable = render(intel(3, { holdingsStatus: 'unavailable', buyers: intel(3).buyers.map((b) => ({ ...b, heldRaw: null })) }))
  assert.match(unavailable, /UNAVAILABLE/)
  assert.match(unavailable, /Not read — not zero/)
  assert.equal(count(unavailable, '>Unavailable<'), 6, 'balance and current-vs-received cells for each of 3 recipients')
  assert.doesNotMatch(unavailable, /<td data-label="Current balance" class="eb-num"><span class="eb-amt"[^>]*>0</)

  const zero = render(intel(2, { buyers: [buyer(0, { heldRaw: '0' }), buyer(1)] }))
  assert.match(zero, /<td data-label="Current balance" class="eb-num"><span class="eb-amt" title="0 TKN · 0 raw">0<span class="eb-unit">TKN<\/span>/)

  const failed = render(intel(2, { holdingsStatus: 'failed' }))
  assert.match(failed, /FAILED/)
  assert.equal(count(failed, '>Unavailable<') >= 2, true, 'failed refresh never shows balances')

  const cached = render(intel(2, { budget: { calls: 0, cu: 0 }, currentHoldings: { blockNumber: 77000, blockTimestampSec: 1_760_000_000, readAtMs: 1_760_000_001_000, source: 'cache', cacheAgeSec: 95, walletsRead: 2, walletsObserved: 2 } }))
  assert.match(cached, /block 77000 · 2025-10-09 08:53:20 UTC · cached, 1m 35s old/)
  const live = render(intel(2, { currentHoldings: { blockNumber: 77000, blockTimestampSec: null, readAtMs: 1_760_000_001_000, source: 'live', cacheAgeSec: 0, walletsRead: 2, walletsObserved: 2 } }))
  assert.match(live, /block 77000 · live read/)
  const unrecorded = render(intel(2))
  assert.match(unrecorded, /Read for every recipient · read block not recorded/)
})

// ── Coverage, holdings snapshot, supply exposure, balance comparison ─────────────────────────────
test('receipt cap: the window tile states receipts inspected, never "N blocks read"', () => {
  const capped = render(intel(5, { status: 'partial', evidenceStatus: 'partial', window: { startBlock: 100, endBlock: 119, pools: [POOL], buysObserved: 50, examined: { startBlock: 100, endBlock: 112, receipts: 50, swapTransactions: 80 } }, coverage: { capped: true, reasons: ['receipt_cap_50'], provisional: false, scope: EARLY_BUYER_WINDOW_SCOPE } }))
  assert.doesNotMatch(capped, /blocks read/)
  assert.match(capped, /50 of 80 swap transactions inspected · blocks 100–112/)
  assert.match(capped, /Swap logs were requested for blocks 100–119, but receipts were inspected only for 50 of 80 swap transactions · blocks 100–112/)
  const complete = render(intel(3, { window: { startBlock: 100, endBlock: 119, pools: [POOL], buysObserved: 3, examined: { startBlock: 100, endBlock: 104, receipts: 3, swapTransactions: 3 } } }))
  assert.match(complete, /All 3 swap transactions inspected \(blocks 100–104\)/)
  const legacy = render(intel(3))
  assert.match(legacy, /20 nominal blocks · receipt coverage not recorded/)
  assert.doesNotMatch(legacy, /blocks read/)
})

test('supply exposure: one exact sentence with denominator and coverage, or fail closed with no percentage', () => {
  const exposure = { status: 'available' as const, reason: null, blockNumber: 77000, totalSupplyRaw: '1000', observedHeldRaw: '52', observedPct: 5.2, ordinaryHeldRaw: '40', ordinaryPct: 4, walletsIncluded: 3, excludedSharedRecipients: [wallet(2)] }
  const html = render(intel(3, { supplyExposure: exposure, currentHoldings: { blockNumber: 77000, blockTimestampSec: null, readAtMs: 1, source: 'live', cacheAgeSec: 0, walletsRead: 3, walletsObserved: 3 } }))
  assert.match(html, /Observed early recipients currently hold <strong[^>]*>5.2%<\/strong> of token supply\./)
  assert.match(html, /3 of 3 observed recipients · block 77000 · live read/)
  assert.match(html, /Denominator: totalSupply\(\) at the same block/)
  assert.match(html, /not the whole launch cohort and not an inferred wallet cluster/)
  assert.match(html, /Excluding 1 shared recipient: 4% of supply \(same total supply\)/)
  assert.match(html, /Present-day state — not launch evidence/)
  const closed = render(intel(3, { holdingsStatus: 'partial', supplyExposure: { ...exposure, status: 'unavailable', reason: 'holdings_incomplete', observedPct: null, observedHeldRaw: null, ordinaryPct: null, ordinaryHeldRaw: null, walletsIncluded: 0 } }))
  assert.match(closed, /Supply exposure unavailable — current balances were not read for every observed recipient\. No percentage is shown\./)
  assert.doesNotMatch(closed, /currently hold/)
  assert.match(render(intel(3)), /Supply exposure unavailable/, 'no exposure field means no figure')
})

test('current vs received never says bought more, sold, profit or loss', () => {
  const html = render(intel(3, { buyers: [buyer(0, { boughtRaw: '100', heldRaw: '250' }), buyer(1, { boughtRaw: '100', heldRaw: '0' }), buyer(2, { boughtRaw: '300', heldRaw: '100' })] }))
  assert.match(html, /Current balance exceeds observed launch receipts \(250% of the amount observed received\)/)
  assert.match(html, />250% · exceeds</)
  assert.match(html, />0% · zero balance</)
  assert.match(html, />33.33%</)
  assert.match(html, /Not evidence of a sale, transfer, profit or loss/)
  assert.doesNotMatch(html, /bought more|sold|profit(?! or loss)|realized/i)
  const unread = render(intel(2, { holdingsStatus: 'unavailable', buyers: intel(2).buyers.map((b) => ({ ...b, heldRaw: null })) }))
  assert.equal(count(unread, '<td data-label="Current vs received" class="eb-num" title="Current balance was not read, so no comparison is made."><span class="eb-unavail">Unavailable</span>'), 2)
})

test('shared recipients are listed with their evidence and tagged, and T1 shows both denominators', () => {
  const FEE = wallet(40)
  const shared = { wallet: FEE, classification: 'fee_or_distribution_pattern' as const, transactions: [tx(1), tx(2), tx(3)], partnerClusters: 3, signers: 3, shareBps: { min: 500, max: 500 }, reason: 'Received a near-constant 5.00–5.00% of the pool-sourced delivery; ownership and purpose are not proven' }
  const base = intel(3)
  const html = render({ ...base, buyers: [...base.buyers, buyer(40)], groups: [{ ...base.groups[0], boughtWithinEarlySetPct: 80, boughtWithinOrdinaryRecipientsPct: 100 }], deliveryGraph: { source: 'transaction_facts', multiRecipientTransactions: 4, linkingTransactions: 1, sharedRecipients: [shared], unlinkedRecipients: 0, denominators: { observedRecipients: 4, observedDeliveredRaw: '1', ordinaryRecipients: 3, ordinaryDeliveredRaw: '1' } } })
  assert.match(html, /Fee or distribution pattern/)
  assert.match(html, /Not used to link other recipients into T1/)
  assert.match(html, /5.00–5.00%/)
  assert.match(html, /1 shared recipient set aside/)
  assert.match(html, /Share of all observed deliveries<\/dt><dd>80%/)
  assert.match(html, /Share excluding shared recipients<\/dt><dd>100%/)
  assert.match(html, />Shared</)
  for (const h of shared.transactions) assert.match(html, new RegExp(`https://basescan.org/tx/${h}`))
})

// ── Coverage ─────────────────────────────────────────────────────────────────────────────────────
test('partial + receipt cap: explained in plain words, raw codes preserved in Evidence details', () => {
  const html = render(intel(5, { status: 'partial', evidenceStatus: 'partial', coverage: { capped: true, reasons: ['receipt_cap_50', 'window_not_finalized'], provisional: true, scope: EARLY_BUYER_WINDOW_SCOPE } }))
  assert.match(html, /Partial evidence/)
  assert.match(html, /Missing data is not evidence of no activity/)
  assert.match(html, /Only the first 50 swap receipts in the window were read/)
  assert.match(html, /<span class="eb-code">receipt_cap_50<\/span>/)
  assert.match(html, /PROVISIONAL/)
})

test('comma-joined and unknown coverage codes are split and shown verbatim', () => {
  assert.deepEqual(coverageCodes(['a,b', 'b', ' c ']), ['a', 'b', 'c'])
  assert.equal(reasonLabel('something_new'), 'something_new')
  assert.equal(reasonLabel('rpc_http_503'), 'The RPC provider returned HTTP 503.')
})

test('associations not evaluated on an unverified launch are not presented as "none found"', () => {
  const html = render(intel(1, { status: 'partial', evidenceStatus: 'partial', launch: { status: 'estimated', block: 100, pool: POOL, creationTx: null, liquidityTx: null }, groups: [], discovery: { earliestDiscoveredPool: POOL, earliestVerifiedPool: null, candidates: [], complete: false } }))
  assert.match(html, /does not mean no associations exist/)
  assert.doesNotMatch(html, /No shared-transaction or shared-block associations were observed/)
})

test('all disclaimers and explorer links of the response are present', () => {
  const i = intel(3, { launchDistributions: [{ wallet: wallet(50), rawAmount: '1000', txHash: tx(50) }] })
  const html = render(i)
  assert.match(html, /Pool-sourced token delivery is not proof that each recipient paid or coordinated/)
  assert.match(html, /Coordination and individual payment are not proven/)
  assert.match(html, /creator-origin launch distributions observed separately; not counted as buys/)
  assert.match(html, /actual provider billing unavailable here/)
  for (const h of [tx(5000), tx(5001), tx(9999), tx(0), tx(50)]) assert.match(html, new RegExp(`https://basescan.org/tx/${h}`))
  assert.match(html, new RegExp(`https://basescan.org/address/${wallet(0)}`))
  // Explorer links open safely in a new tab.
  for (const a of html.match(/<a [^>]*>/g) ?? []) { assert.match(a, /target="_blank"/); assert.match(a, /rel="noopener noreferrer"/) }
})

test('Ethereum results link to Etherscan', () => {
  const html = renderToStaticMarkup(createElement(EarlyBuyersReport, { intel: intel(2), chain: 'eth', decimals: 18, tokenSymbol: 'PEPE' }))
  assert.match(html, /https:\/\/etherscan.io\/tx\//)
  assert.doesNotMatch(html, /basescan/)
})

// ── API consumption unchanged ────────────────────────────────────────────────────────────────────
test('panel still calls the same endpoint with the same body and reads the same response field', () => {
  const src = readFileSync(join(process.cwd(), 'app/terminal/token-scanner/EarlyBuyersPanel.tsx'), 'utf8')
  assert.match(src, /fetch\('\/api\/token\/early-buyers', \{ method: 'POST'/)
  assert.match(src, /body: JSON.stringify\(\{ chain, contract \}\)/)
  assert.match(src, /payload\.earlyBuyerIntel/)
  const page = readFileSync(join(process.cwd(), 'app/terminal/token-scanner/page.tsx'), 'utf8')
  assert.match(page, /decimals=\{result\.walletDetailMetadata\?\.decimals \?\? null\}/, 'only provider-verified decimals are passed, never the 18 default')
})
