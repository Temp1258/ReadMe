import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { clearSessions, getLatestSession, type SessionStatus } from './db/indexeddb';

type AuthState = {
  token: string;
  email: string;
  userId?: string;
};

type AudioStatus = 'Idle' | 'Listening' | 'Transcribing' | 'Error';
type AppView = 'transcription' | 'notes';

type DeviceOption = {
  id: string;
  label: string;
};

type RuntimeEventMessage =
  | { type: 'TRANSCRIPT_UPDATE'; payload: { seq: number; text: string; transcript: string } }
  | { type: 'STATUS_UPDATE'; payload: { status: AudioStatus; detail?: string; selectedDeviceId: string; seq: number } }
  | { type: 'ERROR'; payload: { message: string } };

function mapSessionStatusToAudioStatus(status: SessionStatus): AudioStatus {
  if (status === 'listening') {
    return 'Listening';
  }

  if (status === 'transcribing') {
    return 'Transcribing';
  }

  if (status === 'error') {
    return 'Error';
  }

  return 'Idle';
}

const AUTH_STORAGE_KEY = 'auth';
const AUDIO_DEVICE_STORAGE_KEY = 'selectedAudioDeviceId';
const STT_API_KEY_STORAGE_KEY = 'sttApiKey';
const DEFAULT_API_BASE_URL = 'http://localhost:8080';
const DEV_MOCK_TOKEN = 'dev-mock-token';
const OFFSCREEN_DOCUMENT_PATH = 'src/offscreen.html';

type RuntimeContext = {
  contextType: string;
  documentUrl?: string;
};

async function ensureOffscreenDocument(): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.runtime?.id || !chrome.offscreen?.createDocument) {
    return;
  }

  const offscreenDocumentUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  const getContexts = chrome.runtime.getContexts as
    | ((query: { contextTypes: string[]; documentUrls: string[] }) => Promise<RuntimeContext[]>)
    | undefined;

  if (getContexts) {
    const contexts = await getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenDocumentUrl],
    });

    if (contexts.length > 0) {
      return;
    }
  }

  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: 'Run continuous microphone capture while popup is closed.',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('single offscreen document')) {
      throw error;
    }
  }
}

type ChromeStorageArea = {
  get: (keys: string | string[] | null, callback: (items: Record<string, unknown>) => void) => void;
  set: (items: Record<string, unknown>, callback?: () => void) => void;
  remove: (keys: string | string[], callback?: () => void) => void;
};

function getStorageArea(): ChromeStorageArea | null {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return null;
  }

  return chrome.storage.local;
}

async function readAuthState(): Promise<AuthState | null> {
  const storage = getStorageArea();

  if (!storage) {
    const localData = window.localStorage.getItem(AUTH_STORAGE_KEY);
    return localData ? (JSON.parse(localData) as AuthState) : null;
  }

  return new Promise((resolve) => {
    storage.get(AUTH_STORAGE_KEY, (items) => {
      resolve((items[AUTH_STORAGE_KEY] as AuthState | undefined) ?? null);
    });
  });
}

async function persistAuthState(auth: AuthState): Promise<void> {
  const storage = getStorageArea();

  if (!storage) {
    window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(auth));
    return;
  }

  await new Promise<void>((resolve) => {
    storage.set({ [AUTH_STORAGE_KEY]: auth }, () => resolve());
  });
}

async function clearAuthState(): Promise<void> {
  const storage = getStorageArea();

  if (!storage) {
    window.localStorage.removeItem(AUTH_STORAGE_KEY);
    return;
  }

  await new Promise<void>((resolve) => {
    storage.remove(AUTH_STORAGE_KEY, () => resolve());
  });
}

async function readSelectedDeviceId(): Promise<string> {
  const storage = getStorageArea();

  if (!storage) {
    return window.localStorage.getItem(AUDIO_DEVICE_STORAGE_KEY) ?? 'default';
  }

  return new Promise((resolve) => {
    storage.get(AUDIO_DEVICE_STORAGE_KEY, (items) => {
      resolve((items[AUDIO_DEVICE_STORAGE_KEY] as string | undefined) ?? 'default');
    });
  });
}

async function persistSelectedDeviceId(deviceId: string): Promise<void> {
  const storage = getStorageArea();

  if (!storage) {
    window.localStorage.setItem(AUDIO_DEVICE_STORAGE_KEY, deviceId);
    return;
  }

  await new Promise<void>((resolve) => {
    storage.set({ [AUDIO_DEVICE_STORAGE_KEY]: deviceId }, () => resolve());
  });
}

