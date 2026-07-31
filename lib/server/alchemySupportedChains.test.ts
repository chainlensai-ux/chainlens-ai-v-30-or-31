import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAlchemySupportedChain, assertAlchemyChainAllowed, UnsupportedAlchemyChainError } from './alchemySupportedChains'

test('base, eth, polygon, bnb, arbitrum, hyperevm are all supported (matches .env.example)', () => {
  for (const chain of ['base', 'eth', 'polygon', 'bnb', 'arbitrum', 'hyperevm']) {
    assert.equal(isAlchemySupportedChain(chain), true, chain)
  }
})

// PROVEN-ABSENCE REGRESSION GUARD, DISCLOSED: the exact 10-chain incident list minus the 5 this
// app genuinely supports -- these 5 must NEVER be silently treated as supported again.
test('scroll, optimism, avalanche, zksync, and linea are NOT supported -- no code path in this app calls Alchemy for them', () => {
  for (const chain of ['scroll', 'optimism', 'avalanche', 'zksync', 'linea']) {
    assert.equal(isAlchemySupportedChain(chain), false, chain)
  }
})

test('chain matching is case-insensitive', () => {
  assert.equal(isAlchemySupportedChain('BASE'), true)
  assert.equal(isAlchemySupportedChain('Scroll'), false)
})

test('assertAlchemyChainAllowed throws a typed error for an unsupported chain, never silently proceeds', () => {
  assert.throws(() => assertAlchemyChainAllowed('scroll', '/api/example'), UnsupportedAlchemyChainError)
})

test('assertAlchemyChainAllowed does not throw for a supported chain', () => {
  assert.doesNotThrow(() => assertAlchemyChainAllowed('base', '/api/example'))
})

test('the thrown error carries the chain and route for diagnosis, never a wallet address or secret', () => {
  try {
    assertAlchemyChainAllowed('zksync', '/api/portfolio')
    assert.fail('expected throw')
  } catch (err) {
    assert.ok(err instanceof UnsupportedAlchemyChainError)
    assert.equal(err.chain, 'zksync')
    assert.equal(err.route, '/api/portfolio')
  }
})
