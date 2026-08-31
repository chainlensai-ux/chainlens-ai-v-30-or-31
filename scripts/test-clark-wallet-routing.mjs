// Clark /wallet routing + canonical engine fix (this task):
//   1. classifyClarkContractSubtype (app/api/clark/route.ts) narrows a bare "has bytecode" contract
//      hit into token / pair / contract_wallet / unknown BEFORE any "not a wallet" rejection — a
//      contract wallet (Safe, smart wallet, proxy wallet) is never auto-rejected.
//   2. The /wallet entity gate only rejects as "not a wallet" when the contract is a CONFIRMED token
//      or pair — never a bare/unclassified contract hit.
//   3. Every /wallet-shaped response (inline-address entity gate, appIntent wallet_scan,
//      routed.intent === "wallet_scan" memory follow-up) shares ONE helper —
//      buildClarkWalletReadResponse — which calls the SAME canonical runWalletScan() engine the
//      Wallet Scanner page itself uses, never the old getWalletFromV2/mapWalletRunnerResult shape.
//   4. Deep Scan Wallet really calls runWalletScan with scanDepth: 'deep'.
//   5. formatCanonicalWalletRead (lib/server/clarkRouting.ts) renders the required WALLET READ
//      template (Overview/Behavior/PnL/Evidence/CTA) from the orchestrator's real return fields,
//      never a raw debug dump, never fake PnL.
//   6. A pool/pair contract gets a distinct "pool contract, not wallet" reply with LP actions.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  formatTokenContractNotWalletReply,
  formatPoolContractNotWalletReply,
  formatCanonicalWalletRead,
  buildClarkWalletAnswerActions,
  buildClarkLpAnswerActions,
} from '../lib/server/clarkRouting.ts'

const routeSrc = readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
const routeCode = routeSrc.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')

const WALLET = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
const TOKEN = '0x940181a94A35A4569E4529A3CDfB74e38FD98631'

