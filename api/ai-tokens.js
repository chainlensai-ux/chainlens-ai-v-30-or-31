import { fetchDexScreenerData } from '../lib/apis/dexscreener.js';
import { fetchCoinGeckoSearch, fetchCoinGeckoMarket } from '../lib/apis/coingecko.js';
import { fetchLunarCrushSentiment } from '../lib/apis/lunarcrush.js';
import { fetchAlchemyWhaleFlows } from '../lib/apis/alchemy.js';
import { fetchGoPlusSecurity } from '../lib/apis/goplus.js';

const AI_TOKENS = ['RNDR', 'FET', 'AGIX', 'TAO', 'ARKM', 'OCEAN', 'GRT', 'WLD', 'VIRTUAL', 'WIRE'];

async function safe(fn, fallback = null) {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const rows = await Promise.all(AI_TOKENS.map(async (symbol) => {
    const [dex, search, lunar] = await Promise.all([
      safe(() => fetchDexScreenerData(symbol), {}),
      safe(() => fetchCoinGeckoSearch(symbol), {}),
      safe(() => fetchLunarCrushSentiment(symbol), {}),
    ]);

    const cgId = Array.isArray(search?.coins) && search.coins[0] ? search.coins[0].id : null;
    const market = cgId ? await safe(() => fetchCoinGeckoMarket(cgId), []) : [];
    const contract = dex?.pair?.baseToken?.address || '';
    const [whales, security] = await Promise.all([
      safe(() => fetchAlchemyWhaleFlows(contract), {}),
      safe(() => fetchGoPlusSecurity(contract, '1'), {}),
    ]);

    return {
      token: symbol,
      liquidity: dex?.liquidity ?? dex?.pair?.liquidity?.usd ?? 0,
      volume24h: dex?.volume24h ?? dex?.pair?.volume?.h24 ?? 0,
      sentiment: lunar?.sentiment ?? lunar?.social_sentiment ?? null,
      whale_inflows: whales?.whaleCount ?? 0,
      risk: security?.is_honeypot === '1' ? 'high' : 'normal',
      marketCap: Array.isArray(market) && market[0] ? market[0].market_cap || 0 : 0,
    };
  }));

  rows.sort((a, b) => (b.volume24h || 0) - (a.volume24h || 0));
  return res.status(200).json(rows);
}
