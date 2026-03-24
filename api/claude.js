const CLARK_SYSTEM = `You are Clark, ChainLens AI — the sharpest onchain analyst in the room.

Personality and voice: confident, direct, data-driven. You state conclusions like a desk that already did the work. You never hedge with soft language.

Hard rules:
- Never say "I think", "I believe", "it might", "could be", "probably", "maybe", "perhaps", or similar uncertainty fillers. Replace them with the strongest supportable read from the data you have.
- Lead the first sentence with the single most important signal or conclusion (price action, flow, risk, or opportunity).
- Be concise and specific. Short paragraphs beat essays.
- Ground every answer in real numbers, tickers, timeframes, levels, or on-chain facts whenever they appear in the user message or any context appended to it. Name the source when citing (e.g. CoinGecko price, DexScreener volume, LunarCrush sentiment, Etherscan / whale flow). If no data was supplied for a claim, say what is missing in one blunt line — do not fabricate metrics.
- Treat the app as if you have already ingested live context from LunarCrush (sentiment), CoinGecko (prices), DexScreener (liquidity/volume/pairs), and Etherscan-style whale activity when those values are present in the prompt; prioritize them over generic crypto commentary.
- End every reply with a clear actionable verdict: one line that says what to do, watch, or avoid (e.g. "Verdict: …").`;

const CG_BASE = 'https://api.coingecko.com/api/v3';
const DEX_TOP_VOL_URL =
  'https://api.dexscreener.com/latest/dex/search?q=USDC&sort=volume&order=desc&limit=20';
const ETHERSCAN_V2 = 'https://api.etherscan.io/v2/api';
const WHALE_WATCH = '0x21a31Ee1afC51d94C2eFcCAa2092aD1028285549';
const ALCHEMY_RPC_ENV_URL = 'https://eth-mainnet.g.alchemy.com/v2/ENV';

const LUNARCRUSH_API = 'https://lunarcrush.com/api4/public';
const GRAPH_UNISWAP_V3_SUBGRAPH_ID = 'ELUcwgpm14LKPLrBRuVvPvNKHQ9HvwmtKgKSH6123cr7';

const LUNAR_TOPIC_MAP = {
  btc: 'bitcoin',
  bitcoin: 'bitcoin',
  eth: 'ethereum',
  ethereum: 'ethereum',
  sol: 'solana',
  sol: 'solana',
  solana: 'solana',
  doge: 'dogecoin',
  dogecoin: 'dogecoin',
  xrp: 'xrp',
  ripple: 'xrp',
  ada: 'cardano',
  cardano: 'cardano',
  avax: 'avalanche-2',
  avalanche: 'avalanche-2',
  bnb: 'binancecoin',
  link: 'chainlink',
  matic: 'matic-network',
  polygon: 'matic-network',
  pepe: 'pepe',
  arb: 'arbitrum',
  arbitrum: 'arbitrum',
};

/** CoinGecko Pro uses x_cg_pro_api_key; Demo uses x_cg_demo_api_key (header name x-cg-demo-api-key). */
function appendCoinGeckoKeyToUrl(fullUrl) {
  const pro = (process.env.COINGECKO_PRO_API_KEY || '').trim();
  const demo = (process.env.COINGECKO_DEMO_API_KEY || '').trim();
  const generic = (process.env.COINGECKO_API_KEY || process.env.CG_API_KEY || '').trim();
  const sep = fullUrl.includes('?') ? '&' : '?';
  if (pro) return `${fullUrl}${sep}x_cg_pro_api_key=${encodeURIComponent(pro)}`;
  const key = demo || generic;
  if (key) return `${fullUrl}${sep}x_cg_demo_api_key=${encodeURIComponent(key)}`;
  return fullUrl;
}

async function fetchJsonDirect(url, init = {}) {
  const r = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      'User-Agent': 'ChainLens-Clark/1.0',
      ...(init.headers || {}),
    },
  });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!r.ok) return null;
  if (json && typeof json === 'object' && typeof json.error === 'string' && json.error) return null;
  if (json?.error && typeof json.error === 'object' && json.error.status?.error_code) return null;
  return json;
}

