// Whale Alerts audit: the routes and page must actually use the fixed helpers (behaviour of the
// helpers themselves is covered by tests/whale-alerts-audit.test.ts).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const feed = read('../app/api/whale-alerts/route.ts')
const sync = read('../app/api/whale-alerts/sync/route.ts')
const hook = read('../app/api/webhooks/alchemy/route.ts')
const page = read('../app/terminal/whale-alerts/page.tsx')
const seed = read('../docs/whale-wallets-seed.sql')

// Feed: one visible alert per movement, deduped BEFORE grouping (else a duplicate becomes a fake swap).
assert.ok(feed.indexOf('dedupeMovementLegs(') > 0)
assert.ok(feed.indexOf('dedupeMovementLegs(') < feed.indexOf('groupAlertsByTx(enriched)'))
assert.match(feed, /duplicateLegsRemoved,/)
// Feed: misconfiguration is a failure, not an empty 200.
assert.match(feed, /function emptyUnavailable[\s\S]*?status: 503/)
// Feed: native ETH prices as WETH, never as the sentinel address.
assert.match(feed, /pricingAddressFor\(row\.token_address, row\.token_symbol\)/)

// Sync: owner follows the wallet; checkpoints are per window.
assert.match(sync, /owner_user_id: alertOwnerForWallet\(result\.wallet\)/)
assert.doesNotMatch(sync, /owner_user_id: actor\.kind === 'user' \? actor\.userId/)
assert.match(sync, /checkpointKey\(result\.wallet\.address, windowMs\)/)
assert.match(sync, /checkpointKey\(wallet\.address, windowMs\)/)
// Cron: rotating start, wrap-around, never always-offset-0.
assert.match(sync, /cronRotationStart\(Date\.now\(\)/)
assert.match(sync, /cronNextOffset\(start,/)
assert.doesNotMatch(sync, /let offset = 0\n  let batches = 0/)

// Webhook: shared candidate builder, network guard, deferred events re-delivered (429), not dropped.
assert.match(hook, /buildWebhookCandidates\(rawActivity\.slice\(0, budget\.allowed\)/)
assert.match(hook, /SUPPORTED_WEBHOOK_NETWORKS\.has\(network\)/)
assert.match(hook, /status: 429, headers: \{ 'Retry-After': '60' \}/)
assert.doesNotMatch(hook, /const pairKey = `\$\{txHash\}::\$\{match\.walletKey\}`/)

// Page: stale responses ignored; post-sync reload bypasses the server cache; honest wording.
assert.match(page, /if \(!feedRequestGate\.current\.isLatest\(ticket\)\) return/)
assert.match(page, /if \(opts\?\.fresh\) p\.set\('t', String\(Date\.now\(\)\)\)/)
assert.match(page, /await loadAlerts\(\{ fresh: syncWroteAlerts \}\)/)
assert.match(page, /void loadAlerts\(\{ enrich: false, fresh: true \}\)/)
assert.match(page, /const baseVerb = action\.verb/)
assert.doesNotMatch(page, /'bought'/)

// Seed: no dependency on the dropped unique(address); always sets Base chain_id.
assert.doesNotMatch(seed, /^on conflict \(address\)/m)
assert.match(seed, /chain_id = 8453/)
assert.match(seed, /select lower\(s\.address\), lower\(s\.address\), 8453/)

console.log('whale alerts wiring: ok')