// ── 1. classifyClarkContractSubtype exists, is used before rejecting a wallet question on a
// contract, and fails open (never 'token'/'pair') on an RPC failure. ───────────────────────────────
{
  assert.match(routeSrc, /async function classifyClarkContractSubtype\(/, 'classifyClarkContractSubtype must exist')
  assert.match(routeSrc, /export type ClarkContractSubtype = "token" \| "pair" \| "contract_wallet" \| "unknown";/, 'subtype must include a real contract-wallet bucket, not just token/pair')
  assert.match(routeSrc, /if \(!rpcUrl\) return "unknown";/, 'subtype classifier must fail open to unknown, never guess token/pair, when RPC is unavailable')
  assert.match(routeSrc, /if \(\(name \|\| symbol\) && totalSupplyHex != null\) return "token";/, 'token confirmation requires BOTH real name\\/symbol AND totalSupply evidence')
  assert.match(routeSrc, /return "contract_wallet";/, 'a contract that is neither a confirmed token nor a confirmed pair must be treated as a contract wallet, never auto-rejected')
}

// ── 2. The /wallet entity gate: mismatch only fires for a CONFIRMED token/pair subtype — a bare
// resolvedEntityType === 'contract' hit is no longer sufficient by itself. ─────────────────────────
{
  assert.match(
    routeCode,
    /\(questionCategory === 'wallet' && resolvedEntityType === 'contract' && contractSubtype === 'token'\) \? 'wallet_question_token_address' :/,
    'wallet-question-on-token mismatch must require a CONFIRMED token subtype, not bare contract code',
  )
  assert.match(
    routeCode,
    /\(questionCategory === 'wallet' && resolvedEntityType === 'contract' && contractSubtype === 'pair'\) \? 'wallet_question_pair_address' :/,
    'a confirmed pair contract must be its own distinct mismatch case',
  )
  assert.doesNotMatch(
    routeCode,
    /\(questionCategory === 'wallet' && resolvedEntityType === 'contract'\) \? 'wallet_question_token_address'/,
    'the OLD bare-bytecode rejection must be gone — every contract hit used to reject as "not a wallet"',
  )
}

// ── 3. Never treat every 0x address with code as a token: an unresolved/contract_wallet subtype
// falls through to the real wallet-scan branch, never the token-rejection reply. ───────────────────
{
  assert.match(
    routeCode,
    /if \(questionCategory === 'wallet' && !mismatch\) \{\s*return await buildClarkWalletReadResponse\(/,
    'a wallet question with no confirmed token\\/pair mismatch must run the canonical wallet-scan response, not fall through to a rejection',
  )
}

// ── 4. Canonical engine: buildClarkWalletReadResponse is the ONE place that calls runWalletScan(),
// and every /wallet call site (entity gate, appIntent.wallet_scan, routed wallet_scan follow-up)
// uses it — none of them still builds its primary reply from getWalletFromV2/mapWalletRunnerResult. ─
{
  assert.match(
    routeSrc,
    /async function buildClarkWalletReadResponse\(params: \{[\s\S]{0,400}\}\): Promise<Record<string, unknown>> \{/,
    'buildClarkWalletReadResponse must exist with the documented params shape',
  )
  const helperIdx = routeSrc.indexOf('async function buildClarkWalletReadResponse')
  assert.ok(helperIdx > -1, 'buildClarkWalletReadResponse must be defined')
  const helperBlock = [routeSrc.slice(helperIdx, helperIdx + 3600)]
  assert.ok(helperBlock, 'buildClarkWalletReadResponse body must be found')
  assert.match(helperBlock[0], /const result = await runWalletScan\(\{/, 'buildClarkWalletReadResponse must call the canonical runWalletScan()')
  assert.match(helperBlock[0], /walletAddress: address,/)
  assert.match(helperBlock[0], /chainMode: "all_supported",/, '/wallet must scan all supported chains, matching the Wallet Scanner preview default')
  assert.match(helperBlock[0], /scanDepth: deepScan \? "deep" : "preview",/, 'scanDepth must reflect the real requested depth — preview by default, deep only when asked')
  assert.match(helperBlock[0], /source: "clark",/)
  assert.match(helperBlock[0], /formatCanonicalWalletRead\(address, \{/, 'the reply must be formatted from the canonical result shape')
  assert.doesNotMatch(helperBlock[0], /getWalletFromV2|mapWalletRunnerResult/, 'buildClarkWalletReadResponse must never fall back to the old V2-report engine')

  // Every real /wallet call site now delegates to the shared helper.
  const appIntentBlock = routeSrc.match(/if \(appIntent\.intent === 'wallet_scan'[\s\S]{0,1400}?\n  \}/)
  assert.ok(appIntentBlock, 'appIntent.intent === wallet_scan block must exist')
  assert.match(appIntentBlock[0], /return await buildClarkWalletReadResponse\(\{/, 'appIntent wallet_scan branch must delegate to the shared canonical-engine helper')
  assert.doesNotMatch(appIntentBlock[0], /getWalletFromV2\(walletAddress\)/, 'appIntent wallet_scan branch must no longer build its primary reply from the old engine')

  const routedBlock = routeSrc.match(/if \(routed\.intent === "wallet_scan" && routed\.address[\s\S]{0,1200}?\n  \}/)
  assert.ok(routedBlock, 'routed.intent === "wallet_scan" block must exist')
  assert.match(routedBlock[0], /return await buildClarkWalletReadResponse\(\{/, 'routed wallet_scan follow-up must delegate to the shared canonical-engine helper')
  assert.doesNotMatch(routedBlock[0], /getWalletFromV2\(routed\.address\)/, 'routed wallet_scan follow-up must no longer build its primary reply from the old engine')
}

// ── 5. Deep Scan Wallet action really reaches deep mode: wantsWalletDeepScan()/routed.deep both
// flow into buildClarkWalletReadResponse's deepScan param, which is threaded straight into
// runWalletScan's scanDepth. ────────────────────────────────────────────────────────────────────
{
  assert.match(routeCode, /deepScan: wantsWalletDeepScan\(prompt\),/, 'the entity-gate wallet-scan branch must derive deepScan from the real prompt, not a hardcoded value')
  assert.match(routeCode, /deepScan: Boolean\(routed\.deep\),/, 'the routed wallet_scan follow-up (e.g. "deep scan it") must forward the real routed.deep flag')
}

// ── 6. formatCanonicalWalletRead renders the required template and never leaks raw debug/fake PnL. ─
{
  const preview = formatCanonicalWalletRead(WALLET, {
    chainsScanned: ['base', 'eth'],
    totalValueUsd: 12345.67,
    holdings: [
      { chain: 'base', symbol: 'AERO', valueUsd: 10000 },
      { chain: 'eth', symbol: 'WETH', valueUsd: 2345.67 },
    ],
    activitySummary: { uniqueTransactions: 8, note: null },
    pnlStatus: 'available',
    realizedPnlUsd: 500.5,
    unrealizedPnlUsd: -20,
    pricingCoverage: 'ok',
    evidenceSources: ['v2_pipeline'],
    missingEvidence: [],
    scanMode: 'preview',
  })
  assert.match(preview, /^WALLET READ — 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045/, 'must start with the required WALLET READ header')
  assert.match(preview, /Overview:/)
  assert.match(preview, /Total portfolio value: \$12,345\.67/)
  assert.match(preview, /Chains found: base, eth/)
  assert.match(preview, /Holdings count: 2/)
  assert.match(preview, /Top holdings: AERO \(base, \$10,000\), WETH \(eth, \$2,345\.67\)/)
  assert.match(preview, /Behavior:/)
  assert.match(preview, /Active chains: base, eth/)
  assert.match(preview, /Recent activity summary: 8 unique transactions observed/)
  assert.match(preview, /PnL:/)
  assert.match(preview, /Realized PnL \(verified\): \$500\.5/)
  assert.match(preview, /Evidence:/)
  assert.match(preview, /Sources used: V2 chain pipeline/)
  assert.match(preview, /Pricing coverage: ok/)
  assert.match(preview, /Missing evidence: none/)
  assert.match(preview, /CTA: Deep Scan Wallet \/ Open Wallet Scanner \/ Track Wallet \/ Explain PnL/)
  assert.ok(!/debug|rawReport|finalReport|walletChainSelectionAudit/i.test(preview), 'must never leak raw debug/internal field names')

  // Unavailable PnL must be honest, never a fake number.
  const noPnl = formatCanonicalWalletRead(WALLET, {
    chainsScanned: ['base'],
    totalValueUsd: 0,
    holdings: [],
    activitySummary: { uniqueTransactions: 0, note: null },
    pnlStatus: 'unavailable',
    pricingCoverage: 'unknown',
    evidenceSources: ['v2_pipeline'],
    missingEvidence: ['No verified swaps found for this wallet.'],
    scanMode: 'preview',
  })
  assert.match(noPnl, /Status: unavailable — No verified swaps found for this wallet\./)
  assert.ok(!/Realized PnL \(verified\)/.test(noPnl), 'must never print a verified PnL line when pnlStatus is not available')

  // Deep scan must report an honest queued status, never a fabricated completed result.
  const deep = formatCanonicalWalletRead(WALLET, {
    chainsScanned: ['base', 'eth'],
    totalValueUsd: null,
    holdings: [],
    activitySummary: { uniqueTransactions: null, note: null },
    pnlStatus: 'unsupported',
    pricingCoverage: 'unknown',
    evidenceSources: ['async_job_queue'],
    missingEvidence: [],
    scanMode: 'deep',
    jobStatus: 'queued',
    jobId: 'job-123',
  })
  assert.match(deep, /Deep scan queued \(job job-123\) — poll Wallet Scanner for the completed multi-chain result\./)
  assert.ok(!/is complete\b|scan finished|100%|fully scanned/i.test(deep), 'deep scan must never claim it already finished — only an honest queued status')
}

// ── 7. Pool/pair-on-wallet-question reply is distinct from the token reply, with LP actions. ───────
{
  const poolReply = formatPoolContractNotWalletReply('Base')
  assert.match(poolReply, /^This is a pool\/pair contract, not a wallet\./)
  assert.match(poolReply, /CTA: \/lp, Open Token Scanner/)
  assert.ok(!/token contract/i.test(poolReply), 'pool reply must not reuse the token-contract wording')

  const tokenReply = formatTokenContractNotWalletReply('Base')
  assert.match(tokenReply, /^This is a token contract, not a wallet\./)
  assert.notEqual(poolReply, tokenReply)

  assert.match(
    routeCode,
    /if \(mismatch === 'wallet_question_pair_address'\) \{[\s\S]{0,400}formatPoolContractNotWalletReply/,
    'the pair mismatch branch must use the distinct pool/pair reply',
  )
  const lpActions = buildClarkLpAnswerActions(TOKEN, 'base')
  assert.ok(lpActions.some((a) => a.label === 'Open Token Scanner'))
}

// ── 8. buildClarkWalletAnswerActions provides the required real, clickable action set including a
// real Deep Scan Wallet action. ─────────────────────────────────────────────────────────────────
{
  const actions = buildClarkWalletAnswerActions(WALLET)
  assert.deepEqual(actions.map((a) => a.label), ['Deep Scan Wallet', 'Open Wallet Scanner', 'Track Wallet', 'Explain PnL'])
  const deepScanAction = actions.find((a) => a.label === 'Deep Scan Wallet')
  assert.equal(deepScanAction.kind, 'prompt')
  assert.match(routeCode, /function wantsWalletDeepScan\(prompt: string\): boolean \{\s*return \/\\b\(deep\\s\*scan/, 'the prompt the Deep Scan Wallet chip submits must be recognized by wantsWalletDeepScan')
}

console.log('test-clark-wallet-routing.mjs OK')