function pickLunarNumber(obj, keys) {
  if (!obj) return null;
  for (const k of keys) {
    if (obj[k] == null) continue;
    const v = Number(obj[k]);
    if (Number.isFinite(v)) return v;
  }
  return null;
}

function classifyLunarSentiment(val) {
  if (val < 25) return 'Extreme Fear';
  if (val < 45) return 'Fear';
  if (val < 55) return 'Neutral';
  if (val < 75) return 'Greed';
  return 'Extreme Greed';
}

function safeStringify(obj, maxLen = 10000) {
  try {
    const s = JSON.stringify(obj);
    return s.length > maxLen ? s.slice(0, maxLen) + '…[truncated]' : s;
  } catch {
    return String(obj).slice(0, 800);
  }
}

function internalApiOrigin(req) {
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  if (host) return `${proto}://${host}`;
  if (process.env.VERCEL_URL) return `https://${String(process.env.VERCEL_URL).replace(/^https?:\/\//i, '')}`;
  return 'http://127.0.0.1:3000';
}

function extractWalletAddress(prompt) {
  const s = String(prompt || '');
  const m = s.match(/\b0x[a-fA-F0-9]{40}\b/);
  return m ? m[0] : null;
}

async function alchemyScanRpc(req, rpcBody) {
  try {
    const origin = internalApiOrigin(req).replace(/\/$/, '');
    const r = await fetch(`${origin}/api/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: ALCHEMY_RPC_ENV_URL,
        method: 'POST',
        body: rpcBody,
      }),
    });
    if (!r.ok) {
      console.log('[claude] Alchemy scan rpc HTTP failure', { status: r.status, method: rpcBody?.method || null });
      return null;
    }
    const data = await r.json();
    console.log('[claude] Alchemy scan rpc response', {
      method: rpcBody?.method || null,
      hasError: !!data?.error,
      transfers: Array.isArray(data?.result?.transfers) ? data.result.transfers.length : null,
      tokenBalances: Array.isArray(data?.result?.tokenBalances) ? data.result.tokenBalances.length : null,
      pageKey: data?.result?.pageKey || null,
    });
    return data;
  } catch {
    return null;
  }
}

async function fetchAlchemyWalletContext(req, wallet) {
  try {
    const bal = await alchemyScanRpc(req, {
      jsonrpc: '2.0',
      id: 1,
      method: 'alchemy_getTokenBalances',
      params: [wallet, 'DEFAULT_TOKENS'],
    });
    const tokenBalances = Array.isArray(bal?.result?.tokenBalances) ? bal.result.tokenBalances : [];
    const holdings = tokenBalances
      .filter((t) => t && t.tokenBalance && t.tokenBalance !== '0x0')
      .slice(0, 40)
      .map((t) => ({ contractAddress: t.contractAddress, rawBalance: t.tokenBalance }));

    const allTransfers = [];
    let pageKeyOut = null;
    let pageKeyIn = null;
    for (let i = 0; i < 4; i++) {
      const [outRes, inRes] = await Promise.all([
        alchemyScanRpc(req, {
          jsonrpc: '2.0',
          id: 100 + i,
          method: 'alchemy_getAssetTransfers',
          params: [{
            fromBlock: '0x0',
            toBlock: 'latest',
            fromAddress: wallet,
            category: ['external', 'erc20', 'erc721', 'erc1155', 'internal'],
            withMetadata: true,
            maxCount: '0x64',
            order: 'desc',
            ...(pageKeyOut ? { pageKey: pageKeyOut } : {}),
          }],
        }),
        alchemyScanRpc(req, {
          jsonrpc: '2.0',
          id: 200 + i,
          method: 'alchemy_getAssetTransfers',
          params: [{
            fromBlock: '0x0',
            toBlock: 'latest',
            toAddress: wallet,
            category: ['external', 'erc20', 'erc721', 'erc1155', 'internal'],
            withMetadata: true,
            maxCount: '0x64',
            order: 'desc',
            ...(pageKeyIn ? { pageKey: pageKeyIn } : {}),
          }],
        }),
      ]);
      const outs = Array.isArray(outRes?.result?.transfers) ? outRes.result.transfers : [];
      const ins = Array.isArray(inRes?.result?.transfers) ? inRes.result.transfers : [];
      allTransfers.push(...outs, ...ins);
      pageKeyOut = outRes?.result?.pageKey || null;
      pageKeyIn = inRes?.result?.pageKey || null;
      if (!pageKeyOut && !pageKeyIn) break;
    }
    console.log('[claude] Alchemy wallet context aggregate', {
      wallet,
      holdings: holdings.length,
      transfers: allTransfers.length,
    });

    const txs = allTransfers
      .slice(0, 80)
      .map((t) => ({
        hash: t.hash || '',
        from: t.from || '',
        to: t.to || '',
        asset: t.asset || '',
        value: t.value ?? null,
        category: t.category || '',
        blockTimestamp: t.metadata?.blockTimestamp || null,
      }));

    return { wallet, tokenHoldings: holdings, assetTransfers: txs };
  } catch {
    return null;
  }
}

function extractLunarTopics(prompt) {
  const text = String(prompt || '');
  const seen = new Set();
  const out = [];

  const dollarRe = /\$([A-Za-z][A-Za-z0-9]{1,15})\b/g;
  let m;
  while ((m = dollarRe.exec(text)) !== null) {
    const sym = m[1].toLowerCase();
    const topic = LUNAR_TOPIC_MAP[sym] || sym;
    if (!seen.has(topic)) {
      seen.add(topic);
      out.push(topic);
    }
  }

  const wordRe =
    /\b(bitcoin|btc|ethereum|eth|solana|sol|dogecoin|doge|xrp|ripple|cardano|ada|avalanche|avax|bnb|binancecoin|chainlink|link|polygon|matic|pepe|arbitrum|arb)\b/gi;
  while ((m = wordRe.exec(text)) !== null) {
    const w = m[1].toLowerCase();
    const topic = LUNAR_TOPIC_MAP[w];
    if (topic && !seen.has(topic)) {
      seen.add(topic);
      out.push(topic);
    }
  }

  return out.slice(0, 4);
}

function slimDexPairs(pairs) {
  if (!Array.isArray(pairs)) return [];
  return pairs.slice(0, 12).map((p) => ({
    chainId: p.chainId,
    pair: p.pairAddress,
    base: p.baseToken
      ? { symbol: p.baseToken.symbol, name: p.baseToken.name, address: p.baseToken.address }
      : null,
    priceUsd: p.priceUsd,
    priceChange: p.priceChange,
    volume: p.volume,
    liquidity: p.liquidity,
    url: p.url,
  }));
}

async function fetchLunarDirect(req, topic) {
  try {
    const origin = internalApiOrigin(req).replace(/\/$/, '');
    const r = await fetch(`${origin}/api/lunarsentiment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, interval: '1d', limit: 12 }),
    });
    if (!r.ok) return null;
    const json = await r.json();
    const metrics = json?.metrics || {};
    const points = Array.isArray(json?.data) ? json.data : [];
    const currentVal = Number.isFinite(Number(metrics.galaxy_score))
      ? Number(metrics.galaxy_score)
      : Number.isFinite(Number(points?.[0]?.value))
        ? Number(points[0].value)
        : 50;
    const clamped = Math.max(0, Math.min(100, Math.round(currentVal)));
    return {
      topic,
      lunarCrushSentimentGauge0to100: clamped,
      classification: classifyLunarSentiment(clamped),
      galaxyScoreOrSentimentFields: {
        galaxy_score: metrics.galaxy_score ?? null,
        sentiment: metrics.sentiment_score ?? null,
        alt_rank: metrics.alt_rank ?? null,
      },
      samplePoints: points.slice(0, 5),
    };
  } catch {
    return null;
  }
}

