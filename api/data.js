// api/data.js — ChainLens User Data Handler
// Handles all persistent data: proofvault, ghosttrade, journal, alerts, saved_wallets

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function sbQuery(path, method = 'GET', body = null) {
  const headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Prefer': method === 'POST' ? 'return=representation' : '',
  };
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${SUPABASE_URL}${path}`, opts);
  const text = await r.text();
  try { return { ok: r.ok, status: r.status, data: JSON.parse(text) }; }
  catch { return { ok: r.ok, status: r.status, data: [] }; }
}

async function verifyToken(accessToken) {
  if (!accessToken) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${accessToken}`,
    }
  });
  if (!r.ok) return null;
  const u = await r.json();
  return u?.id || null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  const { action, accessToken, table, payload, id } = req.body || {};

  // All data routes require auth
  const userId = await verifyToken(accessToken);
  if (!userId) return res.status(401).json({ error: 'Invalid session. Please log in again.' });

  const VALID_TABLES = ['proofvault', 'ghost_trades', 'trade_journal', 'price_alerts', 'saved_wallets', 'leaderboard'];
  if (!VALID_TABLES.includes(table)) return res.status(400).json({ error: 'Invalid table' });

  try {

    // ── LOAD all rows for this user ──────────────────────────────────
    if (action === 'load') {
      const r = await sbQuery(`/rest/v1/${table}?user_id=eq.${userId}&order=created_at.desc`);
      return res.status(200).json({ success: true, data: r.data || [] });
    }

    // ── SAVE (upsert full dataset — replaces all rows for user) ───────
    if (action === 'save') {
      // Delete existing rows first
      await sbQuery(`/rest/v1/${table}?user_id=eq.${userId}`, 'DELETE');

      // Re-insert all rows if payload has items
      if (Array.isArray(payload) && payload.length > 0) {
        const rows = payload.map(row => ({ ...row, user_id: userId }));
        await sbQuery(`/rest/v1/${table}`, 'POST', rows);
      }

      return res.status(200).json({ success: true });
    }

    // ── APPEND (insert single row) ────────────────────────────────────
    if (action === 'append') {
      if (!payload) return res.status(400).json({ error: 'No payload' });
      const row = { ...payload, user_id: userId, created_at: new Date().toISOString() };
      const r = await sbQuery(`/rest/v1/${table}`, 'POST', row);
      return res.status(200).json({ success: true, data: r.data });
    }

    // ── DELETE single row ─────────────────────────────────────────────
    if (action === 'delete') {
      if (!id) return res.status(400).json({ error: 'No id' });
      await sbQuery(`/rest/v1/${table}?id=eq.${id}&user_id=eq.${userId}`, 'DELETE');
      return res.status(200).json({ success: true });
    }

    // ── UPDATE single row ─────────────────────────────────────────────
    if (action === 'update') {
      if (!id || !payload) return res.status(400).json({ error: 'No id or payload' });
      await sbQuery(`/rest/v1/${table}?id=eq.${id}&user_id=eq.${userId}`, 'PATCH', payload);
      return res.status(200).json({ success: true });
    }

    // ── LEADERBOARD (public read — all users) ────────────────────────
    if (action === 'leaderboard_load') {
      const r = await sbQuery(`/rest/v1/leaderboard?select=*&order=accuracy.desc&limit=50`);
      return res.status(200).json({ success: true, data: r.data || [] });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    console.error('Data error:', err.message);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}
