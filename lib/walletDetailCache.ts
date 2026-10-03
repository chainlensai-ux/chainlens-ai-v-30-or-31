// Bounded TTL + singleflight, shared by lazy browser reads and server RPC reads.
export function createWalletDetailCache<T>(ttlMs = 60_000, maxEntries = 200, now = Date.now) {
  const values = new Map<string, { value: T; expires: number }>()
  const flights = new Map<string, Promise<T>>()
  return {
    get(key: string, load: () => Promise<T>): Promise<T> {
      const cached = values.get(key)
      if (cached && cached.expires > now()) return Promise.resolve(cached.value)
      const flight = flights.get(key)
      if (flight) return flight
      const promise = Promise.resolve().then(load).then(value => {
        values.delete(key)
        values.set(key, { value, expires: now() + ttlMs })
        while (values.size > maxEntries) values.delete(values.keys().next().value!)
        return value
      }).finally(() => flights.delete(key))
      flights.set(key, promise)
      return promise
    },
  }
}
