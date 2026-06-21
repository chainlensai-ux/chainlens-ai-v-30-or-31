const TRACKED_TOKENS_STORAGE_KEY = "chainlens:trackedTokens";
const TRACKED_TOKEN_SYMBOLS_STORAGE_KEY = "chainlens:trackedTokenSymbols";

function normalizeToken(token: string): string {
  return token.trim().toLowerCase();
}

function dedupeTokens(tokens: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const token of tokens) {
    const normalized = normalizeToken(token);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(normalized);
  }

  return deduped;
}

function readStorage(): Storage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

// PHASE-TS1-FIX: every tracked-token storage access is guarded so the scanner never crashes when storage is unavailable.
export function getTrackedTokens(): string[] {
  try {
    const storage = readStorage();
    if (!storage) return [];

    const rawTokens = storage.getItem(TRACKED_TOKENS_STORAGE_KEY);
    if (!rawTokens) return [];

    const parsedTokens: unknown = JSON.parse(rawTokens);
    if (!Array.isArray(parsedTokens)) return [];

    return dedupeTokens(parsedTokens.filter((token): token is string => typeof token === "string"));
  } catch {
    return [];
  }
}

export function saveTrackedTokens(tokens: string[]): void {
  try {
    const storage = readStorage();
    if (!storage) return;

    storage.setItem(TRACKED_TOKENS_STORAGE_KEY, JSON.stringify(dedupeTokens(tokens)));
  } catch {
    // PHASE-TS1-FIX: callers should update UI state, but storage failures must never escape this utility.
  }
}

export function addTrackedToken(token: string): void {
  try {
    const normalized = normalizeToken(token);
    if (!normalized) return;

    saveTrackedTokens([...getTrackedTokens(), normalized]);
  } catch {
    // PHASE-TS1-FIX: never let persistence failures break successful scans.
  }
}

export function removeTrackedToken(token: string): void {
  try {
    const normalized = normalizeToken(token);
    if (!normalized) return;

    saveTrackedTokens(getTrackedTokens().filter((trackedToken) => trackedToken !== normalized));
  } catch {
    // PHASE-TS1-FIX: removing a tracked token should be best-effort and non-fatal.
  }
}

export function canUseTrackedTokenStorage(): boolean {
  try {
    const storage = readStorage();
    if (!storage) return false;

    const probeKey = `${TRACKED_TOKENS_STORAGE_KEY}:probe`;
    storage.setItem(probeKey, "1");
    storage.removeItem(probeKey);
    return true;
  } catch {
    return false;
  }
}


export function getTrackedTokenSymbols(): Record<string, string> {
  try {
    const storage = readStorage();
    if (!storage) return {};

    const rawSymbols = storage.getItem(TRACKED_TOKEN_SYMBOLS_STORAGE_KEY);
    if (!rawSymbols) return {};

    const parsedSymbols: unknown = JSON.parse(rawSymbols);
    if (!parsedSymbols || typeof parsedSymbols !== "object" || Array.isArray(parsedSymbols)) return {};

    return Object.fromEntries(
      Object.entries(parsedSymbols as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0)
        .map(([contract, symbol]) => [normalizeToken(contract), symbol.trim()]),
    );
  } catch {
    return {};
  }
}

export function saveTrackedTokenSymbol(token: string, symbol: string): void {
  try {
    const normalized = normalizeToken(token);
    const cleanSymbol = symbol.trim();
    if (!normalized || !cleanSymbol) return;

    const storage = readStorage();
    if (!storage) return;

    storage.setItem(
      TRACKED_TOKEN_SYMBOLS_STORAGE_KEY,
      JSON.stringify({ ...getTrackedTokenSymbols(), [normalized]: cleanSymbol }),
    );
  } catch {
    // PHASE-TS1-FIX: token symbols improve display only and must never break scanner persistence.
  }
}
