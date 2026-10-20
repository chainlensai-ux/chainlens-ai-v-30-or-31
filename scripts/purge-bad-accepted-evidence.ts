// One-off: delete stored accepted-evidence records that a broken scan wrote with an impossible
// value (see src/lib/acceptedEvidencePurge.ts for the rules), and optionally one wallet's canonical
// PnL manifests so its next scan rebuilds them from clean evidence.
//
//   npx tsx scripts/purge-bad-accepted-evidence.ts                       # dry run: list what would go
//   npx tsx scripts/purge-bad-accepted-evidence.ts --apply               # delete bad evidence records
//   npx tsx scripts/purge-bad-accepted-evidence.ts --manifests 0xWALLET  # also list/delete that wallet's manifests
//
// Credentials: KV_REST_API_URL and KV_REST_API_TOKEN (the production Vercel KV), e.g. from
// `vercel env pull .env.local`. Server-side script only; not imported by app code.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { createClient } from '@vercel/kv'
import { acceptedEvidencePurgeReason } from '../src/lib/acceptedEvidencePurge'

const ROOT = path.resolve(__dirname, '..')
const envFile = path.join(ROOT, '.env.local')
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/)
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2]
  }
}

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const manifestWallet = args.includes('--manifests') ? args[args.indexOf('--manifests') + 1]?.toLowerCase() : null

async function main() {
  const url = process.env.KV_REST_API_URL
  const token = process.env.KV_REST_API_TOKEN
  if (!url || !token) throw new Error('KV_REST_API_URL / KV_REST_API_TOKEN not set')
  const kv = createClient({ url, token })

  let scanned = 0
  const bad: { key: string; reason: string; priceUsd: unknown }[] = []
  for await (const key of kv.scanIterator({ match: 'v1:accepted-evidence:*', count: 500 })) {
    scanned += 1
    const record = await kv.get(key)
    const reason = acceptedEvidencePurgeReason(record)
    if (reason) bad.push({ key, reason, priceUsd: (record as { priceUsd?: unknown } | null)?.priceUsd })
  }
  console.log(`accepted-evidence records scanned: ${scanned}, bad: ${bad.length}`)
  for (const row of bad.slice(0, 200)) console.log(`  ${row.reason}  ${row.priceUsd}  ${row.key}`)

  const manifests: string[] = []
  if (manifestWallet) {
    for await (const key of kv.scanIterator({ match: `v1:canonical-pnl-sample-manifest:${manifestWallet}:*`, count: 500 })) manifests.push(key)
    console.log(`canonical manifests for ${manifestWallet}: ${manifests.length}`)
    for (const key of manifests) console.log(`  ${key}`)
  }

  const toDelete = [...bad.map((row) => row.key), ...manifests]
  if (!apply) {
    console.log(`dry run: ${toDelete.length} keys would be deleted. Re-run with --apply to delete.`)
    return
  }
  for (let i = 0; i < toDelete.length; i += 100) await kv.del(...toDelete.slice(i, i + 100))
  console.log(`deleted ${toDelete.length} keys`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
