import { describe, it, expect } from 'vitest';
import { appReducer, initialState } from './reducer';
import type { SessionRecord } from '../db/indexeddb';

describe('appReducer', () => {
  it('returns initial state by default', () => {
    const result = appReducer(initialState, { type: 'SET_ERROR', payload: null });
    expect(result.error).toBeNull();
  });

  it('SET_ERROR updates error field', () => {
    const result = appReducer(initialState, { type: 'SET_ERROR', payload: 'something broke' });
    expect(result.error).toBe('something broke');
  });

  it('SET_ACTIVE_VIEW changes view', () => {
    const result = appReducer(initialState, { type: 'SET_ACTIVE_VIEW', payload: 'notes' });
    expect(result.activeView).toBe('notes');
  });

  it('SET_STATUS changes audio status', () => {
    const result = appReducer(initialState, { type: 'SET_STATUS', payload: 'Listening' });
    expect(result.status).toBe('Listening');
  });

  it('SYNC_RECORDING_STATE merges partial state', () => {
    const result = appReducer(initialState, {
      type: 'SYNC_RECORDING_STATE',
      payload: {
        status: 'Transcribing',
        selectedDeviceId: 'mic-123',
        transcriptText: 'hello world',
      },
    });
    expect(result.status).toBe('Transcribing');
    expect(result.selectedDeviceId).toBe('mic-123');
    expect(result.transcriptText).toBe('hello world');
    // unchanged fields
    expect(result.selectedSource).toBe('mic');
  });

  it('CLEAR_ALL_SESSIONS resets session-related state', () => {
    const withSessions = appReducer(initialState, {
      type: 'SET_NOTES_SESSIONS',
      payload: [{ id: 'a' } as SessionRecord],
    });
    const cleared = appReducer(withSessions, { type: 'CLEAR_ALL_SESSIONS' });
    expect(cleared.notesSessions).toEqual([]);
    expect(cleared.selectedSessionId).toBeNull();
    expect(cleared.transcriptText).toBe('');
    expect(cleared.status).toBe('Idle');
  });

  it('UPDATE_SESSION updates a specific session', () => {
    const session: SessionRecord = {
      id: 'sess1',
      startedAt: 1000,
      source: 'mic',
      status: 'stopped',
      transcript: 'hello',
      segments: [],
    };
    const state = appReducer(initialState, { type: 'SET_NOTES_SESSIONS', payload: [session] });
    const updated = appReducer(state, {
      type: 'UPDATE_SESSION',
      payload: {
        id: 'sess1',
        updates: { aiSummary: { summary: 'test', keyPoints: [], actionItems: [], generatedAt: 2000 } },
      },
    });
    expect(updated.notesSessions[0].aiSummary?.summary).toBe('test');
  });

  it('SET_UI_THEME toggles theme', () => {
    const dark = appReducer(initialState, { type: 'SET_UI_THEME', payload: 'dark' });
    expect(dark.uiTheme).toBe('dark');
    const light = appReducer(dark, { type: 'SET_UI_THEME', payload: 'light' });
    expect(light.uiTheme).toBe('light');
  });

  it('SET_SUMMARY_LOADING toggles flag', () => {
    const loading = appReducer(initialState, { type: 'SET_SUMMARY_LOADING', payload: true });
    expect(loading.summaryLoading).toBe(true);
    const done = appReducer(loading, { type: 'SET_SUMMARY_LOADING', payload: false });
    expect(done.summaryLoading).toBe(false);
  });
});
