// Clark deployer/creator checks — multi-chain hardening regression lock (this task):
//   1. The PRIMARY "/deployer" command path (routed.intent === "deployer_check", the one
//      classifyClarkPrompt actually routes a typed "/deployer" or "who deployed this" to) now calls
//      resolveTokenDeployer() FIRST — the fast, cached, chain-scoped Token Scanner lookup — before
//      ever falling back to the slow, full /api/dev-wallet route. Previously this handler skipped
//      the fast resolver entirely, which is the root cause of "/deployer does not work properly for
//      Robinhood and BNB" / "Clark is not consistently using the Token Scanner engine/cache".
//   2. No chain is ever silently substituted for ETH/Base when BNB/Robinhood fails — the resolver
//      call and its fallback are always keyed by the SAME resolved chain, never a hardcoded default.
//   3. resolveTokenDeployer() persists CONFIRMED results to the shared cross-instance KV cache
//      (lib/server/cache/tokenCache.ts) under the exact required key convention
//      `deployer:${chainSlug}:${tokenAddress}` — the real fix for "same token can confirm once,
//      then timeout later" (in-memory-only cache does not survive a serverless cold start / a
//      different warm instance).
//   4. Response headers are literally "DEPLOYER READ" (EVM) and "SOLANA CREATOR READ" (Solana) at
//      every real call site, not "DEPLOYER / DEV WALLET READ" or "SOLANA CREATOR / AUTHORITY READ".
//   5. The Solana deployer/creator answer reuses buildClarkDeployerAnswerActions (the same real
//      /holders, /lp, /token, /deployer, Open Token Scanner action set EVM gets) and writes the same
//      follow-up-reusable memory shape (chain, lastIntent: "deployer_check") EVM writes.
//   6. BNB and Robinhood both have real, distinct EXPLORER_CONFIG entries — never null/missing,
//      never aliased to eth/base.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolveTokenDeployer } from '../lib/server/deployerResolver.ts'

const routeSrc = readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
const resolverSrc = readFileSync(new URL('../lib/server/deployerResolver.ts', import.meta.url), 'utf8')

