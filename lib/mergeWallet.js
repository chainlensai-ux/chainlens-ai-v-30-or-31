export function mergeWalletData(zerionData = {}, goldrushData = {}) {
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
    if (!contract) continue;
    const existing = byAddress.get(contract);
    const balance = Number(token?.balance || 0) / Math.pow(10, Number(token?.contract_decimals || 0));
    const usdValue = Number(token?.quote || 0);
    if (!existing) {
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
  }

  const tokens = [...byAddress.values()].sort((a, b) => (b.usdValue || 0) - (a.usdValue || 0));
  const totalUsd = tokens.reduce((sum, t) => sum + (t.usdValue || 0), 0);

  return {
    totalUsd,
    totalTokens: tokens.length,
    topTokens: tokens.slice(0, 20),
    tokens,
  };
}
