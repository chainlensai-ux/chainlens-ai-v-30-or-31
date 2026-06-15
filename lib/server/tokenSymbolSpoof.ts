// Detects token symbols that visually mimic well-known stablecoins/blue-chips
// (e.g. via combining marks, zero-width characters, or confusable Unicode
// lookalike letters from other scripts) but are not the real asset.
//
// This is a classification-only helper: it does NOT touch provider calls,
// PnL math, or the FIFO engine. It is used to (a) exclude spoofed symbols
// from stablecoin-activity heuristics and (b) surface a warning to the UI.

const KNOWN_SYMBOLS = ['USDC', 'USDT', 'ETH', 'BTC', 'WETH', 'WBTC', 'DAI']

// Confusable-letter map: maps lookalike characters (after NFKD + diacritic
// stripping) from other scripts/blocks to their plain-Latin equivalent.
const CONFUSABLE_MAP: Record<string, string> = {
  // Cyrillic
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M',
  'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T',
  'Х': 'X',
  // Greek
  'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H',
  'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O',
  'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X',
  // Lookalike letters (e.g. small capital C used in Latin Extended)
  'ꓚ': 'C',
}

/**
 * Strip Unicode combining marks (category Mn), format/control characters
 * (category Cf/Cc, includes zero-width and bidi-control chars), and any
 * other invisible characters, after NFKD-normalizing to decompose
 * diacritics from base letters.
 */
function stripInvisibleAndCombining(input: string): string {
  const decomposed = input.normalize('NFKD')
  let out = ''
  for (const ch of decomposed) {
    // Combining marks (Mn), format chars (Cf), control chars (Cc)
    if (/[\p{Mn}\p{Cf}\p{Cc}]/u.test(ch)) continue
    out += ch
  }
  return out
}

/** Apply the confusable-letter map, char by char. */
function applyConfusableMap(input: string): string {
  let out = ''
  for (const ch of input) {
    out += CONFUSABLE_MAP[ch] ?? ch
  }
  return out
}

/** Returns the Unicode script "family" bucket for a character, or null for neutral chars. */
function scriptFamily(ch: string): 'latin' | 'cyrillic' | 'greek' | 'khmer' | 'other' | null {
  const cp = ch.codePointAt(0) ?? 0
  if (cp < 0x80) {
    // ASCII letters are Latin; digits/punctuation are neutral
    if (/[A-Za-z]/.test(ch)) return 'latin'
    return null
  }
  if (cp >= 0x0080 && cp <= 0x024F) return 'latin' // Latin Extended
  if (cp >= 0x0400 && cp <= 0x04FF) return 'cyrillic'
  if (cp >= 0x0370 && cp <= 0x03FF) return 'greek'
  if (cp >= 0x1780 && cp <= 0x17FF) return 'khmer'
  return 'other'
}

export function detectSuspiciousTokenSymbol(symbol: string): {
  suspicious: boolean
  reason?: string
  normalizedGuess?: string
} {
  if (!symbol || typeof symbol !== 'string') return { suspicious: false }

  // Plain ASCII, no weird characters at all — fast path for the common case.
  const isPlainAscii = /^[\x20-\x7E]*$/.test(symbol)
  if (isPlainAscii) {
    return { suspicious: false }
  }

  // Detect zero-width / combining / control characters present in the raw symbol.
  const hasInvisibleOrCombining = /[\p{Mn}\p{Cf}\p{Cc}]/u.test(symbol.normalize('NFKD'))

  // Detect mixed scripts (e.g. Latin + Cyrillic/Greek/Khmer/etc.)
  const families = new Set<string>()
  for (const ch of symbol) {
    const fam = scriptFamily(ch)
    if (fam) families.add(fam)
  }
  const mixedScripts = families.size > 1

  // Build a cleaned/normalized guess: strip invisible/combining chars, map
  // confusables, then uppercase.
  const cleaned = applyConfusableMap(stripInvisibleAndCombining(symbol)).toUpperCase()

  const matchedKnown = KNOWN_SYMBOLS.find((known) => cleaned === known)

  if (hasInvisibleOrCombining || mixedScripts) {
    if (matchedKnown && symbol !== matchedKnown) {
      return {
        suspicious: true,
        reason: `Symbol "${symbol}" visually resembles "${matchedKnown}" but contains ${hasInvisibleOrCombining ? 'hidden/combining characters' : 'mixed-script lookalike characters'}.`,
        normalizedGuess: matchedKnown,
      }
    }
    return {
      suspicious: true,
      reason: `Symbol "${symbol}" contains ${hasInvisibleOrCombining ? 'hidden/combining characters' : 'mixed-script characters'} that may be used to spoof a well-known token.`,
    }
  }

  // No invisible/combining/mixed-script signal — if the cleaned form matches
  // a known symbol but the raw symbol differs (e.g. diacritics on a single
  // script), still flag it.
  if (matchedKnown && symbol !== matchedKnown) {
    return {
      suspicious: true,
      reason: `Symbol "${symbol}" visually resembles "${matchedKnown}" but is not an exact match.`,
      normalizedGuess: matchedKnown,
    }
  }

  return { suspicious: false }
}
