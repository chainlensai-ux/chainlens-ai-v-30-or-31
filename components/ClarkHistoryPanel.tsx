'use client'

import { useState } from 'react'
import type { ClarkChatFolder, ClarkChatSummary } from '@/lib/client/clarkHistoryClient'

export type ClarkHistoryPanelProps = {
  folders: ClarkChatFolder[]
  chats: ClarkChatSummary[]
  activeChatId: string | null
  historySaveFailed: boolean
  historyStatusMessage?: string | null
  onNewChat: () => void
  onSelectChat: (id: string) => void
  onSearch: (query: string) => void
  onCreateFolder: (name: string) => void
  onRenameChat: (id: string, title: string) => void
  onMoveChat: (id: string, folderId: string | null) => void
  onDeleteChat: (id: string) => void
  onDeleteFolder: (id: string) => void
}

export default function ClarkHistoryPanel({
  folders, chats, activeChatId, historySaveFailed, historyStatusMessage,
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
        .clk-histpanel { display:flex; flex-direction:column; gap:12px; border:1px solid rgba(148,163,184,.14); border-radius:16px; background:rgba(6,11,22,.86); padding:14px; min-height:320px; }
        .clk-histpanel-new { border:1px solid rgba(34,211,238,.32); border-radius:10px; background:rgba(34,211,238,.08); color:#67e8f9; font-weight:800; font-size:13px; padding:9px 12px; cursor:pointer; }
        .clk-histpanel-search { border:1px solid rgba(148,163,184,.18); border-radius:10px; background:rgba(2,6,14,.7); color:#e2e8f0; font-size:13px; padding:8px 10px; }
        .clk-histpanel-fail { color:#fbbf24; font-size:11px; font-weight:700; }
        .clk-histpanel-folders { display:flex; flex-wrap:wrap; gap:6px; }
        .clk-histpanel-folder-chip { border:1px solid rgba(148,163,184,.18); border-radius:999px; padding:4px 9px; font-size:11px; font-weight:700; color:#a8b4c7; background:rgba(15,23,42,.4); cursor:pointer; }
        .clk-histpanel-folder-chip--active { color:#67e8f9; border-color:rgba(34,211,238,.4); background:rgba(34,211,238,.08); }
        .clk-histpanel-list { display:flex; flex-direction:column; gap:6px; overflow-y:auto; max-height:420px; }
        .clk-histpanel-item { border:1px solid rgba(148,163,184,.12); border-radius:10px; padding:9px 10px; cursor:pointer; background:rgba(11,18,32,.6); }
        .clk-histpanel-item--active { border-color:rgba(45,212,191,.4); background:rgba(45,212,191,.06); }
        .clk-histpanel-item-title { font-size:13px; font-weight:750; color:#e5edf8; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .clk-histpanel-item-preview { font-size:11px; color:#7c8aa1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:2px; }
        .clk-histpanel-item-row { display:flex; align-items:center; justify-content:space-between; gap:6px; }
        .clk-histpanel-item-actions { display:flex; gap:6px; }
        .clk-histpanel-item-btn { border:0; background:transparent; color:#64748b; cursor:pointer; font-size:11px; padding:0; }
        .clk-histpanel-empty { color:#7c8aa1; font-size:13px; line-height:1.5; padding:12px 2px; }
        .clk-histpanel-rename-input { width:100%; font-size:13px; border:1px solid rgba(34,211,238,.4); border-radius:8px; background:rgba(2,6,14,.8); color:#e5edf8; padding:6px 8px; }
      `}</style>

      <button type='button' className='clk-histpanel-new' onClick={onNewChat}>+ New Chat</button>
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
                  <div className='clk-histpanel-item-title'>{chat.pinned ? '📌 ' : ''}{chat.title}</div>
                  {chat.last_message_preview && <div className='clk-histpanel-item-preview'>{chat.last_message_preview}</div>}
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
