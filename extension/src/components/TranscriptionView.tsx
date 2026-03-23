import { useEffect, useState } from 'react';
import type { AudioStatus, AudioSource, RecordingDiagnostics, DeviceOption } from '../types';
import type { TranslationKey } from '../i18n';
import { loadSettings, type SttProvider } from '../settings';
import { normalizeAudioSource } from '../utils/format';

const providerLabelMap: Record<SttProvider, string> = {
  openai: 'OpenAI Whisper',
  deepgram: 'Deepgram Nova-2',
  siliconflow: 'SiliconFlow',
  mock: 'Mock',
};

type TranscriptionViewProps = {
  status: AudioStatus;
  recordingDiagnostics: RecordingDiagnostics;
  isRecordingActive: boolean;
  isAudioSourceLocked: boolean;
  isMicrophoneLocked: boolean;
  selectedSource: AudioSource;
  selectedDeviceId: string;
  devices: DeviceOption[];
  error: string | null;
  warning: string | null;
  recordingTabTitle: string | null;
  t: (key: TranslationKey) => string;
  onStartListening: () => void;
  onStopListening: () => void;
  onSourceChange: (source: AudioSource) => void;
  onDeviceChange: (deviceId: string) => void;

};

export function TranscriptionView({
  status,
  recordingDiagnostics,
  isRecordingActive,
  isAudioSourceLocked,
  isMicrophoneLocked,
  selectedSource,
  selectedDeviceId,
  devices,
  error,
  warning,
  recordingTabTitle,
  t,
  onStartListening,
  onStopListening,
  onSourceChange,
  onDeviceChange,

}: TranscriptionViewProps) {
  const [providerLabel, setProviderLabel] = useState('Mock');
  const [providerConfigured, setProviderConfigured] = useState(false);

  useEffect(() => {
    loadSettings().then((settings) => {
      const p = settings.stt.provider;
      setProviderLabel(providerLabelMap[p]);
      if (p === 'openai') setProviderConfigured(Boolean(settings.stt.apiKey?.trim()));
      else if (p === 'deepgram') setProviderConfigured(Boolean(settings.stt.deepgramApiKey?.trim()));
      else if (p === 'siliconflow') setProviderConfigured(Boolean(settings.stt.siliconflowApiKey?.trim()));
      else setProviderConfigured(false);
    });
  }, []);

  const isTranscribing = status === 'Listening' || status === 'Transcribing';

  // Build the recording source label for the bottom panel
  const sourceLabel = (() => {
    if (selectedSource === 'tab' || selectedSource === 'mix') {
      return recordingTabTitle || t('sourceTab');
    }
    return t('sourceMic');
  })();

  return (
    <section className="transcription-view">
      <section className="status-card" aria-label={t('status')}>
        <div className="status-card__header">
          <div className="status-pill">
            <span className={`status-dot status-dot--${status.toLowerCase()}`} aria-hidden="true" />
            <p className="status-pill__label">{t('status')}</p>
            <p className="status-pill__value">{status}</p>
          </div>
          <p className="status-card__provider">{providerLabel} · {providerConfigured ? t('configured') : t('notConfigured')}</p>
        </div>
        <div className="status-metrics" role="list" aria-label={t('status')}>
          <p className="status-metrics__item" role="listitem">
            <span className="status-metrics__label">{t('metricDuration')}</span>
            <span className="status-metrics__value">{recordingDiagnostics.durationLabel}</span>
          </p>
          <p className="status-metrics__item" role="listitem">
            <span className="status-metrics__label">{t('metricSize')}</span>
            <span className="status-metrics__value">{recordingDiagnostics.totalMB.toFixed(2)} MB</span>
          </p>
          <p className="status-metrics__item" role="listitem">
            <span className="status-metrics__label">{t('metricRate')}</span>
            <span className="status-metrics__value">{recordingDiagnostics.mbPerMin.toFixed(2)} MB/min</span>
          </p>
          <p className="status-metrics__item" role="listitem">
            <span className="status-metrics__label">{t('metricChunks')}</span>
            <span className="status-metrics__value">
              {recordingDiagnostics.transcribedChunks} / {recordingDiagnostics.totalChunksToTranscribe}
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

      {warning && <p className="notice">{warning}</p>}
      {error && <p className="error">{error}</p>}

      <section className="transcript-progress-panel">
        <div className="transcript-progress-panel__header">
          <h2>{t('recordingSource')}</h2>
          <span className={`status-indicator status-indicator--${status.toLowerCase()}`}>{status}</span>
        </div>
        <p className="recording-source-label">{isTranscribing ? sourceLabel : t('notRecording')}</p>
      </section>
    </section>
  );
}
