// ─── Parent dashboard UI + Firebase realtime ───
import {
  db, storage,
  collection, onSnapshot, query, where,
  ref, getDownloadURL,
  setDoc, doc, addDoc, serverTimestamp
} from './firebase-config.js';
import { S }    from './state.js';
import { fmtTime, makeDateKey, formatLabel, getMonday, getStreak } from './helpers.js';

// ══════════════════════════════════════════════
// REALTIME FAMILY LISTENER
// ══════════════════════════════════════════════

export function startFamilyListener() {
  if (S.familyUnsub) { S.familyUnsub(); S.familyUnsub = null; }
  const q = query(collection(db, 'sessions'), where('familyId', '==', S.familyId));
  S.familyUnsub = onSnapshot(q, snap => {
    S.sessions = snap.docs
      .map(d => ({ _docId: d.id, ...d.data() }))
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    renderDashboard();
  }, e => console.error('Family listener villa:', e));
}

// ══════════════════════════════════════════════
// DASHBOARD STATE
// ══════════════════════════════════════════════

let _phSelectedKey = null;

// ══════════════════════════════════════════════
// MAIN RENDER
// ══════════════════════════════════════════════

export function renderDashboard() {
  // Velja fyrsta barn ef ekkert valið
  if (!_phSelectedKey) {
    const children = S.parentChildren || [];
    _phSelectedKey = children.length > 0 ? children[0].key : 'all';
  }
  renderChildCards();
  renderWeekGrid();
  updateStats();
  renderCalendar();
  renderRecordings();
}

// ── Barn kort ──
function renderChildCards() {
  const row = document.getElementById('ph-children-row');
  if (!row) return;
  const children = S.parentChildren || [];
  const sessions = S.sessions || [];
  if (!children.length) {
    row.innerHTML = '<div class="ph-no-children">Engin börn skráð enn</div>';
    return;
  }
  const today = makeDateKey(new Date());
  row.innerHTML = children.map(c => {
    const count      = sessions.filter(s => s.childKey === c.key).length;
    const isSelected = c.key === _phSelectedKey;
    const readToday  = sessions.some(s => s.childKey === c.key && s.date === today && (s.seconds||0) >= 60);
    return `
      <div class="ph-child-card ${isSelected ? 'ph-child-selected' : ''}" onclick="selectChild('${c.key}')">
        <div class="ph-child-avatar ${isSelected ? 'ph-child-avatar-active' : ''}">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        </div>
        <div class="ph-child-name">${c.name}</div>
        <div class="ph-child-code">${c.code || ''}</div>
        <div class="ph-child-sessions">${count} lotur</div>
        ${readToday ? '<div class="ph-child-today">✓ Las í dag</div>' : ''}
      </div>`;
  }).join('');
}

export function selectChild(key) {
  _phSelectedKey = key;
  renderChildCards();
  renderWeekGrid();
  updateStats();
  renderCalendar();
  renderRecordings();
}

// ── 7 daga grid ──
function renderWeekGrid() {
  const grid = document.getElementById('ph-week-grid');
  if (!grid) return;
  const sessions = S.sessions || [];
  const days  = ['M','Þ','M','F','F','L','S'];
  const today = new Date(); today.setHours(12,0,0,0);
  const cells = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today); d.setDate(today.getDate() - i);
    const key     = makeDateKey(d);
    const isToday = i === 0;
    const daySessions = sessions.filter(s => {
      const matchChild = !_phSelectedKey || _phSelectedKey === 'all' ? true : s.childKey === _phSelectedKey;
      return s.date === key && matchChild && (s.seconds||0) >= 60;
    });
    const mins     = daySessions.reduce((a,s) => a + Math.floor((s.seconds||0)/60), 0);
    const dotClass = mins === 0 ? 'ph-wdot-empty' : mins < 15 ? 'ph-wdot-low' : mins < 30 ? 'ph-wdot-mid' : 'ph-wdot-full';
    cells.push(`
      <div class="ph-wday-cell">
        <div class="ph-wday-lbl ${isToday ? 'ph-wday-today' : ''}">${days[6-i]}</div>
        <div class="ph-wdot ${dotClass} ${isToday ? 'ph-wdot-today' : ''}" title="${mins > 0 ? mins + ' mín' : 'Ekki lesið'}"></div>
      </div>`);
  }
  grid.innerHTML = cells.join('');
}

