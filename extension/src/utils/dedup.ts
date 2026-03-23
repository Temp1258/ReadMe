/**
 * Shared overlap deduplication for transcript segments.
 * Used by both transcription.ts (batch) and live-transcribe.ts (live).
 */

import { MIN_OVERLAP_DEDUP_WORDS, MAX_OVERLAP_DEDUP_WORDS } from '../offscreen/constants';

function normalizeWord(word: string): string {
  return word.toLowerCase().replace(/(^[^a-z0-9']+|[^a-z0-9']+$)/gi, '');
}

/**
 * Extract the last N whitespace-separated words from a string without
 * splitting the entire string.  This avoids O(n) work on a transcript
 * that can grow to 100 KB+ during a 2-hour recording.
 */
function lastNWords(text: string, n: number): string[] {
  const words: string[] = [];
  let end = text.length;

  while (words.length < n && end > 0) {
    // Skip trailing whitespace
    while (end > 0 && /\s/.test(text[end - 1])) end--;
    if (end === 0) break;

    // Find start of current word
    let start = end;
    while (start > 0 && !/\s/.test(text[start - 1])) start--;

    words.push(text.slice(start, end));
    end = start;
  }

  words.reverse();
  return words;
}

/**
 * Given an existing transcript and a new incoming text, remove any
 * overlapping prefix from the incoming text that already appears at the
 * end of the existing transcript.
 *
 * Uses a sliding-window approach checking 3-40 word overlap.
 */
export function removeOverlapPrefix(existing: string, incoming: string): string {
  if (!existing || !incoming) return incoming.trim();

  // Only extract the tail we actually need — O(MAX_OVERLAP_DEDUP_WORDS), not O(transcript length)
  const tailWords = lastNWords(existing, MAX_OVERLAP_DEDUP_WORDS).map(normalizeWord).filter(Boolean);
  const incomingWords = incoming.trim().split(/\s+/).filter(Boolean);

  if (tailWords.length === 0 || incomingWords.length === 0) {
    return incoming.trim();
  }

  const headWords = incomingWords.map(normalizeWord).filter(Boolean);
  const maxOverlap = Math.min(tailWords.length, headWords.length, MAX_OVERLAP_DEDUP_WORDS);

  for (let size = maxOverlap; size >= MIN_OVERLAP_DEDUP_WORDS; size--) {
    const suffix = tailWords.slice(-size);
    const prefix = headWords.slice(0, size);
    if (suffix.every((w, i) => w === prefix[i])) {
      return incomingWords.slice(size).join(' ').trim();
    }
  }

  return incoming.trim();
}
