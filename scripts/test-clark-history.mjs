import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { generateChatTitle, buildMessagePreview, sanitizeMessageMetadata, classifyDbError, sanitizeClarkHistorySearchQuery, sortClarkHistoryChats } from '../lib/server/clarkHistory.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const sqlSrc = fs.readFileSync(path.join(__dirname, '../supabase/clark-chat-history.sql'), 'utf8')
const apiSrc = fs.readFileSync(path.join(__dirname, '../app/api/clark/history/route.ts'), 'utf8')
const pageSrc = fs.readFileSync(path.join(__dirname, '../app/terminal/clark-ai/page.tsx'), 'utf8')
const panelSrc = fs.readFileSync(path.join(__dirname, '../components/ClarkHistoryPanel.tsx'), 'utf8')
const clientSrc = fs.readFileSync(path.join(__dirname, '../lib/client/clarkHistoryClient.ts'), 'utf8')
const PROVIDER_RE = /goldrush|covalent|geckoterminal|coingecko|dexscreener|alchemy/i

const tokenAddr = '0x' + '1'.repeat(40)
const walletAddr = '0x' + '2'.repeat(40)

// 1. Auto-title: token address → "Token scan: 0x1234…"
{
  const title = generateChatTitle(`scan ${tokenAddr}`)
  assert.equal(title, `Token scan: ${tokenAddr.slice(0, 6)}…`)
}

// 2. Auto-title: wallet address (with the word "wallet") → "Wallet read: 0x1234…"
{
  const title = generateChatTitle(`analyze wallet ${walletAddr}`)
  assert.equal(title, `Wallet read: ${walletAddr.slice(0, 6)}…`)
}

// 3. Auto-title: market prompt → "Base market read"
{
  assert.equal(generateChatTitle("what's pumping on Base?"), 'Base market read')
  assert.equal(generateChatTitle('top movers on base today'), 'Base market read')
}

// 4. Auto-title: fallback to first 48 chars (no AI call involved — purely rule-based, no network).
{
  const long = 'Can you give me a detailed breakdown of this random unrelated question about gas fees'
  const title = generateChatTitle(long)
  assert.equal(title, `${long.slice(0, 48)}…`)
  assert.ok(title.length <= 49)
}

// 5. Auto-title falls back to app-context address hints when the prompt itself has none.
{
  const title = generateChatTitle('rescan this', { tokenSummary: { address: tokenAddr } })
  assert.equal(title, `Token scan: ${tokenAddr.slice(0, 6)}…`)
}

// 6. Message preview truncation never produces an unbounded string.
{
  const preview = buildMessagePreview('a'.repeat(500))
  assert.ok(preview.length <= 141)
}

// 7. Saved metadata excludes raw debug/provider fields and only carries the safe allowlist.
{
  const payload = {
    intent: 'token_analysis',
    chain: 'base',
    feature: 'clark-ai',
    tokenSummary: { address: tokenAddr },
    ui: { actions: [{ label: 'Open Token Scanner', href: '/terminal/token-scanner', kind: 'link' }] },
    marketContext: { items: [{ symbol: 'VELVET' }, { symbol: 'O' }] },
    goldrushDebugDump: { raw: 'should never be persisted' },
    clarkProviderAttempted: ['goldrush', 'covalent'],
    clarkMarketSource: 'goldrush_v3',
  }
  const meta = sanitizeMessageMetadata(payload)
  assert.equal(meta.intent, 'token_analysis')
  assert.equal(meta.address, tokenAddr)
  assert.equal(meta.marketContextSummary.count, 2)
  assert.equal(meta.marketContextSummary.topSymbol, 'VELVET')
  assert.ok(!('goldrushDebugDump' in meta))
  assert.ok(!('clarkProviderAttempted' in meta))
  assert.ok(!('clarkMarketSource' in meta))
  assert.ok(!PROVIDER_RE.test(JSON.stringify(meta)), 'sanitized metadata carries no provider names')
}

