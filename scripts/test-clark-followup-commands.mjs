import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { resolveClarkFollowupCommand, resolveMomentumListSelection } from '../lib/server/clarkRouting.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const routeSrc = fs.readFileSync(path.join(__dirname, '../app/api/clark/route.ts'), 'utf8')
const PROVIDER_RE = /goldrush|covalent|geckoterminal|coingecko|dexscreener|alchemy/i

const tokenAddr1 = '0x' + '1'.repeat(40)
const tokenAddr2 = '0x' + '2'.repeat(40)
const marketItems = [
  { rank: 1, symbol: 'VELVET', name: 'Velvet Finance', scanTarget: tokenAddr1 },
  { rank: 2, symbol: 'O', name: 'Orbit', scanTarget: tokenAddr2 },
  { rank: 3, symbol: 'NOADDR', name: 'No Address Token', scanTarget: null },
]

// 1. "scan the first one" resolves rank 1 from marketContext.
{
  const r = resolveClarkFollowupCommand('scan the first one', { marketContext: { items: marketItems } }, [])
  assert.equal(r.intent, 'scan_rank')
  assert.equal(r.rank, 1)
  assert.equal(r.address, tokenAddr1)
  assert.equal(r.resolvedFrom, 'market_context')
}

// 2. "scan number 2" resolves rank 2 from sessionMem fallback when appContext has no market items.
{
  const r = resolveClarkFollowupCommand('scan number 2', { marketContext: null }, marketItems)
  assert.equal(r.intent, 'scan_rank')
  assert.equal(r.rank, 2)
  assert.equal(r.address, tokenAddr2)
  assert.equal(r.resolvedFrom, 'session_memory')
}

// 3. "scan velvet" resolves the exact symbol match.
{
  const r = resolveClarkFollowupCommand('scan velvet', { marketContext: { items: marketItems } }, [])
  assert.equal(r.intent, 'scan_symbol')
  assert.equal(r.symbol, 'velvet')
  assert.equal(r.address, tokenAddr1)
}

// 4. Duplicate symbol asks which one instead of guessing.
{
  const dupes = [
    { rank: 1, symbol: 'ABC', name: 'Alpha', scanTarget: tokenAddr1 },
    { rank: 2, symbol: 'ABC', name: 'Beta', scanTarget: tokenAddr2 },
  ]
  const r = resolveClarkFollowupCommand('check abc', { marketContext: { items: dupes } }, [])
  assert.equal(r.address, null, 'never guesses between ambiguous symbol matches')
  assert.equal(r.ambiguousMatches.length, 2)
  assert.equal(r.omittedReason, 'ambiguous_symbol')
}

// 5. Rank without a scanTarget gives a graceful, address-free result (no guessing a contract).
{
  const r = resolveClarkFollowupCommand('scan 3', { marketContext: { items: marketItems } }, [])
  assert.equal(r.intent, 'scan_rank')
  assert.equal(r.rank, 3)
  assert.equal(r.address, null)
  assert.equal(r.omittedReason, 'no_scan_target_for_rank')
}

// 6. "rescan this" on the token page builds a token-context resolution.
{
  const r = resolveClarkFollowupCommand('rescan this', { route: '/terminal/token-scanner', tokenSummary: { address: tokenAddr1, chain: 'base' } }, [])
  assert.equal(r.intent, 'rescan_current_token')
  assert.equal(r.address, tokenAddr1)
  assert.equal(r.resolvedFrom, 'token_context')
}

// 7. "rescan this" on the wallet page builds a wallet-context resolution.
{
  const walletAddr = '0x' + 'a'.repeat(40)
  const r = resolveClarkFollowupCommand('rescan this', { route: '/terminal/wallet-scanner', walletSummary: { address: walletAddr } }, [])
  assert.equal(r.intent, 'rescan_current_wallet')
  assert.equal(r.address, walletAddr)
  assert.equal(r.resolvedFrom, 'wallet_context')
}

// 8. "why is pnl locked" uses walletSummary only — never guesses from a token.
{
  const walletAddr = '0x' + 'a'.repeat(40)
  const r = resolveClarkFollowupCommand('why is pnl locked', { walletSummary: { address: walletAddr }, tokenSummary: { address: tokenAddr1 } }, [])
  assert.equal(r.intent, 'explain_pnl_lock')
  assert.equal(r.resolvedFrom, 'wallet_context')
}

// 9. "what are the risks" on the token page uses tokenSummary.
{
  const r = resolveClarkFollowupCommand('what are the risks', { route: '/terminal/token-scanner', tokenSummary: { address: tokenAddr1 } }, [])
  assert.equal(r.intent, 'explain_current_token')
  assert.equal(r.resolvedFrom, 'token_context')
}

// 10. No provider names leak through any resolved field.
{
  const r = resolveClarkFollowupCommand('scan velvet', { marketContext: { items: marketItems } }, [])
  assert.ok(!PROVIDER_RE.test(JSON.stringify(r)), 'resolved command names no providers')
}

// 11. Unresolvable prompts return "unknown" instead of guessing, so every existing dispatcher
//     downstream keeps working unchanged.
{
  const r = resolveClarkFollowupCommand('what is FDV', {}, [])
  assert.equal(r.intent, 'unknown')
}

