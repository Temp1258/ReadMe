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
  const [selectedProvider, setSelectedProvider] = useState<'openai' | 'tencent' | 'aliyun'>('openai');
  const [tencentSecretIdInput, setTencentSecretIdInput] = useState('');
  const [tencentSecretKeyInput, setTencentSecretKeyInput] = useState('');
  const [aliyunAccessKeyIdInput, setAliyunAccessKeyIdInput] = useState('');
  const [aliyunAccessKeySecretInput, setAliyunAccessKeySecretInput] = useState('');
  const [storedApiKey, setStoredApiKey] = useState('');
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
      setDefaultSource(settings.defaultSource ?? defaults.defaultSource);
      setSttDiagnostics(summary);
    });
  }, []);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setStatusMessage(null);

    const trimmedKey = apiKeyInput.trim();

    if (apiKeyInput.length > 0 && trimmedKey.length === 0) {
      setError('Whisper API key cannot be only whitespace.');
      return;
    }

    setIsSaving(true);

    try {
      const previousSettings = await loadSettings();
      const nextSettings = trimmedKey
        ? {
            ...previousSettings,
            defaultSource,
            stt: {
              ...previousSettings.stt,
              provider: 'openai' as const,
              apiKey: trimmedKey,
            },
          }
        : {
            ...previousSettings,
            defaultSource,
          };

      await saveSettings(nextSettings);

      const updatedStt = await loadSttSettings();
      setStoredApiKey(updatedStt.apiKey?.trim() ?? '');
      setApiKeyInput('');
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
      setApiKeyInput('');
      await refreshSttDiagnostics();
      setStatusMessage('API key cleared.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to clear API key.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleClearTencentInputs = () => {
    if (!window.confirm('Clear Tencent credentials?')) return;
    setTencentSecretIdInput('');
    setTencentSecretKeyInput('');
    setStatusMessage('Inputs cleared.');
  };

  const handleClearAliyunInputs = () => {
    if (!window.confirm('Clear Aliyun credentials?')) return;
    setAliyunAccessKeyIdInput('');
    setAliyunAccessKeySecretInput('');
    setStatusMessage('Inputs cleared.');
  };

  const handleUiOnlySave = () => {
    setError(null);
    setStatusMessage('Saved (UI only, not persisted).');
  };

  const keySummary = storedApiKey ? `Configured (${maskSecret(storedApiKey)})` : 'Not configured';

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
            onChange={(event) => setSelectedProvider(event.target.value as 'openai' | 'tencent' | 'aliyun')}
            value={selectedProvider}
          >
            <option value="openai">OpenAI Whisper</option>
            <option value="tencent">Tencent</option>
            <option value="aliyun">Aliyun</option>
          </select>

          {selectedProvider === 'openai' ? (
            <>
              <label className="form__label" htmlFor="whisper-api-key-status">
                Whisper API Key status
              </label>
              <input className="form__input" id="whisper-api-key-status" readOnly type="text" value={keySummary} />

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

              <button className="button" disabled={isSaving} type="submit">
                {isSaving ? 'Saving...' : 'Save'}
              </button>
              <button className="button button--secondary" disabled={isSaving || !storedApiKey} onClick={handleClearApiKey} type="button">
                Clear API key
              </button>
            </>
          ) : null}

          {selectedProvider === 'tencent' ? (
            <>
              <label className="form__label" htmlFor="tencent-secret-id">
                Tencent SecretId
              </label>
              <input
                className="form__input"
                id="tencent-secret-id"
                onChange={(event) => setTencentSecretIdInput(event.target.value)}
                type="password"
                value={tencentSecretIdInput}
              />

              <label className="form__label" htmlFor="tencent-secret-key">
                Tencent SecretKey
              </label>
              <input
                className="form__input"
                id="tencent-secret-key"
                onChange={(event) => setTencentSecretKeyInput(event.target.value)}
                type="password"
                value={tencentSecretKeyInput}
              />
              <p className="status-row__hint">(UI only, not saved)</p>

              <button className="button button--secondary" onClick={handleClearTencentInputs} type="button">
                Clear Tencent inputs
              </button>
              <button className="button" onClick={handleUiOnlySave} type="button">
                Save
              </button>
            </>
          ) : null}

          {selectedProvider === 'aliyun' ? (
            <>
              <label className="form__label" htmlFor="aliyun-access-key-id">
                Aliyun AccessKeyId
              </label>
              <input
                className="form__input"
                id="aliyun-access-key-id"
                onChange={(event) => setAliyunAccessKeyIdInput(event.target.value)}
                type="password"
                value={aliyunAccessKeyIdInput}
              />

              <label className="form__label" htmlFor="aliyun-access-key-secret">
                Aliyun AccessKeySecret
              </label>
              <input
                className="form__input"
                id="aliyun-access-key-secret"
                onChange={(event) => setAliyunAccessKeySecretInput(event.target.value)}
                type="password"
                value={aliyunAccessKeySecretInput}
              />
              <p className="status-row__hint">(UI only, not saved)</p>

              <button className="button button--secondary" onClick={handleClearAliyunInputs} type="button">
                Clear Aliyun inputs
              </button>
              <button className="button" onClick={handleUiOnlySave} type="button">
                Save
              </button>
            </>
          ) : null}

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

          {statusMessage ? <p className="success">{statusMessage}</p> : null}
          {error ? <p className="error">{error}</p> : null}
        </form>

        <div className="panel" style={{ marginTop: '1rem' }}>
          <h2 style={{ marginTop: 0 }}>STT diagnostics (safe)</h2>
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
