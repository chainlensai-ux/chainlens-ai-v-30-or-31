import assert from 'node:assert/strict'
import { fetchOnchainOwner } from '../lib/server/lpProof.ts'
import { resolveBaseRadarOwnershipFallback } from '../lib/server/baseRadarOwnership.ts'

const originalFetch = globalThis.fetch
function restore() { globalThis.fetch = originalFetch }

function mockRpcResult(result) {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ jsonrpc: '2.0', id: 1, result }),
  })
}

function mockRpcFailure() {
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) })
}

async function run() {
  // 1. owner() returns a real, non-zero address -> 'active', ownerAddress captured.
  {
    const ownerAddr = '0x' + '11'.repeat(19) + 'aa' // exactly 40 hex chars (20 bytes)
    assert.equal(ownerAddr.length, 42)
    const paddedHex = '0x' + ownerAddr.slice(2).padStart(64, '0')
    mockRpcResult(paddedHex)
    const result = await fetchOnchainOwner('base', '0xTOKENACTIVE00000000000000000000000001')
    assert.equal(result.status, 'active')
    assert.equal(result.ownerAddress, ownerAddr.toLowerCase())
  }

  // 2. owner() returns the zero address -> 'renounced'.
  {
    const paddedHex = '0x' + '0'.repeat(64)
    mockRpcResult(paddedHex)
    const result = await fetchOnchainOwner('base', '0xTOKENRENOUNCED0000000000000000000000')
    assert.equal(result.status, 'renounced')
  }

  // 3. owner() reverts / returns empty "0x" -> 'no_owner_function' (not "unavailable" — a genuine,
  // distinct fact: the standard Ownable getter simply isn't present on this contract).
  {
    mockRpcResult('0x')
    const result = await fetchOnchainOwner('base', '0xTOKENNOOWNERFN0000000000000000000000')
    assert.equal(result.status, 'no_owner_function')
  }

  // 4. RPC failure (network/HTTP error) -> 'unavailable', never thrown, never treated the same as
  // "no owner function" (a real negative fact) or silently promoted to any verified status.
  {
    mockRpcFailure()
    const result = await fetchOnchainOwner('base', '0xTOKENRPCFAIL00000000000000000000000')
    assert.equal(result.status, 'unavailable')
  }

  // 5. resolveBaseRadarOwnershipFallback wraps each case into the right evidence shape, and 'active'
  // ownership is never marked as anything softer than a real, verified risk fact.
  {
    const ownerAddr = '0x' + '22'.repeat(19) + 'bb' // exactly 40 hex chars (20 bytes)
    const paddedHex = '0x' + ownerAddr.slice(2).padStart(64, '0')
    mockRpcResult(paddedHex)
    const evidence = await resolveBaseRadarOwnershipFallback('base', '0xTOKENE2EACTIVE000000000000000000000')
    assert.equal(evidence.ownershipVerified, true)
    assert.equal(evidence.ownershipStatus, 'active_owner')
    assert.equal(evidence.ownerAddress, ownerAddr.toLowerCase())
    assert.equal(evidence.isRenounced, false)
  }

  // 6. 'no_owner_function' is reported as its own status, but is NOT marked ownershipVerified — it
  // only proves the Ownable owner() getter is absent, not that no privileged control exists at all
  // via a different pattern Token Scanner's fuller analysis might still find.
  {
    mockRpcResult('0x')
    const evidence = await resolveBaseRadarOwnershipFallback('base', '0xTOKENE2ENOOWNER0000000000000000000')
    assert.equal(evidence.ownershipStatus, 'no_owner_function_detected')
    assert.equal(evidence.ownershipVerified, false)
  }

  // 7. RPC unavailable -> resolver returns null (genuinely unknown), never a fabricated status.
  {
    mockRpcFailure()
    const evidence = await resolveBaseRadarOwnershipFallback('base', '0xTOKENE2EUNAVAILABLE0000000000000000')
    assert.equal(evidence, null)
  }

  console.log('test-base-radar-ownership.mjs: all assertions passed')
}

run().then(restore, (err) => { restore(); throw err })
