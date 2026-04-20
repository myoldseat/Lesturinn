// ─── Parent dashboard UI + Firebase realtime ───
import {
  db, storage,
  collection, onSnapshot, query, where,
  ref, getDownloadURL,
  setDoc, doc, addDoc, serverTimestamp
} from './firebase-config.js';
import { S }    from './state.js';
import { fmtTime, makeDateKey, formatLabel, getMonday, getStreak } from './helpers.js';

const IS_MONTHS = ['janúar','febrúar','mars','apríl','maí','júní',
                   'júlí','ágúst','september','október','nóvember','desember'];

function fmtDateIS(dateStr) {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length < 3) return dateStr;
  return `${parseInt(parts[2])}. ${IS_MONTHS[parseInt(parts[1]) - 1] || ''}`;
}

function fmtDateISFull(dateStr) {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length < 3) return dateStr;
  return `${parseInt(parts[2])}. ${IS_MONTHS[parseInt(parts[1]) - 1] || ''} ${parts[0]}`;
}

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
// STATE
// ══════════════════════════════════════════════

let _phSelectedKey = null;
let _hmView  = 'week';
let _hmMonth = new Date().getMonth();
let _hmYear  = new Date().getFullYear();

// Accordion state — hvaða harmonika er opin
let _openRecIdx = null;

// Blocker — hindrar re-render á recordings meðan hljóð er að spila
let _isPlayingAudio = false;

// ══════════════════════════════════════════════
// MAIN RENDER
// ══════════════════════════════════════════════

export function renderDashboard() {
  if (!_phSelectedKey) {
    const children = S.parentChildren || [];
    _phSelectedKey = children.length > 0 ? children[0].key : 'all';
  }
  renderChildCards();
  renderWeekGrid();
  updateStats();
  renderHeatmap();
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
  renderHeatmap();
  renderRecordings();
}

// ── 7 daga grid ──
const DAY_LABELS = ['S','M','Þ','M','F','F','L'];

