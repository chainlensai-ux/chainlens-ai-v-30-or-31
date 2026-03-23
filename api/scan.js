export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let { url, body, method } = req.body || {};
  if (!url) return res.status(400).json({ error: 'No URL provided' });
  const ESCAN = process.env.ETHERSCAN_KEY || '';
  const MORALIS = process.env.MORALIS_KEY || '';
  const isEtherscan = typeof url === 'string' && url.includes('api.etherscan.io');
  if (isEtherscan && (!ESCAN || !String(ESCAN).trim()) && /apikey=ENV\b/.test(url)) {
    return res.status(503).json({
      status: '0',
      message: 'NOTOK',
      result: 'ETHERSCAN_KEY is not set on the server (Vercel env / local .env).'
    });
  }
  if (ESCAN) url = url.replace(/apikey=ENV\b/g, () => `apikey=${encodeURIComponent(String(ESCAN).trim())}`);
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
    'solana-mainnet.g.alchemy.com',
    'api.dexscreener.com',
    'api.coingecko.com',
    'api.moralis.io',
    'deep-index.moralis.io',
    'token.jup.ag',
    'tokens.jup.ag',
    'api.alternative.me'
  ];
  if (!allowed.some(d => url.includes(d))) {
    return res.status(403).json({ error: 'Domain not allowed: ' + url });
  }
  try {
    const isMoralis = typeof url === 'string' && (url.includes('api.moralis.io') || url.includes('deep-index.moralis.io'));
    const fetchOptions = {
      method: method || 'GET',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'ChainLens/1.0' }
    };
    if (isMoralis && MORALIS) fetchOptions.headers['X-API-Key'] = String(MORALIS).trim();
    if (body) fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
    const response = await fetch(url, fetchOptions);
    const text = await response.text();
    // Pass upstream status through so callers can detect errors
    const status = response.ok ? 200 : response.status;
    try {
      return res.status(status).json(JSON.parse(text));
    } catch {
      return res.status(status).send(text);
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
