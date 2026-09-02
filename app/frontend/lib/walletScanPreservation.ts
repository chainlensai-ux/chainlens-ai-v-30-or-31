export function resolvePreservedResultOnScanStart<T extends { scanMetadata?: { walletAddress?: unknown } }>(
  previous: T | null,
  nextAddress: string,
): T | null {
  const previousAddress = previous?.scanMetadata?.walletAddress
  return typeof previousAddress === 'string' && previousAddress.toLowerCase() === nextAddress.toLowerCase()
    ? previous
    : null
}
