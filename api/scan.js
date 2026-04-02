export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let { url, body, method } = req.body || {};
  if (!url) return res.status(400).json({ error: 'No URL provided' });
  const ESCAN = process.env.ETHERSCAN_KEY || '';
  const BSCAN = process.env.BASESCAN_KEY || ESCAN;
  const MORALIS = process.env.MORALIS_KEY || '';
  const ALCHEMY = process.env.ALCHEMY_KEY || '';
  const isEtherscan = typeof url === 'string' && url.includes('api.etherscan.io');
  const isAlchemy = typeof url === 'string' && url.includes('g.alchemy.com');
  if (isEtherscan && (!ESCAN || !String(ESCAN).trim()) && /apikey=ENV\b/.test(url)) {
    return res.status(503).json({
      status: '0',
      message: 'NOTOK',
      result: 'ETHERSCAN_KEY is not set on the server (Vercel env / local .env).'
    });
  }
  if (isAlchemy && (!ALCHEMY || !String(ALCHEMY).trim()) && /\/v2\/ENV\b/.test(url)) {
    return res.status(503).json({
      error: 'ALCHEMY_KEY is not set on the server (Vercel env / local .env).'
    });
  }
  if (typeof url === 'string' && url.includes('api.basescan.org') && BSCAN) {
    url = url.replace(/apikey=ENV\b/g, () => `apikey=${encodeURIComponent(String(BSCAN).trim())}`);
  } else if (ESCAN) {
    url = url.replace(/apikey=ENV\b/g, () => `apikey=${encodeURIComponent(String(ESCAN).trim())}`);
  }
  if (ALCHEMY) url = url.replace(/\/v2\/ENV\b/g, () => `/v2/${String(ALCHEMY).trim()}`);
  const allowed = [
    'api.etherscan.io',
    'api.basescan.org',
    'api.bscscan.com',
    'api.polygonscan.com',
    'blockchain.info',
    'blockstream.info',
    'mempool.space',
    'api.blockchair.com',
    'api.mainnet-beta.solana.com',
    'rpc.ankr.com',
    'g.alchemy.com',
    'solana-mainnet.g.alchemy.com',
    'api.dexscreener.com',
    'api.coingecko.com',
    'api.moralis.io',
    'deep-index.moralis.io',
    'token.jup.ag',
    'tokens.jup.ag',
    'api.alternative.me',
    'api.gopluslabs.io'
  ];
  if (!allowed.some(d => url.includes(d))) {
    return res.status(403).json({ error: 'Domain not allowed: ' + url });
  }
  try {
    const isMoralis = typeof url === 'string' && (url.includes('api.moralis.io') || url.includes('deep-index.moralis.io'));
    const isAlchemyReq = typeof url === 'string' && url.includes('g.alchemy.com');
    const fetchOptions = {
      method: method || 'GET',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'ChainLens/1.0' }
    };
    if (isMoralis && MORALIS) fetchOptions.headers['X-API-Key'] = String(MORALIS).trim();
    if (body) fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (isAlchemyReq) {
      console.log('[scan] Alchemy request', {
        method: fetchOptions.method,
        url: String(url || '').replace(String(ALCHEMY || ''), '***'),
        hasAlchemyKey: !!String(ALCHEMY || '').trim(),
        bodyMethod: body?.method || null,
      });
    }
    const response = await fetch(url, fetchOptions);
    const text = await response.text();
    // Pass upstream status through so callers can detect errors
    const status = response.ok ? 200 : response.status;
    try {
      const json = JSON.parse(text);
      if (isAlchemyReq) {
        const transfers = Array.isArray(json?.result?.transfers) ? json.result.transfers.length : null;
        const tokenBalances = Array.isArray(json?.result?.tokenBalances) ? json.result.tokenBalances.length : null;
        console.log('[scan] Alchemy response', {
          status,
          hasError: !!json?.error,
          transfers,
          tokenBalances,
          pageKey: json?.result?.pageKey || null,
        });
      }
      return res.status(status).json(json);
    } catch {
      return res.status(status).send(text);
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
