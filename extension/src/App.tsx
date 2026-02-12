import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';

type AuthState = {
  token: string;
  email: string;
  userId?: string;
};

type Conversation = {
  id: string;
  title: string;
};

type Message = {
  id: number;
  conversation_id: string;
  sender_id: string;
  text: string;
  created_at?: string;
};

const AUTH_STORAGE_KEY = 'auth';
const DEFAULT_API_BASE_URL = 'http://localhost:8080';
const DEV_MOCK_TOKEN = 'dev-mock-token';
const FALLBACK_CONVERSATIONS: Conversation[] = [{ id: 'c_1', title: 'Test Chat' }];

function buildMockMessages(conversationId: string): Message[] {
  return [{ id: 1, conversation_id: conversationId, sender_id: 'mock_user', text: 'Hello (mock)' }];
}

function sortMessagesChronologically(messages: Message[]): Message[] {
  return [...messages].sort((a, b) => {
    const aCreatedAt = typeof a.created_at === 'string' ? Date.parse(a.created_at) : Number.NaN;
    const bCreatedAt = typeof b.created_at === 'string' ? Date.parse(b.created_at) : Number.NaN;

    if (!Number.isNaN(aCreatedAt) && !Number.isNaN(bCreatedAt) && aCreatedAt !== bCreatedAt) {
      return aCreatedAt - bCreatedAt;
    }

    return a.id - b.id;
  });
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
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [messageError, setMessageError] = useState<string | null>(null);
  const [draftMessage, setDraftMessage] = useState('');
  const [isSendingMessage, setIsSendingMessage] = useState(false);
  const messageListRef = useRef<HTMLDivElement | null>(null);

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

        const data = (await response.json()) as unknown;

        if (!Array.isArray(data)) {
          throw new Error('Conversations API returned an invalid response. Showing fallback list.');
        }

        const parsed = data
          .map((conversation, index) => ({
            id:
              typeof conversation.id === 'string' && conversation.id.trim().length > 0
                ? conversation.id.trim()
                : `conversation-${index}`,
            title:
              typeof conversation.title === 'string' && conversation.title.trim().length > 0
                ? conversation.title.trim()
                : `Conversation ${index + 1}`,
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

  useEffect(() => {
    if (!auth?.token || !activeConversation) {
      setMessages([]);
      setMessageError(null);
      return;
    }

    const fetchMessages = async () => {
      setIsLoadingMessages(true);
      setMessageError(null);

      try {
        const query = new URLSearchParams({ conversation_id: activeConversation.id, limit: '50' });
        const response = await fetch(`${apiBaseUrl}/messages?${query.toString()}`, {
          headers: {
            Authorization: `Bearer ${auth.token}`,
          },
        });

        if (!response.ok) {
          throw new Error('Failed to load message history from API. Showing mock message.');
        }

        const data = (await response.json()) as unknown;

        if (!Array.isArray(data)) {
          throw new Error('Messages API returned an invalid response. Showing mock message.');
        }

        const parsed = data
          .map((message): Message | null => {
            if (typeof message !== 'object' || message === null) {
              return null;
            }

            const rawId = (message as { id?: unknown }).id;
            const rawConversationId = (message as { conversation_id?: unknown }).conversation_id;
            const rawSenderId = (message as { sender_id?: unknown }).sender_id;
            const rawText = (message as { text?: unknown }).text;
            const rawCreatedAt = (message as { created_at?: unknown }).created_at;

            if (
              typeof rawId !== 'number' ||
              typeof rawConversationId !== 'string' ||
              typeof rawSenderId !== 'string' ||
              typeof rawText !== 'string'
            ) {
              return null;
            }

            return {
              id: rawId,
              conversation_id: rawConversationId,
              sender_id: rawSenderId,
              text: rawText,
              created_at: typeof rawCreatedAt === 'string' ? rawCreatedAt : undefined,
            };
          })
          .filter((message): message is Message => message !== null);

        if (parsed.length === 0 && data.length > 0) {
          throw new Error('Messages API returned invalid payload. Showing mock message.');
        }

        setMessages(sortMessagesChronologically(parsed));
      } catch (fetchError) {
        setMessages(buildMockMessages(activeConversation.id));
        setMessageError(fetchError instanceof Error ? fetchError.message : 'Unable to load message history. Showing mock message.');
      } finally {
        setIsLoadingMessages(false);
      }
    };

    fetchMessages();
  }, [activeConversation, apiBaseUrl, auth]);

  useEffect(() => {
    if (!messageListRef.current) {
      return;
    }

    messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
  }, [messages]);

  const appendMessage = (message: Message) => {
    setMessages((previous) => sortMessagesChronologically([...previous, message]));
  };

  const handleSendMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!auth || !activeConversation) {
      return;
    }

    const trimmedMessage = draftMessage.trim();
    if (!trimmedMessage || isSendingMessage) {
      return;
    }

    setIsSendingMessage(true);
    setMessageError(null);

    const localId = Date.now();
    const localMessage: Message = {
      id: localId,
      conversation_id: activeConversation.id,
      sender_id: auth.userId ?? auth.email,
      text: trimmedMessage,
      created_at: new Date().toISOString(),
    };

    try {
      const response = await fetch(`${apiBaseUrl}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${auth.token}`,
        },
        body: JSON.stringify({
          conversation_id: activeConversation.id,
          text: trimmedMessage,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to send message via API. Added as local mock message.');
      }

      const payload = (await response.json()) as Partial<Message>;
      const responseId = typeof payload.id === 'number' ? payload.id : localId;

      appendMessage({
        id: responseId,
        conversation_id:
          typeof payload.conversation_id === 'string' && payload.conversation_id.length > 0
            ? payload.conversation_id
            : activeConversation.id,
        sender_id: typeof payload.sender_id === 'string' && payload.sender_id.length > 0 ? payload.sender_id : auth.userId ?? auth.email,
        text: typeof payload.text === 'string' && payload.text.length > 0 ? payload.text : trimmedMessage,
        created_at: typeof payload.created_at === 'string' ? payload.created_at : new Date().toISOString(),
      });
    } catch (sendError) {
      appendMessage(localMessage);
      setMessageError(sendError instanceof Error ? sendError.message : 'Unable to send message via API. Added as local mock message.');
    } finally {
      setDraftMessage('');
      setIsSendingMessage(false);
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
            {isLoadingMessages ? <p className="panel__body">Loading messages...</p> : null}
            {messageError ? <p className="error">{messageError}</p> : null}

            <div className="message-list" ref={messageListRef} role="log" aria-live="polite">
              {messages.map((message) => {
                const isMe = message.sender_id === (auth.userId ?? auth.email);

                return (
                  <article className={`message ${isMe ? 'message--me' : 'message--other'}`} key={message.id}>
                    <p className="message__sender">{isMe ? 'me' : message.sender_id}</p>
                    <p className="message__text">{message.text}</p>
                  </article>
                );
              })}

              {!isLoadingMessages && messages.length === 0 ? <p className="panel__body">No messages yet.</p> : null}
            </div>

            <form className="composer" onSubmit={handleSendMessage}>
              <input
                aria-label="Type your message"
                className="form__input composer__input"
                onChange={(event) => setDraftMessage(event.target.value)}
                placeholder="Write a message"
                type="text"
                value={draftMessage}
              />
              <button className="button composer__button" disabled={!draftMessage.trim() || isSendingMessage} type="submit">
                {isSendingMessage ? 'Sending...' : 'Send'}
              </button>
            </form>
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
