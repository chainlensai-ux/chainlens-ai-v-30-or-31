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

function coerceArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.data)) return payload.data;
  if (payload.data && Array.isArray(payload.data.data)) return payload.data.data;
  if (payload.data && Array.isArray(payload.data.points)) return payload.data.points;
  return [];
}

function getTimeMs(p) {
  if (!p || typeof p !== 'object') return null;
  const raw = p.time ?? p.timestamp ?? p.datetime ?? p.created_at ?? p.date;
  if (raw == null) return null;
  const n = Number(raw);
  if (Number.isFinite(n)) return n > 1e12 ? n : n * 1000;
  const d = new Date(String(raw));
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function extractSentimentLike(p) {
  return pickNumber(p, [
    'sentiment',
    'social_sentiment',
    'average_sentiment',
    'avg_sentiment',
    'sentiment_score',
  ]);
}

function extractGalaxyScore(p) {
  return pickNumber(p, ['galaxy_score', 'galaxyScore', 'galaxy_score_avg', 'galaxy']);
}

function extractAltRank(p) {
  return pickNumber(p, ['alt_rank', 'altRank', 'altrank', 'alt_rank_rank']);
}

function extractSocialVolumeLike(p) {
  return pickNumber(p, [
    'social_volume',
    'social_volume_usd',
    'social_volume_change',
    'volume',
    'engagements',
    'interactions',
    'mentions',
  ]);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const LUNARCRUSH_KEY = process.env.LUNARCRUSH_KEY || '';
  if (!LUNARCRUSH_KEY) return res.status(500).json({ error: 'LUNARCRUSH_KEY not configured in Vercel env vars' });

  const { topic = 'bitcoin', interval = '1d', limit = 30 } = req.body || {};

  try {
    const authHeaders = { Authorization: `Bearer ${LUNARCRUSH_KEY}` };
    const overviewUrl = `${LUNARCRUSH_API}/topic/${encodeURIComponent(topic)}/v1`;
    const tsUrl = `${LUNARCRUSH_API}/topic/${encodeURIComponent(topic)}/time-series/v1?interval=${encodeURIComponent(interval)}&data_points=${encodeURIComponent(limit)}`;

    const [ovRes, tsRes] = await Promise.allSettled([
      fetch(overviewUrl, { headers: authHeaders }),
      fetch(tsUrl, { headers: authHeaders }),
    ]);

    let overview = {};
    if (ovRes.status === 'fulfilled') {
      try { overview = await ovRes.value.json(); } catch { overview = {}; }
    }

    let seriesPoints = [];
    if (tsRes.status === 'fulfilled') {
      try {
        const tsJson = await tsRes.value.json();
        seriesPoints = coerceArray(tsJson);
      } catch { seriesPoints = []; }
    }

    const sentimentRaw = extractSentimentLike(overview);
    const sentiment = sentimentRaw == null ? 50 : Math.round(clamp(sentimentRaw, 0, 100));
    const bullishPct = sentiment;
    const bearishPct = 100 - sentiment;

    const galaxyScoreRaw = extractGalaxyScore(overview);
    const galaxyScore = galaxyScoreRaw == null ? null : Math.round(clamp(galaxyScoreRaw, 0, 100));

    const altRankRaw = extractAltRank(overview);
    const altRank = altRankRaw == null ? null : Math.round(altRankRaw);

    // Social volume trend
    const values = seriesPoints
      .map(p => ({ t: getTimeMs(p), v: extractSocialVolumeLike(p) }))
      .filter(x => x.v != null && Number.isFinite(x.v));

    let latest = null;
    let avg = null;
    let changePct = null;
    const points = values.slice(-Math.max(2, Math.min(values.length, 20))).map(x => ({ t: x.t, v: x.v }));

    if (values.length) {
      latest = values[values.length - 1].v;
      const sum = values.reduce((s, x) => s + x.v, 0);
      avg = sum / values.length;
      if (avg) changePct = ((latest - avg) / avg) * 100;
    }

    return res.status(200).json({
      sentiment: { score: sentiment, bullishPct, bearishPct },
      galaxyScore,
      altRank,
      socialVolumeTrend: { latest, avg, changePct, points }
    });
  } catch (err) {
    return res.status(500).json({ error: 'LunarCrush fetch failed: ' + err.message });
  }
}

