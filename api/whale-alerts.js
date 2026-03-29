const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured', alerts: [] });
  }

  const limit = Math.min(50, Math.max(1, parseInt(String(req.query?.limit || '30'), 10) || 30));

  try {
    const url = `${SUPABASE_URL}/rest/v1/whale_alerts?select=*&order=timestamp.desc&limit=${limit}`;
    const r = await fetch(url, {
      headers: {
        Accept: 'application/json',
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
    });
    const text = await r.text();
    if (!r.ok) {
      console.error('[whale-alerts] Supabase GET failed', r.status, text.slice(0, 400));
      return res.status(200).json({ alerts: [], error: 'fetch_failed' });
    }
    let rows;
    try {
      rows = JSON.parse(text);
    } catch {
      return res.status(200).json({ alerts: [], error: 'parse_failed' });
    }
    if (!Array.isArray(rows)) return res.status(200).json({ alerts: [] });
    return res.status(200).json({ alerts: rows });
  } catch (e) {
    console.error('[whale-alerts]', e);
    return res.status(200).json({ alerts: [], error: 'exception' });
  }
}
