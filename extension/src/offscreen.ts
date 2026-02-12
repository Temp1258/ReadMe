export {};

type TranscriptionStatus = 'Idle' | 'Listening' | 'Error';

type RuntimeMessage =
  | { type: 'PING' }
  | { type: 'GET_TRANSCRIPTION_STATE' }
  | { type: 'START_TRANSCRIPTION' }
  | { type: 'STOP_TRANSCRIPTION' }
  | { type: 'SET_DEVICE'; payload: { deviceId: string } };

type RuntimeEventMessage =
  | { type: 'TRANSCRIPT_PARTIAL'; payload: { text: string } }
  | { type: 'TRANSCRIPT_FINAL'; payload: { text: string } }
  | { type: 'STATUS_UPDATE'; payload: { status: TranscriptionStatus; detail?: string; deviceId: string } }
  | { type: 'ERROR'; payload: { message: string } };

type SpeechRecognitionResultShape = {
  isFinal: boolean;
  0: { transcript: string };
};

type SpeechRecognitionEventShape = {
  resultIndex: number;
  results: SpeechRecognitionResultShape[];
};

type SpeechRecognitionErrorEventShape = {
  error: string;
};

type SpeechRecognitionShape = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventShape) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventShape) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionShape;

declare global {
  interface Window {
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
    SpeechRecognition?: SpeechRecognitionConstructor;
  }
}

const state = {
  status: 'Idle' as TranscriptionStatus,
  detail: 'Idle',
  currentDeviceId: 'default',
  partialText: '',
  finalized: [] as string[],
  activeStream: null as MediaStream | null,
  recognition: null as SpeechRecognitionShape | null,
  shouldRun: false,
};

function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

function broadcast(message: RuntimeEventMessage): void {
  if (!chrome.runtime?.id) {
    return;
  }

  chrome.runtime.sendMessage(message).catch(() => {
    // Popup may not be open.
  });
}

function updateStatus(status: TranscriptionStatus, detail?: string): void {
  state.status = status;
  state.detail = detail ?? status;

  broadcast({
    type: 'STATUS_UPDATE',
    payload: {
      status: state.status,
      detail: state.detail,
      deviceId: state.currentDeviceId,
    },
  });
}

function publishError(message: string): void {
  updateStatus('Error', message);
  broadcast({ type: 'ERROR', payload: { message } });
}

async function releaseStream(): Promise<void> {
  if (!state.activeStream) {
    return;
  }

  state.activeStream.getTracks().forEach((track) => track.stop());
  state.activeStream = null;
}

async function captureDevice(deviceId: string): Promise<void> {
  await releaseStream();

  state.activeStream = await navigator.mediaDevices.getUserMedia({
    audio: deviceId === 'default' ? true : { deviceId: { exact: deviceId } },
    video: false,
  });
}

function stopRecognition(): void {
  const recognition = state.recognition;
  state.recognition = null;

  if (!recognition) {
    return;
  }

  recognition.onresult = null;
  recognition.onerror = null;
  recognition.onend = null;
  recognition.stop();
}

async function startRecognition(): Promise<void> {
  const RecognitionConstructor = getSpeechRecognitionConstructor();
  if (!RecognitionConstructor) {
    throw new Error('Speech recognition is not supported in this browser.');
  }

  await captureDevice(state.currentDeviceId);

  stopRecognition();

  const recognition = new RecognitionConstructor();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  recognition.onresult = (event: SpeechRecognitionEventShape) => {
    let finalChunk = '';
    let partialChunk = '';

    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const transcript = event.results[index][0]?.transcript?.trim();
      if (!transcript) {
        continue;
      }

      if (event.results[index].isFinal) {
        finalChunk += `${transcript} `;
      } else {
        partialChunk += `${transcript} `;
      }
    }

    const cleanPartial = partialChunk.trim();
    if (cleanPartial) {
      state.partialText = cleanPartial;
      broadcast({
        type: 'TRANSCRIPT_PARTIAL',
        payload: { text: cleanPartial },
      });
    }

    const cleanFinal = finalChunk.trim();
    if (cleanFinal) {
      state.partialText = '';
      state.finalized.push(cleanFinal);
      broadcast({
        type: 'TRANSCRIPT_FINAL',
        payload: { text: cleanFinal },
      });
    }
  };

  recognition.onerror = (event: SpeechRecognitionErrorEventShape) => {
    if (!state.shouldRun && event.error === 'aborted') {
      return;
    }

    publishError(`Speech recognition error: ${event.error}`);
  };

  recognition.onend = () => {
    if (!state.shouldRun) {
      return;
    }

    recognition.start();
  };

  state.recognition = recognition;
  state.shouldRun = true;
  recognition.start();
  updateStatus('Listening', `Listening on ${state.currentDeviceId}`);
}

async function stopTranscription(): Promise<void> {
  state.shouldRun = false;
  stopRecognition();
  await releaseStream();
  state.partialText = '';
  updateStatus('Idle', 'Idle');
}

async function restartTranscriptionWithDevice(deviceId: string): Promise<void> {
  state.currentDeviceId = deviceId;

  if (!state.shouldRun) {
    updateStatus(state.status === 'Error' ? 'Error' : 'Idle', state.detail);
    return;
  }

  try {
    await startRecognition();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    publishError(message);
  }
}

chrome.runtime.onMessage.addListener((rawMessage: RuntimeMessage, _sender, sendResponse) => {
  const message = rawMessage;

  if (message?.type === 'PING') {
    sendResponse({ type: 'PONG' });
    return;
  }

  if (message?.type === 'GET_TRANSCRIPTION_STATE') {
    sendResponse({
      type: 'STATUS_UPDATE',
      payload: {
        status: state.status,
        detail: state.detail,
        deviceId: state.currentDeviceId,
      },
      transcript: {
        partial: state.partialText,
        finalized: state.finalized,
      },
    });
    return;
  }

  if (message?.type === 'START_TRANSCRIPTION') {
    startRecognition()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        const messageText = error instanceof Error ? error.message : String(error);
        publishError(messageText);
        sendResponse({ ok: false, error: messageText });
      });
    return true;
  }

  if (message?.type === 'STOP_TRANSCRIPTION') {
    stopTranscription()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        const messageText = error instanceof Error ? error.message : String(error);
        publishError(messageText);
        sendResponse({ ok: false, error: messageText });
      });
    return true;
  }

  if (message?.type === 'SET_DEVICE') {
    restartTranscriptionWithDevice(message.payload.deviceId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        const messageText = error instanceof Error ? error.message : String(error);
        publishError(messageText);
        sendResponse({ ok: false, error: messageText });
      });
    return true;
  }
});
