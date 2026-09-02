export const KNOWN_FORENSIC_CASE = {
  chain: 'base' as const,
  pool: '0x7f31b371ac675bca3357fd9c26854fed067400c0',
  claimedFactory: '0xade65c38cd4849adba595a4323a8c7ddfe89716a',
  expectedToken0: '0x4200000000000000000000000000000000000006',
  expectedToken1: '0x5576d6ed9181f2225aff5282ac0ed29f755437ea',
  expectedFee: 10000,
}

export type PoolProvenanceRequestBody = {
  chain: 'base'
  pool: string
  claimedFactory: string
  expectedToken0: string
  expectedToken1: string
  expectedFee: number
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

export function validatePoolProvenanceRequestBody(body: unknown): { ok: true; value: PoolProvenanceRequestBody } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Invalid JSON body' }
  const { chain, pool, claimedFactory, expectedToken0, expectedToken1, expectedFee } = body as Record<string, unknown>
  if (chain !== 'base') return { ok: false, error: 'chain must be "base"' }
  if (typeof pool !== 'string' || !ADDRESS_RE.test(pool)) return { ok: false, error: 'pool must be a valid address' }
  if (typeof claimedFactory !== 'string' || !ADDRESS_RE.test(claimedFactory)) return { ok: false, error: 'claimedFactory must be a valid address' }
  if (typeof expectedToken0 !== 'string' || !ADDRESS_RE.test(expectedToken0)) return { ok: false, error: 'expectedToken0 must be a valid address' }
  if (typeof expectedToken1 !== 'string' || !ADDRESS_RE.test(expectedToken1)) return { ok: false, error: 'expectedToken1 must be a valid address' }
  if (typeof expectedFee !== 'number' || !Number.isInteger(expectedFee) || expectedFee < 0) return { ok: false, error: 'expectedFee must be a non-negative integer' }
  return { ok: true, value: { chain, pool, claimedFactory, expectedToken0, expectedToken1, expectedFee } }
}

export function matchesKnownForensicCase(value: PoolProvenanceRequestBody): boolean {
  return value.chain === KNOWN_FORENSIC_CASE.chain
    && value.pool.toLowerCase() === KNOWN_FORENSIC_CASE.pool.toLowerCase()
    && value.claimedFactory.toLowerCase() === KNOWN_FORENSIC_CASE.claimedFactory.toLowerCase()
    && value.expectedToken0.toLowerCase() === KNOWN_FORENSIC_CASE.expectedToken0.toLowerCase()
    && value.expectedToken1.toLowerCase() === KNOWN_FORENSIC_CASE.expectedToken1.toLowerCase()
    && value.expectedFee === KNOWN_FORENSIC_CASE.expectedFee
}
