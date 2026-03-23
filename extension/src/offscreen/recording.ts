import {
  appendRecordingChunk,
  createRecordingSession,
  createSession,
  updateRecordingSession,
  updateSessionState,
} from '../db/indexeddb';
import { state, inMemoryApiKey, inMemoryDeepgramApiKey, inMemorySiliconflowApiKey, activeProvider, setInMemoryApiKey, setInMemoryDeepgramApiKey, setActiveProvider, updateStatus, publishError, computeDiagnostics, broadcast, refreshSttRuntimeSettings, resetLiveCumulativeAudioOffset } from './state';
import type { AudioSource } from './state';
import { CHUNK_TIMESLICE_MS, MAX_RECORDING_DURATION_MS, MAX_RECORDING_SIZE_BYTES } from './constants';
import { transcribeRecordingInSegments } from './segmentation';
import { enqueueChunkForLiveTranscription, flushLiveTranscribeQueue, retryFailedBatches, resetLiveTranscribeState } from './live-transcribe';

export async function setRecordingSessionError(sessionId: string): Promise<void> {
  try {
    const updated = await updateRecordingSession(sessionId, {
      status: 'error',
      stopTime: Date.now(),
    });
    if (updated) {
      state.recordingSession = updated;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[recording-store] failed to set session error status sessionId=${sessionId} error=${message}`);
  }
}

export async function persistChunk(blob: Blob): Promise<void> {
  const recordingSession = state.recordingSession;
  if (!recordingSession) {
    return;
  }

  const chunkSeq = state.nextChunkSeq;

  try {
    await appendRecordingChunk({
      id: `${recordingSession.sessionId}:${chunkSeq}`,
      sessionId: recordingSession.sessionId,
      seq: chunkSeq,
      createdAt: Date.now(),
      bytes: blob.size,
      mimeType: blob.type || recordingSession.mimeType || 'audio/webm',
      blob,
    });

    const updated = await updateRecordingSession(recordingSession.sessionId, {
      totalBytes: recordingSession.totalBytes + blob.size,
      chunkCount: recordingSession.chunkCount + 1,
    });

    if (updated) {
      state.recordingSession = updated;
    }

    state.nextChunkSeq += 1;
    state.seq = chunkSeq;
    updateStatus(state.status, state.detail);

    enqueueChunkForLiveTranscription(blob, chunkSeq, Date.now());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[recording-store] failed to persist chunk sessionId=${recordingSession.sessionId} seq=${chunkSeq} error=${message}`);
    await setRecordingSessionError(recordingSession.sessionId);
    publishError('Failed to persist recording chunk to IndexedDB.');
  }
}

function chooseRecorderMimeType(): string | undefined {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm'];

  for (const mimeType of candidates) {
    if (MediaRecorder.isTypeSupported(mimeType)) {
      return mimeType;
    }
  }

  return undefined;
}

async function stopTracks(): Promise<void> {
  if (state.activeInputStream) {
    state.activeInputStream.getTracks().forEach((track) => track.stop());
    state.activeInputStream = null;
  }

  if (state.activeStream) {
    state.activeStream.getTracks().forEach((track) => track.stop());
  }

  state.playbackSourceNode?.disconnect();
  state.playbackDestinationNode?.disconnect();
  state.playbackSourceNode = null;
  state.playbackDestinationNode = null;

  if (state.playbackContext) {
    if (state.playbackContext.state !== 'closed') {
      await state.playbackContext.close();
    }
    state.playbackContext = null;
  }

  state.activeStream = null;
}

function startDiagnosticsTimer(): void {
  if (state.diagnosticsTimerId !== null) {
    clearInterval(state.diagnosticsTimerId);
  }

  state.diagnosticsTimerId = window.setInterval(() => {
    if (state.status === 'Listening') {
      updateStatus(state.status, state.detail);

      // Auto-stop on limits
      const session = state.recordingSession;
      if (session) {
        const elapsed = Date.now() - session.startTime;
        if (elapsed >= MAX_RECORDING_DURATION_MS) {
          console.info(`[recording] auto-stop: max duration reached (${Math.round(elapsed / 60000)}min)`);
          void stopRecording();
          return;
        }
        if (session.totalBytes >= MAX_RECORDING_SIZE_BYTES) {
          console.info(`[recording] auto-stop: max size reached (${(session.totalBytes / (1024 * 1024)).toFixed(0)}MB)`);
          void stopRecording();
          return;
        }
      }
    }
  }, 1000);
}

function stopDiagnosticsTimer(): void {
  if (state.diagnosticsTimerId !== null) {
    clearInterval(state.diagnosticsTimerId);
    state.diagnosticsTimerId = null;
  }
}

async function getTabAudioStream(streamId: string): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
          suppressLocalAudioPlayback: false,
        },
      } as MediaTrackConstraints,
      video: false,
    });
  } catch (err) {
    console.error('STT tab getUserMedia failed', err);
    throw err;
  }
}

