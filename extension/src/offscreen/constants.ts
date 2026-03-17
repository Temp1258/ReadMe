export const CHUNK_TIMESLICE_MS = 30_000;
export const CHUNK_MIN_BYTES = 1_024;
export const MAX_SEGMENT_BYTES = 19 * 1024 * 1024;
export const HARD_MAX_SEGMENT_BYTES = 24 * 1024 * 1024;
export const TARGET_SEGMENT_DURATION_MS = 20 * 60 * 1000;
export const SEGMENT_TRANSCRIPT_OVERLAP_MS = 5_000;
export const MIN_OVERLAP_DEDUP_WORDS = 3;
export const MAX_OVERLAP_DEDUP_WORDS = 40;
export const TRANSCRIBE_MAX_RETRIES = 3;
export const TRANSCRIBE_INITIAL_BACKOFF_MS = 500;

/** Number of chunks to accumulate before triggering live transcription (2 chunks = ~60s) */
export const LIVE_TRANSCRIBE_CHUNK_COUNT = 2;
