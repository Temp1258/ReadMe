import { FormEvent, useEffect, useState } from 'react';
import React from 'react';
import ReactDOM from 'react-dom/client';
import {
  defaults,
  getSttCredentialSummary,
  loadSettings,
  loadSttSettings,
  maskSecret,
  saveSettings,
  saveSttSettings,
  type DefaultSource,
  type SttProvider,
} from './settings';
import './options.css';

function parseDefaultSourceInput(source: string): DefaultSource {
  return source === 'tab' || source === 'mix' ? source : 'microphone';
}

function OptionsPage() {
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [deepgramKeyInput, setDeepgramKeyInput] = useState('');
  const [siliconflowKeyInput, setSiliconflowKeyInput] = useState('');
  const [selectedProvider, setSelectedProvider] = useState<SttProvider>('mock');
  const [storedApiKey, setStoredApiKey] = useState('');
  const [storedDeepgramKey, setStoredDeepgramKey] = useState('');
  const [storedSiliconflowKey, setStoredSiliconflowKey] = useState('');
  const [defaultSource, setDefaultSource] = useState<DefaultSource>(defaults.defaultSource);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [sttDiagnostics, setSttDiagnostics] = useState<Awaited<ReturnType<typeof getSttCredentialSummary>> | null>(null);

  const refreshSttDiagnostics = async () => {
    const summary = await getSttCredentialSummary();
    setSttDiagnostics(summary);
  };

  useEffect(() => {
    Promise.all([loadSettings(), loadSttSettings(), getSttCredentialSummary()]).then(([settings, stt, summary]) => {
      setStoredApiKey(stt.apiKey?.trim() ?? '');
      setStoredDeepgramKey(settings.stt.deepgramApiKey?.trim() ?? '');
      setStoredSiliconflowKey(settings.stt.siliconflowApiKey?.trim() ?? '');
      setSelectedProvider(settings.stt.provider);
      setDefaultSource(settings.defaultSource ?? defaults.defaultSource);
      setSttDiagnostics(summary);
    });
  }, []);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setStatusMessage(null);

    const trimmedKey = apiKeyInput.trim();
    const trimmedDeepgramKey = deepgramKeyInput.trim();
    const trimmedSiliconflowKey = siliconflowKeyInput.trim();

    if (apiKeyInput.length > 0 && trimmedKey.length === 0) {
      setError('API key cannot be only whitespace.');
      return;
    }

    setIsSaving(true);

    try {
      const previousSettings = await loadSettings();

      const nextStt = {
        ...previousSettings.stt,
        provider: selectedProvider,
        ...(trimmedKey ? { apiKey: trimmedKey } : {}),
        ...(trimmedDeepgramKey ? { deepgramApiKey: trimmedDeepgramKey } : {}),
        ...(trimmedSiliconflowKey ? { siliconflowApiKey: trimmedSiliconflowKey } : {}),
      };

      await saveSettings({
        ...previousSettings,
        defaultSource,
        stt: nextStt,
      });

      const updatedStt = await loadSttSettings();
      setStoredApiKey(updatedStt.apiKey?.trim() ?? '');
      const updatedSettings = await loadSettings();
      setStoredDeepgramKey(updatedSettings.stt.deepgramApiKey?.trim() ?? '');
      setStoredSiliconflowKey(updatedSettings.stt.siliconflowApiKey?.trim() ?? '');
      setApiKeyInput('');
      setDeepgramKeyInput('');
      setSiliconflowKeyInput('');
      await refreshSttDiagnostics();
      setStatusMessage('Settings saved.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save settings.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleClearApiKey = async () => {
    setError(null);
    setStatusMessage(null);
    setIsSaving(true);

    try {
      await saveSttSettings({ provider: 'mock' });
      const currentSettings = await loadSettings();
      await saveSettings({ ...currentSettings, defaultSource });
      setStoredApiKey('');
      setStoredDeepgramKey('');
      setStoredSiliconflowKey('');
      setApiKeyInput('');
      setDeepgramKeyInput('');
      setSiliconflowKeyInput('');
      setSelectedProvider('mock');
      await refreshSttDiagnostics();
      setStatusMessage('API keys cleared.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to clear API key.');
    } finally {
      setIsSaving(false);
    }
  };

  const openaiKeySummary = storedApiKey ? `Configured (${maskSecret(storedApiKey)})` : 'Not configured';
  const deepgramKeySummary = storedDeepgramKey ? `Configured (${maskSecret(storedDeepgramKey)})` : 'Not configured';
  const siliconflowKeySummary = storedSiliconflowKey ? `Configured (${maskSecret(storedSiliconflowKey)})` : 'Not configured';

  const hasAnyKey = Boolean(storedApiKey || storedDeepgramKey || storedSiliconflowKey);

  return (
    <div className="opt-page">
      <header className="opt-header">
        <h1 className="opt-title">Settings</h1>
        <p className="opt-subtitle">Manage your ReadMe preferences</p>
      </header>

      <form className="opt-form" onSubmit={handleSubmit}>
        {/* Provider card */}
        <section className="opt-card">
          <h2 className="opt-card__heading">Provider</h2>
          <div className="opt-row">
            <div className="opt-row__label">
              <span className="opt-row__title">STT Provider</span>
              <span className="opt-row__hint">Speech-to-text service</span>
            </div>
            <select
              className="opt-select"
              id="stt-provider"
              onChange={(event) => setSelectedProvider(event.target.value as SttProvider)}
              value={selectedProvider}
            >
              <option value="openai">OpenAI Whisper</option>
              <option value="deepgram">Deepgram Nova-2</option>
              <option value="siliconflow">SiliconFlow</option>
              <option value="mock">Mock (offline)</option>
            </select>
          </div>
        </section>

        {/* API Key card */}
        {selectedProvider !== 'mock' && (
          <section className="opt-card">
            <h2 className="opt-card__heading">API Key</h2>

            {selectedProvider === 'openai' && (
              <>
                <div className="opt-row">
                  <div className="opt-row__label">
                    <span className="opt-row__title">Status</span>
                  </div>
                  <span className={`opt-badge ${storedApiKey ? 'opt-badge--ok' : 'opt-badge--none'}`}>
                    {openaiKeySummary}
                  </span>
                </div>
                <div className="opt-row opt-row--stacked">
                  <label className="opt-row__title" htmlFor="whisper-api-key">
                    OpenAI API Key
                  </label>
                  <input
                    className="opt-input"
                    id="whisper-api-key"
                    onChange={(event) => setApiKeyInput(event.target.value)}
                    placeholder="sk-..."
                    type="password"
                    value={apiKeyInput}
                  />
                </div>
              </>
            )}

            {selectedProvider === 'deepgram' && (
              <>
                <div className="opt-row">
                  <div className="opt-row__label">
                    <span className="opt-row__title">Status</span>
                  </div>
                  <span className={`opt-badge ${storedDeepgramKey ? 'opt-badge--ok' : 'opt-badge--none'}`}>
                    {deepgramKeySummary}
                  </span>
                </div>
                <div className="opt-row opt-row--stacked">
                  <label className="opt-row__title" htmlFor="deepgram-api-key">
                    Deepgram API Key
                  </label>
                  <input
                    className="opt-input"
                    id="deepgram-api-key"
                    onChange={(event) => setDeepgramKeyInput(event.target.value)}
                    placeholder="dg-..."
                    type="password"
                    value={deepgramKeyInput}
                  />
                </div>
              </>
            )}

            {selectedProvider === 'siliconflow' && (
              <>
                <div className="opt-row">
                  <div className="opt-row__label">
                    <span className="opt-row__title">Status</span>
                  </div>
                  <span className={`opt-badge ${storedSiliconflowKey ? 'opt-badge--ok' : 'opt-badge--none'}`}>
                    {siliconflowKeySummary}
                  </span>
                </div>
                <div className="opt-row opt-row--stacked">
                  <label className="opt-row__title" htmlFor="siliconflow-api-key">
                    SiliconFlow API Key
                  </label>
                  <input
                    className="opt-input"
                    id="siliconflow-api-key"
                    onChange={(event) => setSiliconflowKeyInput(event.target.value)}
                    placeholder="sk-..."
                    type="password"
                    value={siliconflowKeyInput}
                  />
                </div>
              </>
            )}
          </section>
        )}

        {/* Audio card */}
        <section className="opt-card">
          <h2 className="opt-card__heading">Audio</h2>
          <div className="opt-row">
            <div className="opt-row__label">
              <span className="opt-row__title">Default source</span>
              <span className="opt-row__hint">Microphone for voice, Tab for playback, Mix for both</span>
            </div>
            <select
              className="opt-select"
              id="default-source"
              onChange={(event) => setDefaultSource(parseDefaultSourceInput(event.target.value))}
              value={defaultSource}
            >
              <option value="microphone">Microphone</option>
              <option value="tab">Tab audio</option>
              <option value="mix">Mix (tab + mic)</option>
            </select>
          </div>
        </section>

        {/* Actions */}
        <div className="opt-actions">
          <button className="opt-btn opt-btn--primary" disabled={isSaving} type="submit">
            {isSaving ? 'Saving...' : 'Save'}
          </button>
          <button
            className="opt-btn opt-btn--danger"
            disabled={isSaving || !hasAnyKey}
            onClick={handleClearApiKey}
            type="button"
          >
            Clear API Keys
          </button>
        </div>

        {statusMessage && <p className="opt-toast opt-toast--success">{statusMessage}</p>}
        {error && <p className="opt-toast opt-toast--error">{error}</p>}
      </form>

      {/* Diagnostics */}
      <details className="opt-card opt-card--details">
        <summary className="opt-card__heading opt-card__summary">Diagnostics</summary>
        <div className="opt-diag">
          <div className="opt-diag__row">
            <span className="opt-diag__label">Provider</span>
            <span className="opt-diag__value">{sttDiagnostics?.provider ?? 'unknown'}</span>
          </div>
          <div className="opt-diag__row">
            <span className="opt-diag__label">Configured</span>
            <span className="opt-diag__value">{sttDiagnostics?.configured ? 'Yes' : 'No'}</span>
          </div>
          <div className="opt-diag__row">
            <span className="opt-diag__label">Key (last 4)</span>
            <span className="opt-diag__value">{sttDiagnostics?.last4 ?? '—'}</span>
          </div>
          <div className="opt-diag__row">
            <span className="opt-diag__label">Backend</span>
            <span className="opt-diag__value">{sttDiagnostics?.backend ?? 'unknown'}</span>
          </div>
        </div>
      </details>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <OptionsPage />
  </React.StrictMode>,
);
