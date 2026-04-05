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

async function fetchJson(url, init = {}) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function zerionHeaders() {
  const key = (process.env.ZERION_KEY || '').trim();
  if (!key) return null;
  const encoded = Buffer.from(`${key}:`).toString('base64');
  return { Authorization: `Basic ${encoded}`, accept: 'application/json' };
}

async function fetchZerionWallet(wallet) {
  if (!wallet) return {};
  const headers = zerionHeaders();
  if (!headers) return { error: 'ZERION_KEY missing' };

  const [portfolio, positions, transactions] = await Promise.allSettled([
    fetchJson(`https://api.zerion.io/v1/wallets/${wallet}/portfolio/?currency=usd`, { headers }),
    fetchJson(`https://api.zerion.io/v1/wallets/${wallet}/positions/?filter[position_types]=wallet&currency=usd&page[size]=100&sort=-value`, { headers }),
    fetchJson(`https://api.zerion.io/v1/wallets/${wallet}/transactions/?currency=usd&page[size]=50&sort=-operation_at`, { headers }),
  ]);

  return {
    portfolio: portfolio.status === 'fulfilled' ? portfolio.value : null,
    positions: positions.status === 'fulfilled' ? positions.value : null,
    transactions: transactions.status === 'fulfilled' ? transactions.value : null,
  };
}

async function fetchGoldRushWallet(wallet, chainId = '1') {
  if (!wallet) return {};
  const key = (process.env.GOLDRUSH_API_KEY || '').trim();
  if (!key) return { error: 'GOLDRUSH_API_KEY missing' };
  const data = await fetchJson(`https://api.covalenthq.com/v1/${chainId}/address/${wallet}/balances_v2/?key=${key}`);
  return data?.data || {};
}

async function fetchGoldRushTokenMetadata(token, chainId = '1') {
  if (!token) return {};
  const key = (process.env.GOLDRUSH_API_KEY || '').trim();
  if (!key) return { error: 'GOLDRUSH_API_KEY missing' };
  const data = await fetchJson(`https://api.covalenthq.com/v1/${chainId}/tokens/${token}/token_holders_v2/?page-size=1&key=${key}`);
  return data?.data || {};
}

async function fetchDexScreenerData(token) {
  if (!token) return {};
  const data = await fetchJson(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(token)}`, {
    headers: { accept: 'application/json' },
  });
  const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
  const best = pairs[0] || null;
  return {
    pair: best,
    pairs,
    liquidity: best?.liquidity?.usd ?? null,
    volume24h: best?.volume?.h24 ?? null,
    priceUsd: best?.priceUsd ?? null,
  };
}

function coinGeckoUrl(url) {
  const key = (process.env.COINGECKO_DEMO_API_KEY || process.env.COINGECKO_API_KEY || '').trim();
  if (!key) return url;
  return `${url}${url.includes('?') ? '&' : '?'}x_cg_demo_api_key=${encodeURIComponent(key)}`;
}

async function fetchCoinGeckoSearch(query) {
  if (!query) return {};
  return fetchJson(coinGeckoUrl(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(query)}`), {
    headers: { accept: 'application/json' },
  });
}

async function fetchCoinGeckoMarket(ids) {
  if (!ids) return [];
  const idList = Array.isArray(ids) ? ids.join(',') : ids;
  return fetchJson(
    coinGeckoUrl(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${encodeURIComponent(idList)}&sparkline=false&price_change_percentage=24h`),
    { headers: { accept: 'application/json' } },
  );
}

async function fetchGoPlusSecurity(token, chainId = '1') {
  if (!token) return {};
  const data = await fetchJson(`https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${encodeURIComponent(token)}`, {
    headers: { accept: 'application/json' },
  });
  return data?.result?.[String(token).toLowerCase()] || data?.result || {};
}

async function fetchLunarCrushSentiment(topic) {
  if (!topic) return {};
  const key = (process.env.LUNARCRUSH_KEY || '').trim();
  if (!key) return { error: 'LUNARCRUSH_KEY missing' };
  const data = await fetchJson(`https://lunarcrush.com/api4/public/topic/${encodeURIComponent(topic)}/v1`, {
    headers: {
      accept: 'application/json',
      Authorization: `Bearer ${key}`,
      'X-API-Key': key,
    },
  });
  return data?.data || data || {};
}

async function fetchAlchemyWhaleFlows(addressOrToken) {
  if (!addressOrToken) return {};
  if (!isWalletAddress(addressOrToken)) return { note: 'whale flow requires wallet address' };

  const key = (process.env.ALCHEMY_API_KEY || '').trim();
  if (!key) return { error: 'ALCHEMY_API_KEY missing' };

  const data = await fetchJson(`https://eth-mainnet.g.alchemy.com/v2/${key}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'alchemy_getAssetTransfers',
      params: [{
        fromBlock: '0x0',
        toBlock: 'latest',
        fromAddress: addressOrToken,
        category: ['external', 'erc20'],
        withMetadata: true,
        maxCount: '0x64',
        order: 'desc',
      }],
    }),
  });

  const rows = Array.isArray(data?.result?.transfers) ? data.result.transfers : [];
  const whaleTransfers = rows.filter((t) => Number(t?.value || 0) >= 1000);
  return { totalTransfers: rows.length, whaleTransfers, whaleCount: whaleTransfers.length };
}

function mergeWalletData(zerionData = {}, goldrushData = {}) {
  const zerionPositions = Array.isArray(zerionData?.positions?.data) ? zerionData.positions.data : [];
  const goldrushTokens = Array.isArray(goldrushData?.items) ? goldrushData.items : [];
  const byAddress = new Map();

  for (const pos of zerionPositions) {
    const contract = (
      pos?.relationships?.fungible?.data?.id ||
      pos?.attributes?.fungible_info?.implementations?.[0]?.address ||
      ''
    ).toLowerCase();
    if (!contract) continue;
    byAddress.set(contract, {
      symbol: pos?.attributes?.fungible_info?.symbol || '',
      name: pos?.attributes?.fungible_info?.name || '',
      contractAddress: contract,
      balance: Number(pos?.attributes?.quantity?.numeric || 0),
      usdValue: Number(pos?.attributes?.value || 0),
      price: Number(pos?.attributes?.price || 0),
      source: 'zerion',
    });
  }

  for (const token of goldrushTokens) {
    const contract = String(token?.contract_address || '').toLowerCase();
    if (!contract || byAddress.has(contract)) continue;
    const balance = Number(token?.balance || 0) / Math.pow(10, Number(token?.contract_decimals || 0));
    const usdValue = Number(token?.quote || 0);
    byAddress.set(contract, {
      symbol: token?.contract_ticker_symbol || '',
      name: token?.contract_name || '',
      contractAddress: contract,
      balance,
      usdValue,
      price: balance > 0 ? usdValue / balance : 0,
      source: 'goldrush',
    });
  }

  const tokens = [...byAddress.values()].sort((a, b) => (b.usdValue || 0) - (a.usdValue || 0));
  return {
    totalUsd: tokens.reduce((sum, t) => sum + (t.usdValue || 0), 0),
    totalTokens: tokens.length,
    topTokens: tokens.slice(0, 20),
    tokens,
  };
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
    wallet: walletMerged,
    raw: { wallet: rawWallet, token: rawTokenMeta, zerion },
    pairs,
    market,
    security,
    sentiment,
    whales,
  });
}
