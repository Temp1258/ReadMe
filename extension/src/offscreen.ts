export {};

type AudioStatus = 'Idle' | 'Recording' | 'Error';

type RuntimeMessage =
  | { type: 'PING' }
  | { type: 'GET_AUDIO_STATE' }
  | { type: 'START_RECORDING'; payload?: { deviceId?: string } }
  | { type: 'STOP_RECORDING' };

type RuntimeEventMessage =
  | { type: 'AUDIO_CHUNK'; payload: { seq: number; ts: number; mimeType: string; size: number; dataBase64: string } }
  | { type: 'STATUS_UPDATE'; payload: { status: AudioStatus; detail?: string; selectedDeviceId: string; seq: number } }
  | { type: 'ERROR'; payload: { message: string } };

const CHUNK_TIMESLICE_MS = 1000;

const state = {
  status: 'Idle' as AudioStatus,
  detail: 'Idle',
  selectedDeviceId: 'default',
  seq: 0,
  activeStream: null as MediaStream | null,
  recorder: null as MediaRecorder | null,
};

function broadcast(message: RuntimeEventMessage): void {
  if (!chrome.runtime?.id) {
    return;
  }

  chrome.runtime.sendMessage(message).catch(() => {
    // Popup may not be open.
  });
}

function updateStatus(status: AudioStatus, detail?: string): void {
  state.status = status;
  state.detail = detail ?? status;

  broadcast({
    type: 'STATUS_UPDATE',
    payload: {
      status: state.status,
      detail: state.detail,
      selectedDeviceId: state.selectedDeviceId,
      seq: state.seq,
    },
  });
}

function publishError(message: string): void {
  updateStatus('Error', message);
  broadcast({ type: 'ERROR', payload: { message } });
}

async function stopTracks(): Promise<void> {
  if (!state.activeStream) {
    return;
  }

  state.activeStream.getTracks().forEach((track) => track.stop());
  state.activeStream = null;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onloadend = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Unable to encode audio chunk.'));
        return;
      }

      const [, base64 = ''] = result.split(',');
      resolve(base64);
    };

    reader.onerror = () => {
      reject(new Error('Unable to read audio chunk data.'));
    };

    reader.readAsDataURL(blob);
  });
}

async function stopRecording(): Promise<void> {
  const recorder = state.recorder;
  state.recorder = null;

  if (recorder && recorder.state !== 'inactive') {
    recorder.ondataavailable = null;
    recorder.onerror = null;
    recorder.onstop = null;
    recorder.stop();
  }

  await stopTracks();
  updateStatus('Idle', 'Idle');
}

async function startRecording(deviceId?: string): Promise<void> {
  if (deviceId) {
    state.selectedDeviceId = deviceId;
  }

  await stopRecording();

  const audioConstraint = state.selectedDeviceId === 'default' ? true : { deviceId: { exact: state.selectedDeviceId } };

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: audioConstraint,
    video: false,
  });

  state.activeStream = stream;

  const recorder = new MediaRecorder(stream);
  recorder.ondataavailable = (event) => {
    const blob = event.data;
    if (!blob || blob.size === 0) {
      return;
    }

    const nextSeq = state.seq + 1;
    state.seq = nextSeq;

    blobToBase64(blob)
      .then((dataBase64) => {
        broadcast({
          type: 'AUDIO_CHUNK',
          payload: {
            seq: nextSeq,
            ts: Date.now(),
            mimeType: blob.type || recorder.mimeType || 'audio/webm',
            size: blob.size,
            dataBase64,
          },
        });
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        publishError(message);
      });
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
  updateStatus('Recording', `Recording on ${state.selectedDeviceId}`);
}

chrome.runtime.onMessage.addListener((rawMessage: RuntimeMessage, _sender, sendResponse) => {
  const message = rawMessage;

  if (message?.type === 'PING') {
    sendResponse({ type: 'PONG' });
    return;
  }

  if (message?.type === 'GET_AUDIO_STATE') {
    sendResponse({
      status: state.status,
      selectedDeviceId: state.selectedDeviceId,
      seq: state.seq,
      detail: state.detail,
    });
    return;
  }

  if (message?.type === 'START_RECORDING') {
    startRecording(message.payload?.deviceId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        const messageText = error instanceof Error ? error.message : String(error);
        publishError(messageText);
        sendResponse({ ok: false, error: messageText });
      });
    return true;
  }

  if (message?.type === 'STOP_RECORDING') {
    stopRecording()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        const messageText = error instanceof Error ? error.message : String(error);
        publishError(messageText);
        sendResponse({ ok: false, error: messageText });
      });
    return true;
  }
});