// ── 1. The routed deployer_check handler calls resolveTokenDeployer before the /api/dev-wallet
// fallback, and short-circuits (returns) when it finds a confirmed deployer. ─────────────────────
{
  const block = routeSrc.match(/if \(routed\.intent === "deployer_check"\) \{[\s\S]{0,20000}?\n  \}\n\n  if \(routed\.intent === "token_scan"\)/)
  assert.ok(block, 'the routed deployer_check handler block must exist')
  const body = block[0]
  const fastIdx = body.indexOf('resolveTokenDeployer(')
  const devWalletIdx = body.indexOf('callInternalApiCaught(origin, "/api/dev-wallet"')
  assert.ok(fastIdx > -1, 'the routed deployer_check handler must call resolveTokenDeployer()')
  assert.ok(devWalletIdx > -1, 'the routed deployer_check handler must still keep the full /api/dev-wallet fallback')
  assert.ok(fastIdx < devWalletIdx, 'resolveTokenDeployer() must be tried BEFORE the slow /api/dev-wallet fallback (fast, cached tier first)')
  assert.match(body, /if \(fastDeployer\?\.deployerAddress && thisDevChain\) \{[\s\S]{0,2200}return \{/, 'a fast-resolver hit must short-circuit with an immediate return, never fall through to the slow fallback')
}

// ── 2. No silent ETH/Base substitution: the same `thisDevChain` variable feeds both the fast
// resolver call and the /api/dev-wallet fallback call — never two different chain values, and never
// a bare "eth"/"base" literal used as a chain default anywhere in this handler. ───────────────────
{
  const block = routeSrc.match(/if \(routed\.intent === "deployer_check"\) \{[\s\S]{0,20000}?\n  \}\n\n  if \(routed\.intent === "token_scan"\)/)[0]
  assert.match(block, /chainSlug: thisDevChain, chainId: resolverChainId, tokenAddress: target/, 'the fast resolver must be called with the resolved chain, never a hardcoded one')
  assert.match(block, /chain: thisDevChain \}, authHeader/, 'the /api/dev-wallet fallback must be called with the SAME resolved chain the fast resolver used')
  // Chain-strict guard: resolverChainId is only assigned for the four real EVM chains this resolver
  // supports — no catch-all branch that defaults an unrecognized chain to 1 (eth) or 8453 (base).
  assert.match(block, /const resolverChainId = thisDevChain === "eth" \? 1 : thisDevChain === "base" \? 8453 : thisDevChain === "bnb" \? 56 : thisDevChain === "robinhood" \? 4663 : null;/,
    'resolverChainId must be null for any chain other than the four explicitly supported ones — never a default')
}

// ── 3. Cross-instance KV persistence, DISCLOSED root-cause fix for "confirms once, then times out
// later": confirmed results are written through to the shared tokenCache.ts KV module, keyed
// `deployer:${chainSlug}:${tokenAddress}`, and read back BEFORE any network call on a cache miss. ──
{
  assert.match(resolverSrc, /import \{ getTokenCache, setTokenCache \} from '@\/lib\/server\/cache\/tokenCache'/,
    'the resolver must reuse the existing shared (Vercel KV, cross-instance) cache module, not a new persistence layer')
  assert.match(resolverSrc, /const KV_KEY_PREFIX = 'deployer'/, 'the KV key prefix must be the exact required literal "deployer"')
  assert.match(resolverSrc, /function kvCacheKey\(chainSlug: ResolverChainSlug, tokenAddress: string\): string \{\s*\n\s*return `\$\{KV_KEY_PREFIX\}:\$\{chainSlug\}:\$\{tokenAddress\.toLowerCase\(\)\}`/,
    'the KV cache key must use the exact required convention deployer:${chainSlug}:${tokenAddressOrMint}')
  assert.match(resolverSrc, /const kvHit = await getTokenCache<ResolveTokenDeployerResult>\(kvCacheKey\(input\.chainSlug, tokenAddress\)\)/,
    'a same-instance cache miss must fall through to a cross-instance KV read before any network call')
  assert.match(resolverSrc, /if \(kvHit && kvHit\.deployerAddress\)/, 'only a CONFIRMED (real deployerAddress) KV entry is ever trusted — never a cached miss/timeout')
  const setCalls = (resolverSrc.match(/void setTokenCache\(kvCacheKey\(input\.chainSlug, tokenAddress\), result, KV_SUCCESS_TTL_SECONDS\)/g) ?? []).length
  assert.equal(setCalls, 2, 'both success tiers (explorer creation lookup, RPC earliest-transfer) must write their confirmed result through to KV')
  // A "not found" result must NEVER be persisted to KV — only the in-memory (process-lifetime, short
  // TTL) cache, so a different, possibly-healthier instance is always allowed to try again.
  const notFoundBlock = resolverSrc.slice(resolverSrc.indexOf('confidence: \'low\', evidenceSource: \'none\','))
  assert.doesNotMatch(notFoundBlock.slice(0, 400), /setTokenCache/, 'a not-found/unavailable result must never be written to the cross-instance KV cache')
}

// ── 4. Required literal response headers. ─────────────────────────────────────────────────────
{
  assert.match(routeSrc, /"DEPLOYER READ",\n\s*`Token: \$\{tokenNameFast\}/, 'the fast-tier /deployer answer must use the literal "DEPLOYER READ" header')
  assert.match(routeSrc, /overview: `DEPLOYER READ\\n\\n/, 'the tool-call fast-path renderer must use the literal "DEPLOYER READ" header')
  const deployerReadCount = (routeSrc.match(/"DEPLOYER READ"/g) ?? []).length
  assert.ok(deployerReadCount >= 4, `expected at least 4 real "DEPLOYER READ" literal headers across EVM call sites, found ${deployerReadCount}`)
  const solanaCreatorReadCount = (routeSrc.match(/"SOLANA CREATOR READ"/g) ?? []).length
  assert.equal(solanaCreatorReadCount, 2, 'both independent Solana deployer/creator call sites must use the literal "SOLANA CREATOR READ" header')
  assert.doesNotMatch(routeSrc, /SOLANA CREATOR \/ AUTHORITY READ/, 'the old non-literal Solana header must not remain anywhere')
  assert.doesNotMatch(routeSrc, /DEPLOYER \/ DEV WALLET READ/, 'the old non-literal EVM header must not remain anywhere')
}

// ── 5. Solana action-set and follow-up-memory parity with EVM. ──────────────────────────────────
{
  const buildSolanaFn = routeSrc.match(/async function buildSolanaCreatorAnswer\([\s\S]*?\n  \}\n/)
  assert.ok(buildSolanaFn, 'buildSolanaCreatorAnswer must exist')
  assert.match(buildSolanaFn[0], /ui: wantsDeployer\s*\n\s*\? \{ intentBadge: "Deployer Read", actions: buildClarkDeployerAnswerActions\(tokenAddress, "solana"\) \}/,
    'buildSolanaCreatorAnswer\'s deployer branch must reuse buildClarkDeployerAnswerActions with the real /holders /lp /token /deployer /Open-Token-Scanner action set, and expose it via ui.actions (the field the client actually renders)')
  assert.match(buildSolanaFn[0], /lastIntent: "deployer_check"/, 'a Solana deployer answer must write the same lastIntent: "deployer_check" memory shape EVM does')
  assert.match(buildSolanaFn[0], /if \(wantsDeployer\) updateMemIntent\(sessionMem!, "deployer_check"\);/, 'session-level lastIntent must also be updated for follow-up routing to recognize the Solana deployer answer')

  // The second, independent "who deployed this" Solana branch (plan.intent === "dev_wallet") gets
  // the same treatment — real actions via ui.actions, and follow-up memory.
  const legacySolBlock = routeSrc.match(/if \(isValidSolanaMintAddress\(resolvedAddress\)\) \{[\s\S]{0,6500}?\n      \};\n    \}/)
  assert.ok(legacySolBlock, 'the legacy dev_wallet intent\'s own Solana branch must exist')
  assert.match(legacySolBlock[0], /ui: \{ intentBadge: "Deployer Read", actions: buildClarkDeployerAnswerActions\(resolvedAddress, "solana"\) \}/,
    'the legacy Solana deployer branch must also expose real actions via ui.actions')
  assert.match(legacySolBlock[0], /updateMemToken\(sessionMem!, resolvedAddress, null, null, lines\.join\("\\n"\), \{ chain: "solana", lastIntent: "deployer_check" \}\);/,
    'the legacy Solana deployer branch must also write follow-up-reusable token memory (previously missing entirely)')
}

// ── 6. BNB and Robinhood are real, distinct, never-aliased EXPLORER_CONFIG entries. ─────────────
{
  assert.match(resolverSrc, /bnb: \{\s*\n\s*explorerName: 'BscScan \(Etherscan V2\)'/, 'BNB must have its own real explorer config entry')
  assert.match(resolverSrc, /chainid=56/, 'BNB explorer lookup must use chainid=56 (BNB), never 1 (eth) or 8453 (base)')
  assert.match(resolverSrc, /robinhood: \{\s*\n\s*explorerName: 'Robinhood Chain Blockscout'/, 'Robinhood must have its own real explorer config entry')
  assert.match(resolverSrc, /robinhoodchain\.blockscout\.com/, 'Robinhood must use its own real Blockscout instance, never an eth/base explorer')
  // Never a shared/fallback branch that maps bnb or robinhood chain slugs onto eth/base config.
  assert.doesNotMatch(resolverSrc, /bnb:\s*EXPLORER_CONFIG\.eth/, 'BNB must never alias the eth explorer config')
  assert.doesNotMatch(resolverSrc, /robinhood:\s*EXPLORER_CONFIG\.(eth|base)/, 'Robinhood must never alias the eth/base explorer config')
}

// ── 7. Live resolver behavior: same address on different chains never shares a result, and a
// resolved result is stable across repeated calls (works with or without KV configured — KV read/
// write both fail open to "no-op"/"miss" in a test environment with no KV credentials). ──────────
{
  const addr = '0x' + '99'.repeat(20)
  const [bnbResult, robinhoodResult] = await Promise.all([
    resolveTokenDeployer({ chainSlug: 'bnb', chainId: 56, tokenAddress: addr }),
    resolveTokenDeployer({ chainSlug: 'robinhood', chainId: 4663, tokenAddress: addr }),
  ])
  assert.ok(typeof bnbResult.confidenceReason === 'string' && bnbResult.confidenceReason.length > 0, 'BNB lookup must return a real confidenceReason even when unresolved')
  assert.ok(typeof robinhoodResult.confidenceReason === 'string' && robinhoodResult.confidenceReason.length > 0, 'Robinhood lookup must return a real confidenceReason even when unresolved')
  // Repeated call for the same chain/token must be stable (same-instance cache), never flip results.
  const repeat = await resolveTokenDeployer({ chainSlug: 'bnb', chainId: 56, tokenAddress: addr })
  assert.equal(repeat.deployerAddress, bnbResult.deployerAddress, 'repeated lookups for the same chain/token must return a stable result')
}

// ── 8. Response-format parity, DISCLOSED (this task): the slow-path (/api/dev-wallet) fallback
// template must produce the SAME field set/order as the fast-path template — Chain:, Evidence
// source:, high/medium/low confidence vocabulary, and the full 5-item /holders /lp /token /deployer
// Open-Token-Scanner Next list — never the older "Status:"/"open_check" shape. ────────────────────
{
  const block = routeSrc.match(/if \(routed\.intent === "deployer_check"\) \{[\s\S]{0,20000}?\n  \}\n\n  if \(routed\.intent === "token_scan"\)/)[0]
  const slowIdx = block.indexOf('const dw = devRes.json as Record<string, unknown>;')
  assert.ok(slowIdx > -1, 'the slow-path (/api/dev-wallet) success branch must exist')
  const slowBlock = block.slice(slowIdx)
  assert.match(slowBlock, /`Chain: \$\{chainDisplayLabel\(thisDevChain\)\}`/, 'the slow-path template must include a Chain: line, matching the fast-path template')
  assert.match(slowBlock, /`Evidence source: \$\{evidenceLabelSlow\}`/, 'the slow-path template must include an Evidence source: line, matching the fast-path template')
  assert.match(slowBlock, /`- Confidence: \$\{deployerConfidence \?\? "low"\}`/, 'the slow-path confidence must use the real high\/medium\/low vocabulary, never a fake level')
  assert.doesNotMatch(slowBlock, /open_check/, 'the fabricated "open_check" confidence level must never appear again')
  assert.doesNotMatch(slowBlock, /- Status: \$\{deployerStatus/, 'the old non-"Why" Status: line must be gone')
  assert.match(slowBlock, /"- \/holders",\n\s*"- \/lp",\n\s*"- \/token",\n\s*"- \/deployer",\n\s*"- Open Token Scanner",/,
    'the slow-path Next: action list must match the fast path\'s full 5-item list (previously missing /token and /deployer)')
}

// ── 9. No `?? "base"` chain-mislabeling remains reachable anywhere in the deployer_check handler —
// every write either uses the resolved chain directly (proven non-null by an earlier guard) or
// routes to an honest chain-not-supported response instead of a fabricated "base" label. ──────────
{
  const block = routeSrc.match(/if \(routed\.intent === "deployer_check"\) \{[\s\S]{0,20000}?\n  \}\n\n  if \(routed\.intent === "token_scan"\)/)[0]
  assert.doesNotMatch(block, /thisDevChain \?\? "base"/, 'no site in the deployer_check handler may silently substitute "base" for a null/unresolved chain')
}

// ── 10. The failure response itemizes chain attempted / sources attempted / missing config / next
// action explicitly — never just "Source failed: ...". ────────────────────────────────────────────
{
  const block = routeSrc.match(/if \(routed\.intent === "deployer_check"\) \{[\s\S]{0,20000}?\n  \}\n\n  if \(routed\.intent === "token_scan"\)/)[0]
  assert.match(block, /`Chain attempted: \$\{thisDevChain \? chainDisplayLabel\(thisDevChain\) : chainDisplayLabel\(chainForClarkTools\)\}`/,
    'the failure response must explicitly itemize the chain attempted')
  assert.match(block, /`Sources attempted: \$\{attemptedSources\.length > 0 \? attemptedSources\.join\(", "\) : /,
    'the failure response must explicitly itemize the sources attempted')
  assert.match(block, /`Missing config\/source: \$\{missingConfig\}`/, 'the failure response must explicitly name the missing config/source')
  assert.match(block, /Next best action: Open Token Scanner/, 'the failure response must explicitly name a next best action')
}

// ── 11. Wrong-chain cache rejection for a non-Base chain: a Base cache entry for address X must
// never satisfy a BNB (or Robinhood) request for the same address X — the resolver's cache keys are
// chain-scoped by construction (`${chainSlug}:${tokenAddress}` in-memory, `deployer:${chainSlug}:
// ${tokenAddress}` in the KV tier), never address-only. ─────────────────────────────────────────
{
  const addr = '0x' + 'ab'.repeat(20)
  const baseResult = await resolveTokenDeployer({ chainSlug: 'base', chainId: 8453, tokenAddress: addr })
  const bnbResult = await resolveTokenDeployer({ chainSlug: 'bnb', chainId: 56, tokenAddress: addr })
  // Even when both resolve to "not found" in this network-less test env, they must be independently
  // computed, distinct result objects — never the same cached object served across chains.
  assert.notEqual(baseResult, bnbResult, 'a Base result object must never be the same cached object served for a BNB request on the same address')
  assert.match(resolverSrc, /function cacheKey\([^)]*\): string \{\s*\n\s*return `\$\{chainSlug\}:\$\{tokenAddress\.toLowerCase\(\)\}`/,
    'the in-memory cache key must be chain-scoped (chainSlug:tokenAddress), never address-only')
}

console.log('test-clark-deployer-multichain.mjs: all assertions passed')