// ── Stats ──
function updateStats() {
  const sessions = S.sessions || [];
  const filtered = !_phSelectedKey || _phSelectedKey === 'all'
    ? sessions : sessions.filter(s => s.childKey === _phSelectedKey);
  const mins  = Math.round(filtered.reduce((a,s) => a + (s.seconds||0), 0) / 60);
  const count = filtered.length;
  const clips = filtered.filter(s => s.hasAudio).length;
  const mEl = document.getElementById('ph-stat-mins');
  const sEl = document.getElementById('ph-stat-sessions');
  const cEl = document.getElementById('ph-stat-clips');
  if (mEl) mEl.textContent = mins;
  if (sEl) sEl.textContent = count;
  if (cEl) cEl.textContent = clips;
}

// ── Activity Calendar (7 vikur × 7 dagar) ──
function renderCalendar() {
  const daysRow = document.getElementById('ph-calendar-days');
  const grid    = document.getElementById('ph-calendar-grid');
  const emptyEl = document.getElementById('ph-calendar-empty');
  if (!grid) return;
  const sessions = S.sessions || [];
  const filtered = !_phSelectedKey || _phSelectedKey === 'all'
    ? sessions : sessions.filter(s => s.childKey === _phSelectedKey);
  const today = new Date(); today.setHours(12,0,0,0);
  if (daysRow) daysRow.innerHTML = ['M','Þ','M','F','F','L','S'].map(d => `<div class="ph-cal-day-lbl">${d}</div>`).join('');
  let hasAny = false;
  const rows = [];
  for (let w = 6; w >= 0; w--) {
    const cells = [];
    for (let d = 6; d >= 0; d--) {
      const date    = new Date(today); date.setDate(today.getDate() - (w * 7 + d));
      const key     = makeDateKey(date);
      const isToday = (w === 0 && d === 0);
      const daySessions = filtered.filter(s => s.date === key && (s.seconds||0) >= 60);
      const mins = daySessions.reduce((a,s) => a + Math.floor((s.seconds||0)/60), 0);
      if (mins > 0) hasAny = true;
      const dotClass = mins === 0 ? 'ph-cal-dot-empty' : mins < 15 ? 'ph-cal-dot-low' : mins < 30 ? 'ph-cal-dot-mid' : 'ph-cal-dot-full';
      cells.push(`<div class="ph-cal-dot ${dotClass} ${isToday ? 'ph-cal-dot-today' : ''}" title="${key}: ${mins > 0 ? mins + ' mín' : 'Ekki lesið'}"></div>`);
    }
    rows.push(`<div class="ph-cal-row">${cells.join('')}</div>`);
  }
  grid.innerHTML = rows.join('');
  if (emptyEl) emptyEl.style.display = hasAny ? 'none' : '';
}

