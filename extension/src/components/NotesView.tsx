import { useMemo } from 'react';
import type { SessionRecord, SessionAiSummary } from '../db/indexeddb';
import type { TranslationKey } from '../i18n';
import { formatTimestamp, formatDuration } from '../utils/format';
import { AudioPlayer } from './AudioPlayer';

type NotesViewProps = {
  sessions: SessionRecord[];
  selectedSessionId: string | null;
  loading: boolean;
  error: string | null;
  search: string;
  exportToast: string | null;
  summaryLoading: boolean;
  t: (key: TranslationKey) => string;
  onRefresh: () => void;
  onClearData: () => void;
  onSearchChange: (value: string) => void;
  onSelectSession: (id: string) => void;
  onExport: (format: 'txt' | 'md') => void;
  onSummarize: (sessionId: string) => void;
};

function AiSummaryPanel({ summary, t }: { summary: SessionAiSummary; t: (key: TranslationKey) => string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px', background: 'var(--surfaceAlt)', borderRadius: '8px' }}>
      <h3 style={{ fontSize: '13px', margin: 0 }}>{t('aiSummary')}</h3>
      <p style={{ fontSize: '13px', color: 'var(--text)', margin: 0, lineHeight: 1.5 }}>{summary.summary}</p>

      {summary.keyPoints.length > 0 && (
        <>
          <h3 style={{ fontSize: '12px', margin: 0, color: 'var(--muted)' }}>{t('keyPoints')}</h3>
          <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '12px', lineHeight: 1.6 }}>
            {summary.keyPoints.map((point, i) => (
              <li key={i}>{point}</li>
            ))}
          </ul>
        </>
      )}

      {summary.actionItems.length > 0 ? (
        <>
          <h3 style={{ fontSize: '12px', margin: 0, color: 'var(--muted)' }}>{t('actionItemsLabel')}</h3>
          <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '12px', lineHeight: 1.6 }}>
            {summary.actionItems.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </>
      ) : (
        <p style={{ fontSize: '11px', color: 'var(--muted)', margin: 0 }}>{t('noActionItems')}</p>
      )}
    </div>
  );
}

export function NotesView({
  sessions,
  selectedSessionId,
  loading,
  error,
  search,
  exportToast,
  summaryLoading,
  t,
  onRefresh,
  onClearData,
  onSearchChange,
  onSelectSession,
  onExport,
  onSummarize,
}: NotesViewProps) {
  const filteredSessions = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) {
      return sessions;
    }

    return sessions.filter((session) => session.transcript.toLowerCase().includes(query));
  }, [search, sessions]);

  const selectedSession = useMemo(() => {
    if (!selectedSessionId) {
      return filteredSessions[0] ?? null;
    }

    return filteredSessions.find((session) => session.id === selectedSessionId) ?? filteredSessions[0] ?? null;
  }, [filteredSessions, selectedSessionId]);

  return (
    <section className="notes-view">
      <div className="notes__toolbar">
        <h2>{t('notesTitle')}</h2>
        <div className="notes__toolbar-actions">
          <button className="button button--tertiary" onClick={onRefresh} type="button">
            {t('refresh')}
          </button>
          <button className="button button--tertiary button--danger" onClick={onClearData} type="button">
            {t('clearData')}
          </button>
        </div>
      </div>

      <label className="form__label" htmlFor="notes-search">
        {t('searchTranscript')}
      </label>
      <input
        className="form__input"
        id="notes-search"
        onChange={(event) => onSearchChange(event.target.value)}
        placeholder={t('searchPlaceholder')}
        type="search"
        value={search}
      />

      {error ? <p className="error">{error}</p> : null}
      {loading ? <p className="panel__body">{t('loadingSessions')}</p> : null}

      <div className="notes-layout">
        <div className="notes-list" role="list">
          {!filteredSessions.length ? <p className="panel__body">{t('noSessions')}</p> : null}
          {filteredSessions.map((session, index) => {
            const duration = formatDuration(session.startedAt, session.endedAt);

            return (
              <button
                aria-pressed={selectedSession?.id === session.id}
                className={`notes-list__item ${selectedSession?.id === session.id ? 'notes-list__item--active' : ''}`}
                key={session.id}
                onClick={() => onSelectSession(session.id)}
                type="button"
              >
                <div className="notes-list__title-row">
                  <p className="notes-list__time">{formatTimestamp(session.startedAt)}</p>
                  <span className={`status-indicator status-indicator--${session.status}`}>{session.status}</span>
                </div>
                <p className="notes-list__meta">
                  Transcript #{index + 1}
                  {session.aiSummary ? ' • AI' : ''}
                </p>
                <p className="notes-list__meta">
                  {session.source}
                  {duration ? ` • ${duration}` : ''}
                </p>
              </button>
            );
          })}
        </div>

        <div className="notes-detail">
          {!selectedSession ? (
            <p className="panel__body">{t('selectSession')}</p>
          ) : (
            <>
              <div className="notes-detail__header">
                <h3 className="notes-detail__title">{t('transcriptTitle')}</h3>
                <div className="notes-detail__actions">
                  <div className="notes-detail__export-row" aria-label={t('export')}>
                    <span className="notes-detail__export-label">{t('export')}</span>
                    <button className="notes-detail__export-link" onClick={() => onExport('txt')} type="button">
                      .txt
                    </button>
                    <button className="notes-detail__export-link" onClick={() => onExport('md')} type="button">
                      .md
                    </button>
                  </div>
                  {selectedSession.transcript && !selectedSession.aiSummary && (
                    <button
                      className="button button--secondary button--mini"
                      onClick={() => onSummarize(selectedSession.id)}
                      disabled={summaryLoading}
                      type="button"
                    >
                      {summaryLoading ? t('summarizing') : t('summarize')}
                    </button>
                  )}
                </div>
              </div>

              <AudioPlayer sessionId={selectedSession.id} t={t} />

              {selectedSession.aiSummary && (
                <AiSummaryPanel summary={selectedSession.aiSummary} t={t} />
              )}

              <div className="transcript notes-detail__transcript">
                {selectedSession.transcript ? (
                  <p className="transcript__line transcript__line--preserve">{selectedSession.transcript}</p>
                ) : (
                  <p className="transcript__line transcript__line--muted">{t('noTranscriptYet')}</p>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {exportToast ? <p className="toast">{exportToast}</p> : null}
    </section>
  );
}