async function getAudioStream(source: AudioSource, streamId?: string): Promise<MediaStream> {
  if (source === 'tab' || source === 'mix') {
    if (!streamId) {
      throw new Error('Missing tab capture stream id. Start from the popup Start button.');
    }

    const tabStream = await getTabAudioStream(streamId);
    state.activeInputStream = tabStream;

    const [tabTrack] = tabStream.getAudioTracks();
    console.info(
      `STT: tab stream acquired id=${tabStream.id} trackCount=${tabStream.getAudioTracks().length} trackEnabled=${tabTrack?.enabled ?? false} trackMuted=${tabTrack?.muted ?? true} trackReadyState=${tabTrack?.readyState ?? 'none'}`,
    );

    const context = new AudioContext();
    const tabSourceNode = context.createMediaStreamSource(tabStream);
    const destinationNode = context.createMediaStreamDestination();

    tabSourceNode.connect(destinationNode);
    tabSourceNode.connect(context.destination);

    let micStream: MediaStream | null = null;

    if (source === 'mix') {
      const audioConstraint = state.selectedDeviceId === 'default' ? true : { deviceId: { exact: state.selectedDeviceId } };
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraint,
        video: false,
      });

      const [micTrack] = micStream.getAudioTracks();
      console.info(
        `STT: mic stream for mix acquired id=${micStream.id} trackCount=${micStream.getAudioTracks().length} trackEnabled=${micTrack?.enabled ?? false} trackMuted=${micTrack?.muted ?? true} trackReadyState=${micTrack?.readyState ?? 'none'}`,
      );

      const micSourceNode = context.createMediaStreamSource(micStream);
      micSourceNode.connect(destinationNode);
    }

    state.activeInputStream = new MediaStream([
      ...tabStream.getTracks(),
      ...(micStream ? micStream.getTracks() : []),
    ]);

    state.playbackContext = context;
    state.playbackSourceNode = tabSourceNode;
    state.playbackDestinationNode = destinationNode;

    const [recorderTrack] = destinationNode.stream.getAudioTracks();
    console.info(
      `STT: ${source} recording pipeline ready context=${context.state} recorderTrackCount=${destinationNode.stream.getAudioTracks().length} recorderTrackEnabled=${recorderTrack?.enabled ?? false} recorderTrackMuted=${recorderTrack?.muted ?? true}`,
    );

    return destinationNode.stream;
  }

  const audioConstraint = state.selectedDeviceId === 'default' ? true : { deviceId: { exact: state.selectedDeviceId } };

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: audioConstraint,
    video: false,
  });

  const [micTrack] = stream.getAudioTracks();
  console.info(
    `STT: mic stream acquired id=${stream.id} trackCount=${stream.getAudioTracks().length} trackEnabled=${micTrack?.enabled ?? false} trackMuted=${micTrack?.muted ?? true} trackReadyState=${micTrack?.readyState ?? 'none'}`,
  );

  return stream;
}

export async function stopRecording(): Promise<void> {
  const recorder = state.recorder;
  state.recorder = null;

  if (recorder && recorder.state !== 'inactive') {
    const stopDataPromise = new Promise<Blob | null>((resolve) => {
      recorder.addEventListener(
        'dataavailable',
        (event) => {
          resolve(event.data);
        },
        { once: true },
      );
    });

    // Clear the original handler BEFORE requestData so only the once-listener
    // above handles the event.  Without this, both the original ondataavailable
    // handler AND the once-listener fire, causing the same blob to be persisted
    // (and enqueued for live transcription) twice.
    recorder.ondataavailable = null;

    recorder.requestData();
    const finalChunk = await stopDataPromise;
    if (finalChunk && finalChunk.size > 0) {
      await persistChunk(finalChunk);
    }
  }

  if (recorder && recorder.state !== 'inactive') {
    recorder.onerror = null;
    recorder.onstop = null;
    recorder.stop();
  }

  const recordingSession = state.recordingSession;

  // Capture keys BEFORE any cleanup so retryFailedBatches can use them
  const capturedKeys = {
    apiKey: inMemoryApiKey,
    deepgramKey: inMemoryDeepgramApiKey,
    siliconflowKey: inMemorySiliconflowApiKey,
    provider: activeProvider,
  };

  let transcriptionFailed = false;

  // Flush any remaining live transcription chunks.
  // This now awaits any in-flight processLiveTranscribeQueue before draining,
  // which fixes the race condition where the last batch was lost.
  await flushLiveTranscribeQueue();

  // Retry any batches that failed during live transcription
  if (state.liveFailedBatches.length > 0) {
    updateStatus('Transcribing', `Recovering ${state.liveFailedBatches.length} failed segment(s)...`);
    await retryFailedBatches(capturedKeys);
  }

  const hasLiveTranscript = state.transcript.trim().length > 0;

  if (recordingSession && recordingSession.chunkCount > 0 && !hasLiveTranscript) {
    // Only run batch transcription if live transcription didn't produce results
    updateStatus('Transcribing', 'Transcribing recording...');

    try {
      const recorderMimeType = recorder?.mimeType || recordingSession.mimeType || 'audio/webm';
      await transcribeRecordingInSegments(recordingSession, recorderMimeType);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      transcriptionFailed = true;
      publishError(`Recording failed: ${message}`);
    }
  } else if (recordingSession && recordingSession.chunkCount > 0 && hasLiveTranscript) {
    console.info(`[recording] skipping batch transcription, live transcript available (${state.transcript.length} chars)`);
  }

  await stopTracks();
  state.useMockTranscription = false;
  setInMemoryApiKey(null);
  setInMemoryDeepgramApiKey(null);
  setActiveProvider('mock');

  if (recordingSession) {
    try {
      const updated = await updateRecordingSession(recordingSession.sessionId, {
        stopTime: Date.now(),
        status: state.status === 'Error' ? 'error' : 'stopped',
      });
      if (updated) {
        state.recordingSession = updated;
      }

      const diagnostics = computeDiagnostics();
      const summarySession = state.recordingSession ?? recordingSession;
      console.info(
        `[recording-summary] sessionId=${summarySession.sessionId} durationSec=${diagnostics.durationSec} chunks=${summarySession.chunkCount} totalBytes=${summarySession.totalBytes} totalMB=${diagnostics.totalMB.toFixed(2)} mbPerMin=${diagnostics.mbPerMin.toFixed(2)} estMinTo25MB=${diagnostics.estMinTo25MB === null ? 'n/a' : diagnostics.estMinTo25MB.toFixed(1)} mime=${summarySession.mimeType || 'unknown'} timesliceMs=${summarySession.timesliceMs}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[recording-store] failed to finalize recording session sessionId=${recordingSession.sessionId} error=${message}`);
    }
  }

  if (state.activeSessionId) {
    void updateSessionState(state.activeSessionId, {
      endedAt: Date.now(),
      status: transcriptionFailed ? 'error' : 'stopped',
    });
    state.activeSessionId = null;
  }

  stopDiagnosticsTimer();
  state.recordingSession = null;
  state.nextChunkSeq = 1;

  if (!transcriptionFailed && state.status !== 'Error') {
    updateStatus('Stopped', 'Stopped');
  }
}

