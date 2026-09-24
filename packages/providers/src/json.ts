/**
 * A nanosecond epoch has 19 digits. Number.MAX_SAFE_INTEGER has 16, so JSON.parse loses the last
 * three digits of any ns timestamp a vendor sends as a bare JSON number — Polygon's v2 snapshot
 * and Databento's JSON encoding both do. The loss happens before Conduit sees the value, so it
 * cannot be recovered downstream; the only fix is to not parse those literals as doubles.
 *
 * Long integer literals in value position are quoted before parsing, so they arrive as strings and
 * reach BigInt intact. Everything else is left exactly as-is.
 */

/** Digits at which a decimal integer can exceed Number.MAX_SAFE_INTEGER (9007199254740991). */
const UNSAFE_DIGITS = 16;

export function parseJsonLossless(text: string): unknown {
  // Fast path: almost every frame has no long integer at all.
  if (!/\d{16}/.test(text)) return JSON.parse(text);
  return JSON.parse(quoteLongIntegers(text));
}

/**
 * Walks the document tracking string state, so digits inside a string value are never touched.
 * Floats are left alone: no price, size, or ratio has sixteen integer digits.
 */
export function quoteLongIntegers(text: string): string {
  let out = '';
  let i = 0;
  let inString = false;

  while (i < text.length) {
    const ch = text[i]!;

    if (inString) {
      if (ch === '\\') {
        out += ch + (text[i + 1] ?? '');
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let j = i;
      if (text[j] === '-') j += 1;
      const digitsStart = j;
      while (j < text.length) {
        const d = text[j]!;
        if (d < '0' || d > '9') break;
        j += 1;
      }
      const intDigits = j - digitsStart;
      const next = text[j];
      const isFloat = next === '.' || next === 'e' || next === 'E';
      const token = text.slice(i, j);
      out += !isFloat && intDigits >= UNSAFE_DIGITS ? `"${token}"` : token;
      i = j;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}
