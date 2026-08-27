import assert from 'node:assert/strict'
import fs from 'node:fs'

// TOKEN-NAME-UNKNOWN FIX, DISCLOSED.
//
// Reported live with screenshots: "the deployment is saying unkhown tho dont u see" — real BNB and
// Robinhood Chain deployer lookups both answered "Unknown token (?) was deployed by 0x...", on real,
// live tokens, every time. Root cause: resolveTokenDeployer() (lib/server/deployerResolver.ts) — the
// fast, narrow deployer resolver used by the dev_wallet_analyze tool handler — only ever resolved the
// deployer ADDRESS. It never fetched the token's own name/symbol, and the fast path deliberately never
// runs a full token scan (that's the entire point of it being fast), so evidence.tokenScan and
// evidence.liquidity — the only other sources the dev_wallet response builder read token identity
// from — were always empty on this path. The name/symbol fallback chain bottomed out at the literal
// string "Unknown token" every single time the fast resolver answered, regardless of chain.
//
// Fix: resolveTokenDeployer() now also does a real, cheap ERC20 name()/symbol() eth_call (same
// selectors and ABI-decode logic as app/api/token/route.ts's rpcTokenString), fired in PARALLEL with
// the deployer lookup so it adds no latency to the common case. Threaded through
// evidence.devWallet.tokenName/tokenSymbol and added as a fallback in the dev_wallet response
// builder's tokenName/tokenSymbol derivation, ahead of the "Unknown token"/"?" literal defaults.

const resolverSrc = fs.readFileSync(new URL('../lib/server/deployerResolver.ts', import.meta.url), 'utf8')
const resolverCode = resolverSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

assert.match(resolverCode, /tokenName: string \| null\s*\n\s*tokenSymbol: string \| null/, 'ResolveTokenDeployerResult must carry tokenName/tokenSymbol')
assert.match(resolverCode, /async function tryTokenNameSymbol\(/, 'a real ERC20 name()\\/symbol() RPC helper must exist')
assert.match(resolverCode, /const ERC20_NAME_SELECTOR = '0x06fdde03'/, 'must use the real ERC20 name() selector')
assert.match(resolverCode, /const ERC20_SYMBOL_SELECTOR = '0x95d89b41'/, 'must use the real ERC20 symbol() selector')

// Must be fired in parallel with the deployer lookup, not chained after it (no added latency to the
// common case).
assert.match(
  resolverCode,
  /const nameSymbolPromise = tryTokenNameSymbol\(input\.chainSlug, tokenAddress\)\s*\n\s*\n\s*const explorer = await tryExplorerCreationLookup/,
  'the name\\/symbol RPC must be fired before (in parallel with) the explorer lookup, not after it'
)

// Every return path (explorer success, RPC fallback success, and the final not-found path) must
// carry the resolved token identity — never just the fast-tier success paths.
const tokenNameAssignments = (resolverCode.match(/tokenName: nameSymbol\.name, tokenSymbol: nameSymbol\.symbol,/g) ?? []).length
assert.equal(tokenNameAssignments, 3, `all 3 return sites (explorer success, rpc success, not-found) must carry token identity, found ${tokenNameAssignments}`)

// The decode helper must never leave a raw NUL byte in the regex source (a JSON-escaping mistake
// caught during this fix — \\u0000 as a JSON string escape decodes to an actual NUL character, not
// the 6-character JS regex literal).
assert.doesNotMatch(resolverSrc, /replace\(\/\x00\/g/, 'the null-byte-strip regex must be the literal source text \\u0000, never a raw embedded NUL byte')
assert.match(resolverSrc, /replace\(\/\\u0000\/g, ''\)/, 'the decode helper must strip null bytes via the literal \\u0000 regex')

const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
const routeCode = routeSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

assert.match(routeCode, /tokenName\?: string \| null;\s*\n\s*tokenSymbol\?: string \| null;/, 'ClarkToolEvidence.devWallet must carry tokenName/tokenSymbol')
assert.match(
  routeCode,
  /tokenName: fastResult\.tokenName,\s*\n\s*tokenSymbol: fastResult\.tokenSymbol,/,
  'the fast-path evidence.devWallet assignment must carry the resolver\'s tokenName/tokenSymbol through'
)
assert.match(
  routeCode,
  /resolvedSymbol \?\? evidence\.devWallet\?\.tokenName \?\? "Unknown token";/,
  'the dev_wallet response builder\'s tokenName fallback chain must check evidence.devWallet.tokenName before defaulting to the literal "Unknown token"'
)
assert.match(
  routeCode,
  /resolvedSymbol \?\? evidence\.devWallet\?\.tokenSymbol \?\? "\?";/,
  'the dev_wallet response builder\'s tokenSymbol fallback chain must check evidence.devWallet.tokenSymbol before defaulting to "?"'
)

console.log('test-clark-deployer-token-identity.mjs: all assertions passed')