export async function startRecording(deviceId?: string, source: AudioSource = 'mic', streamId?: string): Promise<void> {
  if (deviceId) {
    state.selectedDeviceId = deviceId;
  }

  state.selectedSource = source;

  await stopRecording();

  state.seq = 0;
  state.transcript = '';
  state.liveTranscribeQueue = [];
  state.liveTranscribeRunning = false;
  state.liveFailedBatches = [];
  state.webmHeader = null;
  state.webmHeaderExtracted = false;
  resetLiveCumulativeAudioOffset();
  resetLiveTranscribeState();

  broadcast({
    type: 'TRANSCRIPT_UPDATE',
    payload: {
      seq: 0,
      text: '',
      transcript: '',
    },
  });

  const stream = await getAudioStream(state.selectedSource, streamId);
  await refreshSttRuntimeSettings();

  const sessionId = crypto.randomUUID();
  state.activeSessionId = sessionId;
  await createSession({
    id: sessionId,
    startedAt: Date.now(),
    source: state.selectedSource,
    deviceId: state.selectedDeviceId,
    status: 'listening',
  });

  state.activeStream = stream;

  const selectedMimeType = chooseRecorderMimeType();
  const recorder = selectedMimeType ? new MediaRecorder(stream, { mimeType: selectedMimeType }) : new MediaRecorder(stream);
  const recorderMimeType = recorder.mimeType || selectedMimeType || 'audio/webm';
  console.info(`STT: recorder mimeType=${recorder.mimeType || 'default'}`);

  state.recordingSession = {
    sessionId,
    startTime: Date.now(),
    status: 'recording',
    totalBytes: 0,
    chunkCount: 0,
    mimeType: recorderMimeType,
    timesliceMs: CHUNK_TIMESLICE_MS,
  };
  state.nextChunkSeq = 1;
  state.transcribedChunks = 0;
  state.totalChunksToTranscribe = 0;

  try {
    await createRecordingSession(state.recordingSession);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[recording-store] failed to create recording session sessionId=${sessionId} error=${message}`);
    await setRecordingSessionError(sessionId);
    throw new Error('Failed to create recording session in IndexedDB.');
  }

  recorder.ondataavailable = (event) => {
    const blob = event.data;
    if (!blob || blob.size === 0) {
      return;
    }

    void persistChunk(blob);
  };

  recorder.onerror = () => {
    publishError('Audio recorder error.');
  };

  recorder.onstop = () => {
    if (state.recorder === recorder) {
      state.recorder = null;
    }
  };

  recorder.start(CHUNK_TIMESLICE_MS);

  state.recorder = recorder;
  startDiagnosticsTimer();
  const sourceDetail =
    state.selectedSource === 'tab' ? 'active tab audio' : state.selectedSource === 'mix' ? `tab + mic (${state.selectedDeviceId})` : state.selectedDeviceId;
  updateStatus('Listening', `Listening on ${sourceDetail}`);
}
