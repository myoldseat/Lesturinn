// ─── Microphone recording — 4 × 15-second snippets ───
import { S } from './state.js';

function getSupportedMimeType() {
  for (const t of ['audio/mp4', 'audio/aac', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg']) {
    try { if (MediaRecorder.isTypeSupported(t)) return t; } catch (e) { /* skip */ }
  }
  return '';
}

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

export async function startAudio() {
  try {
    S.audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    [
      { label: 'min1',  ms: 60000 },
      { label: 'min5',  ms: 300000 },
      { label: 'min9',  ms: 540000 },
      { label: 'min13', ms: 780000 }
    ].forEach(({ label, ms }) => {
      const t = setTimeout(() => recordSnippet(label, 15000), ms);
      S.snippetTimers.push(t);
    });
    document.getElementById('audio-status').textContent = '🎤 Tekur upp við mín. 1, 5, 9 og 13';
  } catch (e) {
    document.getElementById('audio-status').textContent = '🔇 Hljóðupptaka ekki í boði';
  }
}

export function stopAudio() {
  S.snippetTimers.forEach(t => clearTimeout(t));
  S.snippetTimers = [];
  if (S.audioStream) {
    S.audioStream.getTracks().forEach(t => t.stop());
    S.audioStream = null;
  }
}