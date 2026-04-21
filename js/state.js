// ─── Shared application state ───
export const S = {
  role: null,
  familyId: null,
  childKey: null,
  childName: null,
  parentName: null,
  parentEmail: null,
  familyCode: null,
  parentChildren: [],
  expandedChildren: {},
  familyUnsub: null,
  sessions: [],
  timerMode: 'down',
  timerInterval: null,
  readingStartMs: null,
  elapsedSecs: 0,
  pendingSession: null,
  audioStream: null,
  audioSnippets: {},
  snippetTimers: [],

  // ── Analysis additions ──
  fullRecordingChunks: [],
  fullRecordingMimeType: '',
  fullRecorder: null,
  lowMemoryMode: false,
  liveMonitorInterval: null,
  liveAudioCtx: null,
  liveAnalyser: null,
  liveStats: {
    speechSec: 0,
    silenceSec: 0,
    longestSilence: 0,
    _currentSilenceStreak: 0
  }
};

export const TARGET = 15 * 60; // 15 minutes in seconds
