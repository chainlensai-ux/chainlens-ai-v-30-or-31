'use client'

// Thin fetch wrappers around /api/clark/history. Every call is best-effort: history saving must
// never block or break the Clark chat itself, so callers should swallow failures and keep working
// locally (see the `historySaveFailed` flag the Clark page sets when a call here throws/fails).

export type ClarkChatFolder = { id: string; name: string; sort_order: number }
export type ClarkChatSummary = {
  id: string; folder_id: string | null; title: string; summary: string | null
  last_message_preview: string | null; message_count: number; pinned: boolean; archived: boolean
  updated_at: string
}
export type ClarkChatMessageRow = { id: string; chat_id: string; role: 'user' | 'assistant' | 'system'; content: string; metadata: unknown; created_at: string }

async function authHeaders(): Promise<Record<string, string>> {
  const { supabase } = await import('@/lib/supabaseClient')
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export async function fetchClarkHistory(query?: string): Promise<{ folders: ClarkChatFolder[]; chats: ClarkChatSummary[] }> {
  const headers = await authHeaders()
  const url = query ? `/api/clark/history?q=${encodeURIComponent(query)}` : '/api/clark/history'
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error('history fetch failed')
  const json = await res.json()
  return { folders: json.folders ?? [], chats: json.chats ?? [] }
}

export async function fetchClarkChatMessages(chatId: string): Promise<ClarkChatMessageRow[]> {
  const headers = await authHeaders()
  const res = await fetch(`/api/clark/history?chatId=${encodeURIComponent(chatId)}`, { headers })
  if (!res.ok) throw new Error('messages fetch failed')
  const json = await res.json()
  return json.messages ?? []
}

export async function createClarkChat(title?: string, folderId?: string | null): Promise<ClarkChatSummary> {
  const headers = await authHeaders()
  const res = await fetch('/api/clark/history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ type: 'chat', title, folderId }),
  })
  if (!res.ok) throw new Error('create chat failed')
  const json = await res.json()
  return json.chat
}

export async function createClarkFolder(name: string): Promise<ClarkChatFolder> {
  const headers = await authHeaders()
  const res = await fetch('/api/clark/history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ type: 'folder', name }),
  })
  if (!res.ok) throw new Error('create folder failed')
  const json = await res.json()
  return json.folder
}

export async function appendClarkMessage(chatId: string, role: 'user' | 'assistant', content: string, rawPayload?: unknown): Promise<void> {
  const headers = await authHeaders()
  const res = await fetch('/api/clark/history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ type: 'message', chatId, role, content, rawPayload }),
  })
  if (!res.ok) throw new Error('append message failed')
}

export async function renameClarkChat(id: string, title: string): Promise<void> {
  const headers = await authHeaders()
  const res = await fetch('/api/clark/history', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ type: 'chat', id, title }),
  })
  if (!res.ok) throw new Error('rename chat failed')
}

export async function renameClarkFolder(id: string, name: string): Promise<void> {
  const headers = await authHeaders()
  const res = await fetch('/api/clark/history', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ type: 'folder', id, name }),
  })
  if (!res.ok) throw new Error('rename folder failed')
}

export async function moveClarkChatToFolder(id: string, folderId: string | null): Promise<void> {
  const headers = await authHeaders()
  const res = await fetch('/api/clark/history', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ type: 'chat', id, folderId }),
  })
  if (!res.ok) throw new Error('move chat failed')
}

export async function setClarkChatPinned(id: string, pinned: boolean): Promise<void> {
  const headers = await authHeaders()
  const res = await fetch('/api/clark/history', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ type: 'chat', id, pinned }),
  })
  if (!res.ok) throw new Error('pin chat failed')
}

export async function deleteClarkChat(id: string): Promise<void> {
  const headers = await authHeaders()
  const res = await fetch(`/api/clark/history?type=chat&id=${encodeURIComponent(id)}`, { method: 'DELETE', headers })
  if (!res.ok) throw new Error('delete chat failed')
}

export async function deleteClarkFolder(id: string): Promise<void> {
  const headers = await authHeaders()
  const res = await fetch(`/api/clark/history?type=folder&id=${encodeURIComponent(id)}`, { method: 'DELETE', headers })
  if (!res.ok) throw new Error('delete folder failed')
}
