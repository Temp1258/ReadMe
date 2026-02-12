import { FormEvent, useEffect, useMemo, useState } from 'react';

type AuthState = {
  token: string;
  email: string;
};

type Conversation = {
  id: string;
  title: string;
};

const AUTH_STORAGE_KEY = 'auth';
const DEFAULT_API_BASE_URL = 'http://localhost:8080';
const DEV_MOCK_TOKEN = 'dev-mock-token';
const FALLBACK_CONVERSATIONS: Conversation[] = [{ id: 'c_1', title: 'Test Chat' }];

type ChromeStorageArea = {
  get: (keys: string | string[] | null, callback: (items: Record<string, unknown>) => void) => void;
  set: (items: Record<string, unknown>, callback?: () => void) => void;
  clear: (callback?: () => void) => void;
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
    storage.clear(() => resolve());
  });
}

function App() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [isLoadingConversations, setIsLoadingConversations] = useState(false);
  const [conversationError, setConversationError] = useState<string | null>(null);
  const [activeConversation, setActiveConversation] = useState<Conversation | null>(null);

  useEffect(() => {
    readAuthState().then((storedAuth) => {
      if (storedAuth?.token && storedAuth.email) {
        setAuth(storedAuth);
      }
    });
  }, []);

  const apiBaseUrl = useMemo(() => DEFAULT_API_BASE_URL, []);

  useEffect(() => {
    if (!auth?.token) {
      setConversations([]);
      setConversationError(null);
      setActiveConversation(null);
      return;
    }

    const fetchConversations = async () => {
      setIsLoadingConversations(true);
      setConversationError(null);

      try {
        const response = await fetch(`${apiBaseUrl}/conversations`, {
          headers: {
            Authorization: `Bearer ${auth.token}`,
          },
        });

        if (!response.ok) {
          throw new Error('Failed to load conversations from API. Showing fallback list.');
        }

        const data = (await response.json()) as Array<{ id?: string; title?: string }>;
        const parsed = data
          .map((conversation, index) => ({
            id: conversation.id?.trim() || `conversation-${index}`,
            title: conversation.title?.trim() || `Conversation ${index + 1}`,
          }))
          .filter((conversation) => conversation.id);

        setConversations(parsed.length > 0 ? parsed : FALLBACK_CONVERSATIONS);
      } catch (fetchError) {
        setConversations(FALLBACK_CONVERSATIONS);
        setConversationError(fetchError instanceof Error ? fetchError.message : 'Unable to load conversations. Showing fallback list.');
      } finally {
        setIsLoadingConversations(false);
      }
    };

    fetchConversations();
  }, [apiBaseUrl, auth]);

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

      const data = (await response.json()) as { accessToken?: string };

      if (!data.accessToken) {
        throw new Error('Login succeeded but no access token was returned.');
      }

      const nextAuth = {
        token: data.accessToken,
        email,
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
  };

  if (auth) {
    if (activeConversation) {
      return (
        <main className="popup">
          <header className="popup__header">
            <button className="button button--ghost" onClick={() => setActiveConversation(null)} type="button">
              ← Back
            </button>
            <button className="button button--ghost" onClick={handleLogout} type="button">
              Logout
            </button>
          </header>

          <section className="panel">
            <h2>{activeConversation.title}</h2>
            <p className="panel__subtitle">Signed in as {auth.email}</p>
            <p className="panel__body">Chat view placeholder for {activeConversation.title}.</p>
          </section>
        </main>
      );
    }

    return (
      <main className="popup">
        <header className="popup__header">
          <h1>ReadMe</h1>
          <button className="button button--ghost" onClick={handleLogout} type="button">
            Logout
          </button>
        </header>

        <section className="panel">
          <h2>Conversations</h2>
          <p className="panel__subtitle">Signed in as {auth.email}</p>
          {isLoadingConversations ? <p className="panel__body">Loading conversations...</p> : null}
          {conversationError ? <p className="error">{conversationError}</p> : null}

          {!isLoadingConversations ? (
            <ul className="conversation-list">
              {conversations.map((conversation) => (
                <li key={conversation.id}>
                  <button className="conversation-item" onClick={() => setActiveConversation(conversation)} type="button">
                    {conversation.title}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      </main>
    );
  }

  return (
    <main className="popup">
      <h1>ReadMe</h1>
      <p className="subtitle">Sign in to open your chats.</p>

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
