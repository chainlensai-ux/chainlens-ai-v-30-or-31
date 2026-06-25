import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { sanitizeMessageMetadata, buildMessagePreview, classifyDbError, type ClarkHistoryErrorCode } from '@/lib/server/clarkHistory'

// Persists Clark chat history (folders, chats, messages) for the signed-in user only.
// Does not touch Clark's intelligence/routing pipeline in app/api/clark/route.ts — this is a
// separate, additive storage layer the frontend calls after Clark already answered.

const HISTORY_ACTION: Record<ClarkHistoryErrorCode, string> = {
  auth_missing: 'sign_in',
  auth_invalid: 'sign_in',
  table_missing: 'install_tables',
  rls_blocked: 'check_permissions',
  insert_failed: 'retry',
  select_failed: 'retry',
}

function errorResponse(code: ClarkHistoryErrorCode, message: string, status: number) {
  return NextResponse.json(
    { error: message, historyErrorCode: code, historyErrorMessage: message, historyAction: HISTORY_ACTION[code] },
    { status },
  )
}

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

type AuthResult = { userId: string } | { errorCode: 'auth_missing' | 'auth_invalid' }

async function authenticate(req: NextRequest): Promise<AuthResult> {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (!token) return { errorCode: 'auth_missing' }
  const anon = createAnonClient()
  if (!anon) return { errorCode: 'auth_invalid' }
  const { data, error } = await anon.auth.getUser(token)
  if (error || !data.user?.id) return { errorCode: 'auth_invalid' }
  return { userId: data.user.id }
}

export async function GET(req: NextRequest) {
  const auth = await authenticate(req)
  if ('errorCode' in auth) {
    return errorResponse(auth.errorCode, auth.errorCode === 'auth_missing' ? 'Sign in to load Clark history.' : 'Your session has expired. Sign in again.', 401)
  }
  const userId = auth.userId
  const db = getServiceClient()
  if (!db) return errorResponse('select_failed', 'History storage is not configured.', 503)

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
    if (error) return errorResponse(classifyDbError(error, 'select_failed'), error.message, 500)
    return NextResponse.json({ messages: data ?? [] })
  }

  const { data: folders, error: foldersError } = await db
    .from('clark_chat_folders')
    .select('*')
    .eq('user_id', userId)
    .order('sort_order', { ascending: true })
  if (foldersError) return errorResponse(classifyDbError(foldersError, 'select_failed'), foldersError.message, 500)

  if (query) {
    const [byTitle, byContent] = await Promise.all([
      db.from('clark_chats').select('*').eq('user_id', userId)
        .or(`title.ilike.%${query}%,last_message_preview.ilike.%${query}%`)
        .order('updated_at', { ascending: false }),
      db.from('clark_chat_messages').select('chat_id').eq('user_id', userId)
        .ilike('content', `%${query}%`),
    ])
    if (byTitle.error) return errorResponse(classifyDbError(byTitle.error, 'select_failed'), byTitle.error.message, 500)
    if (byContent.error) return errorResponse(classifyDbError(byContent.error, 'select_failed'), byContent.error.message, 500)

    const matchedIds = new Set((byTitle.data ?? []).map((c) => c.id))
    const contentChatIds = [...new Set((byContent.data ?? []).map((m) => m.chat_id))].filter((id) => !matchedIds.has(id))
    let extraChats: unknown[] = []
    if (contentChatIds.length > 0) {
      const { data, error } = await db.from('clark_chats').select('*').eq('user_id', userId).in('id', contentChatIds)
      if (error) return errorResponse(classifyDbError(error, 'select_failed'), error.message, 500)
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
  if (chatsError) return errorResponse(classifyDbError(chatsError, 'select_failed'), chatsError.message, 500)

  return NextResponse.json({ folders: folders ?? [], chats: chats ?? [] })
}

export async function POST(req: NextRequest) {
  const auth = await authenticate(req)
  if ('errorCode' in auth) {
    return errorResponse(auth.errorCode, auth.errorCode === 'auth_missing' ? 'Sign in to save Clark history.' : 'Your session has expired. Sign in again.', 401)
  }
  const userId = auth.userId
  const db = getServiceClient()
  if (!db) return errorResponse('insert_failed', 'History storage is not configured.', 503)

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
    if (error) return errorResponse(classifyDbError(error, 'insert_failed'), error.message, 500)
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
    if (error) return errorResponse(classifyDbError(error, 'insert_failed'), error.message, 500)
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
    if (error) return errorResponse(classifyDbError(error, 'insert_failed'), error.message, 500)

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
  const auth = await authenticate(req)
  if ('errorCode' in auth) {
    return errorResponse(auth.errorCode, auth.errorCode === 'auth_missing' ? 'Sign in to save Clark history.' : 'Your session has expired. Sign in again.', 401)
  }
  const userId = auth.userId
  const db = getServiceClient()
  if (!db) return errorResponse('insert_failed', 'History storage is not configured.', 503)

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
    if (error) return errorResponse(classifyDbError(error, 'insert_failed'), error.message, 500)
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
    if (error) return errorResponse(classifyDbError(error, 'insert_failed'), error.message, 500)
    return NextResponse.json({ chat: data })
  }

  return NextResponse.json({ error: 'Unknown type' }, { status: 400 })
}

export async function DELETE(req: NextRequest) {
  const auth = await authenticate(req)
  if ('errorCode' in auth) {
    return errorResponse(auth.errorCode, auth.errorCode === 'auth_missing' ? 'Sign in to manage Clark history.' : 'Your session has expired. Sign in again.', 401)
  }
  const userId = auth.userId
  const db = getServiceClient()
  if (!db) return errorResponse('insert_failed', 'History storage is not configured.', 503)

  const { searchParams } = new URL(req.url)
  const type = searchParams.get('type')
  const id = searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  if (type === 'folder') {
    // Deleting a folder must never delete its chats — the folder_id FK is ON DELETE SET NULL,
    // but we null it explicitly first so the behavior holds even if the FK action is ever changed.
    await db.from('clark_chats').update({ folder_id: null }).eq('folder_id', id).eq('user_id', userId)
    const { error } = await db.from('clark_chat_folders').delete().eq('id', id).eq('user_id', userId)
    if (error) return errorResponse(classifyDbError(error, 'insert_failed'), error.message, 500)
    return NextResponse.json({ ok: true })
  }

  if (type === 'chat') {
    const { error } = await db.from('clark_chats').delete().eq('id', id).eq('user_id', userId)
    if (error) return errorResponse(classifyDbError(error, 'insert_failed'), error.message, 500)
    return NextResponse.json({ ok: true })
  }

  if (type === 'message') {
    const { error } = await db.from('clark_chat_messages').delete().eq('id', id).eq('user_id', userId)
    if (error) return errorResponse(classifyDbError(error, 'insert_failed'), error.message, 500)
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: 'Unknown type' }, { status: 400 })
}
