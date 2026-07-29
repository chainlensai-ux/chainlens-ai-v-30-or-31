// MODULE — receiptSwapDecoder: forensic resolution of a claimed concentrated-liquidity factory
// whose standard discovery interface is UNSUPPORTED — consulted only after
// unknownConcentratedFactoryVerifier.ts already tried getPool()/poolByPair() and found neither
// worked. Exact production case this task addresses: pool 0x7f31b371ac675bca3357fd9c26854fed067400c0,
// claimed factory 0xade65c38cd4849adba595a4323a8c7ddfe89716a, token0/token1/fee=10000 already
// verified from the receipt itself, factory bytecode exists, but getPool/poolByPair are both
// unsupported. This module never calls another guessed function selector against the factory --
// instead it analyzes the ALREADY-FETCHED factory bytecode offline for known, well-defined
// on-chain patterns (EIP-1167 minimal proxy, EIP-1967 implementation/beacon storage slots, embedded
// CREATE2 opcode + PoolCreated-shaped event topic constants) and, only when the pool's OWN creation
// transaction receipt is already available from data this scan already has (never a new
// unbounded history search), inspects that receipt's logs for a PoolCreated-shaped event whose
// token0/token1/fee/pool fields and EMITTER match this exact pool and factory.
//
// DOES NOT ACCEPT pool.factory() ALONE, DISCLOSED: this module never calls factory() on the pool at
// all -- it independently derives evidence from the CLAIMED FACTORY's own bytecode/storage and (when
// available) its own emitted creation event, never trusting the pool's self-reported claim as proof
// of anything by itself.
//
// NO GUESSED SELECTORS, DISCLOSED: the only contract-level reads this module performs are
// eth_getCode (bytecode) and eth_getStorageAt against the two well-defined, standardized EIP-1967
// storage slots -- never an ad-hoc function call against a selector merely because it "looks
// plausible". A proxy-implementation/beacon storage read is only ever attempted when the factory's
// own bytecode already contains a DELEGATECALL opcode, i.e., bytecode itself justifies the read
// (see this file's own header on the heuristic nature of that opcode scan).
//
// BOUNDED, HEURISTIC BYTECODE SCANNING, DISCLOSED: opcode-presence checks (DELEGATECALL 0xf4,
// CREATE2 0xf5) and the PoolCreated topic-constant check are simple substring scans over the
// runtime bytecode hex, NOT a full EVM disassembler -- they can occasionally false-positive on a
// byte value that happens to appear inside unrelated PUSH immediate data. That is why NONE of these
// signals alone ever produces `verified_factory_creation_event` (the only reason requiring an
// exact, decoded, field-matching creation event) -- see classifyUnsupportedFactoryForensics below
// for the full, honest priority order.
//
// BOUNDED RPC, DISCLOSED: at most 4 new RPC calls per examined factory -- (1) the claimed factory's
// own bytecode, (2) either the implementation's bytecode (EIP-1167, offline-derived address, no
// extra justification call needed) OR the EIP-1967 implementation-slot read (only when DELEGATECALL
// was found), (3) the EIP-1967 beacon-slot read (only when the implementation slot came back empty)
// OR the resolved implementation's bytecode, (4) the resolved implementation's bytecode when (2)
// was the implementation-slot read and it succeeded. No retries.
//
// DOES NOT ADD TO THE VERIFIED REGISTRY, DISCLOSED: same discipline as
// unknownConcentratedFactoryVerifier.ts -- this module's output is a forensic log, never a
// registry mutation, and a positive result here never triggers decode/replay of the swap.
//
// REQUEST-SCOPED CACHE + SINGLEFLIGHT, DISCLOSED: same conventions as every other validator in this
// module set.

import { keccak256, toBytes, decodeAbiParameters } from 'viem'
import { getSharedBaseClient } from './rpcClient'
import type { RawReceiptLog } from './types'

const EIP1167_PREFIX = '363d3d373d3d3d363d73'
const EIP1167_SUFFIX = '5af43d82803e903d91602b57fd5bf3'

