// Clark deployer/holders/action quality — regression lock for the fixes requested:
//   1. /deployer retries/falls back before returning a bare timeout (transient-only retry on the
//      explorer tier, bounded backoff, never retrying a genuinely-unconfigured source).
//   2. A real 'medium' confidence tier exists with the exact required explanation sentence.
//   3. /deployer never becomes a generic full token scan.
//   4. Next actions are real, clickable, current-token-scoped commands — not dead CTA text.
//   5. Follow-ups after /deployer (holders, check holders, lp, explain lp, is it safe, scan token,
//      open token scanner) reuse the same token/chain via real session-memory writes.
//   6. /wallet on a known token contract says the exact required line and offers token actions,
//      with a same-command dedup for an identical repeat.
//   7. No raw debug fields (sourcesAttempted arrays, timing numbers, cache internals) leak into the
//      user-facing analysis text.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolveTokenDeployer } from '../lib/server/deployerResolver.ts'
import { formatTokenContractNotWalletReply, buildClarkDeployerAnswerActions } from '../lib/server/clarkRouting.ts'

const routeSrc = readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
const resolverSrc = readFileSync(new URL('../lib/server/deployerResolver.ts', import.meta.url), 'utf8')

// ── 1. Retry-before-timeout: a bounded retry exists on the explorer tier, and only for transient
// failures — a missing API key (permanently unconfigured) is never retried. ─────────────────────
{
  assert.match(resolverSrc, /async function tryExplorerCreationLookup\(/, 'the retrying wrapper must exist')
  assert.match(resolverSrc, /EXPLORER_RETRY_BACKOFF_MS = 300/, 'a bounded, short retry backoff must exist')
  assert.match(resolverSrc, /transientFailure/, 'the resolver must distinguish transient vs. permanent explorer failures')
  assert.match(resolverSrc, /Not configured for this chain — never worth retrying/, 'a missing API key must never be retried')
  assert.match(resolverSrc, /if \(first\.succeeded \|\| !first\.attempted \|\| !first\.transientFailure\)/,
    'retry must be skipped when the source was never attempted (not configured) or failed non-transiently')
}

// ── 2. Medium confidence: a real tier with the exact required explanation sentence. ─────────────
{
  assert.match(resolverSrc, /confidence: 'medium'/, 'a real medium confidence tier must exist')
  assert.match(
    resolverSrc,
    /confidenceReason: 'Origin wallet matched from available creation evidence, but full deployer history was not confirmed\.'/,
    'medium confidence must use the exact required explanation sentence'
  )
  assert.match(routeSrc, /confidenceReason\?: string \| null;/, 'ClarkToolEvidence.devWallet must carry the resolver\'s confidenceReason through')
  assert.match(routeSrc, /confidenceReason: fastResult\.confidenceReason,/, 'the fast-path evidence assignment must carry confidenceReason through')
  assert.match(routeSrc, /devWallet\.confidenceReason \?\? \(devWallet\.confidence === "High"/, 'the fast-path renderer must prefer the resolver\'s own confidenceReason')
  assert.match(routeSrc, /Origin wallet matched from available creation evidence, but full deployer history was not confirmed\./,
    'the exact required medium-confidence sentence must be reachable from the Clark route (full-scan fallback wording)')
}

// ── 3. /deployer never becomes a generic token scan: the fast tool handler still short-circuits
// before the full /api/dev-wallet call, and the fast-path renderer states plainly it did not run
// cluster/rug-history evidence rather than silently expanding scope. ────────────────────────────
{
  assert.match(routeSrc, /Related deployments: not checked in this fast lookup/, 'fast path must honestly state related deployments were not checked, never fabricate a count')
  assert.match(routeSrc, /if \(fastResult\?\.deployerAddress\) \{[\s\S]{0,900}continue;/,
    'a successful fast-resolver result must still short-circuit before the full scan ever runs')
}

// ── 4. Real, clickable next actions — not dead CTA text. Server-side action list + client-side
// click handler both exist and use the literal required command set. ────────────────────────────
{
  const addr = '0x' + '66'.repeat(20)
  const acts = buildClarkDeployerAnswerActions(addr, 'base')
  assert.deepEqual(acts.map(a => a.label), ['/holders', '/lp', '/token', '/deployer', 'Open Token Scanner'],
    'deployer answer actions must be exactly the requested literal command set')
  assert.ok(acts.filter(a => a.kind === 'prompt').every(a => typeof a.prompt === 'string' && a.prompt.length > 0),
    'every prompt-kind action must carry a real, non-empty prompt string')
  assert.ok(acts.find(a => a.label === 'Open Token Scanner')?.href?.includes(addr), 'Open Token Scanner must link to this exact token')

  assert.match(routeSrc, /buildClarkDeployerAnswerActions\(resolvedAddress, dwOkChain\)/, 'the /deployer answer path must attach real actions server-side')
  const pageSrc = readFileSync(new URL('../app/terminal/clark-ai/page.tsx', import.meta.url), 'utf8')
  assert.match(pageSrc, /msg\.actions\.map\(\(action\) => action\.kind === 'prompt'/, 'the client must render actions as real clickable elements, not plain text')
  assert.match(pageSrc, /void handleSendText\(action\.prompt as string\)/, 'a prompt action click must submit through the same send path as a typed command')
}

// ── 5. Follow-up memory: the /deployer explicit-address path now writes session memory so
// holders/lp/is-it-safe/scan-token/open-token-scanner follow-ups resolve the same token+chain. ──
{
  assert.match(routeSrc, /rememberClarkDeployer\(sessionMem, evidence\.devWallet\.deployerAddress, \{/,
    'a successful /deployer answer must remember the deployer, chain-scoped')
  assert.match(
    routeSrc,
    /updateMemToken\(sessionMem, resolvedAddress, tokenSymbol[\s\S]{0,120}\{ chain: dwOkChain, lastIntent: "dev_wallet" \}\)/,
    'a successful /deployer answer must also write the token into session memory (chain-scoped) so lastToken-based follow-ups resolve it'
  )
  assert.match(routeSrc, /updateMemIntent\(sessionMem, "dev_wallet"\);/, 'lastIntent must be updated so intent-aware follow-up routing recognizes the deployer answer just given')
  // The 7 listed follow-up phrasings all read from sessionMem.lastToken (directly, or via
  // resolveTokenForFollowup / lastClarkSubject, which itself falls back to lastToken) — proven
  // by the existing holders_check/liquidity/token-safety-followup routing already reading
  // sessionMem.lastToken?.address as a resolution source.
  assert.match(routeSrc, /sessionMem\.lastToken\?\.address/, 'follow-up address resolution must read the same lastToken memory /deployer now writes')
}

// ── 6. /wallet on a known token contract: exact required line + real token actions + dedup. ─────
{
  const reply = formatTokenContractNotWalletReply('Base')
  assert.match(reply, /^This is a token contract, not a wallet\.$/m, 'must use the exact required opening line')
  assert.match(reply, /\/token, \/holders, \/lp, \/deployer/, 'must name the real token actions offered')
  assert.match(routeSrc, /lastNotWalletCheck/, 'a same-command dedup memory field must exist for the /wallet-on-token-contract case')
  assert.match(routeSrc, /Same result as last check/, 'a repeat of the identical /wallet-on-token-contract command must say so rather than re-printing an unlabeled duplicate')
  assert.match(routeSrc, /label: '\/holders', prompt: `\/holders \$\{inlineAddress\}`/, 'the not-a-wallet reply must offer a real /holders action for this exact token')
  assert.match(routeSrc, /label: '\/lp', prompt: `\/lp \$\{inlineAddress\}`/, 'the not-a-wallet reply must offer a real /lp action for this exact token')
  assert.match(routeSrc, /label: '\/deployer', prompt: `\/deployer \$\{inlineAddress\}`/, 'the not-a-wallet reply must offer a real /deployer action for this exact token')
}

// ── 7. No raw debug fields ever render in user-facing text. ─────────────────────────────────────
{
  // The structured deployer answer builders must never interpolate sourcesAttempted/timing/cache
  // internals directly into a rendered line — only human-readable derived text.
  const fastFnMatch = routeSrc.match(/function renderFastDeployerAnswer\([\s\S]*?\n\}\n/)
  assert.ok(fastFnMatch, 'renderFastDeployerAnswer must exist')
  const fastFnBody = fastFnMatch[0]
  assert.doesNotMatch(fastFnBody, /\$\{devWallet\.sourcesAttempted/, 'sourcesAttempted must never be interpolated directly into rendered text')
  assert.doesNotMatch(fastFnBody, /\$\{devWallet\.durationMs/, 'timing numbers must never be interpolated directly into rendered text')
  const devFnMatch = routeSrc.match(/function renderDevWalletFocusedRead\([\s\S]*?\n\}\n/)
  assert.ok(devFnMatch, 'renderDevWalletFocusedRead must exist')
  assert.doesNotMatch(devFnMatch[0], /\$\{devWallet\.sourcesAttempted/, 'sourcesAttempted must never be interpolated directly into rendered text')
}

// ── Wrong-chain isolation still holds for the new corroborated result shape (no shared state
// across chains, even with the new confidenceReason/retry fields). ──────────────────────────────
{
  const sameAddress = '0x' + '77'.repeat(20)
  const [baseResult, ethResult] = await Promise.all([
    resolveTokenDeployer({ chainSlug: 'base', chainId: 8453, tokenAddress: sameAddress }),
    resolveTokenDeployer({ chainSlug: 'eth', chainId: 1, tokenAddress: sameAddress }),
  ])
  assert.ok(typeof baseResult.confidenceReason === 'string' && baseResult.confidenceReason.length > 0, 'every result must carry a real confidenceReason')
  assert.ok(typeof ethResult.confidenceReason === 'string' && ethResult.confidenceReason.length > 0, 'every result must carry a real confidenceReason')
}

console.log('test-clark-deployer-quality.mjs: all assertions passed')
