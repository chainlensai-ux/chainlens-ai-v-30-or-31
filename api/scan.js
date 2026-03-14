export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let { url, body, method } = req.body || {};
  if (!url) return res.status(400).json({ error: 'No URL provided' });
  const ESCAN = process.env.ETHERSCAN_KEY || '';
  if (ESCAN) url = url.replace('apikey=ENV', `apikey=${ESCAN}`);
  const allowed = [
    'api.etherscan.io',
    'api.basescan.org',
    'api.bscscan.com',
    'api.polygonscan.com',
    'blockchain.info',
    'blockstream.info',
    'api.blockchair.com',
    'api.mainnet-beta.solana.com',
    'rpc.ankr.com',
    'solana-mainnet.g.alchemy.com',
    'api.dexscreener.com',
    'token.jup.ag',
    'tokens.jup.ag'
  ];
  if (!allowed.some(d => url.includes(d))) {
    return res.status(403).json({ error: 'Domain not allowed: ' + url });
  }
  try {
    const fetchOptions = {
      method: method || 'GET',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'ChainLens/1.0' }
    };
    if (body) fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
    const response = await fetch(url, fetchOptions);
    const text = await response.text();
    try {
      return res.status(200).json(JSON.parse(text));
    } catch {
      return res.status(200).send(text);
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