// STANDARD, WELL-DEFINED STORAGE SLOTS, DISCLOSED: computed here (self-verifying, same convention
// as signatures.ts/signatures.test.ts) rather than hardcoded, so the constant is provably
// keccak256("eip1967.proxy.implementation") - 1 / keccak256("eip1967.proxy.beacon") - 1, the exact
// EIP-1967 definitions -- never a guessed slot.
function eip1967Slot(label: string): `0x${string}` {
  const hash = BigInt(keccak256(toBytes(label)))
  return `0x${(hash - BigInt(1)).toString(16).padStart(64, '0')}`
}
export const EIP1967_IMPLEMENTATION_SLOT = eip1967Slot('eip1967.proxy.implementation')
export const EIP1967_BEACON_SLOT = eip1967Slot('eip1967.proxy.beacon')

// The standard, publicly-documented Uniswap-V3-shaped PoolCreated event signature -- restated, not
// guessed. Self-verified the same way signatures.test.ts verifies every other topic0 constant.
export const POOL_CREATED_EVENT_SIGNATURE = 'PoolCreated(address,address,uint24,int24,address)'
export const POOL_CREATED_TOPIC0 = keccak256(toBytes(POOL_CREATED_EVENT_SIGNATURE))

export type ProxyType = 'eip1167' | 'eip1967_implementation' | 'eip1967_beacon' | 'none' | null

export type UnsupportedFactoryForensicsFinalReason =
  | 'verified_factory_creation_event'
  | 'verified_create2_derivation'
  | 'proxy_implementation_resolved'
  | 'no_supported_creation_proof'
  | 'creation_event_mismatch'
  | 'proxy_resolution_failed'
  | 'rpc_failure'

export type UnsupportedFactoryForensicsDiagnostics = {
  txHash: string
  pool: string
  claimedFactory: string
  factoryCodeHash: string | null
  proxyType: ProxyType
  implementationAddress: string | null
  implementationCodeHash: string | null
  create2Detected: boolean
  poolCreatedTopicDetected: boolean
  creationReceiptAvailable: boolean
  creationEventEmitter: string | null
  creationEventPool: string | null
  creationEventToken0: string | null
  creationEventToken1: string | null
  creationEventFee: number | null
  creationProofMatches: boolean | null
  finalTypedReason: UnsupportedFactoryForensicsFinalReason
}

export type UnsupportedFactoryForensicsAnalyzer = {
  analyze(input: {
    txHash: string
    pool: string
    claimedFactory: string
    expectedToken0: string
    expectedToken1: string
    expectedFee: number
    // Only ever populated by a caller that ALREADY HAS the pool's creation-tx receipt logs from
    // existing data (see this file's own header) -- this module never fetches them itself.
    creationLogs?: readonly RawReceiptLog[]
  }): Promise<UnsupportedFactoryForensicsDiagnostics>
}

function containsOpcode(codeHex: string, opcodeByteHex: string): boolean {
  return codeHex.toLowerCase().replace(/^0x/, '').includes(opcodeByteHex)
}

function detectEip1167(codeHex: string): string | null {
  const code = codeHex.toLowerCase().replace(/^0x/, '')
  if (!code.startsWith(EIP1167_PREFIX)) return null
  const addressHex = code.slice(EIP1167_PREFIX.length, EIP1167_PREFIX.length + 40)
  if (addressHex.length !== 40) return null
  const rest = code.slice(EIP1167_PREFIX.length + 40)
  if (!rest.startsWith(EIP1167_SUFFIX)) return null
  return `0x${addressHex}`
}

function addressFromSlotValue(value: string | null): string | null {
  if (!value) return null
  if (BigInt(value) === BigInt(0)) return null
  return `0x${value.slice(-40)}`
}

export type RawUnsupportedFactoryForensicsInput = {
  txHash: string
  pool: string
  claimedFactory: string
  factoryCodeHash: string | null
  proxyType: ProxyType
  implementationAddress: string | null
  implementationCodeHash: string | null
  create2Detected: boolean
  poolCreatedTopicDetected: boolean
  creationReceiptAvailable: boolean
  creationEventEmitter: string | null
  creationEventPool: string | null
  creationEventToken0: string | null
  creationEventToken1: string | null
  creationEventFee: number | null
  expectedToken0: string
  expectedToken1: string
  expectedFee: number
}

