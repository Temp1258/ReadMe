import { useMemo } from 'react';
import type { SessionRecord } from '../db/indexeddb';
import type { TranslationKey } from '../i18n';
import { formatTimestamp, formatDuration } from '../utils/format';

type NotesViewProps = {
  sessions: SessionRecord[];
  selectedSessionId: string | null;
  loading: boolean;
  error: string | null;
  search: string;
  exportToast: string | null;
  t: (key: TranslationKey) => string;
  onRefresh: () => void;
  onClearData: () => void;
  onSearchChange: (value: string) => void;
  onSelectSession: (id: string) => void;
  onExport: (format: 'txt' | 'md') => void;
};

export function NotesView({
  sessions,
  selectedSessionId,
  loading,
  error,
  search,
  exportToast,
  t,
  onRefresh,
  onClearData,
  onSearchChange,
  onSelectSession,
  onExport,
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
                <div className="notes-detail__export-row" aria-label={t('export')}>
                  <span className="notes-detail__export-label">{t('export')}</span>
                  <button className="notes-detail__export-link" onClick={() => onExport('txt')} type="button">
                    .txt
                  </button>
                  <button className="notes-detail__export-link" onClick={() => onExport('md')} type="button">
                    .md
                  </button>
                </div>
              </div>
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
