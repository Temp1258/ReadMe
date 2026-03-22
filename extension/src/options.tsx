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
import './styles.css';

function formatDetectedSource(
  diagnostics: Awaited<ReturnType<typeof getSttCredentialSummary>> | null,
): string {
  if (!diagnostics) {
    return 'unknown';
  }

  const label = diagnostics.detectedFrom === 'settings.stt.apiKey' ? 'settings.stt.apiKey (canonical)' : 'none';
  return diagnostics.last4 ? `${label} · last4=${diagnostics.last4}` : label;
}

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
      setError('Whisper API key cannot be only whitespace.');
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

  return (
    <main className="popup options-page">
      <header className="popup__header">
        <h1>ReadMe Settings</h1>
      </header>

      <section className="panel">
        <form className="form" onSubmit={handleSubmit}>
          <label className="form__label" htmlFor="stt-provider">
            STT Provider
          </label>
          <select
            className="form__input"
            id="stt-provider"
            onChange={(event) => setSelectedProvider(event.target.value as SttProvider)}
            value={selectedProvider}
          >
            <option value="openai">OpenAI Whisper</option>
            <option value="deepgram">Deepgram Nova-2</option>
            <option value="siliconflow">SiliconFlow</option>
            <option value="mock">Mock (offline testing)</option>
          </select>

          {selectedProvider === 'openai' && (
            <>
              <label className="form__label" htmlFor="whisper-api-key-status">
                Whisper API Key status
              </label>
              <input className="form__input" id="whisper-api-key-status" readOnly type="text" value={openaiKeySummary} />

              <label className="form__label" htmlFor="whisper-api-key">
                New Whisper API Key (optional)
              </label>
              <input
                className="form__input"
                id="whisper-api-key"
                onChange={(event) => setApiKeyInput(event.target.value)}
                placeholder="sk-..."
                type="password"
                value={apiKeyInput}
              />
            </>
          )}

          {selectedProvider === 'deepgram' && (
            <>
              <label className="form__label" htmlFor="deepgram-api-key-status">
                Deepgram API Key status
              </label>
              <input className="form__input" id="deepgram-api-key-status" readOnly type="text" value={deepgramKeySummary} />

              <label className="form__label" htmlFor="deepgram-api-key">
                New Deepgram API Key (optional)
              </label>
              <input
                className="form__input"
                id="deepgram-api-key"
                onChange={(event) => setDeepgramKeyInput(event.target.value)}
                placeholder="dg-..."
                type="password"
                value={deepgramKeyInput}
              />
            </>
          )}

          <label className="form__label" htmlFor="default-source">
            Default audio source
          </label>
          <select
            className="form__input"
            id="default-source"
            onChange={(event) =>
              setDefaultSource(parseDefaultSourceInput(event.target.value))
            }
            value={defaultSource}
          >
            <option value="microphone">Microphone</option>
            <option value="tab">Tab audio</option>
            <option value="mix">Mix (tab + mic)</option>
          </select>
          <p className="status-row__hint">Use Microphone for ambient voice, Tab audio for playback, or Mix for both.</p>

          <button className="button" disabled={isSaving} type="submit">
            {isSaving ? 'Saving...' : 'Save'}
          </button>
          <button className="button button--secondary" disabled={isSaving || (!storedApiKey && !storedDeepgramKey && !storedSiliconflowKey)} onClick={handleClearApiKey} type="button">
            Clear API keys
          </button>

          {statusMessage ? <p className="success">{statusMessage}</p> : null}
          {error ? <p className="error">{error}</p> : null}
        </form>

        <div className="panel" style={{ marginTop: '1rem' }}>
          <h2 style={{ marginTop: 0 }}>STT diagnostics</h2>
          <p>Provider: {sttDiagnostics?.provider ?? 'unknown'}</p>
          <p>Configured: {sttDiagnostics?.configured ? 'true' : 'false'}</p>
          <p>Last4: {sttDiagnostics?.last4 ?? 'n/a'}</p>
          <p>Backend: {sttDiagnostics?.backend ?? 'unknown'}</p>
          <p>Detected from: {formatDetectedSource(sttDiagnostics)}</p>
        </div>
      </section>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <OptionsPage />
  </React.StrictMode>,
);
