import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';

type AuthState = {
  token: string;
  email: string;
  userId?: string;
};

type TranscriptionStatus = 'Idle' | 'Listening' | 'Error';
type AppView = 'transcription' | 'notes';

type DeviceOption = {
  id: string;
  label: string;
};

type RuntimeEventMessage =
  | { type: 'TRANSCRIPT_PARTIAL'; payload: { text: string } }
  | { type: 'TRANSCRIPT_FINAL'; payload: { text: string } }
  | { type: 'STATUS_UPDATE'; payload: { status: TranscriptionStatus; detail?: string; deviceId: string } }
  | { type: 'ERROR'; payload: { message: string } };

const AUTH_STORAGE_KEY = 'auth';
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
      justification: 'Run continuous speech transcription while popup is closed.',
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

async function queryStateFromOffscreen() {
  const sendMessage = chrome.runtime?.sendMessage as
    | ((message: { type: 'GET_TRANSCRIPTION_STATE' }) => Promise<{
        payload?: { status?: TranscriptionStatus; detail?: string; deviceId?: string };
        transcript?: { partial?: string; finalized?: string[] };
      }>)
    | undefined;

  if (!sendMessage) {
    return null;
  }

  return sendMessage({ type: 'GET_TRANSCRIPTION_STATE' });
}

function App() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<AppView>('transcription');
  const [status, setStatus] = useState<TranscriptionStatus>('Idle');
  const [statusHint, setStatusHint] = useState('Idle');
  const [devices, setDevices] = useState<DeviceOption[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState('default');
  const [partialTranscript, setPartialTranscript] = useState('');
  const [transcriptLines, setTranscriptLines] = useState<string[]>([]);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    readAuthState().then((storedAuth) => {
      if (storedAuth?.token && storedAuth.email) {
        setAuth(storedAuth);
      }
    });
  }, []);

  const apiBaseUrl = useMemo(() => DEFAULT_API_BASE_URL, []);

  useEffect(() => {
    if (!transcriptRef.current) {
      return;
    }

    transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
  }, [transcriptLines, partialTranscript]);

  useEffect(() => {
    if (!auth || typeof chrome === 'undefined') {
      return;
    }

    let disposed = false;

    const syncState = async () => {
      try {
        await ensureOffscreenDocument();
        const snapshot = await queryStateFromOffscreen();
        if (disposed || !snapshot) {
          return;
        }

        const nextStatus = snapshot.payload?.status ?? 'Idle';
        setStatus(nextStatus);
        setStatusHint(snapshot.payload?.detail ?? nextStatus);

        if (snapshot.payload?.deviceId) {
          setSelectedDeviceId(snapshot.payload.deviceId);
        }

        setPartialTranscript(snapshot.transcript?.partial ?? '');
        setTranscriptLines(snapshot.transcript?.finalized ?? []);
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
        setSelectedDeviceId(message.payload.deviceId);
        return;
      }

      if (message.type === 'TRANSCRIPT_PARTIAL') {
        setPartialTranscript(message.payload.text);
        return;
      }

      if (message.type === 'TRANSCRIPT_FINAL') {
        setPartialTranscript('');
        setTranscriptLines((current) => [...current, message.payload.text]);
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

  const sendControlMessage = async (message: { type: 'START_TRANSCRIPTION' | 'STOP_TRANSCRIPTION' } | { type: 'SET_DEVICE'; payload: { deviceId: string } }) => {
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
    setPartialTranscript('');
    setTranscriptLines([]);
  };

  const handleStartListening = async () => {
    setError(null);

    try {
      await ensureOffscreenDocument();
      await sendControlMessage({ type: 'START_TRANSCRIPTION' });
    } catch (startError) {
      const message = startError instanceof Error ? startError.message : 'Unable to start transcription.';
      setStatus('Error');
      setStatusHint(message);
      setError(message);
    }
  };

  const handleStopListening = async () => {
    setError(null);

    try {
      await ensureOffscreenDocument();
      await sendControlMessage({ type: 'STOP_TRANSCRIPTION' });
    } catch (stopError) {
      const message = stopError instanceof Error ? stopError.message : 'Unable to stop transcription.';
      setStatus('Error');
      setStatusHint(message);
      setError(message);
    }
  };

  const handleDeviceChange = async (deviceId: string) => {
    setSelectedDeviceId(deviceId);
    setError(null);

    try {
      await ensureOffscreenDocument();
      await sendControlMessage({
        type: 'SET_DEVICE',
        payload: { deviceId },
      });
    } catch (deviceError) {
      const message = deviceError instanceof Error ? deviceError.message : 'Unable to switch microphone.';
      setStatus('Error');
      setStatusHint(message);
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
            </div>

            {error && <p className="error">{error}</p>}

            <div aria-live="polite" className="transcript" ref={transcriptRef} role="log">
              {transcriptLines.length === 0 && !partialTranscript ? (
                <p className="transcript__line transcript__line--muted">No transcript yet. Start listening to begin.</p>
              ) : null}

              {transcriptLines.map((line, index) => (
                <p className="transcript__line" key={`${line}-${index}`}>
                  {line}
                </p>
              ))}

              {partialTranscript ? <p className="transcript__line transcript__line--partial">{partialTranscript}</p> : null}
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
