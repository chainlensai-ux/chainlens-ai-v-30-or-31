'use client'

import { useState } from 'react'
import type { ClarkChatFolder, ClarkChatSummary } from '@/lib/client/clarkHistoryClient'

export type ClarkHistoryPanelProps = {
  folders: ClarkChatFolder[]
  chats: ClarkChatSummary[]
  activeChatId: string | null
  historySaveFailed: boolean
  historyStatusMessage?: string | null
  historyLimit?: number | null
  historyChatCount?: number
  historyAtLimit?: boolean
  historyLimitCopy?: string | null
  /** Optional small type label per row (e.g. Token / Wallet / LP / Chat). Presentation only. */
  chatTypeLabel?: (chat: ClarkChatSummary) => string | null
  onNewChat: () => void
  onSelectChat: (id: string) => void
  onSearch: (query: string) => void
  onCreateFolder: (name: string) => void
  onRenameChat: (id: string, title: string) => void
  onMoveChat: (id: string, folderId: string | null) => void
  onDeleteChat: (id: string) => void
  onDeleteFolder: (id: string) => void
}

// DESIGN FIX, DISCLOSED (Clark AI final polish): repeated low-value chat titles ("hi", "hey",
// "test") were visually identical to real analysis chats, dominating the list. This purely
// changes presentation (smaller, muted, no preview line) — the chat itself, its data, and every
// action (rename/move/delete/select) are unchanged and still fully functional.
const GENERIC_CHAT_TITLES = new Set(['hi', 'hey', 'hello', 'yo', 'sup', 'test', 'hii', 'heyy', 'ok', 'okay', 'new clark chat'])
function isGenericChatTitle(title: string): boolean {
  const t = title.trim().toLowerCase()
  return t.length <= 3 || GENERIC_CHAT_TITLES.has(t)
}

