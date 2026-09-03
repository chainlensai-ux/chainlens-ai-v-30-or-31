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

export default function ClarkHistoryPanel({
  folders, chats, activeChatId, historySaveFailed, historyStatusMessage,
  historyLimit = null, historyChatCount = 0, historyAtLimit = false, historyLimitCopy = null,
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
        .clk-histpanel { display:flex; flex-direction:column; gap:13px; }
        .clk-histpanel-new { border:1px solid rgba(34,211,238,.28); border-radius:10px; background:rgba(34,211,238,.06); color:#67e8f9; font-weight:750; font-size:13.5px; padding:10px 14px; cursor:pointer; transition:background .15s, border-color .15s; }
        .clk-histpanel-new:hover { background:rgba(34,211,238,.11); border-color:rgba(34,211,238,.42); }
        .clk-histpanel-new:disabled { opacity:.45; cursor:not-allowed; }
        .clk-histpanel-new:disabled:hover { background:rgba(34,211,238,.06); border-color:rgba(34,211,238,.28); }
        .clk-histpanel-meta { color:#71809a; font-size:11px; font-weight:650; letter-spacing:.04em; }
        .clk-histpanel-search { border:1px solid rgba(148,163,184,.16); border-radius:10px; background:rgba(2,6,14,.6); color:#e2e8f0; font-size:13.5px; padding:9px 12px; }
        .clk-histpanel-fail { color:#fbbf24; font-size:11.5px; font-weight:700; }
        .clk-histpanel-folders { display:flex; flex-wrap:wrap; gap:7px; }
        .clk-histpanel-folder-chip { border:1px solid rgba(148,163,184,.16); border-radius:999px; padding:4px 10px; font-size:11px; font-weight:700; color:#a8b4c7; background:rgba(15,23,42,.35); cursor:pointer; }
        .clk-histpanel-folder-chip--active { color:#67e8f9; border-color:rgba(34,211,238,.4); background:rgba(34,211,238,.08); }
        .clk-histpanel-list { display:flex; flex-direction:column; gap:4px; overflow-y:auto; max-height:390px; }
        .clk-histpanel-item { border:1px solid transparent; border-radius:10px; padding:11px 12px; cursor:pointer; background:transparent; transition:background .15s, border-color .15s; }
        .clk-histpanel-item:hover { background:rgba(148,163,184,.05); border-color:rgba(148,163,184,.12); }
        .clk-histpanel-item--active { border-color:rgba(45,212,191,.32); background:rgba(45,212,191,.055); }
        .clk-histpanel-item-title { font-size:13.5px; font-weight:700; color:#dbe4f0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .clk-histpanel-item-title--generic { font-size:12.5px; font-weight:500; color:#5b6b84; }
        .clk-histpanel-item-preview { font-size:11.5px; color:#71809a; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:3px; }
        .clk-histpanel-item-row { display:flex; align-items:center; justify-content:space-between; gap:7px; }
        /* AUDIT/DESIGN FIX, DISCLOSED (Clark AI polish): rename/move/delete previously rendered as
           permanent text buttons on every row — visible noise even when not needed. Now hidden by
           default and revealed only on row hover/focus, matching the task's "subtle, not visible
           noise unless hover-supported" spec. Kept as real, always-clickable elements (not removed
           from the DOM) so keyboard/focus navigation still reaches them via :focus-within. */
        .clk-histpanel-item-actions { display:flex; gap:9px; flex-shrink:0; opacity:0; transition:opacity .15s; }
        .clk-histpanel-item:hover .clk-histpanel-item-actions,
        .clk-histpanel-item:focus-within .clk-histpanel-item-actions { opacity:1; }
        @media (hover: none) {
          .clk-histpanel-item-actions { opacity:1; }
          .clk-histpanel-item-btn { min-height:44px; padding:8px 10px; }
        }
        .clk-histpanel-item-btn { border:0; background:transparent; color:#5b6b84; cursor:pointer; font-size:11px; font-weight:600; padding:0; }
        .clk-histpanel-item-btn:hover { color:#94a3b8; }
        .clk-histpanel-empty { color:#7c8aa1; font-size:13px; line-height:1.55; padding:12px 2px; }
        .clk-histpanel-rename-input { width:100%; font-size:13.5px; border:1px solid rgba(34,211,238,.4); border-radius:9px; background:rgba(2,6,14,.8); color:#e5edf8; padding:7px 9px; }
      `}</style>

      <button type='button' className='clk-histpanel-new' onClick={onNewChat} disabled={historyAtLimit}>+ New Chat</button>
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
      <input
        className='clk-histpanel-search'
        placeholder='Search chats...'
        value={query}
        onChange={(e) => { setQuery(e.target.value); onSearch(e.target.value) }}
      />

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
                  <div className={`clk-histpanel-item-title${isGenericChatTitle(chat.title) ? ' clk-histpanel-item-title--generic' : ''}`}>{chat.pinned ? '📌 ' : ''}{chat.title}</div>
                  {chat.last_message_preview && !isGenericChatTitle(chat.title) && <div className='clk-histpanel-item-preview'>{chat.last_message_preview}</div>}
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
