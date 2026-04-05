function alchemyUrl() {
  const key = (process.env.ALCHEMY_API_KEY || '').trim();
  if (!key) return null;
  return `https://eth-mainnet.g.alchemy.com/v2/${key}`;
}

async function rpc(method, params) {
  const url = alchemyUrl();
  if (!url) return { error: 'ALCHEMY_API_KEY missing' };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`Alchemy request failed (${res.status})`);
  const data = await res.json();
  if (data?.error) throw new Error(data.error.message || 'Alchemy RPC error');
  return data?.result || {};
}

export async function fetchAlchemyWhaleFlows(addressOrToken) {
  if (!addressOrToken) return {};
  const isWallet = /^0x[a-fA-F0-9]{40}$/.test(addressOrToken);
  if (!isWallet) return { note: 'whale flow requires wallet address' };

  const transfers = await rpc('alchemy_getAssetTransfers', [{
    fromBlock: '0x0',
    toBlock: 'latest',
    fromAddress: addressOrToken,
    category: ['external', 'erc20'],
    withMetadata: true,
    maxCount: '0x64',
    order: 'desc',
  }]);

  const rows = Array.isArray(transfers?.transfers) ? transfers.transfers : [];
  const whaleTransfers = rows.filter((t) => Number(t?.value || 0) >= 1000);

  return {
    totalTransfers: rows.length,
    whaleTransfers,
    whaleCount: whaleTransfers.length,
  };
}