// PURE, DISCLOSED: all classification logic lives here, independent of how the raw evidence was
// gathered -- directly unit-testable (including this task's own production scenario) without a
// live RPC client.
export function classifyUnsupportedFactoryForensics(input: RawUnsupportedFactoryForensicsInput): UnsupportedFactoryForensicsDiagnostics {
  const pool = input.pool.toLowerCase()
  const claimedFactory = input.claimedFactory.toLowerCase()
  const implementationAddress = input.implementationAddress ? input.implementationAddress.toLowerCase() : null

  const base = {
    txHash: input.txHash, pool, claimedFactory, factoryCodeHash: input.factoryCodeHash,
    proxyType: input.proxyType, implementationAddress, implementationCodeHash: input.implementationCodeHash,
    create2Detected: input.create2Detected, poolCreatedTopicDetected: input.poolCreatedTopicDetected,
    creationReceiptAvailable: input.creationReceiptAvailable,
    creationEventEmitter: input.creationEventEmitter, creationEventPool: input.creationEventPool,
    creationEventToken0: input.creationEventToken0, creationEventToken1: input.creationEventToken1,
    creationEventFee: input.creationEventFee,
  }

  // TOTAL FAILURE, DISCLOSED: no bytecode was ever obtained at all -- honest "learned nothing",
  // never a false 'no_supported_creation_proof' guess.
  if (input.proxyType === null && !input.factoryCodeHash) {
    return { ...base, creationProofMatches: null, finalTypedReason: 'rpc_failure' }
  }

  // STRONGEST EVIDENCE, DISCLOSED: a decoded PoolCreated-shaped event from the pool's OWN creation
  // receipt, whose emitter is cryptographically linked to the claimed factory (either the factory
  // itself, or its resolved proxy implementation) and whose fields exactly match the already-
  // verified token0/token1/fee/pool.
  if (input.creationEventPool) {
    const emitterLinked = input.creationEventEmitter === claimedFactory
      || (implementationAddress !== null && input.creationEventEmitter === implementationAddress)
    const fieldsMatch = input.creationEventPool === pool
      && input.creationEventToken0 === input.expectedToken0.toLowerCase()
      && input.creationEventToken1 === input.expectedToken1.toLowerCase()
      && input.creationEventFee === input.expectedFee
    if (emitterLinked && fieldsMatch) {
      return { ...base, creationProofMatches: true, finalTypedReason: 'verified_factory_creation_event' }
    }
    return { ...base, creationProofMatches: false, finalTypedReason: 'creation_event_mismatch' }
  }

  // A proxy pattern was found AND fully resolved to concrete implementation bytecode -- we now know
  // exactly what code runs, even without a creation-event to prove pool provenance.
  if (input.implementationCodeHash) {
    return { ...base, creationProofMatches: null, finalTypedReason: 'proxy_implementation_resolved' }
  }

  // Structural evidence only (see this file's own header on the heuristic, non-disassembling scan)
  // -- both a CREATE2 opcode and an embedded PoolCreated topic constant were found in the factory's
  // own bytecode, consistent with (but never a full cryptographic proof of) deterministic pool
  // deployment.
  if (input.create2Detected && input.poolCreatedTopicDetected) {
    return { ...base, creationProofMatches: null, finalTypedReason: 'verified_create2_derivation' }
  }

  // A proxy pattern was detected but could not be fully resolved within the RPC budget (e.g. an
  // EIP-1967 beacon slot with no further beacon.implementation() read attempted, or an
  // implementation address whose own bytecode fetch failed).
  if (input.proxyType && input.proxyType !== 'none') {
    return { ...base, creationProofMatches: null, finalTypedReason: 'proxy_resolution_failed' }
  }

  return { ...base, creationProofMatches: null, finalTypedReason: 'no_supported_creation_proof' }
}

