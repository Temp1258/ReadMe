/**
 * Measures the actual audio duration of a Blob by decoding it with OfflineAudioContext.
 * Returns duration in milliseconds, or null if decoding fails.
 */
export async function getAudioDurationMs(blob: Blob): Promise<number | null> {
  if (blob.size === 0) return null;

  try {
    const arrayBuffer = await blob.arrayBuffer();
    const context = new OfflineAudioContext(1, 1, 44100);
    const audioBuffer = await context.decodeAudioData(arrayBuffer);
    const durationMs = Math.round(audioBuffer.duration * 1000);
    return durationMs > 0 ? durationMs : null;
  } catch {
    return null;
  }
}
