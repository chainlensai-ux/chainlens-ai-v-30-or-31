async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GoPlus request failed (${res.status})`);
  return res.json();
}

export async function fetchGoPlusSecurity(token, chainId = '1') {
  if (!token) return {};
  const url = `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${encodeURIComponent(token)}`;
  const data = await fetchJson(url);
  return data?.result?.[token.toLowerCase()] || data?.result || {};
}
