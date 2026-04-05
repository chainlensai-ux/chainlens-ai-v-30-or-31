import { fetchZerionWallet } from '../lib/apis/zerion.js';
import { fetchGoldRushWallet, fetchGoldRushTokenMetadata } from '../lib/apis/goldrush.js';
import { fetchDexScreenerData } from '../lib/apis/dexscreener.js';
import { fetchCoinGeckoMarket, fetchCoinGeckoSearch } from '../lib/apis/coingecko.js';
import { fetchGoPlusSecurity } from '../lib/apis/goplus.js';
import { fetchLunarCrushSentiment } from '../lib/apis/lunarcrush.js';
import { fetchAlchemyWhaleFlows } from '../lib/apis/alchemy.js';
import { mergeWalletData } from '../lib/mergeWallet.js';

function isWalletAddress(v) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(v || ''));
}

async function safe(fn, fallback = {}) {
  try {
    return await fn();
  } catch (error) {
    return { ...fallback, error: error.message || 'request failed' };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const wallet = String(req.query.wallet || '').trim();
  const token = String(req.query.token || '').trim();
  const mode = String(req.query.mode || '').trim().toLowerCase() || 'token';

  const useWallet = mode === 'wallet' || (!!wallet && isWalletAddress(wallet));
  const useToken = mode === 'token' || mode === 'narrative' || !!token;

  const [zerion, rawWallet, rawTokenMeta, pairs, sentiment, whales] = await Promise.all([
    useWallet ? safe(() => fetchZerionWallet(wallet)) : Promise.resolve({}),
    useWallet ? safe(() => fetchGoldRushWallet(wallet, '1')) : Promise.resolve({}),
    useToken ? safe(() => fetchGoldRushTokenMetadata(token, '1')) : Promise.resolve({}),
    useToken ? safe(() => fetchDexScreenerData(token)) : Promise.resolve({}),
    useToken ? safe(() => fetchLunarCrushSentiment(token)) : Promise.resolve({}),
    safe(() => fetchAlchemyWhaleFlows(useWallet ? wallet : token)),
  ]);

  const walletMerged = useWallet ? mergeWalletData(zerion, rawWallet) : {};

  let market = {};
  if (useToken) {
    const search = await safe(() => fetchCoinGeckoSearch(token), {});
    const first = Array.isArray(search?.coins) ? search.coins[0] : null;
    market = first ? await safe(() => fetchCoinGeckoMarket(first.id), {}) : {};
  }

  const security = useToken ? await safe(() => fetchGoPlusSecurity(token, '1')) : {};

  return res.status(200).json({
    mode,
    wallet: walletMerged,
    raw: {
      wallet: rawWallet,
      token: rawTokenMeta,
      zerion,
    },
    pairs,
    market,
    security,
    sentiment,
    whales,
  });
}
