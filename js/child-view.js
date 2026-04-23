// ─── Everything the CHILD sees and does ───
import { db, storage, collection, addDoc, query, where, onSnapshot,
         serverTimestamp, ref, uploadBytes, getDownloadURL } from './firebase-config.js';
import { S, TARGET }   from './state.js';
import { startAudio, stopAudio, getLiveStats, getFullRecordingBlob } from './audio.js';
import { analyzeSnippetBlob, analyzeAudio } from './audio-analysis.js';
import {
  fmtTime, makeDateKey, formatLabel, renderWeekDots,
  getStreakWithShields, getShields, checkAndGrantShield,
  playSound, checkMilestone
} from './helpers.js';

// ── Setup ──
export function setupChildHome() {
  document.getElementById('child-name-pill').textContent = S.childName;
  document.getElementById('child-hero').textContent = `Halló, ${S.childName} 🌟`;
  loadChildSessions();
}

// ── Realtime listener ──
function loadChildSessions() {
  const q = query(
    collection(db, 'sessions'),
    where('familyId', '==', S.familyId),
    where('childKey', '==', S.childKey)
  );

  onSnapshot(q, snap => {
    const sessions = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    const streak  = getStreakWithShields(sessions, S.childKey);
    const shields = getShields(S.childKey);
    renderWeekDots(sessions, 'child-week-dots');

    // streak badge
    const streakEl = document.getElementById('child-streak');
    if (streak > 0) { streakEl.style.display = 'inline-flex'; document.getElementById('streak-num').textContent = streak; }
    else            { streakEl.style.display = 'none'; }

    // shields badge
    const shieldsEl = document.getElementById('child-shields');
    if (shields > 0) { shieldsEl.style.display = 'inline-flex'; document.getElementById('shields-num').textContent = shields; }
    else             { shieldsEl.style.display = 'none'; }

    const ns = checkAndGrantShield(S.childKey, streak);
    if (ns > 0) setTimeout(() => playSound('streak'), 300);

    // streak warning
    const today     = makeDateKey(new Date());
    const yesterday = makeDateKey(new Date(Date.now() - 86400000));
    const readToday     = sessions.some(s => s.date === today     && (s.seconds || 0) >= 60);
    const readYesterday = sessions.some(s => s.date === yesterday && (s.seconds || 0) >= 60);
    const warningEl   = document.getElementById('shield-warning');
    const warningText = document.getElementById('shield-warning-text');

    if (!readToday && readYesterday && streak > 1) {
      warningEl.style.display = '';
      warningText.textContent = shields > 0
        ? `Þú átt ${shields} frídaga — ef þú gleymir er skjöldurinn notaður sjálfkrafa.`
        : `Les í dag til að halda ${streak} daga röðinni!`;
    } else {
      warningEl.style.display = 'none';
    }

    // recent sessions list - show only 3 most recent, simplified
    if (sessions.length) {
      document.getElementById('child-sessions-wrap').style.display = '';
      document.getElementById('child-sessions-list').innerHTML = sessions.slice(0, 3).map(s => {
        const pageEnd = s.pageEnd;
        const pageStart = s.pageStart;
        const totalPages = s.totalPages;
        
        let progressText = '';
        if (totalPages && pageEnd && (totalPages - pageEnd) <= 20) {
          const pagesRemaining = Math.max(0, totalPages - pageEnd);
          progressText = pagesRemaining > 0 ? `📖 ${pagesRemaining} bls. eftir` : '✅ Bók lokið!';
        }
        
        const thumbnailHtml = s.imagePath 
          ? `<img src="${s.imagePath}" alt="cover">`
          : `📖`;
        
        return `
          <div class="session-tile">
            <div class="session-tile-top">
              <div class="session-tile-left">
                <div class="session-tile-title">${s.title || 'Lestur'}</div>
                <div class="session-tile-date">${formatLabel(s.createdAt) || s.date || ''} · ${fmtTime(s.seconds || 0)}</div>
              </div>
              <div class="session-tile-thumbnail">${thumbnailHtml}</div>
            </div>
            ${progressText ? `<div class="session-tile-progress">${progressText}</div>` : ''}
          </div>`;
      }).join('');
    }
  }, e => console.error('Child listener villa:', e));
}

// ── Timer mode ──
export function setMode(mode) {
  S.timerMode = mode;
  document.getElementById('mode-down').className = 'mode-btn' + (mode === 'down' ? ' active' : '');
  document.getElementById('mode-up').className   = 'mode-btn' + (mode === 'up'   ? ' active' : '');
  document.getElementById('timer-display').textContent = mode === 'down' ? '15:00' : '0:00';
}