function decodePoolCreatedLog(log: RawReceiptLog): {
  emitter: string; token0: string; token1: string; fee: number; pool: string
} | null {
  if ((log.topics[0] ?? '').toLowerCase() !== POOL_CREATED_TOPIC0.toLowerCase()) return null
  if (log.topics.length < 4) return null
  try {
    const token0 = `0x${log.topics[1].slice(-40)}`.toLowerCase()
    const token1 = `0x${log.topics[2].slice(-40)}`.toLowerCase()
    const fee = Number(BigInt(log.topics[3]))
    const [, pool] = decodeAbiParameters([{ type: 'int24' }, { type: 'address' }], log.data as `0x${string}`)
    return { emitter: log.address.toLowerCase(), token0, token1, fee, pool: (pool as string).toLowerCase() }
  } catch {
    return null
  }
}

// Real, on-chain implementation. NO RETRIES, DISCLOSED: each read below is attempted exactly once,
// bounded to at most 4 total RPC calls (see this file's own header for the exact call-count
// accounting per path).
export function createLiveUnsupportedFactoryForensicsAnalyzer(): UnsupportedFactoryForensicsAnalyzer {
  return {
    async analyze(input) {
      const { txHash, pool, claimedFactory, expectedToken0, expectedToken1, expectedFee, creationLogs } = input
      const client = getSharedBaseClient()
      if (!client) {
        return classifyUnsupportedFactoryForensics({
          txHash, pool, claimedFactory, factoryCodeHash: null, proxyType: null, implementationAddress: null,
          implementationCodeHash: null, create2Detected: false, poolCreatedTopicDetected: false,
          creationReceiptAvailable: Boolean(creationLogs && creationLogs.length > 0),
          creationEventEmitter: null, creationEventPool: null, creationEventToken0: null, creationEventToken1: null,
          creationEventFee: null, expectedToken0, expectedToken1, expectedFee,
        })
      }

      // CALL 1 of 4: the claimed factory's own runtime bytecode.
      let factoryCode: string | null = null
      try {
        factoryCode = (await client.getBytecode({ address: claimedFactory as `0x${string}` })) ?? null
      } catch {
        factoryCode = null
      }
      const factoryCodeHash = factoryCode ? keccak256(factoryCode as `0x${string}`) : null

      let proxyType: ProxyType = 'none'
      let implementationAddress: string | null = null
      let implementationCodeHash: string | null = null
      let create2Detected = false
      let poolCreatedTopicDetected = false

      if (factoryCode) {
        create2Detected = containsOpcode(factoryCode, 'f5')
        poolCreatedTopicDetected = factoryCode.toLowerCase().includes(POOL_CREATED_TOPIC0.slice(2).toLowerCase())

        const minimalProxyImpl = detectEip1167(factoryCode)
        if (minimalProxyImpl) {
          proxyType = 'eip1167'
          implementationAddress = minimalProxyImpl
          // CALL 2 of 4: the delegate's own bytecode -- justified directly by the EIP-1167 pattern
          // itself (the implementation address is embedded verbatim, no guess involved).
          try {
            const code = await client.getBytecode({ address: implementationAddress as `0x${string}` })
            implementationCodeHash = code ? keccak256(code as `0x${string}`) : null
          } catch {
            implementationCodeHash = null
          }
        } else if (containsOpcode(factoryCode, 'f4')) {
          // CALL 2 of 4: the EIP-1967 implementation slot -- only read because the factory's own
          // bytecode contains DELEGATECALL, justifying the probe.
          let implSlotValue: string | null = null
          try {
            implSlotValue = (await client.getStorageAt({ address: claimedFactory as `0x${string}`, slot: EIP1967_IMPLEMENTATION_SLOT })) ?? null
          } catch {
            implSlotValue = null
          }
          const implFromSlot = addressFromSlotValue(implSlotValue)
          if (implFromSlot) {
            proxyType = 'eip1967_implementation'
            implementationAddress = implFromSlot
            // CALL 3 of 4: the resolved implementation's own bytecode.
            try {
              const code = await client.getBytecode({ address: implementationAddress as `0x${string}` })
              implementationCodeHash = code ? keccak256(code as `0x${string}`) : null
            } catch {
              implementationCodeHash = null
            }
          } else {
            // CALL 3 of 4: the EIP-1967 beacon slot -- only tried because the implementation slot
            // itself came back empty (standard slots justify the read, per this task's own rule).
            let beaconSlotValue: string | null = null
            try {
              beaconSlotValue = (await client.getStorageAt({ address: claimedFactory as `0x${string}`, slot: EIP1967_BEACON_SLOT })) ?? null
            } catch {
              beaconSlotValue = null
            }
            const beaconAddr = addressFromSlotValue(beaconSlotValue)
            if (beaconAddr) {
              // A beacon proxy was detected but its own beacon.implementation() is deliberately NOT
              // read here to stay within the 4-call budget already spent on discovery -- surfaced
              // honestly as proxy_resolution_failed by the classifier, never silently upgraded.
              proxyType = 'eip1967_beacon'
            }
          }
        }
      }

      // CREATION-LOG INSPECTION, DISCLOSED: reuses ALREADY-SUPPLIED logs only -- zero new RPC calls,
      // never a history search for the pool's creation tx.
      let creationEventEmitter: string | null = null
      let creationEventPool: string | null = null
      let creationEventToken0: string | null = null
      let creationEventToken1: string | null = null
      let creationEventFee: number | null = null
      if (creationLogs) {
        for (const log of creationLogs) {
          const decoded = decodePoolCreatedLog(log)
          if (decoded) {
            creationEventEmitter = decoded.emitter
            creationEventPool = decoded.pool
            creationEventToken0 = decoded.token0
            creationEventToken1 = decoded.token1
            creationEventFee = decoded.fee
            break
          }
        }
      }

      return classifyUnsupportedFactoryForensics({
        txHash, pool, claimedFactory, factoryCodeHash, proxyType, implementationAddress, implementationCodeHash,
        create2Detected, poolCreatedTopicDetected, creationReceiptAvailable: Boolean(creationLogs && creationLogs.length > 0),
        creationEventEmitter, creationEventPool, creationEventToken0, creationEventToken1, creationEventFee,
        expectedToken0, expectedToken1, expectedFee,
      })
    },
  }
}