/** Compact relative time for a chat row ("now", "8m", "3h", "2d", or a short date). */
export function chatRowTime(updatedAt: string, nowMs: number = Date.now()): string {
  const t = Date.parse(updatedAt)
  if (!Number.isFinite(t)) return ''
  const s = Math.max(0, Math.round((nowMs - t) / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

type ChatGroup = { label: string; chats: ClarkChatSummary[] }

/** Pinned first, then Today / Yesterday / Previous 7 days / Older, by updated_at. Order within a group is kept. */
export function groupChatsByRecency(chats: ClarkChatSummary[], nowMs: number = Date.now()): ChatGroup[] {
  const startOfToday = new Date(nowMs); startOfToday.setHours(0, 0, 0, 0)
  const today = startOfToday.getTime()
  const yesterday = today - 86_400_000
  const weekAgo = today - 6 * 86_400_000
  const groups: ChatGroup[] = [
    { label: 'Pinned', chats: [] }, { label: 'Today', chats: [] }, { label: 'Yesterday', chats: [] },
    { label: 'Previous 7 days', chats: [] }, { label: 'Older', chats: [] },
  ]
  for (const chat of chats) {
    const t = Date.parse(chat.updated_at)
    const idx = chat.pinned ? 0 : !Number.isFinite(t) ? 4 : t >= today ? 1 : t >= yesterday ? 2 : t >= weekAgo ? 3 : 4
    groups[idx].chats.push(chat)
  }
  return groups.filter((g) => g.chats.length > 0)
}

export default function ClarkHistoryPanel({
  folders, chats, activeChatId, historySaveFailed, historyStatusMessage,
  historyLimit = null, historyChatCount = 0, historyAtLimit = false, historyLimitCopy = null, chatTypeLabel,
  onNewChat, onSelectChat, onSearch, onCreateFolder, onRenameChat, onMoveChat, onDeleteChat, onDeleteFolder,
}: ClarkHistoryPanelProps) {
  const [query, setQuery] = useState('')
  const [activeFolderId, setActiveFolderId] = useState<string | 'all'>('all')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const visibleChats = activeFolderId === 'all' ? chats : chats.filter((c) => c.folder_id === activeFolderId)
  const groups = groupChatsByRecency(visibleChats)
  const folderName = (id: string | null) => (id ? folders.find((f) => f.id === id)?.name ?? null : null)

  return (
    <div className='clk-histpanel'>
      <style>{`
        .clk-histpanel { display:flex; flex-direction:column; gap:10px; min-height:0; flex:1 1 auto; }
        .clk-histpanel-top { display:flex; flex-direction:column; gap:8px; }
        .clk-histpanel-new { display:flex; align-items:center; justify-content:center; gap:7px; height:36px; border:1px solid rgba(31,214,220,.3); border-radius:10px; background:rgba(31,214,220,.08); color:#bff6f7; font-weight:650; font-size:13px; cursor:pointer; transition:background .15s, border-color .15s; }
        .clk-histpanel-new:hover { background:rgba(31,214,220,.14); border-color:rgba(31,214,220,.46); }
        .clk-histpanel-new:disabled { opacity:.45; cursor:not-allowed; }
        .clk-histpanel-new:disabled:hover { background:rgba(31,214,220,.08); border-color:rgba(31,214,220,.3); }
        .clk-histpanel-searchwrap { position:relative; }
        .clk-histpanel-searchwrap svg { position:absolute; left:10px; top:50%; transform:translateY(-50%); color:#6f7479; pointer-events:none; }
        .clk-histpanel-search { width:100%; height:34px; box-sizing:border-box; border:1px solid rgba(170,176,182,.13); border-radius:9px; background:#0d0f11; color:#e4e7ea; font-size:12.5px; padding:0 10px 0 30px; transition:border-color .15s; }
        .clk-histpanel-search::placeholder { color:#6f7479; }
        .clk-histpanel-search:focus { outline:none; border-color:rgba(31,214,220,.42); }
        .clk-histpanel-meta { color:#80858a; font:600 10.5px var(--font-plex-mono, monospace); letter-spacing:.04em; }
        .clk-histpanel-fail { color:#fbbf24; font-size:11.5px; font-weight:600; line-height:1.45; }
        .clk-histpanel-folders { display:flex; flex-wrap:wrap; gap:4px; }
        .clk-histpanel-folder { display:inline-flex; align-items:center; border-radius:7px; background:rgba(170,176,182,.06); }
        .clk-histpanel-folder--active { background:rgba(31,214,220,.1); box-shadow:inset 0 0 0 1px rgba(31,214,220,.28); }
        .clk-histpanel-folder-chip { height:26px; border:0; border-radius:7px; padding:0 9px; font-size:11.5px; font-weight:600; color:#a4a9ae; background:transparent; cursor:pointer; max-width:140px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .clk-histpanel-folder-chip:hover { color:#e3e6e9; }
        .clk-histpanel-folder--active .clk-histpanel-folder-chip { color:#a5f3f5; }
        .clk-histpanel-folder-x { height:26px; border:0; background:transparent; color:#6f7479; cursor:pointer; padding:0 7px 0 0; font-size:10px; }
        .clk-histpanel-folder-x:hover { color:#f87171; }
        .clk-histpanel-folder-add { height:26px; border:1px dashed rgba(170,176,182,.2); border-radius:7px; padding:0 9px; background:transparent; color:#80858a; font-size:11.5px; font-weight:600; cursor:pointer; }
        .clk-histpanel-folder-add:hover { color:#d4d8dc; border-color:rgba(170,176,182,.36); }
        .clk-histpanel-list { flex:1 1 auto; min-height:120px; overflow-y:auto; margin:0 -6px; padding:0 2px; }
        .clk-histpanel-group + .clk-histpanel-group { margin-top:10px; }
        .clk-histpanel-group-label { margin:0 0 3px; padding:0 8px; color:#6f7479; font:700 10px var(--font-plex-mono, monospace); letter-spacing:.12em; text-transform:uppercase; }
        .clk-histpanel-item { position:relative; display:flex; align-items:center; border-radius:8px; transition:background .15s; }
        .clk-histpanel-item:hover { background:rgba(170,176,182,.06); }
        .clk-histpanel-item--active { background:rgba(31,214,220,.08); }
        .clk-histpanel-item--active:hover { background:rgba(31,214,220,.1); }
        .clk-histpanel-item--active::before { content:''; position:absolute; left:0; top:7px; bottom:7px; width:2px; border-radius:2px; background:#1fd6dc; }
        .clk-histpanel-item-main { flex:1; min-width:0; border:0; background:transparent; text-align:left; padding:7px 8px 7px 10px; cursor:pointer; border-radius:8px; }
        .clk-histpanel-item-main:focus-visible { outline:2px solid rgba(31,214,220,.55); outline-offset:-2px; }
        .clk-histpanel-item-title { font-size:12.5px; font-weight:600; color:#dfe3e6; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .clk-histpanel-item--active .clk-histpanel-item-title { color:#f4f6f8; }
        .clk-histpanel-item-title--generic { font-weight:500; color:#80858a; }
        .clk-histpanel-item-sub { display:flex; gap:6px; align-items:center; margin-top:2px; font:600 10px var(--font-plex-mono, monospace); letter-spacing:.04em; color:#6f7479; text-transform:uppercase; overflow:hidden; white-space:nowrap; }
        .clk-histpanel-item-folder { color:#8fa3a8; overflow:hidden; text-overflow:ellipsis; }
        /* Rename/move/delete stay real, always-clickable elements, revealed on row hover/focus. */
        .clk-histpanel-item-actions { display:flex; gap:2px; flex-shrink:0; padding-right:4px; opacity:0; transition:opacity .15s; }
        .clk-histpanel-item:hover .clk-histpanel-item-actions,
        .clk-histpanel-item:focus-within .clk-histpanel-item-actions { opacity:1; }
        /* With a mouse, the actions float over the row's right edge on hover so titles keep the full width. */
        @media (hover: hover) {
          .clk-histpanel-item-actions { position:absolute; right:0; top:0; bottom:0; align-items:center; padding:0 4px 0 18px; border-radius:0 8px 8px 0; background:linear-gradient(90deg, rgba(14,16,18,0), #121518 16px); pointer-events:none; }
          .clk-histpanel-item--active .clk-histpanel-item-actions { background:linear-gradient(90deg, rgba(14,24,26,0), #0f1f21 16px); }
          .clk-histpanel-item:hover .clk-histpanel-item-actions,
          .clk-histpanel-item:focus-within .clk-histpanel-item-actions { pointer-events:auto; }
        }
        @media (hover: none) {
          .clk-histpanel-item-actions { opacity:1; }
          .clk-histpanel-item-btn { width:36px; height:40px; }
        }
        .clk-histpanel-item-btn { display:grid; place-items:center; width:24px; height:24px; border:0; border-radius:6px; background:transparent; color:#80858a; cursor:pointer; padding:0; }
        .clk-histpanel-item-btn:hover { color:#e3e6e9; background:rgba(255,255,255,.05); }
        .clk-histpanel-item-btn--danger:hover { color:#fca5a5; }
        .clk-histpanel-item-btn:focus-visible, .clk-histpanel-folder-chip:focus-visible, .clk-histpanel-folder-x:focus-visible, .clk-histpanel-folder-add:focus-visible, .clk-histpanel-new:focus-visible { outline:2px solid rgba(31,214,220,.55); outline-offset:1px; }
        .clk-histpanel-empty { color:#80858a; font-size:12px; line-height:1.55; padding:6px 8px; margin:0; }
        .clk-histpanel-rename-input { width:100%; margin:3px 4px; font-size:12.5px; border:1px solid rgba(31,214,220,.4); border-radius:7px; background:#0d0f11; color:#e5edf8; padding:6px 8px; }
      `}</style>

      <div className='clk-histpanel-top'>
        <button type='button' className='clk-histpanel-new' onClick={onNewChat} disabled={historyAtLimit}>
          <svg width='13' height='13' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.4' strokeLinecap='round' aria-hidden='true'><path d='M12 5v14M5 12h14' /></svg>
          New chat
        </button>
        <div className='clk-histpanel-searchwrap'>
          <svg width='13' height='13' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.2' strokeLinecap='round' aria-hidden='true'><circle cx='11' cy='11' r='7' /><path d='m20 20-3.5-3.5' /></svg>
          <input
            className='clk-histpanel-search'
            type='search'
            placeholder='Search chats'
            aria-label='Search chats'
            value={query}
            onChange={(e) => { setQuery(e.target.value); onSearch(e.target.value) }}
          />
        </div>
      </div>

      {historyLimit != null && (
        <span className='clk-histpanel-meta'>{historyChatCount}/{historyLimit} saved chats</span>
      )}
      {historyAtLimit && historyLimitCopy && (
        <span className='clk-histpanel-fail'>{historyLimitCopy}</span>
      )}
      {historySaveFailed && (
        <span className='clk-histpanel-fail' role='status'>
          {historyStatusMessage ?? 'History not saved — Clark still works, but this chat won’t persist.'}
        </span>
      )}

      <div className='clk-histpanel-folders' role='group' aria-label='Folders'>
        <span className={`clk-histpanel-folder${activeFolderId === 'all' ? ' clk-histpanel-folder--active' : ''}`}>
          <button type='button' className='clk-histpanel-folder-chip' aria-pressed={activeFolderId === 'all'} onClick={() => setActiveFolderId('all')}>All chats</button>
        </span>
        {folders.map((f) => (
          <span key={f.id} className={`clk-histpanel-folder${activeFolderId === f.id ? ' clk-histpanel-folder--active' : ''}`}>
            <button type='button' className='clk-histpanel-folder-chip' aria-pressed={activeFolderId === f.id} title={f.name} onClick={() => setActiveFolderId(f.id)}>{f.name}</button>
            <button type='button' className='clk-histpanel-folder-x' aria-label={`Delete folder ${f.name}`} onClick={() => { if (activeFolderId === f.id) setActiveFolderId('all'); onDeleteFolder(f.id) }}>✕</button>
          </span>
        ))}
        <button
          type='button'
          className='clk-histpanel-folder-add'
          onClick={() => { const name = window.prompt('Folder name?'); if (name && name.trim()) onCreateFolder(name.trim()) }}
        >
          + Folder
        </button>
      </div>

      <nav className='clk-histpanel-list' aria-label='Saved Clark chats'>
        {visibleChats.length === 0 && (
          <p className='clk-histpanel-empty'>Start a Clark chat. Your token, wallet, and market reads will be saved here.</p>
        )}
        {groups.map((group) => (
          <div key={group.label} className='clk-histpanel-group'>
            <p className='clk-histpanel-group-label'>{group.label}</p>
            {group.chats.map((chat) => (
              <div key={chat.id} className={`clk-histpanel-item${chat.id === activeChatId ? ' clk-histpanel-item--active' : ''}`}>
                {renamingId === chat.id ? (
                  <input
                    className='clk-histpanel-rename-input'
                    autoFocus
                    aria-label='Rename chat'
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && renameValue.trim()) { onRenameChat(chat.id, renameValue.trim()); setRenamingId(null) }
                      if (e.key === 'Escape') setRenamingId(null)
                    }}
                    onBlur={() => setRenamingId(null)}
                  />
                ) : (
                  <>
                    <button
                      type='button'
                      className='clk-histpanel-item-main'
                      aria-current={chat.id === activeChatId ? 'true' : undefined}
                      title={chat.last_message_preview ?? chat.title}
                      onClick={() => onSelectChat(chat.id)}
                    >
                      <div className={`clk-histpanel-item-title${isGenericChatTitle(chat.title) ? ' clk-histpanel-item-title--generic' : ''}`}>{chat.pinned ? '📌 ' : ''}{chat.title}</div>
                      <div className='clk-histpanel-item-sub'>
                        {chatTypeLabel?.(chat) && <span>{chatTypeLabel(chat)}</span>}
                        <span>{chatRowTime(chat.updated_at)}</span>
                        {activeFolderId === 'all' && folderName(chat.folder_id) && <span className='clk-histpanel-item-folder'>· {folderName(chat.folder_id)}</span>}
                      </div>
                    </button>
                    <div className='clk-histpanel-item-actions'>
                      <button type='button' className='clk-histpanel-item-btn' aria-label={`Rename ${chat.title}`} title='Rename' onClick={() => { setRenameValue(chat.title); setRenamingId(chat.id) }}>
                        <svg width='13' height='13' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' aria-hidden='true'><path d='M12 20h9' /><path d='M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z' /></svg>
                      </button>
                      <button
                        type='button'
                        className='clk-histpanel-item-btn'
                        aria-label={`Move ${chat.title} to a folder`}
                        title='Move to folder'
                        onClick={() => {
                          if (folders.length === 0) { window.alert('Create a folder first.'); return }
                          const names = folders.map((f, i) => `${i + 1}. ${f.name}`).join('\n')
                          const choice = window.prompt(`Move to which folder?\n${names}\n(0 = remove from folder)`)
                          if (choice === null) return
                          const idx = Number(choice)
                          if (idx === 0) { onMoveChat(chat.id, null); return }
                          const folder = folders[idx - 1]
                          if (folder) onMoveChat(chat.id, folder.id)
                        }}
                      >
                        <svg width='13' height='13' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' aria-hidden='true'><path d='M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z' /></svg>
                      </button>
                      <button type='button' className='clk-histpanel-item-btn clk-histpanel-item-btn--danger' aria-label={`Delete ${chat.title}`} title='Delete' onClick={() => onDeleteChat(chat.id)}>
                        <svg width='13' height='13' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' aria-hidden='true'><path d='M3 6h18' /><path d='M8 6V4h8v2' /><path d='M19 6l-1 14H6L5 6' /></svg>
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        ))}
      </nav>
    </div>
  )
}