async function readSttApiKey(): Promise<string> {
  const storage = getStorageArea();

  if (!storage) {
    return window.localStorage.getItem(STT_API_KEY_STORAGE_KEY) ?? '';
  }

  return new Promise((resolve) => {
    storage.get(STT_API_KEY_STORAGE_KEY, (items) => {
      resolve((items[STT_API_KEY_STORAGE_KEY] as string | undefined) ?? '');
    });
  });
}

async function persistSttApiKey(apiKey: string): Promise<void> {
  const storage = getStorageArea();

  if (!storage) {
    window.localStorage.setItem(STT_API_KEY_STORAGE_KEY, apiKey);
    return;
  }

  await new Promise<void>((resolve) => {
    storage.set({ [STT_API_KEY_STORAGE_KEY]: apiKey }, () => resolve());
  });
}

async function queryStateFromOffscreen() {
  const sendMessage = chrome.runtime?.sendMessage as
    | ((message: { type: 'GET_AUDIO_STATE' }) => Promise<{
        status?: AudioStatus;
        detail?: string;
        selectedDeviceId?: string;
        seq?: number;
        transcript?: string;
      }>)
    | undefined;

  if (!sendMessage) {
    return null;
  }

  return sendMessage({ type: 'GET_AUDIO_STATE' });
}

