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

  return (
    <div className='clk-histpanel'>
      <style>{`
        .clk-histpanel { display:flex; flex-direction:column; gap:8px; min-height:0; }
        .clk-histpanel-top { display:flex; gap:6px; align-items:center; }
        .clk-histpanel-new { flex:0 0 auto; border:1px solid rgba(34,211,238,.26); border-radius:7px; background:rgba(34,211,238,.06); color:#67e8f9; font-weight:700; font-size:12px; padding:6px 10px; cursor:pointer; white-space:nowrap; transition:background .15s, border-color .15s; }
        .clk-histpanel-new:hover { background:rgba(34,211,238,.12); border-color:rgba(34,211,238,.42); }
        .clk-histpanel-new:disabled { opacity:.45; cursor:not-allowed; }
        .clk-histpanel-new:disabled:hover { background:rgba(34,211,238,.06); border-color:rgba(34,211,238,.26); }
        .clk-histpanel-meta { color:#8391a7; font:600 10.5px var(--font-plex-mono, monospace); letter-spacing:.04em; }
        .clk-histpanel-search { flex:1 1 auto; min-width:0; border:1px solid rgba(148,163,184,.12); border-radius:7px; background:rgba(2,6,14,.55); color:#e2e8f0; font-size:12.5px; padding:6px 9px; }
        .clk-histpanel-search:focus { outline:none; border-color:rgba(34,211,238,.4); }
        .clk-histpanel-fail { color:#fbbf24; font-size:11px; font-weight:650; line-height:1.4; }
        .clk-histpanel-folders { display:flex; flex-wrap:wrap; gap:4px 10px; }
        .clk-histpanel-folder-chip { border:0; padding:0; font-size:11px; font-weight:600; color:#8391a7; background:transparent; cursor:pointer; display:inline-flex; align-items:center; }
        .clk-histpanel-folder-chip:hover { color:#c3ccdb; }
        .clk-histpanel-folder-chip--active { color:#67e8f9; }
        .clk-histpanel-list { display:flex; flex-direction:column; gap:1px; overflow-y:auto; max-height:min(420px, calc(100vh - 360px)); margin:0 -6px; }
        .clk-histpanel-item { position:relative; border-radius:6px; padding:6px 8px 6px 10px; cursor:pointer; background:transparent; transition:background .12s; }
        .clk-histpanel-item:hover { background:rgba(148,163,184,.06); }
        .clk-histpanel-item--active { background:rgba(34,211,238,.07); }
        .clk-histpanel-item--active::before { content:''; position:absolute; left:0; top:6px; bottom:6px; width:2px; border-radius:2px; background:#22d3ee; }
        .clk-histpanel-item-title { font-size:12.5px; font-weight:600; color:#dbe4f0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .clk-histpanel-item-title--generic { font-weight:500; color:#7c8aa1; }
        .clk-histpanel-item-sub { display:flex; gap:6px; align-items:center; margin-top:1px; font:600 10px var(--font-plex-mono, monospace); letter-spacing:.04em; color:#71809a; text-transform:uppercase; }
        .clk-histpanel-item-row { display:flex; align-items:center; justify-content:space-between; gap:6px; }
        /* Rename/move/delete stay real, always-clickable elements, revealed on row hover/focus. */
        .clk-histpanel-item-actions { display:flex; gap:7px; flex-shrink:0; opacity:0; transition:opacity .15s; }
        .clk-histpanel-item:hover .clk-histpanel-item-actions,
        .clk-histpanel-item:focus-within .clk-histpanel-item-actions { opacity:1; }
        @media (hover: none) {
          .clk-histpanel-item-actions { opacity:1; }
          .clk-histpanel-item-btn { min-height:44px; padding:8px 10px; }
        }
        .clk-histpanel-item-btn { border:0; background:transparent; color:#71809a; cursor:pointer; font-size:10.5px; font-weight:600; padding:0; }
        .clk-histpanel-item-btn:hover { color:#cbd5e1; }
        .clk-histpanel-empty { color:#8391a7; font-size:12px; line-height:1.5; padding:4px 6px; margin:0; }
        .clk-histpanel-rename-input { width:100%; font-size:12.5px; border:1px solid rgba(34,211,238,.4); border-radius:6px; background:rgba(2,6,14,.8); color:#e5edf8; padding:5px 7px; }
      `}</style>

      <div className='clk-histpanel-top'>
        <input
          className='clk-histpanel-search'
          placeholder='Search chats...'
          aria-label='Search chats'
          value={query}
          onChange={(e) => { setQuery(e.target.value); onSearch(e.target.value) }}
        />
        <button type='button' className='clk-histpanel-new' onClick={onNewChat} disabled={historyAtLimit}>+ New Chat</button>
      </div>

      {historyLimit != null && (
        <span className='clk-histpanel-meta'>{historyChatCount}/{historyLimit} saved chats</span>
      )}
      {historyAtLimit && historyLimitCopy && (
        <span className='clk-histpanel-fail'>{historyLimitCopy}</span>
      )}
      {historySaveFailed && (
        <span className='clk-histpanel-fail'>
          {historyStatusMessage ?? 'History not saved — Clark still works, but this chat won’t persist.'}
        </span>
      )}

      <div className='clk-histpanel-folders'>
        <span
          className={`clk-histpanel-folder-chip${activeFolderId === 'all' ? ' clk-histpanel-folder-chip--active' : ''}`}
          onClick={() => setActiveFolderId('all')}
        >
          All chats
        </span>
        {folders.map((f) => (
          <span
            key={f.id}
            className={`clk-histpanel-folder-chip${activeFolderId === f.id ? ' clk-histpanel-folder-chip--active' : ''}`}
            onClick={() => setActiveFolderId(f.id)}
          >
            {f.name}
            <button type='button' className='clk-histpanel-item-btn' style={{ marginLeft: 6 }} onClick={(e) => { e.stopPropagation(); onDeleteFolder(f.id) }}>✕</button>
          </span>
        ))}
        <button
          type='button'
          className='clk-histpanel-folder-chip'
          onClick={() => { const name = window.prompt('Folder name?'); if (name && name.trim()) onCreateFolder(name.trim()) }}
        >
          + Folder
        </button>
      </div>

      <div className='clk-histpanel-list'>
        {visibleChats.length === 0 && (
          <p className='clk-histpanel-empty'>Start a Clark chat. Your token, wallet, and market reads will be saved here.</p>
        )}
        {visibleChats.map((chat) => (
          <div
            key={chat.id}
            className={`clk-histpanel-item${chat.id === activeChatId ? ' clk-histpanel-item--active' : ''}`}
            onClick={() => onSelectChat(chat.id)}
          >
            {renamingId === chat.id ? (
              <input
                className='clk-histpanel-rename-input'
                autoFocus
                value={renameValue}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && renameValue.trim()) { onRenameChat(chat.id, renameValue.trim()); setRenamingId(null) }
                  if (e.key === 'Escape') setRenamingId(null)
                }}
                onBlur={() => setRenamingId(null)}
              />
            ) : (
              <div className='clk-histpanel-item-row'>
                <div style={{ minWidth: 0 }}>
                  <div className={`clk-histpanel-item-title${isGenericChatTitle(chat.title) ? ' clk-histpanel-item-title--generic' : ''}`} title={chat.last_message_preview ?? chat.title}>{chat.pinned ? '📌 ' : ''}{chat.title}</div>
                  <div className='clk-histpanel-item-sub'>
                    {chatTypeLabel?.(chat) && <span>{chatTypeLabel(chat)}</span>}
                    <span>{chatRowTime(chat.updated_at)}</span>
                  </div>
                </div>
                <div className='clk-histpanel-item-actions'>
                  <button type='button' className='clk-histpanel-item-btn' onClick={(e) => { e.stopPropagation(); setRenameValue(chat.title); setRenamingId(chat.id) }}>Rename</button>
                  <button
                    type='button'
                    className='clk-histpanel-item-btn'
                    onClick={(e) => {
                      e.stopPropagation()
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
                    Move
                  </button>
                  <button type='button' className='clk-histpanel-item-btn' onClick={(e) => { e.stopPropagation(); onDeleteChat(chat.id) }}>Delete</button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
