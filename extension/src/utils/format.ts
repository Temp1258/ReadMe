import type { SessionRecord } from '../db/indexeddb';

export function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

export function formatDuration(startedAt: number, endedAt?: number): string | null {
  if (!endedAt || endedAt <= startedAt) {
    return null;
  }

  const totalSeconds = Math.floor((endedAt - startedAt) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

export function formatFileTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

export function formatExportDuration(startedAt: number, endedAt?: number): string {
  if (!endedAt || endedAt <= startedAt) {
    return 'in-progress';
  }

  const totalMs = endedAt - startedAt;
  const human = formatDuration(startedAt, endedAt);
  return human ? `${human} (${totalMs}ms)` : `${totalMs}ms`;
}

export function formatOffsetLabel(offsetMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(offsetMs / 1000));
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function normalizeAudioSource(source?: string): 'mic' | 'tab' | 'mix' {
  return source === 'tab' || source === 'mix' ? source : 'mic';
}

export function isRecordingActiveStatus(status: string): boolean {
  return status !== 'Idle' && status !== 'Stopped' && status !== 'Error';
}

export function getExportFileName(session: SessionRecord, extension: string): string {
  const safeSource = session.source.replace(/[^a-z0-9_-]/gi, '_');
  const timestamp = formatFileTimestamp(session.startedAt);
  return `readme_${safeSource}_${timestamp}.${extension}`;
}
