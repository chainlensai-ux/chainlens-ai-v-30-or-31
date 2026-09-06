import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8')
const workerRoute = read('../app/api/wallet-scan/worker/route.ts')
const queue = read('../src/modules/walletScanQueue.ts')
const pollRoute = read('../app/api/wallet-scan/[jobId]/route.ts')
const enqueueRoute = read('../app/api/wallet-scan/route.ts')

assert.match(workerRoute, /if \(!isAuthorizedWalletScanWorkerRequest\(req\)\)[\s\S]*?status: 401/,
  'an unauthenticated worker invocation must return 401 before running the worker')
assert.match(workerRoute, /if \(!secret \|\| !authorization\.startsWith\('Bearer '\)\) return false/,
  'the worker must fail closed when WALLET_SCAN_WORKER_SECRET is unset')
assert.match(queue, /authorization: `Bearer \$\{workerSecret\}`/,
  'the trusted enqueue trigger must send the worker secret')
assert.match(enqueueRoute, /const authUser = await requireAuthenticatedUser\(req\)[\s\S]*?userId: authUser\.userId/,
  'enqueue must bind the authenticated user id into the job')
assert.match(queue, /export type WalletScanJobMetadata = \{[\s\S]*?userId: string/,
  'stored job metadata must carry its owner')
assert.match(pollRoute, /const auth = await requireAuthenticatedUser\(req\)[\s\S]*?if \(!auth\) return unauthorizedResponse\(\)/,
  'an unauthenticated poll must return 401')
assert.match(pollRoute, /if \(!job \|\| job\.userId !== auth\.userId\)[\s\S]*?status: 404/,
  'User A polling User B job id must receive 404 without scan leakage')

console.log('PASS wallet-scan worker and poll authorization boundaries')