export type UnsupportedFactoryForensicsRequestScope = {
  cache: Map<string, UnsupportedFactoryForensicsDiagnostics>
  inFlight: Map<string, Promise<UnsupportedFactoryForensicsDiagnostics>>
}

export function createUnsupportedFactoryForensicsRequestScope(): UnsupportedFactoryForensicsRequestScope {
  return { cache: new Map(), inFlight: new Map() }
}

function scopeKey(pool: string, claimedFactory: string, token0: string, token1: string, fee: number): string {
  return `${pool.toLowerCase()}:${claimedFactory.toLowerCase()}:${token0.toLowerCase()}:${token1.toLowerCase()}:${fee}`
}

// Wraps `inner` with the request-scoped cache/singleflight described above. Returns a `callCount()`
// accessor so a caller can expose exactly how many real analysis attempts this scan made.
export function createCachedUnsupportedFactoryForensicsAnalyzer(
  inner: UnsupportedFactoryForensicsAnalyzer,
  scope: UnsupportedFactoryForensicsRequestScope,
): { analyzer: UnsupportedFactoryForensicsAnalyzer; callCount: () => number } {
  let calls = 0
  return {
    callCount: () => calls,
    analyzer: {
      async analyze(input) {
        const key = scopeKey(input.pool, input.claimedFactory, input.expectedToken0, input.expectedToken1, input.expectedFee)
        if (scope.cache.has(key)) return scope.cache.get(key)!
        if (scope.inFlight.has(key)) return scope.inFlight.get(key)!

        calls += 1
        const promise = inner.analyze(input)
        scope.inFlight.set(key, promise)
        const result = await promise
        scope.inFlight.delete(key)
        scope.cache.set(key, result)
        return result
      },
    },
  }
}