// 8. Action labels that happen to leak a provider name are dropped, not merely passed through.
{
  const meta = sanitizeMessageMetadata({ ui: { actions: [{ label: 'Powered by Goldrush', href: '/x', kind: 'link' }] } })
  assert.equal((meta.actions ?? []).length, 0, 'provider-named actions are filtered out')
}

// 9. SQL migration: all three tables exist, are user-scoped via auth.uid() = user_id RLS, and the
//    folder→chat relationship is ON DELETE SET NULL (deleting a folder must not delete chats).
for (const table of ['clark_chat_folders', 'clark_chats', 'clark_chat_messages']) {
  assert.ok(sqlSrc.includes(`public.${table}`), `migration defines ${table}`)
  assert.ok(sqlSrc.includes(`alter table public.${table} enable row level security`), `${table} has RLS enabled`)
}
assert.ok(/clark_chat_folders_select_own[\s\S]*?auth\.uid\(\) = user_id/.test(sqlSrc))
assert.ok(/clark_chats_select_own[\s\S]*?auth\.uid\(\) = user_id/.test(sqlSrc))
assert.ok(/clark_chat_messages_select_own[\s\S]*?auth\.uid\(\) = user_id/.test(sqlSrc))
assert.ok(/folder_id uuid null references public\.clark_chat_folders\(id\) on delete set null/.test(sqlSrc), 'deleting a folder sets folder_id null, never deletes chats')

// 10. API: every handler scopes reads/writes by the authenticated user_id (RLS-respecting even
//     though the route uses the service client, exactly like the existing watchlist routes).
assert.ok(/authenticate/.test(apiSrc) && /eq\('user_id', userId\)/.test(apiSrc), "history route scopes queries by the caller's user_id")
assert.ok(/sanitizeMessageMetadata/.test(apiSrc), 'history route sanitizes metadata before persisting it')
assert.ok(!PROVIDER_RE.test(apiSrc), 'history route source has no provider names')

// 11. Frontend: history loading/saving never blocks sending, never wipes messages on reload, and
//     surfaces a non-blocking failure state.
assert.ok(/sessionStorage\.getItem\(ACTIVE_CHAT_ID_KEY\)/.test(pageSrc), 'restores the active chat id across reload')
assert.ok(/historySaveFailed/.test(pageSrc) && /historySaveFailed/.test(panelSrc), 'a non-blocking History not saved state is wired through')
assert.ok(/History not saved/.test(panelSrc))
assert.ok(/Start a Clark chat\. Your token, wallet, and market reads will be saved here\./.test(panelSrc), 'empty state copy matches spec')
assert.ok(/chatIdPromise\.then/.test(pageSrc), 'message history is appended asynchronously, not awaited before showing the reply')

