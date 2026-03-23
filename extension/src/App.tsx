import { useEffect, useReducer, useRef } from 'react';
import { clearSessions, deleteSession, getLatestSession, listSessions, updateSessionAiSummary } from './db/indexeddb';
import { loadSettings } from './settings';
import type { AudioSource, RuntimeEventMessage } from './types';
import { createTranslator } from './i18n';
import { normalizeAudioSource, isRecordingActiveStatus, getExportFileName } from './utils/format';
import { buildTxtExport, buildMarkdownExport, buildSrtExport, downloadTextFile } from './utils/export';
import { generateSummary } from './stt/llm';
import {
  readSelectedDeviceId,
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
import { appReducer, initialState } from './state/reducer';

function App() {
  const [state, dispatch] = useReducer(appReducer, initialState);
  const exportToastTimerRef = useRef<number | null>(null);
  const previousAudioSourceLockedRef = useRef<boolean | null>(null);

  const {
    error, warning, activeView, status, recordingDiagnostics,
    devices, selectedDeviceId, selectedSource,
    notesSessions, selectedSessionId,
    notesLoading, notesError, notesSearch, exportToast,
    summaryLoading, uiTheme, uiLang,
  } = state;

  const t = createTranslator(uiLang);

  const isRecordingActive = isRecordingActiveStatus(status);
  const isAudioSourceLocked = isRecordingActive;
  const isMicrophoneLocked = selectedSource === 'tab' || isRecordingActive;

  const loadNotesSessions = async () => {
    dispatch({ type: 'SET_NOTES_LOADING', payload: true });
    dispatch({ type: 'SET_NOTES_ERROR', payload: null });

    try {
      const sessions = await listSessions();
      dispatch({ type: 'SET_NOTES_SESSIONS', payload: sessions });
      if (sessions.length === 0) {
        dispatch({ type: 'SET_SELECTED_SESSION', payload: null });
        return;
      }

      if (!selectedSessionId || !sessions.some((s) => s.id === selectedSessionId)) {
        dispatch({ type: 'SET_SELECTED_SESSION', payload: sessions[0].id });
      }
    } catch (notesLoadError) {
      const message = notesLoadError instanceof Error ? notesLoadError.message : 'Unable to load notes.';
      dispatch({ type: 'SET_NOTES_ERROR', payload: message });
    } finally {
      dispatch({ type: 'SET_NOTES_LOADING', payload: false });
    }
  };

  useEffect(() => {
    Promise.all([loadSettings(), getSttDiagnosticsFromRuntime(), readUITheme(), readUILang()]).then(
      ([settings, sttSummary, savedTheme, savedLang]) => {
        dispatch({ type: 'SET_STT_STATUS_LINE', payload: { providerLabel: sttSummary.providerLabel, configured: sttSummary.configurationLabel === 'Configured' } });
        if (sttSummary.error) {
          dispatch({ type: 'SET_ERROR', payload: sttSummary.error });
        }
        dispatch({ type: 'SET_SELECTED_SOURCE', payload: normalizeAudioSource(settings.defaultSource) });
        dispatch({ type: 'SET_UI_THEME', payload: savedTheme });
        dispatch({ type: 'SET_UI_LANG', payload: savedLang });
      },
    );
  }, []);

  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) {
      return;
    }

    const onStorageChange: Parameters<typeof chrome.storage.onChanged.addListener>[0] = (changes, areaName) => {
      if (areaName !== 'local') return;
      if (changes[UI_THEME_STORAGE_KEY]) {
        dispatch({ type: 'SET_UI_THEME', payload: changes[UI_THEME_STORAGE_KEY].newValue === 'dark' ? 'dark' : 'light' });
      }
      if (changes[UI_LANG_STORAGE_KEY]) {
        dispatch({ type: 'SET_UI_LANG', payload: changes[UI_LANG_STORAGE_KEY].newValue === 'zh' ? 'zh' : 'en' });
      }
    };

    chrome.storage.onChanged.addListener(onStorageChange);
    return () => { chrome.storage.onChanged.removeListener(onStorageChange); };
  }, []);

  useEffect(() => {
    if (previousAudioSourceLockedRef.current === isAudioSourceLocked) return;
    previousAudioSourceLockedRef.current = isAudioSourceLocked;
    console.info(`Audio source selector ${isAudioSourceLocked ? 'locked' : 'unlocked'}.`);
  }, [isAudioSourceLocked]);

  useEffect(() => {
    if (typeof chrome === 'undefined') return;

    let disposed = false;

    const syncState = async () => {
      try {
        await ensureOffscreenDocument();
        const settings = await loadSettings();
        const defaultSource = normalizeAudioSource(settings.defaultSource);
        const [snapshot, persistedDeviceId, latestSession] = await Promise.all([
          queryStateFromOffscreen(),
          readSelectedDeviceId(),
          getLatestSession(),
        ]);

        if (disposed) return;

        const fallbackStatus = latestSession ? mapSessionStatusToAudioStatus(latestSession.status) : 'Idle';
        const liveTranscript = snapshot?.transcript ?? '';
        const isRecording = snapshot?.status && snapshot.status !== 'Idle' && snapshot.status !== 'Stopped' && snapshot.status !== 'Error';

        dispatch({
          type: 'SYNC_RECORDING_STATE',
          payload: {
            status: snapshot?.status ?? fallbackStatus,
            selectedDeviceId: snapshot?.selectedDeviceId ?? persistedDeviceId,
            selectedSource: isRecording ? (snapshot?.selectedSource ?? defaultSource) : defaultSource,
            transcriptText: liveTranscript || latestSession?.transcript || '',
            ...(snapshot?.diagnostics ? { recordingDiagnostics: snapshot.diagnostics } : {}),
          },
        });
      } catch (syncError) {
        if (disposed) return;
        const message = syncError instanceof Error ? syncError.message : String(syncError);
        dispatch({ type: 'SET_STATUS', payload: 'Error' });
        dispatch({ type: 'SET_ERROR', payload: message });
      }
    };

    const handleRuntimeMessage = (message: RuntimeEventMessage) => {
      if (message.type === 'STATUS_UPDATE') {
        dispatch({
          type: 'SYNC_RECORDING_STATE',
          payload: {
            status: message.payload.status,
            selectedDeviceId: message.payload.selectedDeviceId,
            selectedSource: message.payload.selectedSource,
            recordingDiagnostics: message.payload.diagnostics,
          },
        });

        if (activeView === 'notes' && (message.payload.status === 'Idle' || message.payload.status === 'Stopped')) {
          void loadNotesSessions();
        }
        return;
      }

      if (message.type === 'TRANSCRIPT_UPDATE') {
        dispatch({ type: 'SET_TRANSCRIPT', payload: message.payload.transcript });
        return;
      }

      if (message.type === 'ERROR') {
        dispatch({ type: 'SET_ERROR', payload: message.payload.message });
      }

      if (message.type === 'WARNING') {
        dispatch({ type: 'SET_WARNING', payload: message.payload.message });
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
    if (activeView !== 'notes') return;
    loadNotesSessions();
  }, [activeView]);

  useEffect(() => {
    const refreshDevices = async () => {
      try {
        const mediaDevices = await navigator.mediaDevices.enumerateDevices();
        const microphoneDevices = mediaDevices.filter((device) => device.kind === 'audioinput');
        if (microphoneDevices.length > 0) {
          dispatch({
            type: 'SET_DEVICES',
            payload: [
              { id: 'default', label: 'System default microphone' },
              ...microphoneDevices.map((device, index) => ({
                id: device.deviceId,
                label: device.label || `Microphone ${index + 1}`,
              })),
            ],
          });
        } else {
          dispatch({
            type: 'SET_DEVICES',
            payload: [{ id: 'default', label: 'System default microphone' }],
          });
        }
      } catch (deviceError) {
        dispatch({
          type: 'SET_DEVICES',
          payload: [{ id: 'default', label: 'System default microphone' }],
        });
      }
    };

    refreshDevices();
    const onDeviceChange = () => { refreshDevices(); };
    navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
    return () => { navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange); };
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
        | { type: 'START_RECORDING'; payload?: { deviceId?: string; source?: AudioSource; streamId?: string } }
      | { type: 'STOP_RECORDING' }
      | { type: 'REFRESH_SETTINGS' },
  ) => {
    const sendMessage = chrome.runtime?.sendMessage as ((payload: typeof message) => Promise<{ ok?: boolean; error?: string }>) | undefined;
    if (!sendMessage) return;
    const result = await sendMessage(message);
    if (result?.ok === false) {
      throw new Error(result.error ?? 'Unknown runtime error');
    }
  };

  const handleStartListening = async () => {
    dispatch({ type: 'SET_ERROR', payload: null });

    try {
      // Chrome extensions cannot trigger the microphone permission prompt from
      // popup or offscreen contexts.  Check the current permission state and, if
      // not yet granted, open a dedicated tab that can show the native prompt.
      if (selectedSource === 'mic' || selectedSource === 'mix') {
        const permStatus = await navigator.permissions.query({ name: 'microphone' as PermissionName });
        if (permStatus.state !== 'granted') {
          const permPageUrl = chrome.runtime.getURL('src/mic-permission.html');
          // Wait for the permission result before continuing.
          await new Promise<void>((resolve, reject) => {
            const onMessage = (msg: { type?: string; granted?: boolean }) => {
              if (msg?.type === 'MIC_PERMISSION_RESULT') {
                chrome.runtime.onMessage.removeListener(onMessage);
                if (msg.granted) {
                  resolve();
                } else {
                  reject(new Error('Microphone permission was denied. Please allow microphone access and try again.'));
                }
              }
            };
            chrome.runtime.onMessage.addListener(onMessage);
            chrome.tabs.create({ url: permPageUrl });
          });
        }
      }

      let streamId: string | undefined;
      if (selectedSource === 'tab' || selectedSource === 'mix') {
        streamId = await new Promise<string>((resolve, reject) => {
          if (!chrome.tabCapture?.getMediaStreamId) {
            reject(new Error('Tab audio capture is not available in this browser.'));
            return;
          }
          chrome.tabCapture.getMediaStreamId({ targetTabId: undefined }, (capturedStreamId) => {
            const runtimeError = chrome.runtime.lastError;
            if (runtimeError) { reject(new Error(runtimeError.message)); return; }
            if (!capturedStreamId) { reject(new Error('Unable to capture active tab audio stream.')); return; }
            resolve(capturedStreamId);
          });
        });
      }

      await ensureOffscreenDocument();
      await sendControlMessage({ type: 'REFRESH_SETTINGS' });
      await sendControlMessage({
        type: 'START_RECORDING',
        payload: { deviceId: selectedDeviceId, source: selectedSource, streamId },
      });
    } catch (startError) {
      const message = startError instanceof Error ? startError.message : 'Unable to start recording.';
      dispatch({ type: 'SET_STATUS', payload: 'Error' });
      dispatch({ type: 'SET_ERROR', payload: message });
    }
  };

  const handleSourceChange = async (source: AudioSource) => {
    if (isRecordingActive) return;
    dispatch({ type: 'SET_ERROR', payload: null });
    try {
      dispatch({ type: 'SET_SELECTED_SOURCE', payload: source });
      await persistSelectedAudioSource(source);
    } catch (sourceError) {
      const message = sourceError instanceof Error ? sourceError.message : 'Unable to switch audio source.';
      dispatch({ type: 'SET_STATUS', payload: 'Error' });
      dispatch({ type: 'SET_ERROR', payload: message });
    }
  };

  const handleStopListening = async () => {
    dispatch({ type: 'SET_ERROR', payload: null });
    try {
      await ensureOffscreenDocument();
      await sendControlMessage({ type: 'STOP_RECORDING' });
    } catch (stopError) {
      const message = stopError instanceof Error ? stopError.message : 'Unable to stop recording.';
      dispatch({ type: 'SET_STATUS', payload: 'Error' });
      dispatch({ type: 'SET_ERROR', payload: message });
    }
  };

  const handleDeviceChange = async (deviceId: string) => {
    dispatch({ type: 'SET_ERROR', payload: null });
    try {
      dispatch({ type: 'SET_SELECTED_DEVICE', payload: deviceId });
      await persistSelectedDeviceId(deviceId);
      if (status === 'Listening' || status === 'Transcribing') {
        await handleStartListening();
      }
    } catch (deviceError) {
      const message = deviceError instanceof Error ? deviceError.message : 'Unable to switch microphone.';
      dispatch({ type: 'SET_STATUS', payload: 'Error' });
      dispatch({ type: 'SET_ERROR', payload: message });
    }
  };

  const handleOpenSettings = async () => {
    if (chrome.runtime?.openOptionsPage) {
      await chrome.runtime.openOptionsPage();
      return;
    }
    window.open(chrome.runtime.getURL('options.html'), '_blank');
  };

  const handleThemeChange = async (theme: typeof uiTheme) => {
    dispatch({ type: 'SET_UI_THEME', payload: theme });
    await persistUITheme(theme);
  };

  const handleLanguageChange = async (lang: typeof uiLang) => {
    dispatch({ type: 'SET_UI_LANG', payload: lang });
    await persistUILang(lang);
  };

  const handleClearSessionData = async () => {
    dispatch({ type: 'SET_ERROR', payload: null });
    try {
      await clearSessions();
      dispatch({ type: 'CLEAR_ALL_SESSIONS' });
    } catch (clearError) {
      const message = clearError instanceof Error ? clearError.message : 'Unable to clear local session data.';
      dispatch({ type: 'SET_ERROR', payload: message });
    }
  };

  const handleDeleteSession = async (sessionId: string) => {
    try {
      await deleteSession(sessionId);
      dispatch({ type: 'DELETE_SESSION', payload: sessionId });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to delete session.';
      dispatch({ type: 'SET_NOTES_ERROR', payload: message });
    }
  };

  const handleSummarize = async (sessionId: string) => {
    const session = notesSessions.find((s) => s.id === sessionId);
    if (!session || !session.transcript) return;

    dispatch({ type: 'SET_SUMMARY_LOADING', payload: true });
    try {
      const settings = await loadSettings();
      const provider = settings.stt.provider;

      let llmSettings: { apiKey: string; endpoint?: string; model?: string };
      if (provider === 'siliconflow') {
        const apiKey = settings.stt.siliconflowApiKey?.trim();
        if (!apiKey) {
          dispatch({ type: 'SET_NOTES_ERROR', payload: t('summaryError') });
          return;
        }
        llmSettings = {
          apiKey,
          endpoint: 'https://api.siliconflow.cn/v1/chat/completions',
          model: 'Qwen/Qwen2.5-7B-Instruct',
        };
      } else {
        const apiKey = settings.stt.apiKey?.trim();
        if (!apiKey) {
          dispatch({ type: 'SET_NOTES_ERROR', payload: t('summaryError') });
          return;
        }
        llmSettings = { apiKey };
      }

      const result = await generateSummary(session.transcript, llmSettings, uiLang);
      const aiSummary = { ...result, generatedAt: Date.now() };
      await updateSessionAiSummary(sessionId, aiSummary);
      dispatch({ type: 'UPDATE_SESSION', payload: { id: sessionId, updates: { aiSummary } } });
    } catch (err) {
      const message = err instanceof Error ? err.message : t('summaryError');
      dispatch({ type: 'SET_NOTES_ERROR', payload: message });
    } finally {
      dispatch({ type: 'SET_SUMMARY_LOADING', payload: false });
    }
  };

  const handleExportSession = async (format: 'txt' | 'md' | 'srt') => {
    const session = notesSessions.find((s) => s.id === selectedSessionId) ?? notesSessions[0];
    if (!session) return;

    try {
      dispatch({ type: 'SET_NOTES_ERROR', payload: null });
      const exportContent =
        format === 'srt' ? buildSrtExport(session)
        : format === 'md' ? buildMarkdownExport(session)
        : buildTxtExport(session);
      const mimeType = 'text/plain;charset=utf-8';
      const fileName = getExportFileName(session, format);

      await downloadTextFile(fileName, mimeType, exportContent);
      dispatch({ type: 'SET_EXPORT_TOAST', payload: `Downloaded: ${fileName}` });
      if (exportToastTimerRef.current !== null) {
        window.clearTimeout(exportToastTimerRef.current);
      }
      exportToastTimerRef.current = window.setTimeout(() => {
        dispatch({ type: 'SET_EXPORT_TOAST', payload: null });
      }, 2000);
    } catch (exportError) {
      const message = exportError instanceof Error ? exportError.message : 'Unable to export this session.';
      dispatch({ type: 'SET_NOTES_ERROR', payload: message });
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
          onClick={() => dispatch({ type: 'SET_ACTIVE_VIEW', payload: 'transcription' })}
          type="button"
        >
          {t('tabsTranscription')}
        </button>
        <button
          className={`segment-control__button ${activeView === 'notes' ? 'segment-control__button--active' : ''}`}
          onClick={() => dispatch({ type: 'SET_ACTIVE_VIEW', payload: 'notes' })}
          type="button"
        >
          {t('tabsNotes')}
        </button>
        <button
          className={`segment-control__button ${activeView === 'settings' ? 'segment-control__button--active' : ''}`}
          onClick={() => dispatch({ type: 'SET_ACTIVE_VIEW', payload: 'settings' })}
          type="button"
        >
          {t('tabsSettings')}
        </button>
      </section>

      {activeView === 'transcription' ? (
        <TranscriptionView
          status={status}
          recordingDiagnostics={recordingDiagnostics}
          isRecordingActive={isRecordingActive}
          isAudioSourceLocked={isAudioSourceLocked}
          isMicrophoneLocked={isMicrophoneLocked}
          selectedSource={selectedSource}
          selectedDeviceId={selectedDeviceId}
          devices={devices}
          error={error}
          warning={warning}
          t={t}
          onStartListening={handleStartListening}
          onStopListening={handleStopListening}
          onSourceChange={handleSourceChange}
          onDeviceChange={handleDeviceChange}
          onLearnMoreClick={() => dispatch({ type: 'SET_ACTIVE_VIEW', payload: 'settings' })}
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
          summaryLoading={summaryLoading}
          t={t}
          onRefresh={loadNotesSessions}
          onClearData={handleClearSessionData}
          onSearchChange={(v) => dispatch({ type: 'SET_NOTES_SEARCH', payload: v })}
          onSelectSession={(id) => dispatch({ type: 'SET_SELECTED_SESSION', payload: id })}
          onExport={handleExportSession}
          onSummarize={handleSummarize}
          onDeleteSession={handleDeleteSession}
        />
      ) : null}

      {activeView === 'settings' ? (
        <SettingsView
          uiTheme={uiTheme}
          uiLang={uiLang}
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