// ── Start reading ──
export function startReading() {
  S.pendingSession = {
    title:     document.getElementById('read-title').value.trim() || 'Lestur',
    pageStart: parseInt(document.getElementById('page-start').value, 10) || null,
    totalPages: parseInt(document.getElementById('total-pages').value, 10) || null
  };
  S.elapsedSecs    = 0;
  S.readingStartMs = Date.now();
  S.audioSnippets  = {
    min1:  { chunks: [], mimeType: '' }, min2:  { chunks: [], mimeType: '' },
    min4:  { chunks: [], mimeType: '' }, min7:  { chunks: [], mimeType: '' },
    min10: { chunks: [], mimeType: '' }
  };
  S.snippetTimers.forEach(t => clearTimeout(t));
  S.snippetTimers = [];

  document.getElementById('setup-card').style.display   = 'none';
  document.getElementById('reading-card').style.display  = '';
  document.getElementById('finish-card').style.display   = 'none';

  const disp = document.getElementById('timer-display');
  disp.textContent = S.timerMode === 'down' ? '15:00' : '0:00';
  disp.className   = 'timer-big running';
  document.getElementById('timer-status').textContent =
    S.timerMode === 'down' ? 'Les upphátt — tíminn líður niður…' : 'Les upphátt…';
  document.getElementById('audio-status').textContent = '';

  if (S.timerInterval) clearInterval(S.timerInterval);
  S.timerInterval = setInterval(() => {
    S.elapsedSecs = Math.floor((Date.now() - S.readingStartMs) / 1000);
    const display = S.timerMode === 'down' ? Math.max(0, TARGET - S.elapsedSecs) : S.elapsedSecs;
    disp.textContent = fmtTime(display);
    if (S.elapsedSecs >= TARGET) {
      disp.className = 'timer-big done';
      document.getElementById('timer-status').textContent = 'Markmið náð! 🎉';
    }
  }, 500);

  startAudio();
}

// ── Stop reading ──
export function stopReading() {
  if (!S.readingStartMs) return;
  clearInterval(S.timerInterval); S.timerInterval = null;
  S.elapsedSecs = Math.floor((Date.now() - S.readingStartMs) / 1000);
  stopAudio();

  if (S.elapsedSecs < 60) {
    if (confirm('Hætta við lestrarlotu?')) { cancelReading(); return; }
  }

  document.getElementById('reading-card').style.display = 'none';
  document.getElementById('finish-card').style.display  = '';

  const mins = Math.floor(S.elapsedSecs / 60);
  document.getElementById('finish-emoji').textContent = mins >= 15 ? '🏆' : mins >= 5 ? '⭐' : '👍';
  document.getElementById('finish-title').textContent = mins >= 15 ? 'Frábær lestur!' : mins >= 5 ? 'Vel gert!' : 'Byrjunin er góð!';
  document.getElementById('finish-sub').textContent   = `${fmtTime(S.elapsedSecs)} lesið — skráðu blaðsíðuna til að rekja framfarir`;
  setTimeout(() => playSound(mins >= 15 ? 'streak' : 'done'), 400);

  document.getElementById('page-end').oninput = function () {
    const start = parseInt(document.getElementById('page-start').value, 10);
    const end   = parseInt(this.value, 10);
    const pd    = document.getElementById('pages-display');
    pd.textContent = (start && end && end > start) ? `📖 ${end - start} blaðsíður lesnar!` : '';
  };

  const photoInput = document.getElementById('book-cover-photo');
  if (photoInput) {
    photoInput.addEventListener('change', function(e) {
      const file = e.target.files?.[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = function(ev) {
          const preview = document.getElementById('thumbnail-preview');
          preview.innerHTML = `<img src="${ev.target.result}" style="width:100%; height:100%; object-fit:cover">`;
        };
        reader.readAsDataURL(file);
      }
    });
  }
}

// ── Cancel reading ──
export function cancelReading() {
  clearInterval(S.timerInterval); S.timerInterval = null;
  stopAudio();
  S.readingStartMs = null; S.elapsedSecs = 0;
  S.pendingSession = null; S.audioSnippets = {};
  document.getElementById('reading-card').style.display = 'none';
  document.getElementById('finish-card').style.display  = 'none';
  document.getElementById('setup-card').style.display   = '';
  document.getElementById('timer-display').textContent  = S.timerMode === 'down' ? '15:00' : '0:00';
  document.getElementById('timer-display').className    = 'timer-big';
}