async function fetchWhaleMovesDirect(ethUsd) {
  try {
    const escan = (process.env.ETHERSCAN_KEY || '').trim();
    if (!escan) {
      return { error: 'ETHERSCAN_KEY not set' };
    }
    const apikey = encodeURIComponent(escan);
    const price = Number.isFinite(ethUsd) && ethUsd > 0 ? ethUsd : 3000;
    const minUsd = 50000;
    const minEth = minUsd / price;
    const nowSec = Math.floor(Date.now() / 1000);
    const sinceSec = nowSec - 7200;

    const latestBlockUrl = `${ETHERSCAN_V2}?chainid=1&module=proxy&action=eth_blockNumber&apikey=${apikey}`;
    const sinceBlockUrl = `${ETHERSCAN_V2}?chainid=1&module=block&action=getblocknobytime&timestamp=${sinceSec}&closest=before&apikey=${apikey}`;

    const [latestJson, sinceJson] = await Promise.all([
      fetchJsonDirect(latestBlockUrl),
      fetchJsonDirect(sinceBlockUrl),
    ]);

    if (!latestJson || latestJson.result == null) {
      return { error: 'eth_blockNumber failed' };
    }
    if (sinceJson?.status === '0' && typeof sinceJson?.result === 'string') {
      return { error: 'getblocknobytime failed', detail: sinceJson.result };
    }

    const latestRaw = String(latestJson.result);
    const latestBlock = latestRaw.startsWith('0x')
      ? parseInt(latestRaw, 16)
      : parseInt(latestRaw, 10);
    if (!Number.isFinite(latestBlock) || latestBlock <= 0) {
      return { error: 'bad latest block', detail: latestRaw };
    }

    let sinceBlock = parseInt(String(sinceJson?.result ?? ''), 10);
    if (!Number.isFinite(sinceBlock) || sinceBlock < 0) {
      return { error: 'bad since block' };
    }

    let startBlock = sinceBlock;
    const endBlock = latestBlock;
    if (startBlock > endBlock) startBlock = Math.max(0, endBlock - 3000);

    const txUrl =
      `${ETHERSCAN_V2}?chainid=1&module=account&action=txlist&address=${WHALE_WATCH}` +
      `&startblock=${startBlock}&endblock=${endBlock}&page=1&offset=1000&sort=desc&apikey=${apikey}`;

    const data = await fetchJsonDirect(txUrl);
    if (!data) return { error: 'txlist fetch failed' };
    if (data.status === '0' && typeof data.result === 'string') {
      return { error: 'Etherscan txlist', detail: data.result };
    }
    const rawList = data.result;
    if (!Array.isArray(rawList)) {
      return { error: 'txlist not array' };
    }

    const watchLower = WHALE_WATCH.toLowerCase();
    const txs = rawList
      .filter((tx) => {
        if (!tx || tx.isError === '1') return false;
        if (tx.txreceipt_status === '0') return false;
        const txTs = parseInt(tx.timeStamp, 10) || 0;
        if (txTs < sinceSec) return false;
        const ethVal = parseFloat(tx.value) / 1e18;
        return ethVal >= minEth;
      })
      .sort((a, b) => (parseFloat(b.value) || 0) - (parseFloat(a.value) || 0))
      .slice(0, 6)
      .map((tx) => {
        const ethVal = parseFloat(tx.value) / 1e18;
        return {
          hash: tx.hash,
          from: tx.from,
          to: tx.to,
          eth: Math.round(ethVal * 1000) / 1000,
          usdApprox: Math.round(ethVal * price),
          timestampUtc: tx.timeStamp
            ? new Date(parseInt(tx.timeStamp, 10) * 1000).toISOString()
            : null,
          directionVsWatch:
            (tx.from || '').toLowerCase() === watchLower ? 'out' : 'in',
        };
      });

    return { watchWallet: WHALE_WATCH, minEthFilter: Math.round(minEth * 1e6) / 1e6, moves: txs };
  } catch {
    return { error: 'etherscan_whale_fetch_failed' };
  }
}

