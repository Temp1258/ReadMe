export type SessionSource = 'mic' | 'tab';
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

const DB_NAME = 'ticnote';
const STORE_NAME = 'sessions';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
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

export async function getSession(id: string): Promise<SessionRecord | null> {
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