function renderWeekGrid() {
  const grid = document.getElementById('ph-week-grid');
  if (!grid) return;
  const sessions = S.sessions || [];
  const today = new Date(); today.setHours(12,0,0,0);
  const cells = [];
  for (let i = 6; i >= 0; i--) {
    const d       = new Date(today); d.setDate(today.getDate() - i);
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
        <div class="ph-wday-lbl ${isToday ? 'ph-wday-today' : ''}">${DAY_LABELS[d.getDay()]}</div>
        <div class="ph-wdot ${dotClass} ${isToday ? 'ph-wdot-today' : ''}" title="${mins > 0 ? mins + ' mín' : 'Ekki lesið'}"></div>
        <div class="ph-wday-num ${isToday ? 'ph-wday-today' : ''}">${d.getDate()}</div>
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

// ══════════════════════════════════════════════
// HEATMAP
// ══════════════════════════════════════════════

export function switchHeatmap(view) {
  _hmView = view;
  ['week','month','year'].forEach(v => {
    const btn = document.getElementById('ph-hm-' + v);
    if (btn) btn.classList.toggle('ph-hm-tab-active', v === view);
  });
  renderHeatmap();
}

export function switchHeatmapMonth(year, month) {
  _hmYear  = year;
  _hmMonth = month;
  renderHeatmap();
}

function renderHeatmap() {
  const el = document.getElementById('ph-heatmap-content');
  if (!el) return;
  const sessions = S.sessions || [];
  const filtered = !_phSelectedKey || _phSelectedKey === 'all'
    ? sessions : sessions.filter(s => s.childKey === _phSelectedKey);
  if (_hmView === 'week')  el.innerHTML = buildWeekHeatmap(filtered);
  if (_hmView === 'month') el.innerHTML = buildMonthHeatmap(filtered);
  if (_hmView === 'year')  el.innerHTML = buildYearHeatmap(filtered);
}

function minsToLevel(mins) {
  if (mins === 0) return 0;
  if (mins < 10)  return 1;
  if (mins < 20)  return 2;
  if (mins < 35)  return 3;
  return 4;
}

function levelClass(l) {
  return ['ph-hm-c0','ph-hm-c1','ph-hm-c2','ph-hm-c3','ph-hm-c4'][l];
}

function legendHtml() {
  return `
    <div class="ph-hm-legend">
      <span class="ph-hm-leg-lbl">Minna</span>
      <div class="ph-hm-leg-cell ph-hm-c0"></div>
      <div class="ph-hm-leg-cell ph-hm-c1"></div>
      <div class="ph-hm-leg-cell ph-hm-c2"></div>
      <div class="ph-hm-leg-cell ph-hm-c3"></div>
      <div class="ph-hm-leg-cell ph-hm-c4"></div>
      <span class="ph-hm-leg-lbl">Meira</span>
    </div>`;
}

function buildWeekHeatmap(sessions) {
  const HOURS = [13,14,15,16,17,18,19,20,21,22];
  const DAYS  = ['Mán','Þri','Mið','Fim','Fös','Lau','Sun'];
  const map = {};
  sessions.forEach(s => {
    const ts = s.timestamp || (s.createdAt?.seconds ? s.createdAt.seconds * 1000 : null);
    if (!ts || (s.seconds||0) < 60) return;
    const d   = new Date(ts);
    const dow = (d.getDay() + 6) % 7;
    const h   = d.getHours();
    if (h < 13 || h > 22) return;
    const k = `${dow}_${h}`;
    map[k] = (map[k] || 0) + Math.floor((s.seconds||0) / 60);
  });
  const todayDow = (new Date().getDay() + 6) % 7;
  const dayHdrs = DAYS.map((d, i) =>
    `<div class="ph-hm-day-lbl ${i === todayDow ? 'ph-hm-today-lbl' : ''}">${d}</div>`
  ).join('');
  const rows = HOURS.map(h => {
    const cells = DAYS.map((d, di) => {
      const mins = map[`${di}_${h}`] || 0;
      const tip  = `${d} ${h}:00 — ${mins > 0 ? mins + ' mín' : 'Ekki lesið'}`;
      return `<div class="ph-hm-cell ${levelClass(minsToLevel(mins))}" title="${tip}"></div>`;
    }).join('');
    return `<div class="ph-hm-row"><div class="ph-hm-hour-lbl">${h}:00</div>${cells}</div>`;
  }).join('');
  return `
    <div class="ph-hm-wrap">
      <div class="ph-hm-day-row"><div class="ph-hm-hour-spacer"></div>${dayHdrs}</div>
      <div class="ph-hm-rows">${rows}</div>
      ${legendHtml()}
    </div>`;
}

function buildMonthHeatmap(sessions) {
  const DAYS = ['Mán','Þri','Mið','Fim','Fös','Lau','Sun'];
  const MONTHS_FULL = ['Janúar','Febrúar','Mars','Apríl','Maí','Júní',
                       'Júlí','Ágúst','September','Október','Nóvember','Desember'];
  const map = {};
  sessions.forEach(s => {
    if ((s.seconds||0) < 60 || !s.date) return;
    map[s.date] = (map[s.date] || 0) + Math.floor((s.seconds||0) / 60);
  });
  const y = _hmYear, m = _hmMonth;
  const firstDay = new Date(y, m, 1);
  const lastDay  = new Date(y, m + 1, 0);
  const startDow = (firstDay.getDay() + 6) % 7;
  const todayKey = makeDateKey(new Date());
  const isNow    = y === new Date().getFullYear() && m === new Date().getMonth();
  const prevFn   = m === 0  ? `switchHeatmapMonth(${y-1},11)` : `switchHeatmapMonth(${y},${m-1})`;
  const nextFn   = m === 11 ? `switchHeatmapMonth(${y+1},0)`  : `switchHeatmapMonth(${y},${m+1})`;
  const dayHdrs  = DAYS.map(d => `<div class="ph-hm-mcal-lbl">${d}</div>`).join('');
  let cells = Array(startDow).fill(`<div class="ph-hm-mcal-cell ph-hm-mcal-empty"></div>`).join('');
  for (let day = 1; day <= lastDay.getDate(); day++) {
    const key  = `${y}-${m+1}-${day}`;
    const mins = map[key] || 0;
    const isToday = key === todayKey;
    cells += `<div class="ph-hm-mcal-cell ${levelClass(minsToLevel(mins))} ${isToday ? 'ph-hm-today-cell' : ''}" title="${day}. ${IS_MONTHS[m]} — ${mins > 0 ? mins + ' mín' : 'Ekki lesið'}"><span class="ph-hm-mcal-num">${day}</span></div>`;
  }
  return `
    <div class="ph-hm-wrap">
      <div class="ph-hm-mnav">
        <button class="ph-hm-nav-btn" onclick="${prevFn}">‹</button>
        <div class="ph-hm-mname">${MONTHS_FULL[m]} ${y}</div>
        <button class="ph-hm-nav-btn" onclick="${nextFn}" ${isNow ? 'disabled' : ''}>›</button>
      </div>
      <div class="ph-hm-mcal-grid">${dayHdrs}${cells}</div>
      ${legendHtml()}
    </div>`;
}

function buildYearHeatmap(sessions) {
  const map = {};
  sessions.forEach(s => {
    if ((s.seconds||0) < 60 || !s.date) return;
    map[s.date] = (map[s.date] || 0) + Math.floor((s.seconds||0) / 60);
  });
  const today = new Date(); today.setHours(12,0,0,0);
  const todayKey = makeDateKey(today);
  const start = new Date(today);
  start.setDate(today.getDate() - 363);
  const startDow = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - startDow);
  const weeks = [];
  let cur = new Date(start);
  while (cur <= today) {
    const week = [];
    for (let d = 0; d < 7; d++) {
      const key = makeDateKey(cur);
      week.push({ key, mins: map[key] || 0, future: cur > today, isToday: key === todayKey });
      cur.setDate(cur.getDate() + 1);
    }
    weeks.push(week);
  }
  const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','Maí','Jún','Júl','Ágú','Sep','Okt','Nóv','Des'];
  let lastM = -1;
  const mlbls = weeks.map((week, wi) => {
    const m = new Date(week[0].key).getMonth();
    if (m !== lastM) { lastM = m; return `<div class="ph-hm-yr-mlbl" style="grid-column:${wi+1}">${MONTHS_SHORT[m]}</div>`; }
    return '';
  }).join('');
  const cols = weeks.map(week => {
    const days = week.map(cell => {
      if (cell.future) return `<div class="ph-hm-yr-cell ph-hm-c0"></div>`;
      return `<div class="ph-hm-yr-cell ${levelClass(minsToLevel(cell.mins))} ${cell.isToday ? 'ph-hm-today-cell' : ''}" title="${fmtDateIS(cell.key)}: ${cell.mins > 0 ? cell.mins + ' mín' : 'Ekki lesið'}"></div>`;
    }).join('');
    return `<div class="ph-hm-yr-week">${days}</div>`;
  }).join('');
  return `
    <div class="ph-hm-wrap">
      <div class="ph-hm-yr-mlbl-row" style="grid-template-columns:repeat(${weeks.length},1fr)">${mlbls}</div>
      <div class="ph-hm-yr-grid">
        <div class="ph-hm-yr-daycol">
          <div></div><div class="ph-hm-yr-dlbl">Þri</div><div></div>
          <div class="ph-hm-yr-dlbl">Fim</div><div></div>
          <div class="ph-hm-yr-dlbl">Lau</div><div></div>
        </div>
        <div class="ph-hm-yr-weeks">${cols}</div>
      </div>
      ${legendHtml()}
    </div>`;
}

// ══════════════════════════════════════════════
// RECORDINGS — accordion
// ══════════════════════════════════════════════

function renderRecordings() {
  const list = document.getElementById('ph-recordings-list');
  const sub  = document.getElementById('ph-rec-subtitle');
  if (!list) return;

  // Ekki re-rendera meðan hljóð er að spila — harmonika heldur sér
  if (_isPlayingAudio) return;

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
    const label = `${fmtDateIS(s.date)} · ${mins} mín`;
    const clips = clipDefs.map(({key: pathKey, label: clipLabel}, i) => {
      const path     = s[pathKey] || (i === 0 ? s.audioPath : null);
      const btnId    = `ph-clipbtn-${s._docId}-${i}`;
      const playerId = `ph-clipplay-${s._docId}-${i}`;
      if (!path) return `<div class="ph-clip-item"><button class="ph-clip-btn ph-clip-disabled" disabled>${clipLabel}</button></div>`;
      return `
        <div class="ph-clip-item">
          <button id="${btnId}" class="ph-clip-btn"
            onclick="event.stopPropagation();phPlayClip('${path}','${playerId}','${btnId}','${S.familyId}','${s.childKey}','${s._docId}')">
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

  // Endursetja harmoniku sem var opin áður en re-render
  if (_openRecIdx !== null) {
    const clips = document.getElementById('ph-clips-' + _openRecIdx);
    const chev  = document.getElementById('ph-chev-'  + _openRecIdx);
    if (clips) clips.style.display = 'grid';
    if (chev)  chev.style.transform = 'rotate(90deg)';
  }
}

export function toggleRec(idx) {
  const clips = document.getElementById('ph-clips-' + idx);
  const chev  = document.getElementById('ph-chev-' + idx);
  if (!clips) return;
  const isOpen = clips.style.display !== 'none';
  clips.style.display = isOpen ? 'none' : 'grid';
  if (chev) chev.style.transform = isOpen ? '' : 'rotate(90deg)';
  _openRecIdx = isOpen ? null : idx;
}

// ══════════════════════════════════════════════
// AUDIO PLAYBACK
// ══════════════════════════════════════════════

export async function phPlayClip(path, playerId, btnId, familyId, childKey, docId) {
  const playerEl = document.getElementById(playerId);
  const btnEl    = document.getElementById(btnId);
  if (!playerEl) return;

  // Ef þegar opið — loka, stoppa, hreinsa
  if (playerEl.style.display !== 'none' && playerEl.innerHTML !== '') {
    const audio = playerEl.querySelector('audio');
    if (audio) audio.pause();
    playerEl.style.display = 'none';
    playerEl.innerHTML = '';
    if (btnEl) btnEl.classList.remove('ph-clip-playing');
    _isPlayingAudio = false;
    return;
  }

  // Kveikja á takka og blocker
  if (btnEl) btnEl.classList.add('ph-clip-playing');
  playerEl.style.display = '';
  playerEl.innerHTML = '<div class="ph-clip-loading">⏳ Hleður...</div>';
  _isPlayingAudio = true;

  // Safety — losna eftir 90 sek í versta falli
  const safetyTimer = setTimeout(() => {
    _isPlayingAudio = false;
    if (btnEl) btnEl.classList.remove('ph-clip-playing');
  }, 90000);

  try {
    const url     = await getDownloadURL(ref(storage, path));
    const resp    = await fetch(url);
    if (!resp.ok) throw new Error('fetch mistókst');
    const blob    = await resp.blob();
    const ext     = path.split('.').pop().toLowerCase();
    const mime    = ext === 'mp4' ? 'audio/mp4' : ext === 'ogg' ? 'audio/ogg' : 'audio/webm';
    const blobUrl = URL.createObjectURL(new Blob([blob], { type: mime }));

    playerEl.innerHTML = `<audio controls preload="auto" src="${blobUrl}"
      style="width:100%;margin-top:6px;border-radius:8px"></audio>`;

    const audio = playerEl.querySelector('audio');
    if (audio) {
      const onDone = () => {
        clearTimeout(safetyTimer);
        _isPlayingAudio = false;
        if (btnEl) btnEl.classList.remove('ph-clip-playing');
        URL.revokeObjectURL(blobUrl);
      };
      audio.addEventListener('ended', onDone);
      audio.addEventListener('pause', onDone);
      // Kveikja hlustunarskilaboð við fyrstu spilun
      audio.addEventListener('play', () => {
        writeListenEvent(familyId, childKey, playerEl, docId);
      }, { once: true });
      audio.play().catch(() => {});
    }

  } catch(e) {
    clearTimeout(safetyTimer);
    playerEl.innerHTML = '<div class="ph-clip-error">❌ Ekki tókst að hlaða</div>';
    if (btnEl) btnEl.classList.remove('ph-clip-playing');
    _isPlayingAudio = false;
  }
}

// ══════════════════════════════════════════════
// LISTEN EVENT — parent-child star trigger
// ══════════════════════════════════════════════

const _listenCooldown = {};

async function writeListenEvent(familyId, childKey, playerEl, sessionDocId) {
  if (!familyId || !childKey) return;
  const now = Date.now();
  const k   = familyId + '_' + childKey;
  if (_listenCooldown[k] && now - _listenCooldown[k] < 5000) return;
  const listenerName = S.parentName || 'Foreldri';
  let wroteAny = false;

  try { await setDoc(doc(db,'listens',k), { listenerName, familyId, childKey, timestamp: now }); wroteAny = true; }
  catch(e) { console.error('Listen write 1:', e); }

  try { await addDoc(collection(db,'listenEvents'), { familyId, childKey, listenerName, timestamp: now, createdAt: serverTimestamp() }); wroteAny = true; }
  catch(e) { console.error('Listen write 2:', e); }

  if (sessionDocId) {
    try { await setDoc(doc(db,'sessions',sessionDocId), { lastListenedAt: now, lastListenerName: listenerName }, { merge: true }); wroteAny = true; }
    catch(e) { console.error('Listen write 3:', e); }
  }

  if (wroteAny) {
    _listenCooldown[k] = now;
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
