async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GoldRush request failed (${res.status})`);
  return res.json();
}

export async function fetchGoldRushWallet(wallet, chainId = '1') {
  if (!wallet) return {};
  const key = (process.env.GOLDRUSH_API_KEY || '').trim();
  if (!key) return { error: 'GOLDRUSH_API_KEY missing' };
  const data = await fetchJson(`https://api.covalenthq.com/v1/${chainId}/address/${wallet}/balances_v2/?key=${key}`);
  return data?.data || {};
}

export async function fetchGoldRushTokenMetadata(token, chainId = '1') {
  if (!token) return {};
  const key = (process.env.GOLDRUSH_API_KEY || '').trim();
  if (!key) return { error: 'GOLDRUSH_API_KEY missing' };
  const data = await fetchJson(`https://api.covalenthq.com/v1/${chainId}/tokens/${token}/token_holders_v2/?page-size=1&key=${key}`);
  return data?.data || {};
}
