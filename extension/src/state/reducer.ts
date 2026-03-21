import type { AudioStatus, AppView, AudioSource, RecordingDiagnostics, UITheme, UILang, DeviceOption } from '../types';
import type { SessionRecord } from '../db/indexeddb';

export type AppState = {
  error: string | null;
  activeView: AppView;
  status: AudioStatus;
  recordingDiagnostics: RecordingDiagnostics;
  devices: DeviceOption[];
  selectedDeviceId: string;
  selectedSource: AudioSource;
  transcriptText: string;
  sttStatusLine: string;
  notesSessions: SessionRecord[];
  selectedSessionId: string | null;
  notesLoading: boolean;
  notesError: string | null;
  notesSearch: string;
  exportToast: string | null;
  summaryLoading: boolean;
  uiTheme: UITheme;
  uiLang: UILang;
};

export const initialState: AppState = {
  error: null,
  activeView: 'transcription',
  status: 'Idle',
  recordingDiagnostics: {
    durationSec: 0,
    durationLabel: '00:00',
    totalBytes: 0,
    totalMB: 0,
    mbPerMin: 0,
    estMinTo25MB: null,
  },
  devices: [],
  selectedDeviceId: 'default',
  selectedSource: 'mic',
  transcriptText: '',
  sttStatusLine: 'Provider: Unknown · Not configured',
  notesSessions: [],
  selectedSessionId: null,
  notesLoading: false,
  notesError: null,
  notesSearch: '',
  exportToast: null,
  summaryLoading: false,
  uiTheme: 'light',
  uiLang: 'en',
};

export type AppAction =
  | { type: 'SET_ERROR'; payload: string | null }
  | { type: 'SET_ACTIVE_VIEW'; payload: AppView }
  | { type: 'SET_STATUS'; payload: AudioStatus }
  | { type: 'SET_DIAGNOSTICS'; payload: RecordingDiagnostics }
  | { type: 'SET_DEVICES'; payload: DeviceOption[] }
  | { type: 'SET_SELECTED_DEVICE'; payload: string }
  | { type: 'SET_SELECTED_SOURCE'; payload: AudioSource }
  | { type: 'SET_TRANSCRIPT'; payload: string }
  | { type: 'SET_STT_STATUS_LINE'; payload: string }
  | { type: 'SET_NOTES_SESSIONS'; payload: SessionRecord[] }
  | { type: 'SET_SELECTED_SESSION'; payload: string | null }
  | { type: 'SET_NOTES_LOADING'; payload: boolean }
  | { type: 'SET_NOTES_ERROR'; payload: string | null }
  | { type: 'SET_NOTES_SEARCH'; payload: string }
  | { type: 'SET_EXPORT_TOAST'; payload: string | null }
  | { type: 'SET_SUMMARY_LOADING'; payload: boolean }
  | { type: 'SET_UI_THEME'; payload: UITheme }
  | { type: 'SET_UI_LANG'; payload: UILang }
  | { type: 'UPDATE_SESSION'; payload: { id: string; updates: Partial<SessionRecord> } }
  | { type: 'SYNC_RECORDING_STATE'; payload: Partial<Pick<AppState, 'status' | 'selectedDeviceId' | 'selectedSource' | 'transcriptText' | 'recordingDiagnostics'>> }
  | { type: 'CLEAR_ALL_SESSIONS' }
  | { type: 'DELETE_SESSION'; payload: string };

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SET_ERROR':
      return { ...state, error: action.payload };
    case 'SET_ACTIVE_VIEW':
      return { ...state, activeView: action.payload };
    case 'SET_STATUS':
      return { ...state, status: action.payload };
    case 'SET_DIAGNOSTICS':
      return { ...state, recordingDiagnostics: action.payload };
    case 'SET_DEVICES':
      return { ...state, devices: action.payload };
    case 'SET_SELECTED_DEVICE':
      return { ...state, selectedDeviceId: action.payload };
    case 'SET_SELECTED_SOURCE':
      return { ...state, selectedSource: action.payload };
    case 'SET_TRANSCRIPT':
      return { ...state, transcriptText: action.payload };
    case 'SET_STT_STATUS_LINE':
      return { ...state, sttStatusLine: action.payload };
    case 'SET_NOTES_SESSIONS':
      return { ...state, notesSessions: action.payload };
    case 'SET_SELECTED_SESSION':
      return { ...state, selectedSessionId: action.payload };
    case 'SET_NOTES_LOADING':
      return { ...state, notesLoading: action.payload };
    case 'SET_NOTES_ERROR':
      return { ...state, notesError: action.payload };
    case 'SET_NOTES_SEARCH':
      return { ...state, notesSearch: action.payload };
    case 'SET_EXPORT_TOAST':
      return { ...state, exportToast: action.payload };
    case 'SET_SUMMARY_LOADING':
      return { ...state, summaryLoading: action.payload };
    case 'SET_UI_THEME':
      return { ...state, uiTheme: action.payload };
    case 'SET_UI_LANG':
      return { ...state, uiLang: action.payload };
    case 'UPDATE_SESSION':
      return {
        ...state,
        notesSessions: state.notesSessions.map((s) =>
          s.id === action.payload.id ? { ...s, ...action.payload.updates } : s,
        ),
      };
    case 'SYNC_RECORDING_STATE':
      return { ...state, ...action.payload };
    case 'DELETE_SESSION': {
      const remaining = state.notesSessions.filter((s) => s.id !== action.payload);
      return {
        ...state,
        notesSessions: remaining,
        selectedSessionId: state.selectedSessionId === action.payload ? null : state.selectedSessionId,
      };
    }
    case 'CLEAR_ALL_SESSIONS':
      return {
        ...state,
        transcriptText: '',
        status: 'Idle',
        notesSessions: [],
        selectedSessionId: null,
      };
    default:
      return state;
  }
}
