import type { SessionRecord } from '../db/indexeddb';
import { formatTimestamp, formatExportDuration, formatOffsetLabel } from './format';

function buildSessionMetadataLines(session: SessionRecord): string[] {
  return [
    `id: ${session.id}`,
    `source: ${session.source}`,
    `status: ${session.status}`,
    `startedAt: ${formatTimestamp(session.startedAt)} (${session.startedAt})`,
    `endedAt: ${session.endedAt ? `${formatTimestamp(session.endedAt)} (${session.endedAt})` : 'n/a'}`,
    `duration: ${formatExportDuration(session.startedAt, session.endedAt)}`,
  ];
}

export function buildTxtExport(session: SessionRecord): string {
  const metadata = buildSessionMetadataLines(session).join('\n');
  const transcript = session.transcript || '(empty)';
  const segments =
    session.segments.length === 0
      ? '(none)'
      : session.segments
          .map((segment) => {
            const hasTiming = typeof segment.startOffsetMs === 'number' && typeof segment.endOffsetMs === 'number';
            const timingLabel = hasTiming
              ? `${formatOffsetLabel(segment.startOffsetMs ?? 0)} - ${formatOffsetLabel(segment.endOffsetMs ?? 0)}`
              : String(segment.ts);
            return `[Segment ${segment.idx} | ${timingLabel}]\n${segment.text}`;
          })
          .join('\n\n');

  return [`Session Metadata`, metadata, '', 'Transcript', transcript, '', 'Segments', segments].join('\n');
}

export function buildMarkdownExport(session: SessionRecord): string {
  const metadataLines = buildSessionMetadataLines(session).map((line) => `- ${line}`).join('\n');
  const transcript = session.transcript || '(empty)';
  const segments =
    session.segments.length === 0
      ? '- (none)'
      : session.segments.map((segment) => `- idx: ${segment.idx}, ts: ${segment.ts}, text: ${segment.text}`).join('\n');

  return [
    '# ReadMe Session Export',
    '',
    '## Metadata',
    metadataLines,
    '',
    '## Transcript',
    '',
    '```text',
    transcript,
    '```',
    '',
    '## Segments',
    segments,
  ].join('\n');
}

function formatSrtTimestamp(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const millis = Math.floor(ms % 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

export function buildSrtExport(session: SessionRecord): string {
  if (session.segments.length === 0) {
    return '';
  }

  return session.segments
    .filter((seg) => typeof seg.startOffsetMs === 'number' && typeof seg.endOffsetMs === 'number')
    .map((seg, index) => {
      const start = formatSrtTimestamp(seg.startOffsetMs ?? 0);
      const end = formatSrtTimestamp(seg.endOffsetMs ?? 0);
      return `${index + 1}\n${start} --> ${end}\n${seg.text}`;
    })
    .join('\n\n');
}

export async function downloadTextFile(filename: string, mimeType: string, content: string): Promise<void> {
  const blob = new Blob([content], { type: mimeType });
  const objectUrl = URL.createObjectURL(blob);

  try {
    const downloads = typeof chrome !== 'undefined' ? chrome.downloads : undefined;
    if (downloads?.download) {
      await new Promise<void>((resolve, reject) => {
        downloads.download({ url: objectUrl, filename, saveAs: true }, () => {
          const runtimeError = typeof chrome !== 'undefined' ? chrome.runtime?.lastError : undefined;
          if (runtimeError) {
            reject(new Error(runtimeError.message));
            return;
          }

          resolve();
        });
      });

      return;
    }

    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  }
}
