import { useEffect, useRef, useState } from 'react';
import { clearSessions, getLatestSession, listSessions, type SessionRecord } from './db/indexeddb';
import { loadSettings } from './settings';
import type { AudioStatus, AppView, AudioSource, RecordingDiagnostics, UITheme, UILang, DeviceOption, RuntimeEventMessage } from './types';
import { createTranslator } from './i18n';
import { normalizeAudioSource, isRecordingActiveStatus, getExportFileName } from './utils/format';
import { buildTxtExport, buildMarkdownExport, downloadTextFile } from './utils/export';
import {
  readSelectedDeviceId,
  readSelectedAudioSource,
  persistSelectedAudioSource,
  persistSelectedDeviceId,
  readUITheme,
  persistUITheme,
  readUILang,
  persistUILang,
  ensureOffscreenDocument,
  getSttDiagnosticsFromRuntime,
  queryStateFromOffscreen,
  mapSessionStatusToAudioStatus,
  UI_THEME_STORAGE_KEY,
  UI_LANG_STORAGE_KEY,
} from './utils/chrome-storage';
import { TranscriptionView } from './components/TranscriptionView';
import { NotesView } from './components/NotesView';
import { SettingsView } from './components/SettingsView';

function App() {
  const [error, setError] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<AppView>('transcription');
  const [status, setStatus] = useState<AudioStatus>('Idle');
  const [recordingDiagnostics, setRecordingDiagnostics] = useState<RecordingDiagnostics>({
    durationSec: 0,
    durationLabel: '00:00',
    totalBytes: 0,
    totalMB: 0,
    mbPerMin: 0,
    estMinTo25MB: null,
  });
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
  const previousAudioSourceLockedRef = useRef<boolean | null>(null);
  const [uiTheme, setUITheme] = useState<UITheme>('light');
  const [uiLang, setUILang] = useState<UILang>('en');

  const t = createTranslator(uiLang);

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
    Promise.all([loadSettings(), getSttDiagnosticsFromRuntime(), readUITheme(), readUILang()]).then(
      ([settings, sttSummary, savedTheme, savedLang]) => {
        setSttStatusLine(`Provider: ${sttSummary.providerLabel} · ${sttSummary.configurationLabel}`);
        if (sttSummary.error) {
          setError(sttSummary.error);
        }
        setSelectedSource(normalizeAudioSource(settings.defaultSource));
        setUITheme(savedTheme);
        setUILang(savedLang);
      },
    );
  }, []);

  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) {
      return;
    }

    const onStorageChange: Parameters<typeof chrome.storage.onChanged.addListener>[0] = (changes, areaName) => {
      if (areaName !== 'local') {
        return;
      }

      if (changes[UI_THEME_STORAGE_KEY]) {
        setUITheme(changes[UI_THEME_STORAGE_KEY].newValue === 'dark' ? 'dark' : 'light');
      }

      if (changes[UI_LANG_STORAGE_KEY]) {
        setUILang(changes[UI_LANG_STORAGE_KEY].newValue === 'zh' ? 'zh' : 'en');
      }
    };

    chrome.storage.onChanged.addListener(onStorageChange);

    return () => {
      chrome.storage.onChanged.removeListener(onStorageChange);
    };
  }, []);

  useEffect(() => {
    if (previousAudioSourceLockedRef.current === isAudioSourceLocked) {
      return;
    }

    previousAudioSourceLockedRef.current = isAudioSourceLocked;
    console.info(`Audio source selector ${isAudioSourceLocked ? 'locked' : 'unlocked'}.`);
  }, [isAudioSourceLocked]);

  useEffect(() => {
    if (typeof chrome === 'undefined') {
      return;
    }

    let disposed = false;

    const syncState = async () => {
      try {
        await ensureOffscreenDocument();
        const [snapshot, persistedDeviceId, persistedAudioSource, latestSession] = await Promise.all([
          queryStateFromOffscreen(),
          readSelectedDeviceId(),
          readSelectedAudioSource(selectedSource),
          getLatestSession(),
        ]);

        if (disposed) {
          return;
        }

        const fallbackStatus = latestSession ? mapSessionStatusToAudioStatus(latestSession.status) : 'Idle';
        const nextStatus = snapshot?.status ?? fallbackStatus;
        const liveTranscript = snapshot?.transcript ?? '';

        setStatus(nextStatus);
        setSelectedDeviceId(snapshot?.selectedDeviceId ?? persistedDeviceId);
        setSelectedSource(snapshot?.selectedSource ?? persistedAudioSource);
        setTranscriptText(liveTranscript || latestSession?.transcript || '');
        if (snapshot?.diagnostics) {
          setRecordingDiagnostics(snapshot.diagnostics);
        }
      } catch (syncError) {
        if (disposed) {
          return;
        }

        const message = syncError instanceof Error ? syncError.message : String(syncError);
        setStatus('Error');
        setError(message);
      }
    };

    const handleRuntimeMessage = (message: RuntimeEventMessage) => {
      if (message.type === 'STATUS_UPDATE') {
        setStatus(message.payload.status);
        setSelectedDeviceId(message.payload.selectedDeviceId);
        setSelectedSource(message.payload.selectedSource);
        setRecordingDiagnostics(message.payload.diagnostics);

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
  }, [activeView]);

  useEffect(() => {
    if (activeView !== 'notes') {
      return;
    }

    loadNotesSessions();
  }, [activeView]);

  useEffect(() => {
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
  }, []);

  useEffect(() => {
    return () => {
      if (exportToastTimerRef.current !== null) {
        window.clearTimeout(exportToastTimerRef.current);
      }
    };
  }, []);

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
    } catch (sourceError) {
      const message = sourceError instanceof Error ? sourceError.message : 'Unable to switch audio source.';
      setStatus('Error');
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

  const handleThemeChange = async (theme: UITheme) => {
    setUITheme(theme);
    await persistUITheme(theme);
  };

  const handleLanguageChange = async (lang: UILang) => {
    setUILang(lang);
    await persistUILang(lang);
  };

  const handleClearSessionData = async () => {
    setError(null);

    try {
      await clearSessions();
      setTranscriptText('');
      setStatus('Idle');
      setNotesSessions([]);
      setSelectedSessionId(null);
    } catch (clearError) {
      const message = clearError instanceof Error ? clearError.message : 'Unable to clear local session data.';
      setError(message);
    }
  };

  const handleExportSession = async (format: 'txt' | 'md') => {
    const session = notesSessions.find((s) => s.id === selectedSessionId) ?? notesSessions[0];
    if (!session) {
      return;
    }

    try {
      setNotesError(null);

      const exportContent = format === 'txt' ? buildTxtExport(session) : buildMarkdownExport(session);
      const mimeType = 'text/plain;charset=utf-8';
      const fileName = getExportFileName(session, format);

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

  return (
    <main className="popup" data-theme={uiTheme}>
      <header className="popup__header">
        <div className="popup__brand">
          <h1>{t('appTitle')}</h1>
          <p className="subtitle subtitle--compact">{t('subtitle')}</p>
        </div>
      </header>

      <section className="segment-control" aria-label="Sections">
        <button
          className={`segment-control__button ${activeView === 'transcription' ? 'segment-control__button--active' : ''}`}
          onClick={() => setActiveView('transcription')}
          type="button"
        >
          {t('tabsTranscription')}
        </button>
        <button
          className={`segment-control__button ${activeView === 'notes' ? 'segment-control__button--active' : ''}`}
          onClick={() => setActiveView('notes')}
          type="button"
        >
          {t('tabsNotes')}
        </button>
        <button
          className={`segment-control__button ${activeView === 'settings' ? 'segment-control__button--active' : ''}`}
          onClick={() => setActiveView('settings')}
          type="button"
        >
          {t('tabsSettings')}
        </button>
      </section>

      {activeView === 'transcription' ? (
        <TranscriptionView
          status={status}
          recordingDiagnostics={recordingDiagnostics}
          sttStatusLine={sttStatusLine}
          isRecordingActive={isRecordingActive}
          isAudioSourceLocked={isAudioSourceLocked}
          isMicrophoneLocked={isMicrophoneLocked}
          selectedSource={selectedSource}
          selectedDeviceId={selectedDeviceId}
          devices={devices}
          transcriptText={transcriptText}
          error={error}
          t={t}
          onStartListening={handleStartListening}
          onStopListening={handleStopListening}
          onSourceChange={handleSourceChange}
          onDeviceChange={handleDeviceChange}
          onLearnMoreClick={() => setActiveView('settings')}
        />
      ) : null}

      {activeView === 'notes' ? (
        <NotesView
          sessions={notesSessions}
          selectedSessionId={selectedSessionId}
          loading={notesLoading}
          error={notesError}
          search={notesSearch}
          exportToast={exportToast}
          t={t}
          onRefresh={loadNotesSessions}
          onClearData={handleClearSessionData}
          onSearchChange={setNotesSearch}
          onSelectSession={setSelectedSessionId}
          onExport={handleExportSession}
        />
      ) : null}

      {activeView === 'settings' ? (
        <SettingsView
          uiTheme={uiTheme}
          uiLang={uiLang}
          sttStatusLine={sttStatusLine}
          t={t}
          onThemeChange={(theme) => void handleThemeChange(theme)}
          onLanguageChange={(lang) => void handleLanguageChange(lang)}
          onOpenSettings={() => void handleOpenSettings()}
        />
      ) : null}

      {exportToast ? <p className="toast">{exportToast}</p> : null}
    </main>
  );
}

export default App;
