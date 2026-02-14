import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { clearSessions, getLatestSession, listSessions, type SessionRecord, type SessionStatus } from './db/indexeddb';
import { loadSettings } from './settings';

type AuthState = {
  token: string;
  email: string;
  userId?: string;
};

type AudioStatus = 'Idle' | 'Listening' | 'Transcribing' | 'Stopped' | 'Error';
type AppView = 'transcription' | 'notes';
type AudioSource = 'mic' | 'tab' | 'mix';

type DeviceOption = {
  id: string;
  label: string;
};

type RuntimeEventMessage =
  | { type: 'TRANSCRIPT_UPDATE'; payload: { seq: number; text: string; transcript: string } }
  | {
      type: 'STATUS_UPDATE';
      payload: { status: AudioStatus; detail?: string; selectedDeviceId: string; selectedSource: AudioSource; seq: number };
    }
  | { type: 'ERROR'; payload: { message: string } };


type GetSttSettingsResponse =
  | {
      ok: true;
      provider: 'openai' | 'mock';
      apiKey?: string | null;
      keyPresent: boolean;
      last4?: string | null;
      detectedFrom?: string | null;
      backend: 'chrome.storage.local' | 'chrome.storage.sync' | 'none';
    }
  | {
      ok: false;
      error: string;
      backend: 'none';
    };

function settingsSourceToAudioSource(source?: string): AudioSource {
  return source === 'tab' || source === 'mix' ? source : 'mic';
}

function parseAudioSourceInput(source: string): AudioSource {
  return source === 'tab' || source === 'mix' ? source : 'mic';
}

