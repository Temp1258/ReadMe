import { FormEvent, useEffect, useState } from 'react';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { defaults, getSettings, getSttCredentialSummary, maskSecret, saveSettings, type DefaultSource } from './settings';
import './styles.css';

function OptionsPage() {
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [storedApiKey, setStoredApiKey] = useState('');
  const [defaultSource, setDefaultSource] = useState<DefaultSource>(defaults.defaultSource);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    getSettings().then((settings) => {
      const summary = getSttCredentialSummary(settings);
      setStoredApiKey(summary.apiKey);
      setDefaultSource(settings.defaultSource ?? defaults.defaultSource);
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

    const nextApiKey = trimmedKey || storedApiKey;

    setIsSaving(true);

    try {
      await saveSettings({
        defaultSource,
        stt: {
          provider: nextApiKey ? 'openai' : 'mock',
          apiKey: nextApiKey || undefined,
        },
      });
      setStoredApiKey(nextApiKey);
      setApiKeyInput('');
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
      await saveSettings({
        defaultSource,
        stt: {
          provider: 'mock',
        },
      });
      setStoredApiKey('');
      setApiKeyInput('');
      setStatusMessage('API key cleared.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to clear API key.');
    } finally {
      setIsSaving(false);
    }
  };

  const keySummary = storedApiKey ? `Configured (${maskSecret(storedApiKey)})` : 'Not configured';

  return (
    <main className="popup options-page">
      <header className="popup__header">
        <h1>ReadMe Settings</h1>
      </header>

      <section className="panel">
        <form className="form" onSubmit={handleSubmit}>
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

          <label className="form__label" htmlFor="default-source">
            Default audio source
          </label>
          <select
            className="form__input"
            id="default-source"
            onChange={(event) => setDefaultSource(event.target.value === 'tab' ? 'tab' : 'microphone')}
            value={defaultSource}
          >
            <option value="microphone">Microphone</option>
            <option value="tab">Tab audio</option>
          </select>

          <button className="button" disabled={isSaving} type="submit">
            {isSaving ? 'Saving...' : 'Save'}
          </button>
          <button className="button button--secondary" disabled={isSaving || !storedApiKey} onClick={handleClearApiKey} type="button">
            Clear API key
          </button>

          {statusMessage ? <p className="success">{statusMessage}</p> : null}
          {error ? <p className="error">{error}</p> : null}
        </form>
      </section>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <OptionsPage />
  </React.StrictMode>,
);
