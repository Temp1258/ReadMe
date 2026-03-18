/**
 * Shared overlap deduplication for transcript segments.
 * Used by both transcription.ts (batch) and live-transcribe.ts (live).
 */

import { MIN_OVERLAP_DEDUP_WORDS, MAX_OVERLAP_DEDUP_WORDS } from '../offscreen/constants';

function normalizeWord(word: string): string {
  return word.toLowerCase().replace(/(^[^a-z0-9']+|[^a-z0-9']+$)/gi, '');
}

/**
 * Given an existing transcript and a new incoming text, remove any
 * overlapping prefix from the incoming text that already appears at the
 * end of the existing transcript.
 *
 * Uses a sliding-window approach checking 3-40 word overlap.
 */
export function removeOverlapPrefix(existing: string, incoming: string): string {
  const existingWords = existing.trim().split(/\s+/).filter(Boolean);
  const incomingWords = incoming.trim().split(/\s+/).filter(Boolean);

  if (existingWords.length === 0 || incomingWords.length === 0) {
    return incoming.trim();
  }

  const tailWords = existingWords.slice(-MAX_OVERLAP_DEDUP_WORDS).map(normalizeWord).filter(Boolean);
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