function App() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<AppView>('transcription');
  const [status, setStatus] = useState<AudioStatus>('Idle');
  const [statusHint, setStatusHint] = useState('Idle');
  const [devices, setDevices] = useState<DeviceOption[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState('default');
  const [transcriptText, setTranscriptText] = useState('');
  const [sttApiKeyInput, setSttApiKeyInput] = useState('');
  const [sttKeySaved, setSttKeySaved] = useState(false);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    readAuthState().then((storedAuth) => {
      if (storedAuth?.token && storedAuth.email) {
        setAuth(storedAuth);
      }
    });

    readSttApiKey().then((key) => {
      setSttApiKeyInput(key);
      setSttKeySaved(Boolean(key));
    });
  }, []);

  const apiBaseUrl = useMemo(() => DEFAULT_API_BASE_URL, []);

  useEffect(() => {
    if (!transcriptRef.current) {
      return;
    }

    transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
  }, [transcriptText]);

  useEffect(() => {
    if (!auth || typeof chrome === 'undefined') {
      return;
    }

    let disposed = false;

    const syncState = async () => {
      try {
        await ensureOffscreenDocument();
        const [snapshot, persistedDeviceId, latestSession] = await Promise.all([
          queryStateFromOffscreen(),
          readSelectedDeviceId(),
          getLatestSession(),
        ]);

        if (disposed) {
          return;
        }

        const fallbackStatus = latestSession ? mapSessionStatusToAudioStatus(latestSession.status) : 'Idle';
        const nextStatus = snapshot?.status ?? fallbackStatus;
        const nextHint = snapshot?.detail ?? (latestSession ? `Last session status: ${latestSession.status}` : nextStatus);
        const liveTranscript = snapshot?.transcript ?? '';

        setStatus(nextStatus);
        setStatusHint(nextHint);
        setSelectedDeviceId(snapshot?.selectedDeviceId ?? persistedDeviceId);
        setTranscriptText(liveTranscript || latestSession?.transcript || '');
      } catch (syncError) {
        if (disposed) {
          return;
        }

        const message = syncError instanceof Error ? syncError.message : String(syncError);
        setStatus('Error');
        setStatusHint(message);
        setError(message);
      }
    };

    const handleRuntimeMessage = (message: RuntimeEventMessage) => {
      if (message.type === 'STATUS_UPDATE') {
        setStatus(message.payload.status);
        setStatusHint(message.payload.detail ?? message.payload.status);
        setSelectedDeviceId(message.payload.selectedDeviceId);
        return;
      }

      if (message.type === 'TRANSCRIPT_UPDATE') {
        setTranscriptText(message.payload.transcript);
        return;
      }

      if (message.type === 'ERROR') {
        setError(message.payload.message);
      }
    };

    chrome.runtime.onMessage.addListener(handleRuntimeMessage);
    syncState();

    return () => {
      disposed = true;
      chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
    };
  }, [auth]);

  useEffect(() => {
    if (!auth) {
      return;
    }

    const refreshDevices = async () => {
      try {
        const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        permissionStream.getTracks().forEach((track) => track.stop());

        const mediaDevices = await navigator.mediaDevices.enumerateDevices();
        const microphoneDevices = mediaDevices.filter((device) => device.kind === 'audioinput');
        const options: DeviceOption[] = [
          { id: 'default', label: 'System default microphone' },
          ...microphoneDevices.map((device, index) => ({
            id: device.deviceId,
            label: device.label || `Microphone ${index + 1}`,
          })),
        ];

        setDevices(options);
      } catch (deviceError) {
        const message = deviceError instanceof Error ? deviceError.message : String(deviceError);
        setError(`Unable to enumerate microphones: ${message}`);
      }
    };

    refreshDevices();

    const onDeviceChange = () => {
      refreshDevices();
    };

    navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);

    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange);
    };
  }, [auth]);

  const sendControlMessage = async (message: { type: 'START_RECORDING'; payload?: { deviceId?: string } } | { type: 'STOP_RECORDING' }) => {
    const sendMessage = chrome.runtime?.sendMessage as ((payload: typeof message) => Promise<{ ok?: boolean; error?: string }>) | undefined;
    if (!sendMessage) {
      return;
    }

    const result = await sendMessage(message);
    if (result?.ok === false) {
      throw new Error(result.error ?? 'Unknown runtime error');
    }
  };

  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!email.trim() || !password.trim()) {
      setError('Email and password are required.');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const response = await fetch(`${apiBaseUrl}/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email, password }),
      });

      if (!response.ok) {
        throw new Error('Login failed. You can use Mock Login for local UI testing.');
      }

      const data = (await response.json()) as {
        accessToken?: string;
        access_token?: string;
        user?: { id?: string; email?: string };
      };
      const accessToken = data.accessToken ?? data.access_token;

      if (!accessToken) {
        throw new Error('Login succeeded but no access token was returned.');
      }

      const nextAuth = {
        token: accessToken,
        email,
        userId: data.user?.id,
      };

      await persistAuthState(nextAuth);
      setAuth(nextAuth);
      setPassword('');
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : 'Unable to login.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleMockLogin = async () => {
    if (!email.trim()) {
      setError('Enter an email to continue with mock login.');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    const nextAuth = {
      token: DEV_MOCK_TOKEN,
      email,
      userId: email,
    };

    await persistAuthState(nextAuth);
    setAuth(nextAuth);
    setPassword('');
    setIsSubmitting(false);
  };

  const handleLogout = async () => {
    await clearAuthState();
    setAuth(null);
    setEmail('');
    setPassword('');
    setError(null);
    setStatus('Idle');
    setStatusHint('Idle');
    setActiveView('transcription');
    setTranscriptText('');
  };

  const handleStartListening = async () => {
    setError(null);

    try {
      await ensureOffscreenDocument();
      await sendControlMessage({ type: 'START_RECORDING', payload: { deviceId: selectedDeviceId } });
    } catch (startError) {
      const message = startError instanceof Error ? startError.message : 'Unable to start recording.';
      setStatus('Error');
      setStatusHint(message);
      setError(message);
    }
  };

  const handleStopListening = async () => {
    setError(null);

    try {
      await ensureOffscreenDocument();
      await sendControlMessage({ type: 'STOP_RECORDING' });
    } catch (stopError) {
      const message = stopError instanceof Error ? stopError.message : 'Unable to stop recording.';
      setStatus('Error');
      setStatusHint(message);
      setError(message);
    }
  };

  const handleDeviceChange = async (deviceId: string) => {
    setError(null);

    try {
      setSelectedDeviceId(deviceId);
      await persistSelectedDeviceId(deviceId);

      if (status === 'Listening' || status === 'Transcribing') {
        await ensureOffscreenDocument();
        await sendControlMessage({ type: 'START_RECORDING', payload: { deviceId } });
      }
    } catch (deviceError) {
      const message = deviceError instanceof Error ? deviceError.message : 'Unable to switch microphone.';
      setStatus('Error');
      setStatusHint(message);
      setError(message);
    }
  };

  const handleSaveApiKey = async () => {
    const trimmed = sttApiKeyInput.trim();
    await persistSttApiKey(trimmed);
    setSttApiKeyInput(trimmed);
    setSttKeySaved(Boolean(trimmed));
  };

  const handleClearSessionData = async () => {
    setError(null);

    try {
      await clearSessions();
      setTranscriptText('');
      setStatus('Idle');
      setStatusHint('Cleared local session data.');
    } catch (clearError) {
      const message = clearError instanceof Error ? clearError.message : 'Unable to clear local session data.';
      setError(message);
    }
  };

  if (auth) {
    return (
      <main className="popup">
        <header className="popup__header">
          <h1>TicNote</h1>
          <button className="button button--ghost" onClick={handleLogout} type="button">
            Logout
          </button>
        </header>

        <section className="view-switcher" aria-label="Sections">
          <button
            className={`view-switcher__button ${activeView === 'transcription' ? 'view-switcher__button--active' : ''}`}
            onClick={() => setActiveView('transcription')}
            type="button"
          >
            Transcription
          </button>
          <button
            className={`view-switcher__button ${activeView === 'notes' ? 'view-switcher__button--active' : ''}`}
            onClick={() => setActiveView('notes')}
            type="button"
          >
            Notes
          </button>
        </section>

        {activeView === 'transcription' ? (
          <section className="panel">
            <p className="panel__subtitle">Signed in as {auth.email}</p>

            <div className="status-row">
              <p className="status-row__label">Status</p>
              <span className={`status-indicator status-indicator--${status.toLowerCase()}`}>{status}</span>
            </div>
            <p className="status-row__hint">{statusHint}</p>

            <p className="warning-text">Warning: audio chunks are sent to a cloud transcription API when an API key is set.</p>

            <label className="form__label" htmlFor="stt-api-key">
              Whisper API Key
            </label>
            <input
              className="form__input"
              id="stt-api-key"
              onChange={(event) => {
                setSttApiKeyInput(event.target.value);
                setSttKeySaved(false);
              }}
              placeholder="sk-..."
              type="password"
              value={sttApiKeyInput}
            />
            <button className="button button--secondary" onClick={handleSaveApiKey} type="button">
              Save API Key
            </button>
            <p className="status-row__hint">{sttKeySaved ? 'API key saved locally.' : 'No key saved. Using mock transcript mode.'}</p>

            <label className="form__label" htmlFor="microphone-device">
              Microphone
            </label>
            <select
              className="form__input"
              id="microphone-device"
              onChange={(event) => handleDeviceChange(event.target.value)}
              value={selectedDeviceId}
            >
              {devices.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.label}
                </option>
              ))}
            </select>

            <div className="controls">
              <button className="button" onClick={handleStartListening} type="button">
                Start
              </button>
              <button className="button button--secondary" onClick={handleStopListening} type="button">
                Stop
              </button>
              <button className="button button--ghost" onClick={handleClearSessionData} type="button">
                Clear data
              </button>
            </div>

            {error && <p className="error">{error}</p>}

            <div aria-live="polite" className="transcript" ref={transcriptRef} role="log">
              {!transcriptText ? <p className="transcript__line transcript__line--muted">No transcript yet. Start recording to begin.</p> : null}
              {transcriptText ? <p className="transcript__line transcript__line--preserve">{transcriptText}</p> : null}
            </div>
          </section>
        ) : (
          <section className="panel">
            <h2>Notes</h2>
            <p className="panel__body">Notes is a placeholder entry point for the next MVP step.</p>
          </section>
        )}
      </main>
    );
  }

  return (
    <main className="popup">
      <h1>ReadMe</h1>
      <p className="subtitle">Sign in to open TicNote transcription.</p>

      <form className="form" onSubmit={handleLogin}>
        <label className="form__label" htmlFor="email">
          Email
        </label>
        <input
          autoComplete="email"
          className="form__input"
          id="email"
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
          type="email"
          value={email}
        />

        <label className="form__label" htmlFor="password">
          Password
        </label>
        <input
          autoComplete="current-password"
          className="form__input"
          id="password"
          onChange={(event) => setPassword(event.target.value)}
          placeholder="••••••••"
          type="password"
          value={password}
        />

        {error && <p className="error">{error}</p>}

        <button className="button" disabled={isSubmitting} type="submit">
          {isSubmitting ? 'Logging in...' : 'Login'}
        </button>

        <button className="button button--secondary" disabled={isSubmitting} onClick={handleMockLogin} type="button">
          Mock Login
        </button>
      </form>
    </main>
  );
}

export default App;
