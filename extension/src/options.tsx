import { FormEvent, useEffect, useState } from 'react';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { defaults, getSettings, saveSettings, type DefaultSource } from './settings';
import './styles.css';

function OptionsPage() {
  const [whisperApiKey, setWhisperApiKey] = useState('');
  const [defaultSource, setDefaultSource] = useState<DefaultSource>(defaults.defaultSource);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    getSettings().then((settings) => {
      setWhisperApiKey(settings.whisperApiKey ?? '');
      setDefaultSource(settings.defaultSource ?? defaults.defaultSource);
    });
  }, []);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setStatusMessage(null);

    const trimmedKey = whisperApiKey.trim();

    if (whisperApiKey.length > 0 && trimmedKey.length === 0) {
      setError('Whisper API key cannot be only whitespace.');
      return;
    }

    setIsSaving(true);

    try {
      await saveSettings({
        whisperApiKey: trimmedKey || undefined,
        defaultSource,
      });
      setWhisperApiKey(trimmedKey);
      setStatusMessage('Settings saved.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save settings.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <main className="popup options-page">
      <header className="popup__header">
        <h1>ReadMe Settings</h1>
      </header>

      <section className="panel">
        <form className="form" onSubmit={handleSubmit}>
          <label className="form__label" htmlFor="whisper-api-key">
            Whisper API Key
          </label>
          <input
            className="form__input"
            id="whisper-api-key"
            onChange={(event) => setWhisperApiKey(event.target.value)}
            placeholder="sk-..."
            type="password"
            value={whisperApiKey}
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