// ── Recordings — accordion ──
function renderRecordings() {
  const list = document.getElementById('ph-recordings-list');
  const sub  = document.getElementById('ph-rec-subtitle');
  if (!list) return;
  const sessions = S.sessions || [];
  const filtered = (!_phSelectedKey || _phSelectedKey === 'all'
    ? sessions : sessions.filter(s => s.childKey === _phSelectedKey)
  ).filter(s => s.hasAudio);

  if (sub) {
    const childName = _phSelectedKey && _phSelectedKey !== 'all'
      ? (S.parentChildren || []).find(c => c.key === _phSelectedKey)?.name || '' : '';
    sub.textContent = childName ? `15 sek klippingar úr lotum ${childName}` : '15 sek klippingar úr hverri lotu';
  }

  if (!filtered.length) {
    list.innerHTML = '<div class="ph-rec-empty">Engar upptökur enn. Klippingar birtast hér eftir lestrarlotur!</div>';
    return;
  }

  const clipDefs = [
    { key: 'audioPath_min1',  label: 'Mín. 1' },
    { key: 'audioPath_min5',  label: 'Mín. 5' },
    { key: 'audioPath_min9',  label: 'Mín. 9' },
    { key: 'audioPath_min13', label: 'Mín. 13' }
  ];

  list.innerHTML = filtered.slice(0, 20).map((s, idx) => {
    const mins  = Math.floor((s.seconds||0) / 60);
    const label = `${s.date || ''} · ${mins} mín`;

    const clips = clipDefs.map(({key: pathKey, label: clipLabel}, i) => {
      const path     = s[pathKey] || (i === 0 ? s.audioPath : null);
      const btnId    = `ph-clipbtn-${s._docId}-${i}`;
      const playerId = `ph-clipplay-${s._docId}-${i}`;
      if (!path) return `
        <div class="ph-clip-item">
          <button class="ph-clip-btn ph-clip-disabled" disabled>${clipLabel}</button>
        </div>`;
      return `
        <div class="ph-clip-item">
          <button id="${btnId}" class="ph-clip-btn"
            onclick="phPlayClip('${path}','${playerId}','${btnId}','${S.familyId}','${s.childKey}','${s._docId}')">
            ▶ ${clipLabel}
          </button>
          <div id="${playerId}" class="ph-clip-player"></div>
        </div>`;
    }).join('');

    return `
      <div class="ph-rec-item" id="ph-rec-${idx}">
        <button class="ph-rec-header" onclick="toggleRec(${idx})">
          <div class="ph-rec-label">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>
            ${label}
          </div>
          <span class="ph-rec-chevron" id="ph-chev-${idx}">›</span>
        </button>
        <div class="ph-rec-clips" id="ph-clips-${idx}" style="display:none">${clips}</div>
      </div>`;
  }).join('');
}

// ── Accordion toggle ──
export function toggleRec(idx) {
  const clips = document.getElementById('ph-clips-' + idx);
  const chev  = document.getElementById('ph-chev-' + idx);
  if (!clips) return;
  const isOpen = clips.style.display !== 'none';
  clips.style.display = isOpen ? 'none' : 'grid';
  if (chev) chev.style.transform = isOpen ? '' : 'rotate(90deg)';
}

// ══════════════════════════════════════════════
// AUDIO PLAYBACK + STAR ANIMATION TRIGGER
// Þegar foreldri smellir play → skrifar í Firebase
// → child-v2.html hlustar → star animation keyrir
// ══════════════════════════════════════════════

export async function phPlayClip(path, playerId, btnId, familyId, childKey, docId) {
  const playerEl = document.getElementById(playerId);
  const btnEl    = document.getElementById(btnId);
  if (!playerEl) return;

  // Toggle off ef þegar opið
  if (playerEl.style.display !== 'none' && playerEl.innerHTML !== '') {
    playerEl.style.display = 'none';
    playerEl.innerHTML = '';
    if (btnEl) btnEl.classList.remove('ph-clip-playing');
    return;
  }

  if (btnEl) btnEl.classList.add('ph-clip-playing');
  playerEl.style.display = '';
  playerEl.innerHTML = '<div class="ph-clip-loading">⏳ Hleður...</div>';

  try {
    // Sækja hljóðskrá úr Firebase Storage
    const url     = await getDownloadURL(ref(storage, path));
    const resp    = await fetch(url);
    if (!resp.ok) throw new Error('fetch mistókst');
    const blob    = await resp.blob();
    const ext     = path.split('.').pop().toLowerCase();
    const mime    = ext === 'mp4' ? 'audio/mp4' : ext === 'ogg' ? 'audio/ogg' : 'audio/webm';
    const blobUrl = URL.createObjectURL(new Blob([blob], { type: mime }));

    playerEl.innerHTML = `<audio controls preload="auto" src="${blobUrl}"
      style="width:100%;margin-top:6px;border-radius:8px"
      onended="URL.revokeObjectURL('${blobUrl}')"></audio>`;

    const audio = playerEl.querySelector('audio');
    if (audio) {
      // ── STAR ANIMATION TRIGGER ──
      // Þegar foreldri ýtir play → writeListenEvent → child-v2.html sér breytinguna
      // → markListenEvent() → animateListenToStar() → stjarna kviknar á barnasíðunni
      audio.addEventListener('play', () => {
        writeListenEvent(familyId, childKey, playerEl, docId);
      });
      audio.play().catch(() => {});
    }

    // Senda einu sinni við opnun (sama hegðun og upprunalegt)
    writeListenEvent(familyId, childKey, playerEl, docId);
    if (btnEl) btnEl.classList.remove('ph-clip-playing');

  } catch(e) {
    playerEl.innerHTML = '<div class="ph-clip-error">❌ Ekki tókst að hlaða</div>';
    if (btnEl) btnEl.classList.remove('ph-clip-playing');
  }
}

