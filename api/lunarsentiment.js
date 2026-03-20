const LUNARCRUSH_API = 'https://lunarcrush.com/api4/public';

function clamp(n, min, max) {
  n = Number(n);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function pickNumber(obj, keys) {
  for (const k of keys) {
    if (!obj || obj[k] == null) continue;
    const v = Number(obj[k]);
    if (Number.isFinite(v)) return v;
  }
  return null;
}

function classify(val) {
  if (val < 25) return 'Extreme Fear';
  if (val < 45) return 'Fear';
  if (val < 55) return 'Neutral';
  if (val < 75) return 'Greed';
  return 'Extreme Greed';
}

function getTimeMs(p) {
  if (!p || typeof p !== 'object') return null;
  // LunarCrush often uses `time`/`date`; we try multiple fields.
  const raw = p.time ?? p.timestamp ?? p.datetime ?? p.created_at ?? p.date;
  if (raw == null) return null;
  const n = Number(raw);
  if (Number.isFinite(n)) {
    // Heuristic: seconds vs milliseconds.
    return n > 1e12 ? n : n * 1000;
  }
  const d = new Date(String(raw));
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function coerceArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.data)) return payload.data;
  // Some APIs return { data: { data: [...] } }
  if (payload.data && Array.isArray(payload.data.data)) return payload.data.data;
  return [];
}

function extractSentimentLike(p) {
  // We try sentiment-like (0-100) fields first. If none exist, we fall back later.
  return pickNumber(p, [
    'sentiment',
    'social_sentiment',
    'average_sentiment',
    'avg_sentiment',
    'sentiment_score',
    'galaxy_score',
    'galaxyScore',
    'galaxy_score_avg',
  ]);
}

function extractEngagementLike(p) {
  return pickNumber(p, [
    'engagements',
    'engagements_24h',
    'interactions',
    'interactions_24h',
    'social_volume',
    'mentions',
  ]);
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const LUNARCRUSH_KEY = process.env.LUNARCRUSH_KEY || '';
  if (!LUNARCRUSH_KEY) {
    return res.status(500).json({ error: 'LUNARCRUSH_KEY not configured in Vercel env vars' });
  }

  const { topic = 'bitcoin', interval = '1d', limit = 30 } = req.body || {};

  try {
    const authHeaders = { 'Authorization': `Bearer ${LUNARCRUSH_KEY}` };
    const overviewUrl = `${LUNARCRUSH_API}/topic/${encodeURIComponent(topic)}/v1`;
    const tsUrl = `${LUNARCRUSH_API}/topic/${encodeURIComponent(topic)}/time-series/v1?interval=${encodeURIComponent(interval)}&data_points=${encodeURIComponent(limit)}`;

    const [ovRes, tsRes] = await Promise.allSettled([
      fetch(overviewUrl, { headers: authHeaders }),
      fetch(tsUrl, { headers: authHeaders }),
    ]);

    let overview = {};
    if (ovRes.status === 'fulfilled') {
      try { overview = await ovRes.value.json(); } catch (e) { overview = {}; }
    }

    let seriesPoints = [];
    if (tsRes.status === 'fulfilled') {
      try {
        const tsJson = await tsRes.value.json();
        seriesPoints = coerceArray(tsJson);
      } catch (e) {
        seriesPoints = [];
      }
    }

    // Current sentiment from topic overview (best single-source-of-truth).
    let currentValRaw = extractSentimentLike(overview);
    if (currentValRaw == null) {
      // If overview doesn't contain sentiment-like fields, use a safe neutral baseline.
      currentValRaw = 50;
    }
    const currentVal = Math.round(clamp(currentValRaw, 0, 100));

    // Map time series points to sentiment-like values if present.
    let mapped = seriesPoints.map(p => ({
      t: getTimeMs(p),
      raw: p,
      v: extractSentimentLike(p),
      c: extractEngagementLike(p),
    }));

    const anySentimentLike = mapped.some(x => x.v != null);

    if (!mapped.length) {
      // Ensure the UI still renders even if the time-series endpoint fails.
      const data = [{ value: currentVal, value_classification: classify(currentVal), time: Date.now() }];
      return res.status(200).json({ data });
    }

    if (!anySentimentLike) {
      // Fall back: normalize engagement-like values into a 0-100 range.
      const counts = mapped.map(x => (x.c != null ? x.c : null)).filter(v => v != null);
      const min = counts.length ? Math.min(...counts) : 0;
      const max = counts.length ? Math.max(...counts) : 0;
      const span = max - min || 1;
      mapped = mapped.map(x => {
        const c = x.c != null ? x.c : min;
        const norm = ((c - min) / span) * 100;
        return { ...x, v: norm };
      });
    }

    // Sort latest first when we can.
    mapped.sort((a, b) => {
      if (a.t == null && b.t == null) return 0;
      if (a.t == null) return 1;
      if (b.t == null) return -1;
      return (b.t || 0) - (a.t || 0);
    });

    // Take up to `limit` data points.
    const take = mapped.slice(0, Math.max(2, Number(limit) || 30));

    // Force the first point to match the overview sentiment so the gauge stays consistent.
    if (take.length) take[0].v = currentVal;

    const data = take.map(x => {
      const v = Math.round(clamp(x.v, 0, 100));
      return { value: v, value_classification: classify(v), time: x.t ?? null };
    });

    return res.status(200).json({ data });
  } catch (err) {
    return res.status(500).json({ error: 'LunarCrush fetch failed: ' + err.message });
  }
}

