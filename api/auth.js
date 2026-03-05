// api/auth.js — ChainLens Supabase Auth Handler
// Handles: signup, login, getUser, logout, updatePlan

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; // service role key (never exposed to client)

async function sb(path, method = 'GET', body = null, token = null) {
  const headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const r = await fetch(`${SUPABASE_URL}${path}`, opts);
  const text = await r.text();
  try { return { ok: r.ok, status: r.status, data: JSON.parse(text) }; }
  catch { return { ok: r.ok, status: r.status, data: text }; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured. Add SUPABASE_URL and SUPABASE_SERVICE_KEY to Vercel env vars.' });
  }

  const { action, email, password, name, plan, userId, accessToken } = req.body || {};

  try {

    // ── SIGNUP ──────────────────────────────────────────────────────
    if (action === 'signup') {
      if (!email || !password || !name) return res.status(400).json({ error: 'Missing fields' });

      // Create auth user via Supabase Auth
      const authRes = await sb('/auth/v1/signup', 'POST', {
        email,
        password,
        data: { name, plan: plan || 'free' }
      });

      if (!authRes.ok) {
        const msg = authRes.data?.msg || authRes.data?.error_description || 'Signup failed';
        return res.status(400).json({ error: msg });
      }

      const authUser = authRes.data;
      const uid = authUser.user?.id || authUser.id;
      if (!uid) return res.status(500).json({ error: 'No user ID returned' });

      // Insert into profiles table
      await sb('/rest/v1/profiles', 'POST', {
        id: uid,
        name,
        email,
        plan: plan || 'free',
        joined: new Date().toISOString(),
      });

      return res.status(200).json({
        success: true,
        user: {
          id: uid,
          name,
          email,
          plan: plan || 'free',
          joined: authUser.user?.created_at || new Date().toISOString(),
          accessToken: authUser.access_token,
          refreshToken: authUser.refresh_token,
        }
      });
    }

    // ── LOGIN ───────────────────────────────────────────────────────
    if (action === 'login') {
      if (!email || !password) return res.status(400).json({ error: 'Missing fields' });

      const authRes = await sb('/auth/v1/token?grant_type=password', 'POST', { email, password });

      if (!authRes.ok) {
        return res.status(401).json({ error: 'Incorrect email or password' });
      }

      const authData = authRes.data;
      const uid = authData.user?.id;
      if (!uid) return res.status(500).json({ error: 'Login failed' });

      // Fetch profile
      const profileRes = await sb(`/rest/v1/profiles?id=eq.${uid}&select=*`);
      const profile = Array.isArray(profileRes.data) ? profileRes.data[0] : null;

      return res.status(200).json({
        success: true,
        user: {
          id: uid,
          name: profile?.name || authData.user?.user_metadata?.name || 'Trader',
          email: authData.user?.email,
          plan: profile?.plan || 'free',
          joined: profile?.joined || authData.user?.created_at,
          accessToken: authData.access_token,
          refreshToken: authData.refresh_token,
        }
      });
    }

    // ── GET USER (session restore) ──────────────────────────────────
    if (action === 'getUser') {
      if (!accessToken) return res.status(401).json({ error: 'No token' });

      // Verify token with Supabase
      const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${accessToken}`,
        }
      });

      if (!userRes.ok) return res.status(401).json({ error: 'Invalid session' });
      const authUser = await userRes.json();
      const uid = authUser.id;

      // Fetch latest profile (plan may have been updated by Stripe)
      const profileRes = await sb(`/rest/v1/profiles?id=eq.${uid}&select=*`);
      const profile = Array.isArray(profileRes.data) ? profileRes.data[0] : null;

      return res.status(200).json({
        success: true,
        user: {
          id: uid,
          name: profile?.name || authUser.user_metadata?.name || 'Trader',
          email: authUser.email,
          plan: profile?.plan || 'free',
          joined: profile?.joined || authUser.created_at,
          accessToken, // pass back same token
        }
      });
    }

    // ── UPDATE PLAN (called by Stripe webhook later) ────────────────
    if (action === 'updatePlan') {
      if (!userId || !plan) return res.status(400).json({ error: 'Missing userId or plan' });
      await sb(`/rest/v1/profiles?id=eq.${userId}`, 'PATCH', { plan });
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    console.error('Auth error:', err.message);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}
