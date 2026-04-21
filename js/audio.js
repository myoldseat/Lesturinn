// ─── Microphone recording — snippets + full recording + live monitor ───
import { S } from './state.js';

// ══════════════════════════════════════════
// MIME TYPE DETECTION
// ══════════════════════════════════════════

function getSupportedMimeType() {
  for (const t of ['audio/mp4', 'audio/aac', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg']) {
    try { if (MediaRecorder.isTypeSupported(t)) return t; } catch (e) { /* skip */ }
  }
  return '';
}

// ══════════════════════════════════════════
// LOW MEMORY DETECTION
// ══════════════════════════════════════════

function detectLowMemory() {
  // navigator.deviceMemory: Chrome/Edge only, returns GB (0.25, 0.5, 1, 2, 4, 8)
  if (navigator.deviceMemory && navigator.deviceMemory < 2) return true;
  // Fallback: low core count often correlates with low-end device
  if (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 2) return true;
  return false;
}

// ══════════════════════════════════════════
// SNIPPET RECORDING (same pattern as before)
// ══════════════════════════════════════════

function recordSnippet(label, duration) {
  if (!S.audioStream) return;
  const chunks  = [];
  const mimeType = getSupportedMimeType();
  let rec;
  try {
    rec = mimeType
      ? new MediaRecorder(S.audioStream, { mimeType })
      : new MediaRecorder(S.audioStream);
  } catch (e) {
    try { rec = new MediaRecorder(S.audioStream); } catch (e2) { return; }
  }
  rec.ondataavailable = e => { if (e.data?.size > 0) chunks.push(e.data); };
  rec.onstop = () => {
    S.audioSnippets[label] = { chunks, mimeType: rec.mimeType || mimeType || 'audio/webm' };
  };
  rec.start(1000);
  setTimeout(() => { if (rec.state !== 'inactive') try { rec.stop(); } catch (e) { /* ok */ } }, duration);
}

// ══════════════════════════════════════════
// FULL RECORDING (for analysis only, never uploaded)
// ══════════════════════════════════════════

function startFullRecording() {
  if (S.lowMemoryMode || !S.audioStream) return;

  const mimeType = getSupportedMimeType();
  S.fullRecordingChunks = [];
  S.fullRecordingMimeType = '';

  try {
    const opts = { audioBitsPerSecond: 48000 };
    if (mimeType) opts.mimeType = mimeType;

    S.fullRecorder = new MediaRecorder(S.audioStream, opts);
    S.fullRecordingMimeType = S.fullRecorder.mimeType || mimeType || 'audio/webm';

    S.fullRecorder.ondataavailable = e => {
      if (e.data?.size > 0) S.fullRecordingChunks.push(e.data);
    };

    S.fullRecorder.start(5000); // chunk every 5s
  } catch (e) {
    console.warn('Full recording not available:', e);
    S.fullRecorder = null;
  }
}

function stopFullRecording() {
  if (S.fullRecorder && S.fullRecorder.state !== 'inactive') {
    try { S.fullRecorder.stop(); } catch (e) { /* ok */ }
  }
  S.fullRecorder = null;
}

// ══════════════════════════════════════════
// LIVE RMS MONITOR (Lag 1)
// ══════════════════════════════════════════

function startLiveMonitor() {
  if (!S.audioStream) return;

  try {
    S.liveAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    S.liveAnalyser = S.liveAudioCtx.createAnalyser();
    S.liveAnalyser.fftSize = 512;

    const source = S.liveAudioCtx.createMediaStreamSource(S.audioStream);
    source.connect(S.liveAnalyser);

    const buffer = new Uint8Array(S.liveAnalyser.frequencyBinCount);
    const POLL_MS = 200;
    const SPEECH_THRESHOLD = 0.015;

    // Reset stats
    S.liveStats = { speechSec: 0, silenceSec: 0, longestSilence: 0, _currentSilenceStreak: 0 };

    S.liveMonitorInterval = setInterval(() => {
      if (!S.liveAnalyser) return;

      S.liveAnalyser.getByteTimeDomainData(buffer);

      let sum = 0;
      for (let i = 0; i < buffer.length; i++) {
        const normalized = (buffer[i] - 128) / 128;
        sum += normalized * normalized;
      }
      const rms = Math.sqrt(sum / buffer.length);
      const stepSec = POLL_MS / 1000;

      if (rms > SPEECH_THRESHOLD) {
        S.liveStats.speechSec += stepSec;
        S.liveStats._currentSilenceStreak = 0;
      } else {
        S.liveStats.silenceSec += stepSec;
        S.liveStats._currentSilenceStreak += stepSec;
        if (S.liveStats._currentSilenceStreak > S.liveStats.longestSilence) {
          S.liveStats.longestSilence = S.liveStats._currentSilenceStreak;
        }
      }
    }, POLL_MS);
  } catch (e) {
    console.warn('Live monitor not available:', e);
  }
}

function stopLiveMonitor() {
  if (S.liveMonitorInterval) {
    clearInterval(S.liveMonitorInterval);
    S.liveMonitorInterval = null;
  }
  if (S.liveAudioCtx) {
    try { S.liveAudioCtx.close(); } catch (e) { /* ok */ }
    S.liveAudioCtx = null;
  }
  S.liveAnalyser = null;
}

// ══════════════════════════════════════════
// PUBLIC API
// ══════════════════════════════════════════

export function getLiveStats() {
  const total = S.liveStats.speechSec + S.liveStats.silenceSec;
  return {
    speechSec: Number(S.liveStats.speechSec.toFixed(1)),
    silenceSec: Number(S.liveStats.silenceSec.toFixed(1)),
    activeRatio: total > 0 ? Number((S.liveStats.speechSec / total).toFixed(3)) : 0,
    longestSilence: Number(S.liveStats.longestSilence.toFixed(1))
  };
}

export function getFullRecordingBlob() {
  if (!S.fullRecordingChunks.length) return null;
  return new Blob(S.fullRecordingChunks, { type: S.fullRecordingMimeType || 'audio/webm' });
}

export async function startAudio() {
  // Detect device capability
  S.lowMemoryMode = detectLowMemory();

  try {
    S.audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });

    // 1. Schedule snippet captures — updated timing
    [
      { label: 'min1',  ms: 30000 },    // 30 sek
      { label: 'min2',  ms: 120000 },   // 2 mín
      { label: 'min4',  ms: 240000 },   // 4 mín
      { label: 'min7',  ms: 420000 }    // 7 mín
    ].forEach(({ label, ms }) => {
      const t = setTimeout(() => recordSnippet(label, 15000), ms);
      S.snippetTimers.push(t);
    });

    // 5th snippet only if reading continues past 9 min
    const t10 = setTimeout(() => recordSnippet('min10', 15000), 600000); // 10 mín
    S.snippetTimers.push(t10);

    // 2. Start full recording (for analysis, not upload)
    startFullRecording();

    // 3. Start live RMS monitor
    startLiveMonitor();

    const statusEl = document.getElementById('audio-status');
    if (statusEl) {
      statusEl.textContent = S.lowMemoryMode
        ? '🎤 Tekur upp klippingar (sparnaðarhamur)'
        : '🎤 Tekur upp — greining virk';
    }
  } catch (e) {
    const statusEl = document.getElementById('audio-status');
    if (statusEl) statusEl.textContent = '🔇 Hljóðupptaka ekki í boði';
  }
}

export function stopAudio() {
  // Stop snippet timers
  S.snippetTimers.forEach(t => clearTimeout(t));
  S.snippetTimers = [];

  // Stop full recording
  stopFullRecording();

  // Stop live monitor
  stopLiveMonitor();

  // Stop mic stream
  if (S.audioStream) {
    S.audioStream.getTracks().forEach(t => t.stop());
    S.audioStream = null;
  }
}