// 12. Backend wires the new resolver into the explicit-scan handoff (reusing the existing scan
//     flow) and exposes the required debug fields.
assert.ok(/resolveClarkFollowupCommand/.test(routeSrc), 'route.ts uses resolveClarkFollowupCommand')
assert.ok(/scan \$\{cmd\.address\}/.test(routeSrc), 'resolved rank/symbol commands reuse the existing scan handoff')
for (const field of [
  'clarkFollowupCommandIntent', 'clarkFollowupResolvedFrom', 'clarkFollowupResolvedRank',
  'clarkFollowupResolvedSymbol', 'clarkFollowupResolvedAddress', 'clarkFollowupAmbiguousMatches', 'clarkFollowupOmittedReason',
]) {
  assert.ok(routeSrc.includes(field), `route exposes debug field ${field}`)
}

// 13. Market-mover follow-up scans ("scan 1") must force token_scan and can never fall
//     through to wallet_scan — route.ts wires a forcedTokenScan override through the
//     recursive handleClarkAI call instead of recursing on a bare, reclassifiable prompt.
assert.ok(routeSrc.includes('forcedTokenScan'), 'route.ts forces token_scan for market follow-up scans')
assert.ok(routeSrc.includes('routed.intent = "token_scan"'), 'forcedTokenScan overrides the classifier result to token_scan')
assert.ok(routeSrc.includes('clarkFollowupForcedIntent'), 'route exposes clarkFollowupForcedIntent debug field')
assert.ok(routeSrc.includes('clarkFollowupScanSource'), 'route exposes clarkFollowupScanSource debug field')
assert.ok(routeSrc.includes('clarkFollowupScanTargetType'), 'route exposes clarkFollowupScanTargetType debug field')
assert.ok(routeSrc.includes('clarkFollowupTokenAddress'), 'route exposes clarkFollowupTokenAddress debug field')
assert.ok(routeSrc.includes('clarkFollowupWalletFallbackBlocked'), 'route exposes clarkFollowupWalletFallbackBlocked debug field')
assert.ok(routeSrc.includes('clarkFollowupBlockedReason'), 'route exposes clarkFollowupBlockedReason debug field')

// 14. A market-context item with a real token address resolves cleanly to a token scan
//     target (never a pool/wallet target) — this is what feeds the forced-token-scan path.
{
  const r = resolveClarkFollowupCommand('scan 1', { marketContext: { items: marketItems } }, [])
  assert.equal(r.intent, 'scan_rank')
  assert.equal(r.address, tokenAddr1)
}
{
  const r = resolveClarkFollowupCommand('scan velvet', { marketContext: { items: marketItems } }, [])
  assert.equal(r.intent, 'scan_symbol')
  assert.equal(r.address, tokenAddr1)
}

// 15. A market row with only a pool/market address (no token contract) must never resolve
//     an address to wallet-scan — it comes back address=null with an explicit omittedReason,
//     and route.ts's pool-aware branch turns that into a "paste the token contract" ask
//     rather than ever reaching the wallet_scan dispatcher.
{
  const r = resolveClarkFollowupCommand('scan 3', { marketContext: { items: marketItems } }, [])
  assert.equal(r.address, null)
  assert.equal(r.omittedReason, 'no_scan_target_for_rank')
}
assert.ok(routeSrc.includes('pool/market row, not the token contract yet'), 'pool-only market rows never get wallet-scanned')

// 16. Direct address prompts with no market-follow-up context still classify independently —
//     resolveClarkFollowupCommand defers to "unknown" with no marketContext/momentum list,
//     leaving the existing address classifier (wallet vs token) to route them as before.
{
  const walletAddr = '0x' + 'b'.repeat(40)
  const r = resolveClarkFollowupCommand(`scan ${walletAddr}`, {}, [])
  assert.equal(r.intent, 'unknown', 'a bare address with no market context is left to the existing classifier, not forced')
}

// 17. The forced-token-scan output must never read as a wallet read.
assert.ok(!/WALLET READ/.test(routeSrc.match(/forcedTokenScan[\s\S]{0,400}/)?.[0] ?? ''), 'forced token-scan wiring stays clear of wallet-read output')

// 18. Rank follow-ups validate generation identity before rank lookup (Item 5).
{
  const currentId = 'ticker_current'
  const stale = resolveMomentumListSelection({
    selection: { listId: 'ticker_old', rank: 1 },
    currentListId: currentId,
    currentItems: marketItems,
    requireListId: true,
  })
  assert.equal(stale.status, 'stale_list')
  assert.equal(stale.selectedItem, null)
  const ok = resolveMomentumListSelection({
    selection: { listId: currentId, rank: 2 },
    currentListId: currentId,
    currentItems: marketItems,
    requireListId: true,
  })
  assert.equal(ok.status, 'resolved')
  assert.equal(ok.selectedItem?.scanTarget, tokenAddr2)
  const none = resolveMomentumListSelection({
    selection: { rank: 1 },
    currentListId: null,
    currentItems: marketItems,
    requireListId: true,
  })
  assert.equal(none.status, 'no_active_list')
  const r = resolveClarkFollowupCommand('scan 1', { marketContext: { items: marketItems } }, [], {
    currentListId: currentId,
    incomingListId: 'ticker_old',
  })
  assert.equal(r.omittedReason, 'stale_list')
  assert.equal(r.address, null)
  const live = resolveClarkFollowupCommand('scan 1', { marketContext: { items: marketItems } }, [], {
    currentListId: currentId,
    incomingListId: currentId,
  })
  assert.equal(live.intent, 'scan_rank')
  assert.equal(live.address, tokenAddr1)
}
assert.ok(routeSrc.includes('resolveMomentumListSelection'), 'route.ts uses resolveMomentumListSelection for rank follow-ups')
assert.ok(routeSrc.includes('stale_momentum_list'), 'stale movers list is an explicit blocked reason')
assert.ok(routeSrc.includes('requireListId: true'), 'session-memory rank lookups require lastMomentumListId')

console.log('clark followup command checks passed')