async function fetchGraphDexContextDirect() {
  try {
    const graphKey = String(process.env.GRAPH_API_KEY || '').trim();
    if (!graphKey) return null;

    const dayAgo = Math.floor(Date.now() / 1000) - 86400;
    const endpoint = `https://gateway.thegraph.com/api/${encodeURIComponent(graphKey)}/subgraphs/id/${GRAPH_UNISWAP_V3_SUBGRAPH_ID}`;
    const query = `
      query TopUniswapV3Pools($dayAgo: Int!) {
        poolDayDatas(
          first: 5
          orderBy: volumeUSD
          orderDirection: desc
          where: { date_gte: $dayAgo }
        ) {
          date
          volumeUSD
          tvlUSD
          pool {
            id
            token0 { symbol }
            token1 { symbol }
          }
        }
      }
    `;

    const r = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'ChainLens-Clark/1.0',
      },
      body: JSON.stringify({ query, variables: { dayAgo } }),
    });
    if (!r.ok) return null;

    const json = await r.json();
    const rows = Array.isArray(json?.data?.poolDayDatas) ? json.data.poolDayDatas : [];
    if (!rows.length) return null;

    return rows.slice(0, 5).map((row) => {
      const t0 = String(row?.pool?.token0?.symbol || '').trim() || 'UNKNOWN';
      const t1 = String(row?.pool?.token1?.symbol || '').trim() || 'UNKNOWN';
      const volumeUsd = Number(row?.volumeUSD);
      const liquidityUsd = Number(row?.tvlUSD);
      return {
        pair: `${t0}/${t1}`,
        volumeUsd24h: Number.isFinite(volumeUsd) ? Math.round(volumeUsd) : null,
        liquidityUsd: Number.isFinite(liquidityUsd) ? Math.round(liquidityUsd) : null,
      };
    });
  } catch {
    return null;
  }
}