// ── writeListenEvent — 3 Firebase channels (sama og upprunalegt) ──
// Channel 1: listens/familyId_childKey (legacy doc)
// Channel 2: listenEvents collection (append-only)
// Channel 3: sessions/docId (fallback merge)
const _listenCooldown = {};

async function writeListenEvent(familyId, childKey, playerEl, sessionDocId) {
  if (!familyId || !childKey) return;
  const now = Date.now();
  const k   = familyId + '_' + childKey;

  // 5 sekúndna cooldown — kemur í veg fyrir spam
  if (_listenCooldown[k] && now - _listenCooldown[k] < 5000) return;

  const listenerName = S.parentName || 'Foreldri';
  let wroteAny = false;

  // Channel 1 — legacy doc (child-v2 hlustar á þetta)
  try {
    await setDoc(doc(db, 'listens', k), {
      listenerName, familyId, childKey, timestamp: now
    });
    wroteAny = true;
  } catch(e) { console.error('Listen write 1 villa:', e); }

  // Channel 2 — append-only stream (child-v2 hlustar á þetta líka)
  try {
    await addDoc(collection(db, 'listenEvents'), {
      familyId, childKey, listenerName, timestamp: now, createdAt: serverTimestamp()
    });
    wroteAny = true;
  } catch(e) { console.error('Listen write 2 villa:', e); }

  // Channel 3 — fallback á session doc
  if (sessionDocId) {
    try {
      await setDoc(doc(db, 'sessions', sessionDocId), {
        lastListenedAt: now, lastListenerName: listenerName
      }, { merge: true });
      wroteAny = true;
    } catch(e) { console.error('Listen write 3 villa:', e); }
  }

  if (wroteAny) {
    _listenCooldown[k] = now;
    // Sýna status í player
    let statusEl = playerEl.querySelector('.ph-listen-status');
    if (!statusEl) {
      statusEl = document.createElement('div');
      statusEl.className = 'ph-listen-status';
      playerEl.appendChild(statusEl);
    }
    statusEl.textContent = '✓ Hlustunarskilaboð sent';
  }
}

// ── Tab skipti ──
export function switchTab(tab) {
  ['activity','recordings'].forEach(t => {
    const btn  = document.getElementById('ph-tab-' + t);
    const cont = document.getElementById('ph-content-' + t);
    if (btn)  btn.classList.toggle('ph-tab-active', t === tab);
    if (cont) cont.style.display = t === tab ? '' : 'none';
  });
}

// ── Gamlar föll — kept for app.js back-compat ──
export function toggleExpand(key) {
  if (!S.expandedChildren) S.expandedChildren = {};
  S.expandedChildren[key] = !S.expandedChildren[key];
}

export function toggleCodes() {
  const panel = document.getElementById('codes-panel');
  const btn   = document.getElementById('codes-toggle-btn');
  if (!panel) return;
  const open = panel.style.display === 'none';
  panel.style.display = open ? '' : 'none';
  if (btn) btn.textContent = open ? '✕ Loka' : '🔑 Kóðar';
}

export async function playClip(path, playerId, btnId, familyId, childKey, sessionDocId) {
  await phPlayClip(path, playerId, btnId, familyId, childKey, sessionDocId);
}
