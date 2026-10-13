/** CNKI limits each request to 800 UTF-16 characters. */
export const CNKI_MAX_TEXT_LENGTH = 800;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Split without modifying any source text. In particular, decimal points,
 * formulas, questions and the final incomplete sentence are kept verbatim.
 * Prefer a sentence/whitespace boundary near the request limit; a long token
 * falls back to a hard boundary without splitting a Unicode surrogate pair.
 */
export function splitCnkiText(
  text: string,
  maxLength: number = CNKI_MAX_TEXT_LENGTH,
): string[] {
  if (!Number.isInteger(maxLength) || maxLength < 1) {
    throw new RangeError("The CNKI chunk limit must be a positive integer.");
  }

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxLength, text.length);
    if (end < text.length) {
      if (
        isHighSurrogate(text.charCodeAt(end - 1)) &&
        isLowSurrogate(text.charCodeAt(end))
      ) {
        end--;
      }
      if (end === start) {
        throw new RangeError(
          "The CNKI chunk limit is too small for a Unicode character.",
        );
      }

      const window = text.slice(start, end);
      const minimumPreferredLength = Math.floor(window.length / 2);
      let sentenceBoundary = 0;
      let whitespaceBoundary = 0;
      for (let i = 0; i < window.length; i++) {
        const current = window[i];
        const next = text[start + i + 1];
        if (/\s/u.test(current)) whitespaceBoundary = i + 1;
        if (
          /[。！？；]/u.test(current) ||
          (/[.!?;]/u.test(current) && (next === undefined || /\s/u.test(next)))
        ) {
          sentenceBoundary = i + 1;
        }
      }
      if (sentenceBoundary >= minimumPreferredLength && sentenceBoundary > 0) {
        end = start + sentenceBoundary;
      } else if (
        whitespaceBoundary >= minimumPreferredLength &&
        whitespaceBoundary > 0
      ) {
        end = start + whitespaceBoundary;
      }
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}
