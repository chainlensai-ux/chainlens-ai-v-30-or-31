export default async function handler(req, res) {
  // Allow CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let { url, body, method } = req.body || {};
  if (!url) return res.status(400).json({ error: 'No URL provided' });

  // Inject Etherscan API key server-side — never exposed to client
  const ESCAN = process.env.ETHERSCAN_API_KEY || '';
  if (url.includes('etherscan.io') && ESCAN) {
    url = url.replace('apikey=ENV', `apikey=${ESCAN}`);
  }

  const allowed = ['api.etherscan.io','api.basescan.org','blockchain.info','api.mainnet-beta.solana.com','blockstream.info','api.blockchair.com','rpc.ankr.com','solana-mainnet.g.alchemy.com'];
  if (!allowed.some(d => url.includes(d))) {
    console.error('Blocked domain:', url);
    return res.status(403).json({ error: 'Domain not allowed: ' + url });
  }

  try {
    console.log('Proxying:', url.substring(0, 80));
    const fetchOptions = { 
      method: method || 'GET', 
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'ChainLens/1.0' }
    };
    if (body) fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
    
    const response = await fetch(url, fetchOptions);
    const text = await response.text();
    console.log('Response status:', response.status, 'length:', text.length);
    
    try {
      const data = JSON.parse(text);
      return res.status(200).json(data);
    } catch {
      return res.status(200).send(text);
    }
  } catch (err) {
    console.error('Proxy fetch error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

