// ─── Shared application state ───
export const S = {
  role: null,
  familyId: null,
  childKey: null,
  childName: null,
  parentName: null,
  parentChildren: [],   // cleaned up from window._parentChildren
  expandedChildren: {}, // cleaned up from window._expandedChildren
  familyUnsub: null,
  sessions: [],
  timerMode: 'down',
  timerInterval: null,
  readingStartMs: null,
  elapsedSecs: 0,
  pendingSession: null,
  audioStream: null,
  audioSnippets: {},
  snippetTimers: []
};

export const TARGET = 15 * 60; // 15 minutes in seconds