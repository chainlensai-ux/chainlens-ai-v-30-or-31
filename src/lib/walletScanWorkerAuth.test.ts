// Internal worker call: stable target host, consistent shared-secret headers, protection bypass.
//   npx tsx --test src/lib/walletScanWorkerAuth.test.ts
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { checkWorkerRequest, resolveWorkerTarget, workerRequestHeaders, WORKER_SECRET_HEADER, VERCEL_BYPASS_HEADER } from './walletScanWorkerAuth'
import { triggerWalletScanWorker } from '../modules/walletScanQueue'

const workerReq = (headers: Record<string, string>) => new Request('https://www.chainlensai.app/api/wallet-scan/worker', { method: 'POST', headers, body: '{}' })

describe('resolveWorkerTarget', () => {
  it('prefers an explicit base URL, then the production domain, then the branch alias, then VERCEL_URL', () => {
    const vercel = { VERCEL_URL: 'chainlens-abc123.vercel.app', VERCEL_BRANCH_URL: 'chainlens-git-main.vercel.app', VERCEL_PROJECT_PRODUCTION_URL: 'www.chainlensai.app', VERCEL_ENV: 'production' }
    assert.deepEqual(resolveWorkerTarget({ ...vercel, WALLET_SCAN_WORKER_BASE_URL: 'https://scan.example.com/' }), { url: 'https://scan.example.com/api/wallet-scan/worker', host: 'scan.example.com', source: 'WALLET_SCAN_WORKER_BASE_URL' })
    assert.deepEqual(resolveWorkerTarget(vercel), { url: 'https://www.chainlensai.app/api/wallet-scan/worker', host: 'www.chainlensai.app', source: 'VERCEL_PROJECT_PRODUCTION_URL' })
    assert.equal(resolveWorkerTarget({ ...vercel, VERCEL_ENV: 'preview' }).source, 'VERCEL_BRANCH_URL')
    assert.equal(resolveWorkerTarget({ VERCEL_URL: 'chainlens-abc123.vercel.app' }).host, 'chainlens-abc123.vercel.app')
    assert.equal(resolveWorkerTarget({}).source, 'localhost')
  })
})

describe('shared secret: sent and checked the same way', () => {
  const env = { WALLET_SCAN_WORKER_SECRET: '  s3cret \n', VERCEL_AUTOMATION_BYPASS_SECRET: 'bypass-1' }
  it('sends the trimmed secret in both headers plus the Vercel bypass header', () => {
    const h = workerRequestHeaders(env)!
    assert.equal(h.authorization, 'Bearer s3cret')
    assert.equal(h[WORKER_SECRET_HEADER], 's3cret')
    assert.equal(h[VERCEL_BYPASS_HEADER], 'bypass-1')
    assert.equal(workerRequestHeaders({ WALLET_SCAN_WORKER_SECRET: 'x' })![VERCEL_BYPASS_HEADER], undefined)
    assert.equal(workerRequestHeaders({}), null)
  })
  it('the route accepts exactly what the trigger sends (either header), and nothing else', () => {
    assert.deepEqual(checkWorkerRequest(workerReq(workerRequestHeaders(env)!), env), { ok: true })
    assert.deepEqual(checkWorkerRequest(workerReq({ [WORKER_SECRET_HEADER]: 's3cret' }), env), { ok: true })
    assert.deepEqual(checkWorkerRequest(workerReq({ authorization: 'bearer s3cret' }), env), { ok: true })
    assert.deepEqual(checkWorkerRequest(workerReq({ authorization: 'Bearer wrong' }), env), { ok: false, reason: 'secret_mismatch' })
    assert.deepEqual(checkWorkerRequest(workerReq({}), env), { ok: false, reason: 'missing_credentials' })
    assert.deepEqual(checkWorkerRequest(workerReq({ authorization: 'Bearer s3cret' }), {}), { ok: false, reason: 'secret_not_configured' })
  })
})

describe('trigger', () => {
  const env = { WALLET_SCAN_WORKER_SECRET: 's', VERCEL_ENV: 'production', VERCEL_PROJECT_PRODUCTION_URL: 'www.chainlensai.app', VERCEL_URL: 'x.vercel.app', VERCEL_AUTOMATION_BYPASS_SECRET: 'b' }
  afterEach(() => undefined)
  it('calls the production domain with the auth + bypass headers', async () => {
    let seen: { url: string; headers: Record<string, string> } | null = null
    await triggerWalletScanWorker('job-1', { env, keepAlive: () => {}, fetchImpl: async (url, init) => { seen = { url: String(url), headers: init?.headers as Record<string, string> }; return new Response(null, { status: 202 }) } })
    assert.equal(seen!.url, 'https://www.chainlensai.app/api/wallet-scan/worker')
    assert.equal(seen!.headers[WORKER_SECRET_HEADER], 's')
    assert.equal(seen!.headers[VERCEL_BYPASS_HEADER], 'b')
  })
  it('a 401 reports the target host, source, status and the start of the body', async () => {
    const outcome = await triggerWalletScanWorker('job-2', { env, keepAlive: () => {}, fetchImpl: async () => new Response('{"error":"unauthorized","reason":"secret_mismatch"}', { status: 401 }) })
    assert.equal(outcome.kind, 'responded')
    const o = outcome as { status: number; targetHost: string; targetSource: string; bodySnippet?: string }
    assert.deepEqual([o.status, o.targetHost, o.targetSource], [401, 'www.chainlensai.app', 'VERCEL_PROJECT_PRODUCTION_URL'])
    assert.match(o.bodySnippet ?? '', /secret_mismatch/)
  })
})

describe('worker route', () => {
  it('returns the rejection reason with the 401', async () => {
    const original = process.env.WALLET_SCAN_WORKER_SECRET
    process.env.WALLET_SCAN_WORKER_SECRET = 'route-secret'
    try {
      const { POST } = await import('../../app/api/wallet-scan/worker/route')
      const res = await POST(workerReq({ authorization: 'Bearer nope' }))
      assert.equal(res.status, 401)
      assert.deepEqual(await res.json(), { error: 'unauthorized', reason: 'secret_mismatch' })
    } finally {
      if (original === undefined) delete process.env.WALLET_SCAN_WORKER_SECRET; else process.env.WALLET_SCAN_WORKER_SECRET = original
    }
  })
})