function isRecordingActiveStatus(status: AudioStatus): boolean {
  return status !== 'Idle' && status !== 'Stopped' && status !== 'Error';
}

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

  if (status === 'stopped') {
    return 'Stopped';
  }

  return 'Idle';
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function formatDuration(startedAt: number, endedAt?: number): string | null {
  if (!endedAt || endedAt <= startedAt) {
    return null;
  }

  const totalSeconds = Math.floor((endedAt - startedAt) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

function formatSegmentOffset(startedAt: number, timestamp: number): string {
  const offsetSeconds = Math.max(0, Math.floor((timestamp - startedAt) / 1000));
  const minutes = Math.floor(offsetSeconds / 60);
  const seconds = offsetSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatFileTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function formatExportDuration(startedAt: number, endedAt?: number): string {
  if (!endedAt || endedAt <= startedAt) {
    return 'in-progress';
  }

  const totalMs = endedAt - startedAt;
  const human = formatDuration(startedAt, endedAt);
  return human ? `${human} (${totalMs}ms)` : `${totalMs}ms`;
}

function getExportFileName(session: SessionRecord, extension: string): string {
  const safeSource = session.source.replace(/[^a-z0-9_-]/gi, '_');
  const timestamp = formatFileTimestamp(session.startedAt);
  return `readme_${safeSource}_${timestamp}.${extension}`;
}

function buildSessionMetadataLines(session: SessionRecord): string[] {
  return [
    `id: ${session.id}`,
    `source: ${session.source}`,
    `status: ${session.status}`,
    `startedAt: ${formatTimestamp(session.startedAt)} (${session.startedAt})`,
    `endedAt: ${session.endedAt ? `${formatTimestamp(session.endedAt)} (${session.endedAt})` : 'n/a'}`,
    `duration: ${formatExportDuration(session.startedAt, session.endedAt)}`,
  ];
}

function buildTxtExport(session: SessionRecord): string {
  const metadata = buildSessionMetadataLines(session).join('\n');
  const transcript = session.transcript || '(empty)';
  const segments =
    session.segments.length === 0
      ? '(none)'
      : session.segments.map((segment) => `#${segment.idx} | ${segment.ts} | ${segment.text}`).join('\n');

  return [`Session Metadata`, metadata, '', 'Transcript', transcript, '', 'Segments', segments].join('\n');
}

function buildMarkdownExport(session: SessionRecord): string {
  const metadataLines = buildSessionMetadataLines(session).map((line) => `- ${line}`).join('\n');
  const transcript = session.transcript || '(empty)';
  const segments =
    session.segments.length === 0
      ? '- (none)'
      : session.segments.map((segment) => `- idx: ${segment.idx}, ts: ${segment.ts}, text: ${segment.text}`).join('\n');

  return [
    '# ReadMe Session Export',
    '',
    '## Metadata',
    metadataLines,
    '',
    '## Transcript',
    '',
    '```text',
    transcript,
    '```',
    '',
    '## Segments',
    segments,
  ].join('\n');
}

async function downloadTextFile(filename: string, mimeType: string, content: string): Promise<void> {
  const blob = new Blob([content], { type: mimeType });
  const objectUrl = URL.createObjectURL(blob);

  try {
    const downloads = typeof chrome !== 'undefined' ? chrome.downloads : undefined;
    if (downloads?.download) {
      await new Promise<void>((resolve, reject) => {
        downloads.download({ url: objectUrl, filename, saveAs: true }, () => {
          const runtimeError = typeof chrome !== 'undefined' ? chrome.runtime?.lastError : undefined;
          if (runtimeError) {
            reject(new Error(runtimeError.message));
            return;
          }

          resolve();
        });
      });

      return;
    }

    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  }
}

const AUTH_STORAGE_KEY = 'auth';
const AUDIO_DEVICE_STORAGE_KEY = 'selectedAudioDeviceId';
const AUDIO_SOURCE_STORAGE_KEY = 'selectedAudioSource';
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
      reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.AUDIO_PLAYBACK],
      justification: 'Capture audio and keep tab playback audible while recording runs offscreen.',
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

async function readSelectedAudioSource(): Promise<AudioSource> {
  const settings = await loadSettings();
  const fallbackSource = settingsSourceToAudioSource(settings.defaultSource);
  const storage = getStorageArea();

  if (!storage) {
    return (window.localStorage.getItem(AUDIO_SOURCE_STORAGE_KEY) as AudioSource | null) ?? fallbackSource;
  }

  return new Promise((resolve) => {
    storage.get(AUDIO_SOURCE_STORAGE_KEY, (items) => {
      const stored = items[AUDIO_SOURCE_STORAGE_KEY];
      if (stored === 'tab' || stored === 'mic' || stored === 'mix') {
        resolve(stored);
        return;
      }

      resolve(fallbackSource);
    });
  });
}

async function persistSelectedAudioSource(source: AudioSource): Promise<void> {
  const storage = getStorageArea();

  if (!storage) {
    window.localStorage.setItem(AUDIO_SOURCE_STORAGE_KEY, source);
    return;
  }

  await new Promise<void>((resolve) => {
    storage.set({ [AUDIO_SOURCE_STORAGE_KEY]: source }, () => resolve());
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


async function getSttDiagnosticsFromRuntime(): Promise<{ providerLabel: string; configurationLabel: string; error?: string }> {
  const sendMessage = chrome.runtime?.sendMessage as ((message: { type: 'GET_STT_SETTINGS' }) => Promise<GetSttSettingsResponse>) | undefined;

  if (!sendMessage) {
    return { providerLabel: 'Unknown', configurationLabel: 'Not configured', error: 'Runtime messaging unavailable.' };
  }

  try {
    const response = await sendMessage({ type: 'GET_STT_SETTINGS' });
    if (!response.ok) {
      return { providerLabel: 'Unknown', configurationLabel: 'Not configured', error: response.error || 'Unable to read STT settings.' };
    }

    const providerLabel = response.provider === 'openai' ? 'OpenAI Whisper' : 'Mock';
    const configurationLabel = response.provider === 'openai' && response.keyPresent ? 'Configured' : 'Not configured';

    return { providerLabel, configurationLabel };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to read STT settings.';
    return { providerLabel: 'Unknown', configurationLabel: 'Not configured', error: message };
  }
}

async function queryStateFromOffscreen() {
  const sendMessage = chrome.runtime?.sendMessage as
    | ((message: { type: 'GET_AUDIO_STATE' }) => Promise<{
        status?: AudioStatus;
        detail?: string;
        selectedDeviceId?: string;
        selectedSource?: AudioSource;
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
  const [selectedSource, setSelectedSource] = useState<AudioSource>('mic');
  const [transcriptText, setTranscriptText] = useState('');
  const [sttStatusLine, setSttStatusLine] = useState('Provider: Unknown · Not configured');
  const [notesSessions, setNotesSessions] = useState<SessionRecord[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [notesLoading, setNotesLoading] = useState(false);
  const [notesError, setNotesError] = useState<string | null>(null);
  const [notesSearch, setNotesSearch] = useState('');
  const [exportToast, setExportToast] = useState<string | null>(null);
  const exportToastTimerRef = useRef<number | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const previousAudioSourceLockedRef = useRef<boolean | null>(null);

  const isRecordingActive = isRecordingActiveStatus(status);
  const isAudioSourceLocked = isRecordingActive;
  const isMicrophoneLocked = selectedSource === 'tab' || isRecordingActive;

  const loadNotesSessions = async () => {
    setNotesLoading(true);
    setNotesError(null);

    try {
      const sessions = await listSessions();
      setNotesSessions(sessions);
      if (sessions.length === 0) {
        setSelectedSessionId(null);
        return;
      }

      setSelectedSessionId((currentSelected) => {
        if (currentSelected && sessions.some((session) => session.id === currentSelected)) {
          return currentSelected;
        }

        return sessions[0].id;
      });
    } catch (notesLoadError) {
      const message = notesLoadError instanceof Error ? notesLoadError.message : 'Unable to load notes.';
      setNotesError(message);
    } finally {
      setNotesLoading(false);
    }
  };

  useEffect(() => {
    readAuthState().then((storedAuth) => {
      if (storedAuth?.token && storedAuth.email) {
        setAuth(storedAuth);
      }
    });

    Promise.all([loadSettings(), getSttDiagnosticsFromRuntime()]).then(([settings, sttSummary]) => {
      setSttStatusLine(`Provider: ${sttSummary.providerLabel} · ${sttSummary.configurationLabel}`);
      if (sttSummary.error) {
        setError(sttSummary.error);
      }
      setSelectedSource(settingsSourceToAudioSource(settings.defaultSource));
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
    if (previousAudioSourceLockedRef.current === isAudioSourceLocked) {
      return;
    }

    previousAudioSourceLockedRef.current = isAudioSourceLocked;
    console.info(`Audio source selector ${isAudioSourceLocked ? 'locked' : 'unlocked'}.`);
  }, [isAudioSourceLocked]);

  useEffect(() => {
    if (!auth || typeof chrome === 'undefined') {
      return;
    }

    let disposed = false;

    const syncState = async () => {
      try {
        await ensureOffscreenDocument();
        const [snapshot, persistedDeviceId, persistedAudioSource, latestSession] = await Promise.all([
          queryStateFromOffscreen(),
          readSelectedDeviceId(),
          readSelectedAudioSource(),
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
        setSelectedSource(snapshot?.selectedSource ?? persistedAudioSource);
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
        setSelectedSource(message.payload.selectedSource);

        if (activeView === 'notes' && (message.payload.status === 'Idle' || message.payload.status === 'Stopped')) {
          void loadNotesSessions();
        }

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
  }, [activeView, auth]);

  useEffect(() => {
    if (!auth || activeView !== 'notes') {
      return;
    }

    loadNotesSessions();
  }, [activeView, auth]);

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

  const sendControlMessage = async (
    message:
        | {
          type: 'START_RECORDING';
          payload?: { deviceId?: string; source?: AudioSource; streamId?: string };
        }
      | { type: 'STOP_RECORDING' }
      | { type: 'REFRESH_SETTINGS' },
  ) => {
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
      let streamId: string | undefined;
      if (selectedSource === 'tab' || selectedSource === 'mix') {
        streamId = await new Promise<string>((resolve, reject) => {
          if (!chrome.tabCapture?.getMediaStreamId) {
            reject(new Error('Tab audio capture is not available in this browser.'));
            return;
          }

          chrome.tabCapture.getMediaStreamId({ targetTabId: undefined }, (capturedStreamId) => {
            const runtimeError = chrome.runtime.lastError;
            if (runtimeError) {
              reject(new Error(runtimeError.message));
              return;
            }

            if (!capturedStreamId) {
              reject(new Error('Unable to capture active tab audio stream.'));
              return;
            }

            resolve(capturedStreamId);
          });
        });
      }

      await ensureOffscreenDocument();
      await sendControlMessage({ type: 'REFRESH_SETTINGS' });
      await sendControlMessage({
        type: 'START_RECORDING',
        payload: {
          deviceId: selectedDeviceId,
          source: selectedSource,
          streamId,
        },
      });
    } catch (startError) {
      const message = startError instanceof Error ? startError.message : 'Unable to start recording.';
      setStatus('Error');
      setStatusHint(message);
      setError(message);
    }
  };

  const handleSourceChange = async (source: AudioSource) => {
    if (isRecordingActive) {
      console.info('Ignoring audio source change while recording is active.');
      return;
    }

    setError(null);

    try {
      setSelectedSource(source);
      await persistSelectedAudioSource(source);

      if (status === 'Listening' || status === 'Transcribing') {
        await handleStartListening();
      }
    } catch (sourceError) {
      const message = sourceError instanceof Error ? sourceError.message : 'Unable to switch audio source.';
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
        await handleStartListening();
      }
    } catch (deviceError) {
      const message = deviceError instanceof Error ? deviceError.message : 'Unable to switch microphone.';
      setStatus('Error');
      setStatusHint(message);
      setError(message);
    }
  };

  const handleOpenSettings = async () => {
    if (chrome.runtime?.openOptionsPage) {
      await chrome.runtime.openOptionsPage();
      return;
    }

    window.open(chrome.runtime.getURL('options.html'), '_blank');
  };

  const handleClearSessionData = async () => {
    setError(null);

    try {
      await clearSessions();
      setTranscriptText('');
      setStatus('Idle');
      setStatusHint('Cleared local session data.');
      setNotesSessions([]);
      setSelectedSessionId(null);
    } catch (clearError) {
      const message = clearError instanceof Error ? clearError.message : 'Unable to clear local session data.';
      setError(message);
    }
  };

  const handleExportSession = async (format: 'txt' | 'md') => {
    if (!selectedSession) {
      return;
    }

    try {
      setNotesError(null);

      const exportContent = format === 'txt' ? buildTxtExport(selectedSession) : buildMarkdownExport(selectedSession);
      const mimeType = 'text/plain;charset=utf-8';
      const fileName = getExportFileName(selectedSession, format);

      await downloadTextFile(fileName, mimeType, exportContent);
      setExportToast(`Downloaded: ${fileName}`);
      if (exportToastTimerRef.current !== null) {
        window.clearTimeout(exportToastTimerRef.current);
      }
      exportToastTimerRef.current = window.setTimeout(() => {
        setExportToast(null);
      }, 2000);
    } catch (exportError) {
      const message = exportError instanceof Error ? exportError.message : 'Unable to export this session.';
      setNotesError(message);
    }
  };

  const filteredSessions = useMemo(() => {
    const query = notesSearch.trim().toLowerCase();
    if (!query) {
      return notesSessions;
    }

    return notesSessions.filter((session) => session.transcript.toLowerCase().includes(query));
  }, [notesSearch, notesSessions]);


  useEffect(() => {
    return () => {
      if (exportToastTimerRef.current !== null) {
        window.clearTimeout(exportToastTimerRef.current);
      }
    };
  }, []);

  const selectedSession = useMemo(() => {
    if (!selectedSessionId) {
      return filteredSessions[0] ?? null;
    }

    return filteredSessions.find((session) => session.id === selectedSessionId) ?? filteredSessions[0] ?? null;
  }, [filteredSessions, selectedSessionId]);

  if (auth) {
    return (
      <main className="popup">
        <header className="popup__header">
          <div className="popup__brand">
            <h1>ReadMe</h1>
            <p className="subtitle subtitle--compact">Quick transcription capture</p>
          </div>
          <div className="popup__header-actions">
            <button aria-label="Open settings" className="icon-button" onClick={handleOpenSettings} type="button">
              ⚙
            </button>
            <button className="button button--tertiary" onClick={handleLogout} type="button">
              Logout
            </button>
          </div>
        </header>

        <section className="segment-control" aria-label="Sections">
          <button
            className={`segment-control__button ${activeView === 'transcription' ? 'segment-control__button--active' : ''}`}
            onClick={() => setActiveView('transcription')}
            type="button"
          >
            Transcription
          </button>
          <button
            className={`segment-control__button ${activeView === 'notes' ? 'segment-control__button--active' : ''}`}
            onClick={() => setActiveView('notes')}
            type="button"
          >
            Notes
          </button>
        </section>

        {activeView === 'transcription' ? (
          <section className="transcription-view">
            <div className="info-row">
              <div className="info-row__status">
                <span className={`status-dot status-dot--${status.toLowerCase()}`} aria-hidden="true" />
                <p className="info-row__status-text">Status: {status}</p>
              </div>
              <p className="info-row__meta">{sttStatusLine}</p>
            </div>

            <details className="warning-inline">
              <summary>
                Warning: audio may be sent to a cloud transcription API.
                <span className="warning-inline__action">Learn more</span>
              </summary>
              <p>When an API key is configured, recorded audio is sent to a cloud transcription API for processing.</p>
            </details>

            <p className="meta-line">Signed in as {auth.email}</p>
            <p className="meta-line">
              {statusHint}
              <button className="link-button" onClick={handleOpenSettings} type="button">
                Settings
              </button>
            </p>

            <section className="controls-row">
              {!isRecordingActive ? (
                <button className="button button--primary" onClick={handleStartListening} type="button">
                  Start
                </button>
              ) : (
                <button className="button button--primary" onClick={handleStopListening} type="button">
                  Stop
                </button>
              )}
              <button className="button button--tertiary" onClick={handleClearSessionData} type="button">
                Clear
              </button>
            </section>

            <section className="inputs-section">
              <p className="section-label">Inputs</p>
              <div className="source-grid">
                <div className="field-group">
                  <label className="form__label" htmlFor="audio-source">
                    Source
                  </label>
                  <select
                    className="form__input"
                    disabled={isAudioSourceLocked}
                    id="audio-source"
                    onChange={(event) =>
                      handleSourceChange(parseAudioSourceInput(event.target.value))
                    }
                    value={selectedSource}
                  >
                    <option value="mic">Microphone</option>
                    <option value="tab">Tab audio</option>
                    <option value="mix">Mix (tab + mic)</option>
                  </select>
                  {isAudioSourceLocked ? <p className="field-hint">Source is locked while recording.</p> : null}
                </div>

                <div className="field-group">
                  <label className="form__label" htmlFor="microphone-device">
                    Microphone
                  </label>
                  <select
                    className="form__input"
                    disabled={isMicrophoneLocked}
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
                </div>
              </div>
            </section>

            {error && <p className="error">{error}</p>}

            <section className="transcript-panel">
              <div className="transcript-panel__header">
                <h2>Transcript</h2>
              </div>
              <div aria-live="polite" className="transcript" ref={transcriptRef} role="log">
                {!transcriptText ? <p className="transcript__line transcript__line--muted">No transcript yet. Start recording to begin.</p> : null}
                {transcriptText ? <p className="transcript__line transcript__line--preserve">{transcriptText}</p> : null}
              </div>
            </section>
          </section>
        ) : (
          <section className="notes-view">
            <div className="notes__toolbar">
              <h2>Notes</h2>
              <button className="button button--tertiary" onClick={loadNotesSessions} type="button">
                Refresh
              </button>
            </div>

            <label className="form__label" htmlFor="notes-search">
              Search transcript
            </label>
            <input
              className="form__input"
              id="notes-search"
              onChange={(event) => setNotesSearch(event.target.value)}
              placeholder="Filter by transcript text"
              type="search"
              value={notesSearch}
            />

            {notesError ? <p className="error">{notesError}</p> : null}
            {notesLoading ? <p className="panel__body">Loading sessions...</p> : null}

            <div className="notes-layout">
              <div className="notes-list" role="list">
                {!filteredSessions.length ? <p className="panel__body">No sessions found.</p> : null}
                {filteredSessions.map((session) => {
                  const preview = session.transcript.trim() ? session.transcript.slice(0, 60) : '(no transcript yet)';
                  const duration = formatDuration(session.startedAt, session.endedAt);

                  return (
                    <button
                      aria-pressed={selectedSession?.id === session.id}
                      className={`notes-list__item ${selectedSession?.id === session.id ? 'notes-list__item--active' : ''}`}
                      key={session.id}
                      onClick={() => setSelectedSessionId(session.id)}
                      type="button"
                    >
                      <div className="notes-list__title-row">
                        <p className="notes-list__time">{formatTimestamp(session.startedAt)}</p>
                        <span className={`status-indicator status-indicator--${session.status}`}>{session.status}</span>
                      </div>
                      <p className="notes-list__meta">
                        {session.source}
                        {duration ? ` • ${duration}` : ''}
                      </p>
                      <p className="notes-list__preview">{preview}</p>
                    </button>
                  );
                })}
              </div>

              <div className="notes-detail">
                {!selectedSession ? (
                  <p className="panel__body">Select a session to view details.</p>
                ) : (
                  <>
                    <div className="notes__toolbar">
                      <h3>Transcript</h3>
                      <div className="notes-detail__actions">
                        <button className="button button--secondary" onClick={() => handleExportSession('txt')} type="button">
                          Export TXT
                        </button>
                        <button className="button button--secondary" onClick={() => handleExportSession('md')} type="button">
                          Export MD
                        </button>
                      </div>
                    </div>
                    <div className="transcript">
                      {selectedSession.transcript ? (
                        <p className="transcript__line transcript__line--preserve">{selectedSession.transcript}</p>
                      ) : (
                        <p className="transcript__line transcript__line--muted">No transcript yet.</p>
                      )}
                    </div>

                    <h3>Segments</h3>
                    {selectedSession.segments.length === 0 ? (
                      <p className="panel__body">No segments yet.</p>
                    ) : (
                      <ul className="notes-segments">
                        {selectedSession.segments.map((segment) => (
                          <li key={segment.idx}>
                            <span className="notes-segments__meta">
                              #{segment.idx} • {formatSegmentOffset(selectedSession.startedAt, segment.ts)}
                            </span>{' '}
                            {segment.text}
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </div>
            </div>
          </section>
        )}

        {exportToast ? <p className="toast">{exportToast}</p> : null}
      </main>
    );
  }

  return (
    <main className="popup">
      <h1>ReadMe</h1>
      <p className="subtitle">Sign in to open ReadMe transcription.</p>

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
