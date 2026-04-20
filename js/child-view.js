// ─── Everything the CHILD sees and does ───
import { db, storage, collection, addDoc, query, where, onSnapshot,
         serverTimestamp, ref, uploadBytes, getDownloadURL } from './firebase-config.js';
import { S, TARGET }   from './state.js';
import { startAudio, stopAudio } from './audio.js';
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
        
        // Simple progress indicator - only show if book is nearly done
        let progressText = '';
        if (totalPages && pageEnd && (totalPages - pageEnd) <= 20) {
          const pagesRemaining = Math.max(0, totalPages - pageEnd);
          progressText = pagesRemaining > 0 ? `📖 ${pagesRemaining} bls. eftir` : '✅ Bók lokið!';
        }
        
        // Thumbnail
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
    min1:  { chunks: [], mimeType: '' }, min5:  { chunks: [], mimeType: '' },
    min9:  { chunks: [], mimeType: '' }, min13: { chunks: [], mimeType: '' }
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

  // ── Setup image preview ──
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

// ── Save session (core) ──
async function doSaveSession(pageEnd) {
  const err = document.getElementById('save-error');
  err.textContent = 'Vistar...';
  try {
    const now = new Date(), ts = now.getTime();
    const clipDefs = [
      { label: 'min1',  fileName: 'hljod_1' },
      { label: 'min5',  fileName: 'hljod_5' },
      { label: 'min9',  fileName: 'hljod_9' },
      { label: 'min13', fileName: 'hljod_13' }
    ];
    const audioPaths = {};
    let uploadCount  = 0;

    for (const { label, fileName } of clipDefs) {
      const snippet = S.audioSnippets[label];
      if (!snippet?.chunks?.length) { audioPaths[label] = null; continue; }
      try {
        const mimeType = snippet.mimeType || 'audio/webm';
        const ext  = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('ogg') ? 'ogg' : 'webm';
        const blob = new Blob(snippet.chunks, { type: mimeType });
        const path = `recordings/${S.familyId}/${S.childKey}/${ts}/${fileName}.${ext}`;
        await uploadBytes(ref(storage, path), blob, { contentType: mimeType });
        audioPaths[label] = path; uploadCount++;
      } catch (e) { console.error(`Storage villa (${label}):`, e); audioPaths[label] = null; }
    }

    if (uploadCount > 0) err.textContent = `🎤 ${uploadCount} hljóðklippum vistað!`;

    // ── Handle image upload ──
    let imagePath = null;
    const photoInput = document.getElementById('book-cover-photo');
    if (photoInput?.files?.[0]) {
      try {
        const imageFile = photoInput.files[0];
        // Compress image using canvas
        const compressedBlob = await compressImage(imageFile);
        const ext = imageFile.type.includes('png') ? 'png' : 'jpg';
        const path = `covers/${S.familyId}/${S.childKey}/${ts}/cover.${ext}`;
        await uploadBytes(ref(storage, path), compressedBlob, { contentType: imageFile.type });
        imagePath = await getDownloadURL(ref(storage, path));
        if (uploadCount === 0) err.textContent = '📷 Bókakápunni hlaðið!';
        else err.textContent = `🎤 ${uploadCount} hljóðklippum og 📷 bókakápunni hlaðið!`;
      } catch (e) { console.error('Image upload villa:', e); imagePath = null; }
    }

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
      audioPath_min5:  audioPaths.min5  || null,
      audioPath_min9:  audioPaths.min9  || null,
      audioPath_min13: audioPaths.min13 || null,
      audioPath: audioPaths.min1 || audioPaths.min5 || audioPaths.min9 || audioPaths.min13 || null,
      timestamp: ts, date: makeDateKey(now), createdAt: serverTimestamp()
    });

    const myCount = (S.sessions || []).filter(s => s.childKey === S.childKey).length + 1;
    checkMilestone(myCount);
    finishReset();
  } catch (e) { err.textContent = 'Ekki tókst að vista: ' + e.message; console.error(e); }
}

export function saveSession() { doSaveSession(parseInt(document.getElementById('page-end').value, 10) || null); }
export function skipSave()    { doSaveSession(null); }

function finishReset() {
  S.pendingSession = null; S.readingStartMs = null; S.audioSnippets = {};
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