// ── Compress image ──
async function compressImage(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = function(e) {
      const img = new Image();
      img.onload = function() {
        const canvas = document.createElement('canvas');
        const maxWidth = 200, maxHeight = 280;
        let { width, height } = img;
        if (width > height) {
          if (width > maxWidth) { height *= maxWidth / width; width = maxWidth; }
        } else {
          if (height > maxHeight) { width *= maxHeight / height; height = maxHeight; }
        }
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob(resolve, file.type, 0.7);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// ══════════════════════════════════════════════════════════
// SAVE SESSION — with analysis integration
// ══════════════════════════════════════════════════════════

async function doSaveSession(pageEnd) {
  const err = document.getElementById('save-error');
  err.textContent = 'Greinir hljóð...';

  try {
    const now = new Date(), ts = now.getTime();

    // ── 1. Collect live stats (always available) ──
    const liveStats = getLiveStats();

    // ── 2. Analyze full recording if available ──
    let sessionAnalysis = null;
    const fullBlob = getFullRecordingBlob();
    if (fullBlob) {
      try {
        const fullCfg = {
          snippetDurationSec: 15, minSnippets: 1, maxSnippets: 4,
          earlyAnchorSec: 45, vadQuantile: 70, minSpeechRatio: 0.4,
          praatSilenceDb: -25, praatMinDipDb: 2, praatMinPauseSec: 0.3, praatVoicedZcrMax: 0.22
        };
        const fullResult = await analyzeAudio(fullBlob, fullCfg);
        sessionAnalysis = {
          totalScore: fullResult.sessionSummary.totalScore,
          profile: fullResult.sessionSummary.profile,
          activeRatio: fullResult.sessionSummary.activeRatio,
          fragmentationScore: fullResult.sessionSummary.fragmentationScore,
          flowScore: fullResult.sessionSummary.flowScore,
          efficiencyScore: fullResult.sessionSummary.efficiencyScore,
          controlScore: fullResult.sessionSummary.controlScore,
          praatSyllables: fullResult.sessionSummary.praatSyllables,
          praatSpeechRate: fullResult.sessionSummary.praatSpeechRate
        };
      } catch (e) {
        console.warn('Session analysis failed (continuing without):', e);
      }
    }

    // ── 3. Analyze each snippet and decide usability ──
    err.textContent = 'Greinir klippingar...';

    const clipDefs = [
      { label: 'min1',  fileName: 'hljod_30s' },
      { label: 'min2',  fileName: 'hljod_2m' },
      { label: 'min4',  fileName: 'hljod_4m' },
      { label: 'min7',  fileName: 'hljod_7m' },
      { label: 'min10', fileName: 'hljod_10m' }
    ];

    const snippetResults = {};
    const audioPaths = {};
    let uploadCount = 0;

    for (const { label, fileName } of clipDefs) {
      const snippet = S.audioSnippets[label];

      // No data for this snippet
      if (!snippet?.chunks?.length) {
        snippetResults[label] = { usable: false, reason: 'no_data' };
        audioPaths[label] = null;
        continue;
      }

      const mimeType = snippet.mimeType || 'audio/webm';
      const blob = new Blob(snippet.chunks, { type: mimeType });

      // Run analysis on snippet
      try {
        const result = await analyzeSnippetBlob(blob);
        snippetResults[label] = {
           usable: result.usable,
           quality: result.quality,
           reason: result.reason,
           totalScore: result.totalScore,
           profile: result.profile,
           activeRatio: result.activeRatio,
           praatSyllables: result.praatSyllables,
           longestBurst: result.longestBurst,
           fragmentationScore: result.fragmentationScore,
           decodingPauseCount: result.summary?.decodingPauseCount || 0
         };
      } catch (e) {
        // Analysis failed — upload anyway (better to have audio than not)
        console.warn(`Snippet analysis failed for ${label}:`, e);
        snippetResults[label] = { usable: true, quality: 'unknown', reason: null };
      }

      // Only upload usable snippets
      if (snippetResults[label].usable === false) {
        audioPaths[label] = null;
        continue;
      }

      // Upload
      try {
        const ext = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('ogg') ? 'ogg' : 'webm';
        const path = `recordings/${S.familyId}/${S.childKey}/${ts}/${fileName}.${ext}`;
        await uploadBytes(ref(storage, path), blob, { contentType: mimeType });
        audioPaths[label] = path;
        uploadCount++;
      } catch (e) {
        console.error(`Storage villa (${label}):`, e);
        audioPaths[label] = null;
      }
    }

    if (uploadCount > 0) err.textContent = `🎤 ${uploadCount} nothæfum klippum vistað!`;

    // ── 4. Build analysis object ──
    const usableSnippets = Object.values(snippetResults).filter(r => r.usable);
    const usableScores = usableSnippets.map(r => r.totalScore).filter(s => s != null && s > 0);
    const bestScore = usableScores.length ? Math.max(...usableScores) : 0;
    const avgScore = usableScores.length
      ? Number((usableScores.reduce((a, b) => a + b, 0) / usableScores.length).toFixed(1))
      : 0;

    const analysis = {
      live: liveStats,
      session: sessionAnalysis,
      snippets: snippetResults,
      overall: {
        usableCount: usableSnippets.length,
        totalSnippets: clipDefs.length,
        bestScore,
        avgScore,
        readingQuality: usableSnippets.length >= 3 ? 'good'
                      : usableSnippets.length >= 1 ? 'fair' : 'poor',
        lowMemoryMode: S.lowMemoryMode
      }
    };

    // ── 5. Handle image upload (unchanged) ──
    let imagePath = null;
    const photoInput = document.getElementById('book-cover-photo');
    if (photoInput?.files?.[0]) {
      try {
        const imageFile = photoInput.files[0];
        const compressedBlob = await compressImage(imageFile);
        const ext = imageFile.type.includes('png') ? 'png' : 'jpg';
        const path = `covers/${S.familyId}/${S.childKey}/${ts}/cover.${ext}`;
        await uploadBytes(ref(storage, path), compressedBlob, { contentType: imageFile.type });
        imagePath = await getDownloadURL(ref(storage, path));
        if (uploadCount === 0) err.textContent = '📷 Bókakápunni hlaðið!';
        else err.textContent = `🎤 ${uploadCount} klippum og 📷 bókakápu hlaðið!`;
      } catch (e) { console.error('Image upload villa:', e); imagePath = null; }
    }

    // ── 6. Save to Firestore ──
    await addDoc(collection(db, 'sessions'), {
      familyId: S.familyId, childKey: S.childKey, childName: S.childName,
      title: S.pendingSession?.title || 'Lestur',
      pageStart: S.pendingSession?.pageStart || null,
      pageEnd: pageEnd || null,
      pagesRead: (S.pendingSession?.pageStart && pageEnd) ? pageEnd - S.pendingSession.pageStart : null,
      totalPages: S.pendingSession?.totalPages || null,
      imagePath: imagePath,
      seconds: S.elapsedSecs, timerMode: S.timerMode,
      hasAudio: uploadCount > 0,
      audioPath_min1:  audioPaths.min1  || null,
      audioPath_min2:  audioPaths.min2  || null,
      audioPath_min4:  audioPaths.min4  || null,
      audioPath_min7:  audioPaths.min7  || null,
      audioPath_min10: audioPaths.min10 || null,
      audioPath: audioPaths.min1 || audioPaths.min2 || audioPaths.min4 || audioPaths.min7 || audioPaths.min10 || null,
      analysis,
      timestamp: ts, date: makeDateKey(now), createdAt: serverTimestamp()
    });

    const myCount = (S.sessions || []).filter(s => s.childKey === S.childKey).length + 1;
    checkMilestone(myCount);
    finishReset();
  } catch (e) {
    err.textContent = 'Ekki tókst að vista: ' + e.message;
    console.error(e);
  }
}

export function saveSession() { doSaveSession(parseInt(document.getElementById('page-end').value, 10) || null); }
export function skipSave()    { doSaveSession(null); }

function finishReset() {
  S.pendingSession = null; S.readingStartMs = null; S.audioSnippets = {};
  // Clean up full recording blob from memory
  S.fullRecordingChunks = [];
  S.fullRecordingMimeType = '';

  document.getElementById('finish-card').style.display = 'none';
  document.getElementById('setup-card').style.display  = '';
  ['read-title', 'page-start', 'page-end', 'total-pages', 'book-cover-photo'].forEach(id => {
    const el = document.getElementById(id);
    if (el?.type === 'file') el.value = '';
    else if (el) el.value = '';
  });
  document.getElementById('pages-display').textContent = '';
  document.getElementById('thumbnail-preview').innerHTML = '';
  document.getElementById('save-error').textContent    = '';
  document.getElementById('timer-display').textContent = S.timerMode === 'down' ? '15:00' : '0:00';
  document.getElementById('timer-display').className   = 'timer-big';
}
