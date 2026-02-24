export type SessionSource = 'mic' | 'tab' | 'mix';
export type SessionStatus = 'idle' | 'listening' | 'transcribing' | 'stopped' | 'error';

export type SessionSegment = {
  idx: number;
  ts: number;
  text: string;
};

export type SessionRecord = {
  id: string;
  startedAt: number;
  endedAt?: number;
  source: SessionSource;
  deviceId?: string;
  status: SessionStatus;
  transcript: string;
  segments: SessionSegment[];
};

export type RecordingSessionStatus = 'recording' | 'stopped' | 'error';

export type RecordingSessionRecord = {
  sessionId: string;
  startTime: number;
  stopTime?: number;
  status: RecordingSessionStatus;
  totalBytes: number;
  chunkCount: number;
  mimeType: string;
  timesliceMs: number;
};

export type RecordingChunkRecord = {
  id: string;
  sessionId: string;
  seq: number;
  createdAt: number;
  bytes: number;
  mimeType: string;
  blob: Blob;
};

const SESSION_DB_NAME = 'ticnote';
const STORE_NAME = 'sessions';
const RECORDING_SESSION_STORE_NAME = 'recording_sessions';
const RECORDING_CHUNK_STORE_NAME = 'recording_chunks';
const RECORDING_CHUNK_SESSION_SEQ_INDEX = 'by_session_seq';
const DB_VERSION = 2;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(SESSION_DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains(RECORDING_SESSION_STORE_NAME)) {
        db.createObjectStore(RECORDING_SESSION_STORE_NAME, { keyPath: 'sessionId' });
      }

      if (!db.objectStoreNames.contains(RECORDING_CHUNK_STORE_NAME)) {
        const chunkStore = db.createObjectStore(RECORDING_CHUNK_STORE_NAME, { keyPath: 'id' });
        chunkStore.createIndex(RECORDING_CHUNK_SESSION_SEQ_INDEX, ['sessionId', 'seq'], { unique: true });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Unable to open IndexedDB.'));
  });

  return dbPromise;
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
  });
}

async function putSession(session: SessionRecord): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).put(session);
  await transactionDone(tx);
}

async function getSession(id: string): Promise<SessionRecord | null> {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(id);

    request.onsuccess = () => {
      resolve((request.result as SessionRecord | undefined) ?? null);
    };

    request.onerror = () => {
      reject(request.error ?? new Error('Unable to read session from IndexedDB.'));
    };
  });
}

export async function listSessions(): Promise<SessionRecord[]> {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).getAll();

    request.onsuccess = () => {
      const sessions = (request.result as SessionRecord[] | undefined) ?? [];
      sessions.sort((a, b) => b.startedAt - a.startedAt);
      resolve(sessions);
    };

    request.onerror = () => {
      reject(request.error ?? new Error('Unable to list sessions from IndexedDB.'));
    };
  });
}

export async function createSession(input: { id: string; startedAt: number; source: SessionSource; deviceId?: string; status: SessionStatus }): Promise<SessionRecord> {
  const session: SessionRecord = {
    id: input.id,
    startedAt: input.startedAt,
    source: input.source,
    deviceId: input.deviceId,
    status: input.status,
    transcript: '',
    segments: [],
  };

  await putSession(session);
  return session;
}

export async function appendSessionSegment(sessionId: string, text: string): Promise<SessionRecord | null> {
  const normalized = text.trim();
  if (!normalized) {
    return getSession(sessionId);
  }

  const session = await getSession(sessionId);
  if (!session) {
    return null;
  }

  const nextIdx = session.segments.length + 1;
  const segment: SessionSegment = {
    idx: nextIdx,
    ts: Date.now(),
    text: normalized,
  };

  const updated: SessionRecord = {
    ...session,
    transcript: session.transcript ? `${session.transcript}\n${normalized}` : normalized,
    segments: [...session.segments, segment],
  };

  await putSession(updated);
  return updated;
}

export async function updateSessionState(sessionId: string, updates: Partial<Pick<SessionRecord, 'status' | 'endedAt'>>): Promise<SessionRecord | null> {
  const session = await getSession(sessionId);
  if (!session) {
    return null;
  }

  const updated: SessionRecord = {
    ...session,
    ...updates,
  };

  await putSession(updated);
  return updated;
}

export async function getLatestSession(): Promise<SessionRecord | null> {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).getAll();

    request.onsuccess = () => {
      const sessions = (request.result as SessionRecord[] | undefined) ?? [];
      if (sessions.length === 0) {
        resolve(null);
        return;
      }

      sessions.sort((a, b) => b.startedAt - a.startedAt);
      resolve(sessions[0]);
    };

    request.onerror = () => {
      reject(request.error ?? new Error('Unable to read latest session from IndexedDB.'));
    };
  });
}

export async function clearSessions(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).clear();
  await transactionDone(tx);
}

