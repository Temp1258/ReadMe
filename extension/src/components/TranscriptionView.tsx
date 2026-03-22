import type { AudioStatus, AudioSource, RecordingDiagnostics, DeviceOption } from '../types';
import type { TranslationKey } from '../i18n';
import { normalizeAudioSource } from '../utils/format';

type TranscriptionViewProps = {
  status: AudioStatus;
  recordingDiagnostics: RecordingDiagnostics;
  sttStatusLine: string;
  isRecordingActive: boolean;
  isAudioSourceLocked: boolean;
  isMicrophoneLocked: boolean;
  selectedSource: AudioSource;
  selectedDeviceId: string;
  devices: DeviceOption[];
  transcriptText: string;
  error: string | null;
  t: (key: TranslationKey) => string;
  onStartListening: () => void;
  onStopListening: () => void;
  onSourceChange: (source: AudioSource) => void;
  onDeviceChange: (deviceId: string) => void;
  onLearnMoreClick: () => void;
};

export function TranscriptionView({
  status,
  recordingDiagnostics,
  sttStatusLine,
  isRecordingActive,
  isAudioSourceLocked,
  isMicrophoneLocked,
  selectedSource,
  selectedDeviceId,
  devices,
  error,
  t,
  onStartListening,
  onStopListening,
  onSourceChange,
  onDeviceChange,
  onLearnMoreClick,
}: TranscriptionViewProps) {
  const { transcribedChunks, totalChunksToTranscribe } = recordingDiagnostics;
  const isTranscribing = status === 'Listening' || status === 'Transcribing';
  const hasProgress = totalChunksToTranscribe > 0;
  const progressPct = hasProgress
    ? Math.min(100, (transcribedChunks / totalChunksToTranscribe) * 100)
    : 0;

  return (
    <section className="transcription-view">
      <section className="status-card" aria-label={t('status')}>
        <div className="status-card__header">
          <div className="status-pill">
            <span className={`status-dot status-dot--${status.toLowerCase()}`} aria-hidden="true" />
            <p className="status-pill__label">{t('status')}</p>
            <p className="status-pill__value">{status}</p>
          </div>
          <p className="status-card__provider">{sttStatusLine}</p>
        </div>
        <div className="status-metrics" role="list" aria-label="Recording diagnostics">
          <p className="status-metrics__item" role="listitem">
            <span className="status-metrics__label">Duration</span>
            <span className="status-metrics__value">{recordingDiagnostics.durationLabel}</span>
          </p>
          <p className="status-metrics__item" role="listitem">
            <span className="status-metrics__label">Size</span>
            <span className="status-metrics__value">{recordingDiagnostics.totalMB.toFixed(2)} MB</span>
          </p>
          <p className="status-metrics__item" role="listitem">
            <span className="status-metrics__label">Rate</span>
            <span className="status-metrics__value">{recordingDiagnostics.mbPerMin.toFixed(2)} MB/min</span>
          </p>
          <p className="status-metrics__item" role="listitem">
            <span className="status-metrics__label">Chunks</span>
            <span className="status-metrics__value">
              {transcribedChunks} / {totalChunksToTranscribe}
            </span>
          </p>
        </div>
      </section>

      <section className="action-card">
        {!isRecordingActive ? (
          <button className="button button--primary action-card__button" onClick={onStartListening} type="button">
            {t('start')}
          </button>
        ) : (
          <button className="button button--primary action-card__button" onClick={onStopListening} type="button">
            {t('stop')}
          </button>
        )}

        <div className="warning-inline warning-inline--compact">
          <p>
            {t('warningOneLine')}
            <button className="link-button" onClick={onLearnMoreClick} type="button">
              {t('learnMore')}
            </button>
          </p>
        </div>
      </section>

      <section className="inputs-section">
        <div className="inputs-section__header">
          <p className="section-label">{t('inputs')}</p>
        </div>
        <div className="source-grid">
          <div className="field-group">
            <label className="form__label" htmlFor="audio-source">
              {t('source')}
            </label>
            <select
              className="form__input"
              disabled={isAudioSourceLocked}
              id="audio-source"
              onChange={(event) =>
                onSourceChange(normalizeAudioSource(event.target.value))
              }
              value={selectedSource}
            >
              <option value="mic">{t('sourceMic')}</option>
              <option value="tab">{t('sourceTab')}</option>
              <option value="mix">{t('sourceMix')}</option>
            </select>
            {isAudioSourceLocked ? <p className="field-hint">{t('sourceLocked')}</p> : null}
          </div>

          <div className="field-group">
            <label className="form__label" htmlFor="microphone-device">
              {t('microphone')}
            </label>
            <select
              className="form__input"
              disabled={isMicrophoneLocked}
              id="microphone-device"
              onChange={(event) => onDeviceChange(event.target.value)}
              value={selectedDeviceId}
            >
              {devices.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.id === 'default' ? t('systemDefaultMic') : device.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>

      {error && <p className="error">{error}</p>}

      <section className="transcript-progress-panel">
        <div className="transcript-progress-panel__header">
          <h2>{t('transcriptionProgress')}</h2>
          <span className={`status-indicator status-indicator--${status.toLowerCase()}`}>{status}</span>
        </div>
        <div className="transcript-progress-bar">
          <div
            className={`transcript-progress-bar__fill ${isTranscribing && hasProgress ? 'transcript-progress-bar__fill--active' : ''}`}
            style={{ width: `${progressPct}%` }}
          />
        </div>
        <div className="transcript-progress-bar__info">
          {hasProgress ? (
            <span>{transcribedChunks} / {totalChunksToTranscribe} chunks ({Math.round(progressPct)}%)</span>
          ) : (
            <span>{status === 'Idle' ? t('transcriptEmpty') : t('liveTranscribing')}</span>
          )}
        </div>
      </section>
    </section>
  );
}
