async function fetchAllZerionWalletPositions(address, zerionHeaders) {
  let url = `https://api.zerion.io/v1/wallets/${address}/positions/?filter[position_types]=wallet&currency=usd&page[size]=100`;
  const allPositions = [];
  while (url) {
    const res = await fetch(url, { headers: zerionHeaders });
    if (!res.ok) break;
    const json = await res.json();
    const items = Array.isArray(json?.data) ? json.data : [];
    allPositions.push(...items);
    url = json?.links?.next || null;
  }
  return allPositions;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { address, chainId = '8453' } = req.body || {};
  if (!address) return res.status(400).json({ error: 'Missing address' });

  const GOLDRUSH_KEY = process.env.GOLDRUSH_API_KEY;
  const ZERION_KEY = process.env.ZERION_KEY;
  const HELIUS_KEY = process.env.HELIUS_KEY;

  const isSolana = !String(address).startsWith('0x');

  const zerionAuth = `Basic ${Buffer.from(ZERION_KEY + ':').toString('base64')}`;
  const zerionHeaders = { Authorization: zerionAuth, accept: 'application/json' };

  // Always fetch Zerion transactions and DeFi positions (works for both EVM and Solana addresses)
  const zerionTxUrl = `https://api.zerion.io/v1/wallets/${address}/transactions/?currency=usd&page[size]=20&sort=-operation_at`;
  const zerionDefiUrl = `https://api.zerion.io/v1/wallets/${address}/positions/?filter[position_types]=deposited,staked,locked,borrowing&currency=usd&page[size]=100`;

  const fetchZerionTxs = fetch(zerionTxUrl, { headers: zerionHeaders }).then(r => r.ok ? r.json() : null).catch(() => null);
  const fetchZerionDefi = fetch(zerionDefiUrl, { headers: zerionHeaders }).then(r => r.ok ? r.json() : null).catch(() => null);

  if (isSolana) {
    // Solana path: Helius token accounts + Zerion transactions/DeFi positions
    const heliusFetch = HELIUS_KEY
      ? fetch(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getTokenAccountsByOwner',
            params: [
              address,
              { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
              { encoding: 'jsonParsed' }
            ]
          })
        }).then(r => r.ok ? r.json() : null).catch(() => null)
      : Promise.resolve(null);

    const [heliusData, zerionTxData, zerionDefiData] = await Promise.all([heliusFetch, fetchZerionTxs, fetchZerionDefi]);

    const solanaTokenAccounts = Array.isArray(heliusData?.result?.value) ? heliusData.result.value : [];
    const solanaTokens = solanaTokenAccounts
      .map(acc => {
        const info = acc?.account?.data?.parsed?.info || {};
        const amount = info?.tokenAmount || {};
        const balance = parseFloat(amount.uiAmountString || amount.uiAmount || 0);
        if (!balance || balance <= 0) return null;
        return {
          mint: info.mint || '',
          symbol: info.mint ? info.mint.slice(0, 6) : 'SPL',
          name: info.mint || 'SPL Token',
          balance,
          decimals: Number(amount.decimals || 0),
          usdValue: 0,
          price: null,
          chain: 'solana',
          contractAddress: info.mint || ''
        };
      })
      .filter(Boolean);

    const transactions = Array.isArray(zerionTxData?.data) ? zerionTxData.data : [];
    const positions = Array.isArray(zerionDefiData?.data) ? zerionDefiData.data : [];

    return res.status(200).json({
      success: true,
      solanaTokens,
      transactions,
      positions,
      totalTokens: solanaTokens.length
    });
  }

  // EVM path: GoldRush + Zerion positions (wallet, all chains, paginated) + Zerion transactions + Zerion DeFi positions
  const [goldRushRes, zerionPositionsResult, zerionPortfolioRes, zerionTxData, zerionDefiData] = await Promise.allSettled([
    fetch(`https://api.covalenthq.com/v1/${chainId}/address/${address}/balances_v2/?key=${GOLDRUSH_KEY}`).then(r => r.json()),
    fetchAllZerionWalletPositions(address, zerionHeaders),
    fetch(`https://api.zerion.io/v1/wallets/${address}/portfolio/?currency=usd`, {
      headers: { Authorization: `Basic ${Buffer.from(ZERION_KEY + ':').toString('base64')}` }
    }).then(r => r.json()),
    fetchZerionTxs,
    fetchZerionDefi
  ]);

  if (goldRushRes.status === 'rejected' && zerionPositionsResult.status === 'rejected' && zerionPortfolioRes.status === 'rejected') {
    return res.status(500).json({ error: 'Both data sources unavailable' });
  }

  const CHAIN_ID_TO_ZERION_NAME = {
    '1': 'ethereum',
    '8453': 'base',
    '137': 'polygon',
    '42161': 'arbitrum',
    '10': 'optimism',
    '56': 'binance-smart-chain',
    '43114': 'avalanche',
  };

  const goldRushTokens = goldRushRes.status === 'fulfilled' ? (goldRushRes.value?.data?.items || []) : [];
  console.log('[walletscan] goldRushTokens:', goldRushTokens.map(t => t.contract_ticker_symbol + ':' + t.quote));
  const zerionPositions = zerionPositionsResult.status === 'fulfilled' ? (zerionPositionsResult.value || []) : [];

  let portfolioTotal = 0;
  if (zerionPortfolioRes.status === 'fulfilled') {
    const attrs = zerionPortfolioRes.value?.data?.attributes;
    const chainDist = attrs?.positions_distribution_by_chain;
    const zerionChainName = CHAIN_ID_TO_ZERION_NAME[String(chainId)];
    if (chainDist && zerionChainName && chainDist[zerionChainName] != null) {
      portfolioTotal = chainDist[zerionChainName];
    } else {
      portfolioTotal = attrs?.total?.positions || 0;
    }
  }

  const zerionMap = {};
  zerionPositions.forEach(p => {
    const addr = p?.relationships?.fungible?.data?.id || '';
    if (addr) zerionMap[addr.toLowerCase()] = p;
  });

  const merged = goldRushTokens
    .filter(token => (token.quote || 0) >= 0.01)
    .map(token => {
      const ca = (token.contract_address || '').toLowerCase();
      const zerionMatch = zerionMap[ca];
      const usdValue = zerionMatch != null ? (zerionMatch.attributes?.value ?? 0) : 0;
      const price = zerionMatch != null ? (zerionMatch.attributes?.price ?? 0) : 0;
      const isUnindexed = !zerionMatch;
      const source = isUnindexed ? 'goldrush_only' : 'merged';
      let finalUsdValue = usdValue;
      let finalPrice = price;
      if (source === 'goldrush_only' && finalUsdValue === 0) {
        if (token.quote && token.quote > 0) {
          finalUsdValue = token.quote;
        }
        const balance = parseFloat(token.balance) / Math.pow(10, token.contract_decimals || 0);
        if (finalPrice === 0 && token.quote && token.quote > 0 && balance > 0) {
          finalPrice = token.quote / balance;
        }
      }
      return {
        symbol: token.contract_ticker_symbol,
        name: token.contract_name,
        contractAddress: token.contract_address,
        balance: parseFloat(token.balance) / Math.pow(10, token.contract_decimals || 0),
        decimals: token.contract_decimals,
        usdValue: finalUsdValue,
        price: finalPrice,
        chain: chainId,
        source,
        isLowCap: isUnindexed,
        isNewOrUnindexed: isUnindexed
      };
    });

  merged.sort((a, b) => (b.usdValue || 0) - (a.usdValue || 0));

  const virtualTokens = merged.filter(t => t.symbol === 'VIRTUAL');
  console.log(`[walletscan] VIRTUAL positions (${virtualTokens.length}):`, JSON.stringify(virtualTokens));

  merged.forEach(token => {
    console.log(`[walletscan] symbol=${token.symbol} usdValue=${token.usdValue} source=${token.source}`);
  });

  const transactions = zerionTxData?.status === 'fulfilled'
    ? (Array.isArray(zerionTxData.value?.data) ? zerionTxData.value.data : [])
    : (Array.isArray(zerionTxData?.data) ? zerionTxData.data : []);

  const positions = zerionDefiData?.status === 'fulfilled'
    ? (Array.isArray(zerionDefiData.value?.data) ? zerionDefiData.value.data : [])
    : (Array.isArray(zerionDefiData?.data) ? zerionDefiData.data : []);

  console.log('[walletscan] portfolioTotal:', portfolioTotal);
  return res.status(200).json({ portfolioTotal, tokens: merged, transactions, positions, success: true, totalTokens: merged.length });
}
