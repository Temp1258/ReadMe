import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';

type AuthState = {
  token: string;
  email: string;
  userId?: string;
};

type TranscriptionStatus = 'Idle' | 'Listening' | 'Error';

type AppView = 'transcription' | 'notes';

const AUTH_STORAGE_KEY = 'auth';
const DEFAULT_API_BASE_URL = 'http://localhost:8080';
const DEV_MOCK_TOKEN = 'dev-mock-token';

const SAMPLE_TRANSCRIPT_FRAGMENTS = [
  'Project kickoff recap: align on MVP scope and timeline.',
  'Action item: validate popup UX with internal users this week.',
  'Reminder: keep implementation simple and focused on shell behavior.',
  'Next step: wire real audio capture and transcription in a follow-up issue.',
];

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

function App() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<AppView>('transcription');
  const [status, setStatus] = useState<TranscriptionStatus>('Idle');
  const [transcriptLines, setTranscriptLines] = useState<string[]>([
    'Welcome to TicNote shell. Press Start to begin simulated live transcription.',
    'This transcript area is scrollable and ready for real-time updates.',
  ]);
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
    if (status !== 'Listening') {
      return;
    }

    let index = 0;
    const intervalId = window.setInterval(() => {
      setTranscriptLines((previous) => [...previous, SAMPLE_TRANSCRIPT_FRAGMENTS[index % SAMPLE_TRANSCRIPT_FRAGMENTS.length]]);
      index += 1;
    }, 2000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [status]);

  useEffect(() => {
    if (!transcriptRef.current) {
      return;
    }

    transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
  }, [transcriptLines]);

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
    setActiveView('transcription');
  };

  const handleStartListening = () => {
    setStatus('Listening');
  };

  const handleStopListening = () => {
    if (status !== 'Listening') {
      setStatus('Error');
      return;
    }

    setStatus('Idle');
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

            <div className="controls">
              <button className="button" onClick={handleStartListening} type="button">
                Start
              </button>
              <button className="button button--secondary" onClick={handleStopListening} type="button">
                Stop
              </button>
            </div>

            <div aria-live="polite" className="transcript" ref={transcriptRef} role="log">
              {transcriptLines.map((line, index) => (
                <p className="transcript__line" key={`${line}-${index}`}>
                  {line}
                </p>
              ))}
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