async function buildLiveContextBlock(req, userPrompt) {
  try {
    const priceUrl = appendCoinGeckoKeyToUrl(
      `${CG_BASE}/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true`
    );
    const globalUrl = appendCoinGeckoKeyToUrl(`${CG_BASE}/global`);

    const topics = extractLunarTopics(userPrompt);

    let priceJson = null;
    try {
      priceJson = await fetchJsonDirect(priceUrl);
    } catch {
      priceJson = null;
    }

    let globalJson = null;
    try {
      globalJson = await fetchJsonDirect(globalUrl);
    } catch {
      globalJson = null;
    }

    let dexJson = null;
    try {
      dexJson = await fetchJsonDirect(DEX_TOP_VOL_URL);
    } catch {
      dexJson = null;
    }

    let ethUsd = 3000;
    if (priceJson?.ethereum?.usd != null) {
      ethUsd = Number(priceJson.ethereum.usd) || ethUsd;
    }

    const lunarResults = [];
    for (const t of topics) {
      try {
        const row = await fetchLunarDirect(req, t);
        if (row) lunarResults.push(row);
      } catch {
        /* soft fail per topic */
      }
    }

    let whaleBox = null;
    try {
      whaleBox = await fetchWhaleMovesDirect(ethUsd);
    } catch {
      whaleBox = { error: 'whale_context_unavailable' };
    }

    let graphDexBox = null;
    try {
      graphDexBox = await fetchGraphDexContextDirect();
    } catch {
      graphDexBox = null;
    }

    const parts = [];

    parts.push(
      'LIVE_CONTEXT_SOURCE: direct HTTP to CoinGecko, DexScreener, Etherscan, LunarCrush, The Graph (no internal /api proxy except /api/lunarsentiment).'
    );

    parts.push(
      'COIN_GECKO_BTC_ETH (direct): ' +
        (priceJson ? safeStringify(priceJson, 2500) : '(skipped — unavailable or auth error)')
    );

    parts.push(
      'COIN_GECKO_GLOBAL (direct): ' +
        (globalJson?.data != null
          ? safeStringify(globalJson.data, 3500)
          : globalJson
            ? safeStringify(globalJson, 3500)
            : '(skipped — unavailable or auth error)')
    );

    const dexPairs = dexJson?.pairs;
    parts.push(
      'DEXSCREENER_TOP_VOLUME_PAIRS (direct): ' +
        (Array.isArray(dexPairs) && dexPairs.length
          ? safeStringify(slimDexPairs(dexPairs), 6000)
          : '(skipped — unavailable)')
    );

    parts.push(
      'ETHERSCAN_WHALE_MOVES (direct, ETH mainnet, high-flow watch wallet): ' +
        (whaleBox && !whaleBox.error
          ? safeStringify(whaleBox, 4000)
          : '(skipped — unavailable)')
    );

    parts.push(
      'GRAPH_DEX_CONTEXT (The Graph, Uniswap v3 top pools by 24h volume): ' +
        (Array.isArray(graphDexBox) && graphDexBox.length
          ? safeStringify(graphDexBox, 4000)
          : '(skipped — unavailable or GRAPH_API_KEY missing)')
    );

    if (topics.length) {
      parts.push(
        'LUNARCRUSH_SENTIMENT_GAUGE (via /api/lunarsentiment, LUNARCRUSH_KEY): ' +
          (lunarResults.length
            ? safeStringify(lunarResults, 6000)
            : '(skipped — no data or LUNARCRUSH_KEY / API error)')
      );
    } else {
      parts.push(
        'LUNARCRUSH_SENTIMENT_GAUGE: no token/topic detected in user message (skip). If needed, infer only from other context above.'
      );
    }

    const wallet = extractWalletAddress(userPrompt);
    if (wallet) {
      let alchemyCtx = null;
      try { alchemyCtx = await fetchAlchemyWalletContext(req, wallet); } catch { alchemyCtx = null; }
      parts.push(
        'ALCHEMY_WALLET_CONTEXT (via /api/scan + ALCHEMY_KEY): ' +
          (alchemyCtx ? safeStringify(alchemyCtx, 7000) : '(skipped — unavailable or ALCHEMY_KEY missing)')
      );
    }

    return parts.join('\n\n');
  } catch (e) {
    return (
      'LIVE_CONTEXT_PARTIAL: aggregation error — continuing without full live block. ' +
      String(e.message || e)
    );
  }
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { prompt, max_tokens = 700 } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'No prompt provided' });
  }

  // Check API key is configured
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY environment variable is not set in Vercel');
    return res.status(500).json({
      error: 'AI service not configured. Add ANTHROPIC_API_KEY to Vercel environment variables.',
      code: 'MISSING_API_KEY',
    });
  }

  let liveContext = '';
  try {
    liveContext = await buildLiveContextBlock(req, prompt);
  } catch (e) {
    liveContext = 'LIVE_CONTEXT_FETCH_ERROR: ' + String(e.message || e);
  }

  const system = `${CLARK_SYSTEM}

---
LIVE CONTEXT (fetched server-side before this request; cite explicitly when using numbers below)
${liveContext}
---`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens,
        system,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();

    if (data.error) {
      console.error('Anthropic API error:', data.error);
      // Give a clear message for auth errors
      if (data.error.type === 'authentication_error') {
        return res.status(500).json({
          error: 'Invalid Anthropic API key. Check ANTHROPIC_API_KEY in Vercel settings.',
          code: 'INVALID_API_KEY',
        });
      }
      return res.status(500).json({ error: data.error.message });
    }

    return res.status(200).json({ text: data.content[0].text });
  } catch (err) {
    console.error('Claude API fetch error:', err.message);
    return res.status(500).json({ error: 'Server error. Try again.' });
  }
}
