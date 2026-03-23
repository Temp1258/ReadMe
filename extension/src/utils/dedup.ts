/**
 * Shared overlap deduplication for transcript segments.
 * Used by both transcription.ts (batch) and live-transcribe.ts (live).
 *
 * Uses character-level suffix-prefix matching after normalization,
 * which works correctly for CJK languages (no word boundaries) as
 * well as Latin/space-separated languages.
 */

/** Max normalized characters to check for overlap in the existing transcript tail. */
const MAX_OVERLAP_CHARS = 1200;

/** Min normalized characters for a valid overlap match (avoids false positives). */
const MIN_OVERLAP_CHARS = 10;

/**
 * Normalize text for overlap comparison: lowercase, remove all
 * punctuation, symbols, and whitespace so that minor formatting
 * differences don't prevent a match.
 */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[\p{P}\p{S}\s]/gu, '');
}

/**
 * Given an existing transcript and a new incoming text, remove any
 * overlapping prefix from the incoming text that already appears at the
 * end of the existing transcript.
 *
 * Works by finding the longest suffix of the normalized existing text
 * that is a prefix of the normalized incoming text, then mapping that
 * match back to the original incoming string to determine how many
 * characters to strip.
 */
export function removeOverlapPrefix(existing: string, incoming: string): string {
  if (!existing || !incoming) return incoming.trim();

  const trimmedIncoming = incoming.trim();

  const normExisting = normalize(existing);
  const normIncoming = normalize(trimmedIncoming);

  if (normExisting.length < MIN_OVERLAP_CHARS || normIncoming.length < MIN_OVERLAP_CHARS) {
    return trimmedIncoming;
  }

  // Only inspect the tail of existing up to MAX_OVERLAP_CHARS
  const tail = normExisting.length > MAX_OVERLAP_CHARS
    ? normExisting.slice(-MAX_OVERLAP_CHARS)
    : normExisting;

  // Find the longest suffix of `tail` that is a prefix of `normIncoming`.
  // Start from the longest possible and work down.
  const maxCheck = Math.min(tail.length, normIncoming.length);
  let bestMatchLen = 0;

  for (let start = tail.length - maxCheck; start <= tail.length - MIN_OVERLAP_CHARS; start++) {
    const suffix = tail.slice(start);
    if (normIncoming.startsWith(suffix)) {
      bestMatchLen = suffix.length;
      break;
    }
  }

  if (bestMatchLen === 0) return trimmedIncoming;

  // Map bestMatchLen normalized chars back to original incoming text position.
  // Iterate by code points (not code units) to correctly handle emoji and
  // other characters outside the BMP that are stored as surrogate pairs.
  const codePoints = [...trimmedIncoming]; // splits by code points
  let normCount = 0;
  let cpIdx = 0;
  let origPos = 0;
  const puncSymWs = /[\p{P}\p{S}\s]/u;
  while (normCount < bestMatchLen && cpIdx < codePoints.length) {
    const cp = codePoints[cpIdx];
    if (!puncSymWs.test(cp)) {
      normCount++;
    }
    origPos += cp.length; // 1 for BMP, 2 for surrogate pairs
    cpIdx++;
  }

  // Also skip any trailing punctuation/symbols/whitespace that sit between
  // the matched overlap and the genuinely new content.
  while (cpIdx < codePoints.length && puncSymWs.test(codePoints[cpIdx])) {
    origPos += codePoints[cpIdx].length;
    cpIdx++;
  }

  return trimmedIncoming.slice(origPos).trim();
}