// 12. Search wiring: typing in the panel calls back into the page, which re-queries the API by q.
assert.ok(/onSearch/.test(panelSrc) && /onSearch=\{.*refreshHistory/.test(pageSrc.replace(/\s+/g, ' ')), 'search input is wired to the history API')

// 13. classifyDbError maps Postgres error signatures to stable history error codes.
{
  assert.equal(classifyDbError({ code: '42P01', message: 'relation "public.clark_chats" does not exist' }, 'select_failed'), 'table_missing')
  assert.equal(classifyDbError({ message: 'relation "x" does not exist' }, 'insert_failed'), 'table_missing')
  assert.equal(classifyDbError({ code: '42501', message: 'permission denied' }, 'select_failed'), 'rls_blocked')
  assert.equal(classifyDbError({ message: 'new row violates row-level security policy' }, 'insert_failed'), 'rls_blocked')
  assert.equal(classifyDbError({ message: 'connection refused' }, 'select_failed'), 'select_failed')
  assert.equal(classifyDbError({ message: 'connection refused' }, 'insert_failed'), 'insert_failed')
}

// 14. API route distinguishes auth_missing (no token) from auth_invalid (bad/expired token), and
//     every error response carries historyErrorCode/historyErrorMessage/historyAction for the
//     frontend to act on — never a bare generic message.
{
  assert.ok(/errorCode === 'auth_missing'/.test(apiSrc) || /auth_missing/.test(apiSrc), 'route distinguishes auth_missing')
  assert.ok(/auth_invalid/.test(apiSrc), 'route distinguishes auth_invalid')
  assert.ok(/historyErrorCode/.test(apiSrc) && /historyErrorMessage/.test(apiSrc) && /historyAction/.test(apiSrc), 'route returns historyErrorCode/historyErrorMessage/historyAction')
  assert.ok(/classifyDbError/.test(apiSrc), 'route classifies DB errors instead of returning generic 500s')
}

// 15. Frontend history client always sends an Authorization bearer header when a session exists,
//     and throws a typed ClarkHistoryError (carrying the API's error code) when a call fails —
//     callers can branch on auth_missing vs table_missing vs rls_blocked instead of guessing.
{
  assert.ok(/class ClarkHistoryError extends Error/.test(clientSrc), 'client exposes a typed history error with a code')
  assert.ok(/Authorization: `Bearer \$\{token\}`/.test(clientSrc), 'client sends the bearer token on every request')
  assert.ok(/auth_missing/.test(clientSrc), 'client throws auth_missing immediately when there is no session')
  assert.ok(/historyErrorCode/.test(clientSrc), 'client reads the API historyErrorCode from failed responses')
}

// 16. Page-level wiring: failures are classified by error code, mapped to a specific non-blocking
//     status message (sign in / tables not installed / permissions / temporarily unavailable),
//     and Clark's own reply is never blocked by a history failure.
{
  assert.ok(/reportHistoryFailure/.test(pageSrc), 'page centralizes history-failure handling')
  assert.ok(/HISTORY_STATUS_MESSAGE/.test(pageSrc), 'page maps error codes to specific status copy')
  assert.ok(/Sign in to save Clark history/.test(pageSrc))
  assert.ok(/History tables not installed/.test(pageSrc))
  assert.ok(/History save blocked by permissions/.test(pageSrc))
  assert.ok(/historyStatusMessage/.test(panelSrc), 'panel renders the specific status message, not just a fixed string')
}

assert.ok(/history_limit/.test(apiSrc), 'history route enforces a saved-chat limit')
assert.ok(/rejectIfHistoryLimitReached/.test(apiSrc), 'new chats are blocked at the plan history cap')
assert.ok(/clarkChatHistoryLimit/.test(apiSrc), 'history cap is read from the canonical plan matrix')
assert.match(pageSrc, /historyAtLimit/, 'Clark AI page tracks when saved-chat history is full')
assert.match(pageSrc, /if \(historyAtLimit && !opts\?\.ignoreLimit\) return/, 'New Chat is a no-op at the Pro/Free history cap')
assert.match(panelSrc, /disabled=\{historyAtLimit\}/, 'New Chat button is disabled at the history cap')
assert.match(pageSrc, /historyChatCount/)
assert.match(pageSrc, /savedChatCount/)
assert.match(apiSrc, /historyMeta/)
assert.match(clientSrc, /chatCount/)
assert.equal((await import('../lib/pricingPlans.ts')).clarkChatHistoryLimit('pro'), 10)
assert.equal((await import('../lib/pricingPlans.ts')).clarkChatHistoryLimit('elite'), null)

// 17. Search query is sanitized before hitting PostgREST — commas / parens / ILIKE wildcards
//     cannot become extra filter syntax. Empty-after-sanitize does not match-all.
{
  assert.equal(sanitizeClarkHistorySearchQuery('velvet'), 'velvet')
  assert.equal(sanitizeClarkHistorySearchQuery('foo,id.neq.0'), 'foo id.neq.0')
  assert.equal(sanitizeClarkHistorySearchQuery('a) ,or(id.eq.1'), 'a or id.eq.1')
  assert.equal(sanitizeClarkHistorySearchQuery('%%%'), '')
  assert.equal(sanitizeClarkHistorySearchQuery('hold_ers'), 'hold ers')
  assert.ok(!apiSrc.includes('.or(`title.ilike.%${query}%'), 'history search must not interpolate the raw q into PostgREST .or()')
  assert.ok(/sanitizeClarkHistorySearchQuery/.test(apiSrc), 'history route sanitizes q before ilike')
  assert.ok(/\.ilike\('title'/.test(apiSrc) && /\.ilike\('last_message_preview'/.test(apiSrc), 'title/preview search uses parameterized ilike, not or()-interpolation')
}

// 18. Search / list ordering is pinned desc then updated_at desc (same as the unfiltered GET).
{
  const sorted = sortClarkHistoryChats([
    { id: 'old', pinned: false, updated_at: '2026-01-01T00:00:00.000Z' },
    { id: 'new', pinned: false, updated_at: '2026-09-01T00:00:00.000Z' },
    { id: 'pin', pinned: true, updated_at: '2026-02-01T00:00:00.000Z' },
  ])
  assert.deepEqual(sorted.map((c) => c.id), ['pin', 'new', 'old'])
  assert.ok(/sortClarkHistoryChats/.test(apiSrc), 'search results are ordered the same way as the chat list')
  assert.ok(/\.order\('pinned', \{ ascending: false \}\)/.test(apiSrc), 'unfiltered chat list pins first')
  assert.ok(/\.order\('updated_at', \{ ascending: false \}\)/.test(apiSrc), 'unfiltered chat list is newest-updated next')
  assert.ok(/\.order\('created_at', \{ ascending: true \}\)/.test(apiSrc), 'messages load oldest-first')
}

// 19. Proven ownership gaps (NOT an RLS leak — service-role is intentional and every query is
//     already .eq('user_id', userId); policies in SQL are auth.uid() = user_id). Before insert/
//     folder attach, the route now also verifies the target chat/folder row belongs to the caller
//     so a guessed UUID cannot attach a message or chat to someone else's row.
{
  assert.ok(/requireOwnedChat/.test(apiSrc), 'message insert verifies the chat belongs to the caller')
  assert.ok(/requireOwnedFolder/.test(apiSrc), 'folder_id attach verifies the folder belongs to the caller')
  assert.ok(/folder not found/.test(apiSrc) && /chat not found/.test(apiSrc))
  assert.ok(/folder_id: null/.test(apiSrc), 'deleting a folder nulls folder_id on that user\'s chats first')
  assert.ok(/typeof body\?\.folderId === 'string' \? body\.folderId : null/.test(apiSrc) || /nextFolderId/.test(apiSrc), 'PATCH chat can set folder_id to null')
}

// 20. New-chat / switch-chat / duplicate-send: client already isolates these. Lock the wiring so
//     a later edit cannot drop bumpSession, memory clear, or the request gate.
{
  assert.ok(/function handleNewChat/.test(pageSrc) && /setMessages\(\[\]\)/.test(pageSrc) && /setActiveChatId\(null\)/.test(pageSrc), 'New Chat clears the thread and active id')
  assert.ok(/clearClarkMemory\(\)/.test(pageSrc), 'New Chat clears Clark memory')
  assert.ok(/loadClarkMemoryForChat\(chatId, \{ missing: 'clear' \}\)/.test(pageSrc), 'switching chats loads that chat\'s memory (or clears if none)')
  assert.ok(/requestGateRef\.current\.begin\(text\)/.test(pageSrc), 'sends go through the duplicate-click gate')
  assert.ok(/requestGateRef\.current\.shouldApply\(requestId\)/.test(pageSrc), 'stale in-flight replies are not applied')
  assert.ok(/requestGateRef\.current\.bumpSession\(\)/.test(pageSrc), 'new/switch chat bumps the request-gate session')
  assert.ok(/if \(id === activeChatId\) handleNewChat/.test(pageSrc), 'deleting the active chat opens a fresh empty chat')
}

console.log('clark chat history checks passed')
