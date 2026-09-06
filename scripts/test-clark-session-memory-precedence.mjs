import assert from 'node:assert/strict'
import fs from 'node:fs'

// Clark/CORTEX audit Item 8: process-local SESSION_MEMORY is not authoritative.
// Precedence: explicit prompt > resolved request identity > scanner response >
// current chat memoryEcho > process-local Map. Cold start without the Map must still work.

const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
const memorySrc = fs.readFileSync(new URL('../lib/client/clarkMemory.ts', import.meta.url), 'utf8')
const routeCode = routeSrc.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')

assert.match(routeCode, /function applyClientContextMemoryPrecedence\(/, 'clientContext precedence helper must exist')
assert.match(routeCode, /applyClientContextMemoryPrecedence\(sessionMem, body\.clientContext, explicitTokenCommand\)/, 'restore path must apply clientContext over process-local memory')
assert.match(routeCode, /if \(!explicitTokenCommand && clientContextHas\(clientCtx, "lastToken"\)\)/, 'a present lastToken field, including null, beats SESSION_MEMORY')
assert.match(routeCode, /if \(clientContextHas\(clientCtx, "lastWallet"\)\)/, 'a present lastWallet field, including null, beats SESSION_MEMORY')
assert.match(routeCode, /if \(!sessionMem.lastToken && body\.clientContext\?\.lastToken\?\.address\) sessionMem.lastToken = body\.clientContext.lastToken/, 'omitted clientContext fields still gap-fill so a cold start can rehydrate')
assert.match(routeCode, /if \(!sessionMem.lastWallet && body\.clientContext\?\.lastWallet\?\.address\) sessionMem.lastWallet = body\.clientContext.lastWallet/, 'omitted lastWallet still gap-fills on cold start')
assert.match(routeSrc, /The entity in this message has precedence over all restored page\/session/, 'explicit current prompt still wins over restored memory')

assert.match(memorySrc, /lastToken: readJson\(LAST_TOKEN_KEY\) \?\? null/, 'cleared lastToken round-trips as null so JSON keeps the key')
assert.match(memorySrc, /lastWallet: readJson\(LAST_WALLET_KEY\) \?\? null/, 'cleared lastWallet round-trips as null so JSON keeps the key')

console.log('test-clark-session-memory-precedence.mjs: all assertions passed')