export async function createRecordingSession(session: RecordingSessionRecord): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(RECORDING_SESSION_STORE_NAME, 'readwrite');
  tx.objectStore(RECORDING_SESSION_STORE_NAME).put(session);
  await transactionDone(tx);
}

export async function getRecordingSession(sessionId: string): Promise<RecordingSessionRecord | null> {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(RECORDING_SESSION_STORE_NAME, 'readonly');
    const request = tx.objectStore(RECORDING_SESSION_STORE_NAME).get(sessionId);

    request.onsuccess = () => {
      resolve((request.result as RecordingSessionRecord | undefined) ?? null);
    };

    request.onerror = () => {
      reject(request.error ?? new Error('Unable to read recording session from IndexedDB.'));
    };
  });
}

export async function updateRecordingSession(
  sessionId: string,
  updates: Partial<Omit<RecordingSessionRecord, 'sessionId'>>,
): Promise<RecordingSessionRecord | null> {
  const existing = await getRecordingSession(sessionId);
  if (!existing) {
    return null;
  }

  const updated: RecordingSessionRecord = {
    ...existing,
    ...updates,
  };

  const db = await openDb();
  const tx = db.transaction(RECORDING_SESSION_STORE_NAME, 'readwrite');
  tx.objectStore(RECORDING_SESSION_STORE_NAME).put(updated);
  await transactionDone(tx);
  return updated;
}

export async function appendRecordingChunk(chunk: RecordingChunkRecord): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(RECORDING_CHUNK_STORE_NAME, 'readwrite');
  tx.objectStore(RECORDING_CHUNK_STORE_NAME).put(chunk);
  await transactionDone(tx);
}

export async function listRecordingChunksBySession(sessionId: string): Promise<RecordingChunkRecord[]> {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(RECORDING_CHUNK_STORE_NAME, 'readonly');
    const store = tx.objectStore(RECORDING_CHUNK_STORE_NAME);
    const index = store.index(RECORDING_CHUNK_SESSION_SEQ_INDEX);
    const range = IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]);
    const request = index.getAll(range);

    request.onsuccess = () => {
      resolve((request.result as RecordingChunkRecord[] | undefined) ?? []);
    };

    request.onerror = () => {
      reject(request.error ?? new Error('Unable to list recording chunks from IndexedDB.'));
    };
  });
}

export async function streamRecordingChunksBySession(
  sessionId: string,
  onChunk: (chunk: RecordingChunkRecord) => Promise<void> | void,
): Promise<void> {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    let settled = false;
    let stopped = false;
    let cursorDone = false;
    let txDone = false;
    let pendingCount = 0;
    let firstError: unknown = null;
    let chain = Promise.resolve();
    let finalizeScheduled = false;

    const resolveOnce = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };

    const rejectOnce = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      stopped = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const finalize = () => {
      if (settled || !cursorDone || !txDone || finalizeScheduled) {
        return;
      }

      finalizeScheduled = true;
      void chain
        .catch(() => undefined)
        .then(() => {
          if (firstError) {
            rejectOnce(firstError);
            return;
          }
          resolveOnce();
        });
    };

    const tx = db.transaction(RECORDING_CHUNK_STORE_NAME, 'readonly');
    const store = tx.objectStore(RECORDING_CHUNK_STORE_NAME);
    const index = store.index(RECORDING_CHUNK_SESSION_SEQ_INDEX);
    const range = IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]);
    const request = index.openCursor(range, 'next');

    request.onsuccess = () => {
      if (stopped) {
        return;
      }

      const cursor = request.result;
      if (!cursor) {
        cursorDone = true;
        finalize();
        return;
      }

      const chunk = cursor.value as RecordingChunkRecord;
      pendingCount += 1;
      console.debug(`[stream] enqueue seq=${chunk.seq} pending=${pendingCount}`);

      // Important: continue the cursor synchronously in the request callback.
      // Calling continue() after an async gap can happen after the transaction closes.
      cursor.continue();

      chain = chain
        .catch(() => undefined)
        .then(async () => {
          if (stopped) {
            return;
          }

          console.debug(`[stream] start  seq=${chunk.seq}`);
          await onChunk(chunk);
          console.debug(`[stream] done   seq=${chunk.seq}`);
        })
        .catch((error) => {
          if (!firstError) {
            firstError = error;
            stopped = true;
            try {
              tx.abort();
            } catch {
              // Ignore InvalidStateError if transaction already finished.
            }
            rejectOnce(firstError);
          }
        })
        .finally(() => {
          pendingCount -= 1;
        });
    };

    request.onerror = () => {
      rejectOnce(request.error ?? new Error('Unable to stream recording chunks from IndexedDB.'));
    };

    tx.oncomplete = () => {
      txDone = true;
      finalize();
    };

    tx.onerror = () => {
      rejectOnce(tx.error ?? new Error('IndexedDB transaction failed while streaming recording chunks.'));
    };

    tx.onabort = () => {
      rejectOnce(tx.error ?? new Error('IndexedDB transaction aborted while streaming recording chunks.'));
    };
  });
}
