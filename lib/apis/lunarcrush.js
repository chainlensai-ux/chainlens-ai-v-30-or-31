const BASE = 'https://lunarcrush.com/api4/public';

async function fetchJson(url, key) {
  const res = await fetch(url, {
    headers: {
      accept: 'application/json',
      Authorization: `Bearer ${key}`,
      'X-API-Key': key,
    },
  });
  if (!res.ok) throw new Error(`LunarCrush request failed (${res.status})`);
  return res.json();
}

export async function fetchLunarCrushSentiment(topic) {
  if (!topic) return {};
  const key = (process.env.LUNARCRUSH_KEY || '').trim();
  if (!key) return { error: 'LUNARCRUSH_KEY missing' };
  const data = await fetchJson(`${BASE}/topic/${encodeURIComponent(topic)}/v1`, key);
  return data?.data || data || {};
}
