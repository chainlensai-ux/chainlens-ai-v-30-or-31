import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { sanitizeMessageMetadata, buildMessagePreview } from '@/lib/server/clarkHistory'

// Persists Clark chat history (folders, chats, messages) for the signed-in user only.
// Does not touch Clark's intelligence/routing pipeline in app/api/clark/route.ts — this is a
// separate, additive storage layer the frontend calls after Clark already answered.

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

function createAnonClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) return null
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

async function getUserId(req: NextRequest): Promise<string | null> {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (!token) return null
  const anon = createAnonClient()
  if (!anon) return null
  const { data } = await anon.auth.getUser(token)
  return data.user?.id ?? null
}

export async function GET(req: NextRequest) {
  const userId = await getUserId(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const db = getServiceClient()
  if (!db) return NextResponse.json({ error: 'Service unavailable' }, { status: 503 })

  const { searchParams } = new URL(req.url)
  const chatId = searchParams.get('chatId')
  const query = searchParams.get('q')?.trim()

  if (chatId) {
    const { data, error } = await db
      .from('clark_chat_messages')
      .select('*')
      .eq('user_id', userId)
      .eq('chat_id', chatId)
      .order('created_at', { ascending: true })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ messages: data ?? [] })
  }

  const { data: folders, error: foldersError } = await db
    .from('clark_chat_folders')
    .select('*')
    .eq('user_id', userId)
    .order('sort_order', { ascending: true })
  if (foldersError) return NextResponse.json({ error: foldersError.message }, { status: 500 })

  if (query) {
    const [byTitle, byContent] = await Promise.all([
      db.from('clark_chats').select('*').eq('user_id', userId)
        .or(`title.ilike.%${query}%,last_message_preview.ilike.%${query}%`)
        .order('updated_at', { ascending: false }),
      db.from('clark_chat_messages').select('chat_id').eq('user_id', userId)
        .ilike('content', `%${query}%`),
    ])
    if (byTitle.error) return NextResponse.json({ error: byTitle.error.message }, { status: 500 })
    if (byContent.error) return NextResponse.json({ error: byContent.error.message }, { status: 500 })

    const matchedIds = new Set((byTitle.data ?? []).map((c) => c.id))
    const contentChatIds = [...new Set((byContent.data ?? []).map((m) => m.chat_id))].filter((id) => !matchedIds.has(id))
    let extraChats: unknown[] = []
    if (contentChatIds.length > 0) {
      const { data, error } = await db.from('clark_chats').select('*').eq('user_id', userId).in('id', contentChatIds)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      extraChats = data ?? []
    }
    return NextResponse.json({ folders: folders ?? [], chats: [...(byTitle.data ?? []), ...extraChats] })
  }

  const { data: chats, error: chatsError } = await db
    .from('clark_chats')
    .select('*')
    .eq('user_id', userId)
    .order('pinned', { ascending: false })
    .order('updated_at', { ascending: false })
  if (chatsError) return NextResponse.json({ error: chatsError.message }, { status: 500 })

  return NextResponse.json({ folders: folders ?? [], chats: chats ?? [] })
}

export async function POST(req: NextRequest) {
  const userId = await getUserId(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const db = getServiceClient()
  if (!db) return NextResponse.json({ error: 'Service unavailable' }, { status: 503 })

  const body = await req.json().catch(() => null) as Record<string, unknown> | null
  const type = body?.type

  if (type === 'folder') {
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 })
    const { data, error } = await db
      .from('clark_chat_folders')
      .insert({ user_id: userId, name })
      .select()
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ folder: data })
  }

  if (type === 'chat') {
    const title = typeof body?.title === 'string' && body.title.trim() ? body.title.trim() : 'New Clark Chat'
    const folderId = typeof body?.folderId === 'string' ? body.folderId : null
    const { data, error } = await db
      .from('clark_chats')
      .insert({ user_id: userId, title, folder_id: folderId })
      .select()
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ chat: data })
  }

  if (type === 'message') {
    const chatId = typeof body?.chatId === 'string' ? body.chatId : null
    const role = body?.role
    const content = typeof body?.content === 'string' ? body.content : ''
    if (!chatId || (role !== 'user' && role !== 'assistant' && role !== 'system') || !content) {
      return NextResponse.json({ error: 'chatId, role, and content are required' }, { status: 400 })
    }
    const metadata = sanitizeMessageMetadata(body?.rawPayload ?? body?.metadata ?? {})
    const { data: message, error } = await db
      .from('clark_chat_messages')
      .insert({ user_id: userId, chat_id: chatId, role, content, metadata })
      .select()
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const { data: chatRow } = await db.from('clark_chats').select('message_count').eq('id', chatId).eq('user_id', userId).single()
    await db
      .from('clark_chats')
      .update({
        last_message_preview: buildMessagePreview(content),
        message_count: (chatRow?.message_count ?? 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', chatId)
      .eq('user_id', userId)

    return NextResponse.json({ message })
  }

  return NextResponse.json({ error: 'Unknown type' }, { status: 400 })
}

export async function PATCH(req: NextRequest) {
  const userId = await getUserId(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const db = getServiceClient()
  if (!db) return NextResponse.json({ error: 'Service unavailable' }, { status: 503 })

  const body = await req.json().catch(() => null) as Record<string, unknown> | null
  const type = body?.type
  const id = typeof body?.id === 'string' ? body.id : null
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  if (type === 'folder') {
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (typeof body?.name === 'string' && body.name.trim()) updates.name = body.name.trim()
    if (typeof body?.sortOrder === 'number') updates.sort_order = body.sortOrder
    const { data, error } = await db
      .from('clark_chat_folders')
      .update(updates)
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ folder: data })
  }

  if (type === 'chat') {
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (typeof body?.title === 'string' && body.title.trim()) updates.title = body.title.trim()
    if ('folderId' in (body ?? {})) updates.folder_id = typeof body?.folderId === 'string' ? body.folderId : null
    if (typeof body?.pinned === 'boolean') updates.pinned = body.pinned
    if (typeof body?.archived === 'boolean') updates.archived = body.archived
    const { data, error } = await db
      .from('clark_chats')
      .update(updates)
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ chat: data })
  }

  return NextResponse.json({ error: 'Unknown type' }, { status: 400 })
}

export async function DELETE(req: NextRequest) {
  const userId = await getUserId(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const db = getServiceClient()
  if (!db) return NextResponse.json({ error: 'Service unavailable' }, { status: 503 })

  const { searchParams } = new URL(req.url)
  const type = searchParams.get('type')
  const id = searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  if (type === 'folder') {
    // Deleting a folder must never delete its chats — the folder_id FK is ON DELETE SET NULL,
    // but we null it explicitly first so the behavior holds even if the FK action is ever changed.
    await db.from('clark_chats').update({ folder_id: null }).eq('folder_id', id).eq('user_id', userId)
    const { error } = await db.from('clark_chat_folders').delete().eq('id', id).eq('user_id', userId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  if (type === 'chat') {
    const { error } = await db.from('clark_chats').delete().eq('id', id).eq('user_id', userId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  if (type === 'message') {
    const { error } = await db.from('clark_chat_messages').delete().eq('id', id).eq('user_id', userId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: 'Unknown type' }, { status: 400 })
}
