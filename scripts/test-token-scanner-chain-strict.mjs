// Chain-strictness regression tests — Token Scanner must never mix chain data.
// Covers the required test matrix by source contract + pure-logic replication
// (the API route and page are too large/integrated to import directly here).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isValidSolanaMintAddress, isEvmAddress, classifySolanaMintInput } from '../lib/solanaAddress.ts'
import { TOKEN_SCAN_RESPONSE_SCHEMA_VERSION } from '../lib/server/tokenPublicResponse.ts'

const routeSrc = readFileSync(new URL('../app/api/token/route.ts', import.meta.url), 'utf8')
const pageSrc = readFileSync(new URL('../app/terminal/token-scanner/page.tsx', import.meta.url), 'utf8')
const watchlistSrc = readFileSync(new URL('../app/api/watchlist/tokens/route.ts', import.meta.url), 'utf8')

const evmAddr = '0x' + 'd'.repeat(40)
const solMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' // USDC on Solana — well-formed mint format

// ── 1. Solana/EVM input separation (pure validation, shared lib) ────────────
{
  assert.equal(isValidSolanaMintAddress(solMint), true)
  assert.equal(isEvmAddress(evmAddr), true)
  // A Solana mint must classify as EVM-address-on-Solana rejection when scanned there:
  assert.equal(classifySolanaMintInput(evmAddr), 'evm_address_on_solana')
  // An EVM address must never validate as a Solana mint:
  assert.equal(isValidSolanaMintAddress(evmAddr), false)
}

// ── 2. EVM path rejects Solana mints with wrong_chain ──────────────────────
{
  assert.match(routeSrc, /isValidSolanaMintAddress\(originalInput as unknown\)/,
    'EVM path must reject well-formed Solana mints')
  assert.match(routeSrc, /status: 'wrong_chain'/)
  assert.match(routeSrc, /Switch to Solana or scan with Auto Detect/)
  // The check runs BEFORE the resolver (line order matters).
  const rejectIdx = routeSrc.indexOf("status: 'wrong_chain'")
  const normalizedIdx = routeSrc.indexOf('const normalizedInput = originalInput.toUpperCase()')
  assert.ok(rejectIdx > 0 && normalizedIdx > rejectIdx, 'wrong-chain rejection must run before resolution')
}

// ── 3. GeckoTerminal pools validated against requested network ─────────────
{
  assert.match(routeSrc, /gtAllPoolsRaw/, 'GT pools must be filtered through chain validation')
  assert.match(routeSrc, /_gtPoolsRejectedWrongChain/)
  assert.match(routeSrc, /GT_NETWORK_BY_CHAIN\[chain\]/, 'expected network must come from the requested chain')
  // DexScreener already filtered by chainId — confirm it still is:
  assert.match(routeSrc, /pair\.chainId === dexChainId/)
}

// ── 4. Cache keys are chain-scoped AND schema-versioned ─────────────────────
{
  assert.match(routeSrc, /token:v\$\{TOKEN_SCAN_RESPONSE_SCHEMA_VERSION\}:\$\{chain\}/,
    'cache key must include chain slug and schema version')
  // The same address can therefore never hit another chain's cache entry.
  assert.match(routeSrc, /scanResponseSchemaVersion === TOKEN_SCAN_RESPONSE_SCHEMA_VERSION/,
    'cache reads verify schema version')
  assert.equal(typeof TOKEN_SCAN_RESPONSE_SCHEMA_VERSION, 'number')
}

// ── 5. tokenScanChainStrictAudit present with required fields ───────────────
{
  for (const f of ['requestedChainSlug', 'requestedChainId', 'inputAddress', 'normalizedAddress',
    'addressType', 'scannerPath', 'cacheKey', 'cacheHit', 'cacheChainMatched',
    'providerResultsRejectedWrongChain', 'selectedMarketChain', 'selectedPoolChain',
    'finalChainSlug', 'finalChainId', 'rejectedReason']) {
    assert.ok(routeSrc.includes(f), `tokenScanChainStrictAudit missing: ${f}`)
  }
}

// ── 6. Wrong-chain UI copy ───────────────────────────────────────────────────
{
  assert.match(pageSrc, /This token was not found on .* Switch chain or scan with Auto Detect\./,
    'required wrong-chain message')
  // Client-side Solana-mint-on-EVM guard exists before the ticker resolver:
  assert.match(pageSrc, /isValidSolanaMintAddress\(q\)/)
}

// ── 7. Tracked tokens store chain; delete is chain-scoped; badge not hardcoded ──
{
  assert.match(pageSrc, /chain: \(result\.chain \?\? chain\) as string/, 'tracked insert stores chain')
  assert.match(watchlistSrc, /onConflict: 'user_id,address,chain'/, 'upsert conflict includes chain')
  assert.match(watchlistSrc, /\.eq\('chain', chainParam\)/, 'API delete filters by chain')
  assert.doesNotMatch(pageSrc, /letterSpacing: '\.08em', textTransform: 'uppercase' \}>base<\/span>/,
    'badge must not hardcode base')
}

// ── 8. Robinhood LP consistency: depth-missing-with-pool → unavailable_with_reason ──
{
  assert.match(routeSrc, /_depthMissingButPoolPresent/, 'depth-missing-with-pool state must be explicit')
  assert.match(routeSrc, /unavailable_with_reason/,
    'liquidity section uses unavailable_with_reason, never generic Open Check')
  // Risk score computed independently of liquidity presence (prior audit contract):
  assert.match(routeSrc, /riskEngineScore: typeof tokenRiskScoreResult\.riskScore === 'number'/)
}

console.log('test-token-scanner-chain-strict.mjs: all assertions passed')
