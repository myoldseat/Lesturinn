import {
  db, storage,
  collection, onSnapshot, query, where,
  ref, getDownloadURL,
  setDoc, doc, addDoc, serverTimestamp, updateDoc, getDoc
} from './firebase-config.js';
import { S }    from './state.js';
import { fmtTime, formatLabel, getMonday, getStreak } from './helpers.js';

// ── Theme toggle SVG icons ──

// ── Inject cover fade-in CSS ──
(function(){const s=document.createElement('style');s.textContent=`
.ph-bs-fan-img{transition:opacity .28s ease,filter .28s ease}
.ph-bs-img-loading{opacity:0;filter:blur(6px)}
.ph-bs-img-loaded{opacity:1;filter:blur(0)}
`;document.head.appendChild(s)})();
const _THEME_SVG_SUN = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#1dcdd3" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;
const _THEME_SVG_MOON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#1dcdd3" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;

// ── Goal type SVG icons ──
const _GOAL_SVG = {
  books:   `<svg width="18" height="18" viewBox="0 0 44 44" fill="none" style="display:inline-block;vertical-align:middle;filter:drop-shadow(0 0 3px rgba(29,205,211,0.5))"><rect x="14" y="10" width="18" height="23" rx="3" fill="rgba(29,205,211,0.35)" stroke="#1dcdd3" stroke-width="1.2"/><rect x="11" y="12" width="18" height="23" rx="3" fill="#1dcdd3"/><line x1="16" y1="12" x2="16" y2="35" stroke="#050f1a" stroke-width="1.8" stroke-opacity="0.5"/><line x1="19" y1="18" x2="26" y2="18" stroke="#050f1a" stroke-width="1.3" stroke-opacity="0.45"/><line x1="19" y1="22" x2="26" y2="22" stroke="#050f1a" stroke-width="1.3" stroke-opacity="0.45"/><line x1="19" y1="26" x2="24" y2="26" stroke="#050f1a" stroke-width="1.3" stroke-opacity="0.45"/><path d="M27 10 L27 17 L24.5 15 L22 17 L22 10 Z" fill="rgba(5,15,26,0.6)"/></svg>`,
  pages:   `<svg width="18" height="18" viewBox="0 0 44 44" fill="none" style="display:inline-block;vertical-align:middle;filter:drop-shadow(0 0 3px rgba(29,205,211,0.5))"><path d="M12 9 L28 9 L32 13 L32 36 L12 36 Z" fill="none" stroke="#1dcdd3" stroke-width="1.8" stroke-linejoin="round"/><path d="M28 9 L28 13 L32 13" fill="none" stroke="#1dcdd3" stroke-width="1.8" stroke-linejoin="round"/><line x1="16" y1="19" x2="28" y2="19" stroke="#1dcdd3" stroke-width="1.6" stroke-linecap="round"/><line x1="16" y1="23.5" x2="28" y2="23.5" stroke="#1dcdd3" stroke-width="1.6" stroke-linecap="round"/><line x1="16" y1="28" x2="23" y2="28" stroke="#1dcdd3" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  minutes: `<svg width="18" height="18" viewBox="0 0 44 44" fill="none" style="display:inline-block;vertical-align:middle;filter:drop-shadow(0 0 3px rgba(29,205,211,0.5))"><circle cx="22" cy="22" r="13" fill="none" stroke="#1dcdd3" stroke-width="1.8"/><path d="M22 9 A13 13 0 0 1 33.26 28.5" fill="none" stroke="#1dcdd3" stroke-width="3" stroke-linecap="round" opacity="0.35"/><line x1="22" y1="22" x2="22" y2="14" stroke="#1dcdd3" stroke-width="2" stroke-linecap="round"/><line x1="22" y1="22" x2="28" y2="26" stroke="#1dcdd3" stroke-width="1.6" stroke-linecap="round"/><circle cx="22" cy="22" r="2" fill="#1dcdd3"/></svg>`,
  days:    `<svg width="18" height="18" viewBox="0 0 44 44" fill="none" style="display:inline-block;vertical-align:middle;filter:drop-shadow(0 0 3px rgba(29,205,211,0.5))"><rect x="9" y="13" width="26" height="22" rx="3.5" fill="none" stroke="#1dcdd3" stroke-width="1.8"/><rect x="9" y="13" width="26" height="7.5" rx="3.5" fill="#1dcdd3" opacity="0.9"/><rect x="9" y="17" width="26" height="3.5" fill="#1dcdd3" opacity="0.9"/><line x1="15" y1="10" x2="15" y2="15" stroke="#1dcdd3" stroke-width="2" stroke-linecap="round"/><line x1="29" y1="10" x2="29" y2="15" stroke="#1dcdd3" stroke-width="2" stroke-linecap="round"/><circle cx="15" cy="27" r="2.5" fill="#1dcdd3"/><circle cx="22" cy="27" r="2.5" fill="#1dcdd3"/><circle cx="29" cy="27" r="2.5" fill="#1dcdd3"/><circle cx="15" cy="33.5" r="2.5" fill="#1dcdd3"/><circle cx="22" cy="33.5" r="2.5" fill="none" stroke="#1dcdd3" stroke-width="1.4" opacity="0.4"/><circle cx="29" cy="33.5" r="2.5" fill="none" stroke="#1dcdd3" stroke-width="1.4" opacity="0.4"/></svg>`
};

// ── Goal type definitions (must match bookshelf) ──
const GOAL_TYPES = {
  books:   { icon: _GOAL_SVG.books,   name: 'Bækur',     unit: 'bækur' },
  pages:   { icon: _GOAL_SVG.pages,   name: 'Blaðsíður', unit: 'bls.'  },
  minutes: { icon: _GOAL_SVG.minutes, name: 'Mínútur',   unit: 'mín.'  },
  days:    { icon: _GOAL_SVG.days,    name: 'Dagar',     unit: 'daga'  }
};

// ── Audio URL cache (15 min TTL) ──
const _audioUrlCache = {};
const _AUDIO_CACHE_TTL = 15 * 60 * 1000;

async function getCachedAudioUrl(storagePath) {
  if (!storagePath) return null;
  const now = Date.now();
  const cached = _audioUrlCache[storagePath];
  if (cached && cached.expires > now) return cached.url;
  try {
    const url = await getDownloadURL(ref(storage, storagePath));
    _audioUrlCache[storagePath] = { url, expires: now + _AUDIO_CACHE_TTL };
    return url;
  } catch (e) {
    console.warn('Audio URL fetch failed:', storagePath, e);
    return null;
  }
}


function makeDateKey(d) {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

// Normalize date key — strips leading zeros so "2026-04-16" → "2026-4-16"
function normDate(d) {
  if (!d) return '';
  const p = d.split('-');
  if (p.length !== 3) return d;
  return `${p[0]}-${parseInt(p[1])}-${parseInt(p[2])}`;
}

const IS_MONTHS = ['janúar','febrúar','mars','apríl','maí','júní',
                   'júlí','ágúst','september','október','nóvember','desember'];
const IS_MONTHS_SHORT = ['jan.','feb.','mars','apr.','maí','júní',
                         'júlí','ág.','sep.','okt.','nóv.','des.'];

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
// REALTIME BOOKS LISTENER
// ══════════════════════════════════════════════

let _booksUnsub = null;
let _dashboardReady = false;

const _preloadedCovers = new Set();
function preloadCovers(books) {
  const urls = books
    .map(b => b.coverUrl || b.coverBase64)
    .filter(Boolean)
    .filter(src => !_preloadedCovers.has(src));
  if (!urls.length) return Promise.resolve();
  return Promise.all(urls.map(src => new Promise(resolve => {
    _preloadedCovers.add(src);
    const img = new Image();
    img.onload = resolve;
    img.onerror = resolve;
    img.src = src;
  })));
}

// Preload only covers visible on dashboard: hero book + up to 3 fan covers
function preloadDashboardCovers() {
  const books = S.books || [];
  const childBooks = !_phSelectedKey || _phSelectedKey === 'all'
    ? books : books.filter(b => b.childKey === _phSelectedKey);

  const hero = childBooks.find(b => b.status === 'reading');
  const fanBooks = childBooks
    .filter(b => b.coverUrl || b.coverBase64 || b.imagePath)
    .slice(0, 3);

  const needed = [hero, ...fanBooks].filter(Boolean);
  return preloadCovers(needed);
}

export function startBooksListener() {
  if (_booksUnsub) { _booksUnsub(); _booksUnsub = null; }
  if (!S.familyId) return;
  const q = query(collection(db, 'books'), where('familyId', '==', S.familyId));
  _booksUnsub = onSnapshot(q, async snap => {
    S.books = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _dashboardReady = true;
    renderDashboard();
    // Preload only dashboard-visible covers in background, then re-render
    preloadDashboardCovers().then(() => renderDashboard());
  }, e => console.warn('Books listener villa:', e));
}

// ══════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════

let _phSelectedKey  = null;
let _hmView         = 'week';
let _hmMonth        = new Date().getMonth();
let _hmYear         = new Date().getFullYear();
let _openRecIdx     = null;
let _isPlayingAudio = false;
let _recDays        = 14;   // nýlegt: sýna síðustu 14 daga
let _recTab         = 'recent'; // 'recent' | 'saved'

// ══════════════════════════════════════════════
// PER-CLIP FAVORITES — Firestore
// ══════════════════════════════════════════════

export async function toggleClipFav(docId, clipKey, starElId) {
  if (!docId || !clipKey) return;
  const starEl = document.getElementById(starElId);

  // Lesa núverandi stöðu úr sessions cache
  const session = S.sessions?.find(s => s._docId === docId);
  if (!session) return;

  const current = !!(session?.favorites?.[clipKey]);
  const next    = !current;

  // Guest má bæta við favorites en ekki fjarlægja
  if (S.role === 'guest' && current) return;

  const listenerName = _getListenerName();
  const clipPath = _getClipPathFromSession(session, clipKey);
  const book = _findBookForSession(session);
  const now = Date.now();

  // Uppfæra UI strax (optimistic)
  if (starEl) {
    starEl.textContent = next ? '★' : '☆';
    starEl.classList.toggle('ph-clip-fav-active', next);
    starEl.title = next ? 'Fjarlægja úr uppáhaldi' : 'Vista klippingu';
  }

  // Uppfæra local cache
  const prevFavorites = { ...(session.favorites || {}) };
  const prevFavClipLabel = session.favClipLabel;
  const prevFavClipPath = session.favClipPath;
  const prevFavSavedBy = session.favSavedBy;
  const prevFavSavedAt = session.favSavedAt;
  const prevBookId = session.bookId;
  const prevBookTitle = session.bookTitle;

  if (!session.favorites) session.favorites = {};
  session.favorites[clipKey] = next;

  if (next && clipPath) {
    session.favClipLabel = clipKey;
    session.favClipPath = clipPath;
    session.favSavedAt = now;
    session.favSavedBy = listenerName;
    session.bookId = session.bookId || book?.id || null;
    session.bookTitle = session.bookTitle || book?.title || '';
  } else if (!next && session.favClipLabel === clipKey) {
    const remaining = Object.keys(session.favorites).find(k => session.favorites[k]);
    if (remaining) {
      const remainingPath = _getClipPathFromSession(session, remaining);
      session.favClipLabel = remaining;
      session.favClipPath = remainingPath || null;
    } else {
      session.favClipLabel = null;
      session.favClipPath = null;
      session.favSavedAt = null;
      session.favSavedBy = null;
    }
  }

  // Uppfæra header stjörnu
  _updateRowStar(docId);

  const sessionUpdate = {
    [`favorites.${clipKey}`]: next
  };

  if (next && clipPath) {
    sessionUpdate.favClipLabel = clipKey;
    sessionUpdate.favClipPath = clipPath;
    sessionUpdate.favSavedAt = now;
    sessionUpdate.favSavedBy = listenerName;
    if (book?.id) sessionUpdate.bookId = book.id;
    if (book?.title) sessionUpdate.bookTitle = book.title;
  } else if (!next && prevFavClipLabel === clipKey) {
    const remaining = Object.keys(session.favorites || {}).find(k => session.favorites[k]);
    if (remaining) {
      sessionUpdate.favClipLabel = remaining;
      sessionUpdate.favClipPath = _getClipPathFromSession(session, remaining) || null;
    } else {
      sessionUpdate.favClipLabel = null;
      sessionUpdate.favClipPath = null;
      sessionUpdate.favSavedAt = null;
      sessionUpdate.favSavedBy = null;
    }
  }

  // Skrifa á Firestore — session er source of truth fyrir saved clip
  try {
    await updateDoc(doc(db, 'sessions', docId), sessionUpdate);

    // Skrifa líka í books/{bookId}.journeyEntries svo parent journey og kid bookshelf lesi sömu reglu úr Firestore.
    if (book?.id && clipPath) {
      await _syncGoldMomentToBook(book, session, clipKey, clipPath, listenerName, next, now);
    }

    // Local er bara playback/cache bridge — ekki source of truth.
    if (next && clipPath) _cacheGoldMomentLocal(session, clipKey, clipPath, listenerName, book);
  } catch (e) {
    console.error('toggleClipFav villa:', e);
    // Rollback
    if (starEl) {
      starEl.textContent = current ? '★' : '☆';
      starEl.classList.toggle('ph-clip-fav-active', current);
      starEl.title = current ? 'Fjarlægja úr uppáhaldi' : 'Vista klippingu';
    }
    session.favorites = prevFavorites;
    session.favClipLabel = prevFavClipLabel;
    session.favClipPath = prevFavClipPath;
    session.favSavedBy = prevFavSavedBy;
    session.favSavedAt = prevFavSavedAt;
    session.bookId = prevBookId;
    session.bookTitle = prevBookTitle;
    _updateRowStar(docId);
  }
}

function _getClipPathFromSession(session, clipKey) {
  if (!session || !clipKey) return null;
  return session.audioPaths?.[clipKey]
    || session[`audioPath_${clipKey}`]
    || (clipKey === 'min1' ? session.audioPath : null)
    || null;
}

function _findBookForSession(session) {
  const books = S.books || [];
  if (!session) return null;
  if (session.bookId) {
    const byId = books.find(b => b.id === session.bookId);
    if (byId) return byId;
  }
  if (session.bookTitle) {
    const byTitle = books.find(b =>
      b.childKey === session.childKey &&
      String(b.title || '').trim().toLowerCase() === String(session.bookTitle || '').trim().toLowerCase()
    );
    if (byTitle) return byTitle;
  }
  const current = _getReadingBook();
  if (current && (!session.childKey || current.childKey === session.childKey)) return current;
  return books.find(b => b.childKey === session.childKey && b.status === 'reading') || null;
}

function _makeGoldMomentEntry(session, clipKey, clipPath, listenerName, now) {
  const pageFrom = session.pageFrom || session.currentPageFrom || null;
  const pageTo = session.pageTo || session.currentPageTo || null;
  return {
    type: 'gold_moment',
    id: `gm_${session._docId || session.id || 'session'}_${clipKey}`,
    sessionId: session._docId || session.id || '',
    clipKey,
    clipPath,
    date: session.date || makeDateKey(new Date()),
    savedAt: now,
    savedBy: listenerName || 'Foreldri',
    text: `${listenerName || 'Foreldri'} geymdi lesturinn þinn`,
    pageFrom,
    pageTo
  };
}

async function _syncGoldMomentToBook(book, session, clipKey, clipPath, listenerName, next, now) {
  if (!book?.id) return;
  const entryId = `gm_${session._docId || session.id || 'session'}_${clipKey}`;
  const snap = await getDoc(doc(db, 'books', book.id));
  const fresh = snap.exists() ? snap.data() : book;
  let entries = Array.isArray(fresh.journeyEntries) ? [...fresh.journeyEntries] : [];
  entries = entries.filter(e => !(e?.type === 'gold_moment' && (e.id === entryId || (e.sessionId === (session._docId || session.id) && e.clipKey === clipKey))));
  if (next) entries.unshift(_makeGoldMomentEntry(session, clipKey, clipPath, listenerName, now));
  await updateDoc(doc(db, 'books', book.id), { journeyEntries: entries, updatedAt: serverTimestamp() });

  // Optimistic local S.books update
  const localBook = (S.books || []).find(b => b.id === book.id);
  if (localBook) localBook.journeyEntries = entries;
}

function _cacheGoldMomentLocal(session, clipKey, clipPath, listenerName, book) {
  try {
    if (!S.familyId || !session?.childKey || !clipPath) return;
    const gmKey = 'upphatt_gm_' + S.familyId + '_' + session.childKey;
    localStorage.setItem(gmKey, JSON.stringify({
      saver: listenerName || 'Foreldri',
      clipPath,
      clipKey,
      sessionId: session._docId || session.id || '',
      bookId: book?.id || session.bookId || '',
      bookTitle: book?.title || session.bookTitle || '',
      date: session.date || ''
    }));
  } catch (e) { /* local cache only */ }
}


// Uppfæra header stjörnu á row — sýnir ef einhver clip inni er fav
function _updateRowStar(docId) {
  const session = S.sessions?.find(s => s._docId === docId);
  const hasFav  = session?.favorites && Object.values(session.favorites).some(v => v);
  const el      = document.getElementById(`ph-rowstar-${docId}`);
  if (el) {
    el.style.display = hasFav ? 'inline-flex' : 'none';
    el.classList.toggle('ph-clip-fav-active', hasFav);
  }
}

export function switchRecTab(tab) {
  _recTab = tab;
  _openRecIdx = null;
  renderRecordings();
}

// ══════════════════════════════════════════════
// MAIN RENDER
// ══════════════════════════════════════════════

export function renderDashboard() {
  // Show loading until books + covers are ready
  const body = document.querySelector('.ph-body');
  if (!_dashboardReady && body) {
    if (!document.getElementById('ph-loading-screen')) {
      const loader = document.createElement('div');
      loader.id = 'ph-loading-screen';
      loader.style.cssText = 'display:flex;align-items:center;justify-content:center;padding:60px 0;flex-direction:column;gap:12px;';
      loader.innerHTML = '<div style="font-size:2em">📚</div><div style="opacity:0.7">Sæki gögn...</div>';
      body.prepend(loader);
    }
    // Hide all tiles until ready
    body.querySelectorAll('.ph-tile, .ph-tile-split, .ph-stats-grid, .ph-tabs, .ph-tab-content').forEach(el => el.style.display = 'none');
    return;
  }

  // Remove loading screen and show content
  const loader = document.getElementById('ph-loading-screen');
  if (loader) loader.remove();
  const body2 = document.querySelector('.ph-body');
  if (body2) {
    body2.querySelectorAll('.ph-tile, .ph-tile-split, .ph-stats-grid, .ph-tabs').forEach(el => el.style.display = '');
    // Tab content visibility handled by switchTab
    const activeTab = document.querySelector('.ph-tab-active');
    if (activeTab) activeTab.click();
  }

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
  let children = S.parentChildren || [];
  const sessions = S.sessions || [];

  // Guest fallback: ef parentChildren er tómt, byggja úr sessions
  if (!children.length && sessions.length) {
    const seen = {};
    sessions.forEach(s => {
      if (s.childKey && !seen[s.childKey]) {
        seen[s.childKey] = true;
        children.push({ key: s.childKey, name: s.childName || s.childKey, code: '' });
      }
    });
    S.parentChildren = children;
  }

  if (!children.length) {
    row.innerHTML = '<div class="ph-no-children">Engin börn skráð enn</div>';
    return;
  }
  const today = makeDateKey(new Date());
  const isGuest = S.role === 'guest';
  row.innerHTML = children.map(c => {
    const isSelected = c.key === _phSelectedKey;
    const readToday  = sessions.some(s => s.childKey === c.key && normDate(s.date) === today && (s.seconds||0) >= 60);

    // Síðustu 7 dagar stats
    const last7 = [];
    for (let di = 0; di < 7; di++) {
      const dd = new Date(); dd.setHours(12,0,0,0);
      dd.setDate(dd.getDate() - di);
      last7.push(makeDateKey(dd));
    }
    const childSessions7 = sessions.filter(s => s.childKey === c.key && last7.includes(normDate(s.date)) && (s.seconds||0) >= 60);
    const totalMins7 = childSessions7.reduce((a,s) => a + Math.floor((s.seconds||0)/60), 0);
    const daysRead7 = new Set(childSessions7.map(s => normDate(s.date))).size;

    return `
      <div class="ph-child-card ${isSelected ? 'ph-child-selected' : ''}" onclick="selectChild('${c.key}')">
        <div class="ph-child-avatar ${isSelected ? 'ph-child-avatar-active' : ''}">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        </div>
        <div class="ph-child-name">${c.name}</div>
        ${!isGuest && c.code ? `<div class="ph-child-code">${c.code}</div>` : ''}
        <div class="ph-child-sessions">${totalMins7} mín · ${daysRead7}/7 daga</div>
        ${readToday ? '<div class="ph-child-today">✓ Las í dag</div>' : ''}
      </div>`;
  }).join('');
}

export function selectChild(key) {
  _phSelectedKey = key;
  _openRecIdx = null;
  renderChildCards();
  renderWeekGrid();
  updateStats();
  renderHeatmap();
  renderRecordings();
}

// ── 7 daga grid — síðustu 7 dagar (í dag + 6 dagar aftur) ──
const DAY_LABELS = ['S','M','Þ','M','F','F','L'];

function renderWeekGrid() {
  const grid = document.getElementById('ph-week-grid');
  if (!grid) return;
  const sessions = S.sessions || [];
  const today = new Date(); today.setHours(12,0,0,0);
  const todayKey = makeDateKey(today);

  // Síðustu 7 dagar: byrja 6 dögum síðan, enda á í dag
  const cells = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key     = makeDateKey(d);
    const isToday = key === todayKey;
    const daySessions = sessions.filter(s => {
      const matchChild = !_phSelectedKey || _phSelectedKey === 'all' ? true : s.childKey === _phSelectedKey;
      return normDate(s.date) === key && matchChild && (s.seconds||0) >= 60;
    });
    const mins     = daySessions.reduce((a,s) => a + Math.floor((s.seconds||0)/60), 0);
    const hasRead  = mins > 0;
    const dotClass = mins === 0 ? 'ph-wdot-empty' : mins < 15 ? 'ph-wdot-low' : mins < 30 ? 'ph-wdot-mid' : 'ph-wdot-full';
    cells.push(`
      <div class="ph-wday-cell" onclick="showWeekTip(this)" data-mins="${mins}">
        <div class="ph-wday-lbl ${isToday ? 'ph-wday-today' : ''}">${DAY_LABELS[d.getDay()]}</div>
        <div class="ph-wdot ${dotClass} ${isToday ? 'ph-wdot-today' : ''}">
          ${hasRead ? '<span class="ph-wdot-check">✓</span>' : ''}
        </div>
        <div class="ph-wday-num ${isToday ? 'ph-wday-today' : ''}">${d.getDate()}</div>
      </div>`);
  }
  grid.innerHTML = cells.join('');
}

// Tap tooltip for week grid
window.showWeekTip = function(el) {
  // Remove any existing tooltip
  const old = document.querySelector('.ph-wtip');
  if (old) old.remove();
  const mins = parseInt(el.dataset.mins || '0');
  const tip = document.createElement('div');
  tip.className = 'ph-wtip';
  tip.textContent = mins > 0 ? mins + ' mín' : 'Ekki lesið';
  el.style.position = 'relative';
  el.appendChild(tip);
  setTimeout(() => tip.remove(), 2000);
};

// ── Stats ──
function updateStats() {
  const sessions = S.sessions || [];
  const filtered = !_phSelectedKey || _phSelectedKey === 'all'
    ? sessions : sessions.filter(s => s.childKey === _phSelectedKey);

  renderNowReading(filtered);
  renderJourneyCard();
  renderGoalsCard();
  renderBookshelfLink();
}

// ── Timestamp helper for book fields ──
function bookTs(b, f) {
  const v = b[f]; if (!v) return 0;
  if (typeof v === 'number') return v;
  if (v.toMillis) return v.toMillis();
  if (v.seconds) return v.seconds * 1000;
  return 0;
}

function _esc(s) { return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function _getSelectedChildName() {
  if (!_phSelectedKey || _phSelectedKey === 'all') return '';
  const c = (S.parentChildren || []).find(c => c.key === _phSelectedKey);
  return c ? c.name : '';
}

function _getReadingBook() {
  const books = S.books || [];
  const childBooks = !_phSelectedKey || _phSelectedKey === 'all'
    ? books : books.filter(b => b.childKey === _phSelectedKey);
  return childBooks
    .filter(b => b.status === 'reading')
    .sort((a, b) => bookTs(b, 'lastReadAt') - bookTs(a, 'lastReadAt'))[0] || null;
}


function _reactionText(r) {
  if (typeof r === 'string') return r;
  if (!r) return '';
  const name = r.name || r.authorName || r.by || r.savedBy || '';
  const text = r.text || r.comment || r.message || '';
  return name && text ? `${name}: ${text}` : (text || name || '');
}

function _reactionAuthor(r) {
  const txt = _reactionText(r);
  if (typeof r === 'object' && r) return r.name || r.authorName || r.by || r.savedBy || '';
  const idx = txt.indexOf(':');
  return idx > -1 ? txt.slice(0, idx).trim() : '';
}

function _reactionBody(r) {
  const txt = _reactionText(r);
  const idx = txt.indexOf(':');
  return idx > -1 ? txt.slice(idx + 1).trim() : txt;
}

function _isParentRole() {
  return S.role !== 'guest';
}

function _canDeleteJourneyReaction(r) {
  if (_isParentRole()) return true;
  const mine = _getListenerName();
  const author = _reactionAuthor(r);
  return !!mine && !!author && author === mine;
}

function _getLatestJourneyReaction(hero) {
  const entries = hero?.journeyEntries || [];
  for (const e of entries) {
    if (e?.type === 'gold_moment') continue;
    const reactions = Array.isArray(e?.reactions) ? e.reactions.filter(Boolean) : [];
    if (reactions.length) return reactions[reactions.length - 1];
  }
  return null;
}

function _renderReactionBubble(r, entryIndex = null, reactionIndex = null) {
  const author = _reactionAuthor(r);
  const body = _reactionBody(r);
  const canDelete = entryIndex !== null && reactionIndex !== null && _canDeleteJourneyReaction(r);
  return `
    <div class="jm-reaction-bubble">
      <div class="jm-reaction-copy">
        ${author ? `<span class="jm-reaction-author">${_esc(author)}</span>` : ''}
        <span class="jm-reaction-text">${_esc(body)}</span>
      </div>
      ${canDelete ? `<button class="jm-reaction-delete" data-entry-index="${entryIndex}" data-reaction-index="${reactionIndex}" type="button" aria-label="Eyða kommenti">×</button>` : ''}
    </div>`;
}

function _ensureJourneyDeleteDialog() {
  let modal = document.getElementById('jm-delete-confirm');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'jm-delete-confirm';
  modal.className = 'jm-confirm-overlay';
  modal.innerHTML = `
    <div class="jm-confirm-card" role="dialog" aria-modal="true" aria-labelledby="jm-confirm-title">
      <button class="jm-confirm-x" data-jm-confirm="cancel" type="button" aria-label="Loka">×</button>
      <div class="jm-confirm-icon">!</div>
      <h2 id="jm-confirm-title">Eyða kommenti?</h2>
      <p>Þetta fjarlægir kommentið úr lestrarferðalaginu.</p>
      <div class="jm-confirm-actions">
        <button class="jm-confirm-btn secondary" data-jm-confirm="cancel" type="button">Hætta við</button>
        <button class="jm-confirm-btn danger" data-jm-confirm="ok" type="button">Eyða</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  return modal;
}

function _confirmDeleteJourneyReaction() {
  const modal = _ensureJourneyDeleteDialog();
  modal.classList.add('open');
  return new Promise(resolve => {
    const done = value => {
      modal.classList.remove('open');
      modal.querySelectorAll('[data-jm-confirm]').forEach(btn => btn.removeEventListener('click', onClick));
      modal.removeEventListener('click', onBackdrop);
      resolve(value);
    };
    const onClick = ev => done(ev.currentTarget.dataset.jmConfirm === 'ok');
    const onBackdrop = ev => { if (ev.target === modal) done(false); };
    modal.querySelectorAll('[data-jm-confirm]').forEach(btn => btn.addEventListener('click', onClick));
    modal.addEventListener('click', onBackdrop);
  });
}

async function _deleteJourneyReaction(bookId, entryIndex, reactionIndex) {
  const ok = await _confirmDeleteJourneyReaction();
  if (!ok) return;
  try {
    const book = (S.books || []).find(b => b.id === bookId);
    if (!book) return;
    const entries = (book.journeyEntries || []).map(e => ({ ...e, reactions: Array.isArray(e.reactions) ? [...e.reactions] : [] }));
    const entry = entries[entryIndex];
    if (!entry || !entry.reactions || !entry.reactions[reactionIndex]) return;
    const reaction = entry.reactions[reactionIndex];
    if (!_canDeleteJourneyReaction(reaction)) return;
    entry.reactions.splice(reactionIndex, 1);
    await updateDoc(doc(db, 'books', bookId), { journeyEntries: entries, updatedAt: serverTimestamp() });
    book.journeyEntries = entries;
    if (_jmBookId === bookId) _renderJourneyModal(bookId);
    renderJourneyCard();
  } catch (e) {
    console.error('Delete journey reaction villa:', e);
  }
}

// ── "Að lesa" kort ──
function renderNowReading(filteredSessions) {
  const el = document.getElementById('ph-now-reading');
  if (!el) return;

  const hero = _getReadingBook();

  if (!hero) {
    el.innerHTML = `
      <div class="ph-nr-empty">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="color:var(--ph-accent);opacity:.5"><path d="M4.5 5.5v13.2c0 .4.4.7.8.5 2.1-.9 4.4-.8 6.2.4.3.2.7 0 .7-.4V7.1c0-.5-.2-.9-.6-1.1-2-1.1-4.6-1.2-6.8-.2-.2.1-.3.3-.3.5Z"/><path d="M19.5 5.5v13.2c0 .4-.4.7-.8.5-2.1-.9-4.4-.8-6.2.4-.3.2-.7 0-.7-.4V7.1c0-.5.2-.9.6-1.1 2-1.1 4.6-1.2 6.8-.2.2.1.3.3.3.5Z"/></svg>
        <div class="ph-nr-empty-text">Ekkert verið að lesa</div>
      </div>`;
    return;
  }

  const pct = hero.progressPercent || 0;
  const title = hero.title || '';
  const author = hero.author || '';
  const pages = hero.currentPageTo ? `bls. ${hero.currentPageTo} af ${hero.totalPages || '?'}` : '';

  const daySet = new Set();
  let totalMins = 0;
  filteredSessions.forEach(s => {
    if ((s.seconds || 0) >= 60) {
      daySet.add(s.date || '');
      totalMins += Math.floor((s.seconds || 0) / 60);
    }
  });
  const avgMin = daySet.size > 0 ? Math.round(totalMins / daySet.size) : 0;

  const coverSrc = hero.imagePath || hero.coverUrl || hero.coverBase64 || '';
  let coverHtml = '';
  if (coverSrc) {
    coverHtml = `<img src="${_esc(coverSrc)}" alt="" class="ph-nr-cover">`;
  } else {
    const c1 = hero.c1 || '#2b8f91';
    const c2 = hero.c2 || '#0a2341';
    coverHtml = `<div class="ph-nr-cover-ph" style="background:linear-gradient(135deg,${c1},${c2})"><span>${_esc((title).charAt(0))}</span></div>`;
  }

  el.innerHTML = `
    <div class="ph-nr-label">Að lesa</div>
    <div class="ph-nr-row">
      ${coverHtml}
      <div class="ph-nr-info">
        <div class="ph-nr-title">${_esc(title)}</div>
        <div class="ph-nr-meta">${pages}</div>
        <div class="ph-nr-progress" aria-label="${pct}% búið">
          <div class="ph-nr-bar"><div class="ph-nr-fill" style="width:${pct}%"></div></div>
          <span class="ph-nr-pct">${pct}%</span>
        </div>
      </div>
    </div>`;
}

// ── Lestrarferðalag kort ──
let _jnSending = false;

function renderJourneyCard() {
  const el = document.getElementById('ph-journey-card');
  if (!el) return;

  const hero = _getReadingBook();

  if (!hero || !hero.journeyEntries?.length) {
    el.onclick = null;
    el.style.cursor = 'default';
    el.removeAttribute('data-book-id');
    el.innerHTML = `
      <div class="ph-jn-empty">
        <div class="ph-jn-label">Lestrarferðalag</div>
        <div class="ph-jn-empty-text">${hero ? 'Engar færslur enn' : 'Ekkert verið að lesa'}</div>
      </div>`;
    return;
  }

  // Find the last entry that has a child note
  const allEntries = hero.journeyEntries;
  const lastWithNote = [...allEntries].reverse().find(e => e.note && e.note.trim());
  const totalCount = allEntries.length;
  const bookId = hero.id;

  // Page range label for the last entry
  const pageRange = lastWithNote?.pageFrom
    ? `bls. ${lastWithNote.pageFrom}–${lastWithNote.pageTo}`
    : '';
  let cardMeta = '';
  if (lastWithNote?.date) {
    const p = lastWithNote.date.split('-');
    if (p.length === 3) cardMeta = `${parseInt(p[2])}. ${IS_MONTHS_SHORT[parseInt(p[1]) - 1] || ''}`;
  }
  if (pageRange) cardMeta += (cardMeta ? ' · ' : '') + pageRange;

  const latestReaction = _getLatestJourneyReaction(hero);
  const latestReactionHtml = latestReaction
    ? `<div class="ph-jn-last-comment">${_renderReactionBubble(latestReaction)}</div>`
    : '';

  el.setAttribute('data-book-id', bookId);
  el.style.cursor = 'pointer';
  el.onclick = () => openJourneyModal(bookId);

  el.innerHTML = `
    <div class="ph-jn-label">Lestrarferðalag</div>
    ${lastWithNote ? `
      <div class="ph-jn-card-note">
        ${cardMeta ? `<div class="ph-jn-card-pages">${cardMeta}</div>` : ''}
        <div class="ph-jn-card-text">\u201C${_esc(lastWithNote.note)}\u201D</div>
      </div>
      ${latestReactionHtml}
      <div class="ph-jn-meira-row">
        <span class="ph-jn-meira-pill">Meira &rsaquo;</span>
        <span class="ph-jn-total-hint">${totalCount} ${totalCount === 1 ? 'færsla' : 'færslur'}</span>
      </div>
      ${_getGoldMomentPreview(hero)}
    ` : `
      <div class="ph-jn-empty-text">Engar færslur enn</div>
    `}`;
}

// ── Gold moment preview for dashboard card ──
function _getGoldMomentPreview(hero) {
  const childKey = _phSelectedKey;
  if (!childKey) return '';

  // Firestore/book journey is source of truth first
  const entry = (hero?.journeyEntries || []).find(e => e?.type === 'gold_moment' && e.clipPath);
  if (entry) {
    _cacheGoldMomentLocal({ childKey, _docId: entry.sessionId, date: entry.date, bookTitle: hero.title }, entry.clipKey || 'gold', entry.clipPath, entry.savedBy || 'Foreldri', hero);
    return `
      <div class="ph-jn-gm-preview">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="#1dcdd3" stroke="none"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
        <span>${_esc(entry.savedBy || 'Foreldri')} varðveitti gullmola</span>
      </div>`;
  }

  // Fallback: legacy sessions with favClipLabel/favClipPath
  const gm = (S.sessions || []).find(s =>
    s.childKey === childKey &&
    (s.favClipPath || (s.favClipLabel && (s.audioPaths?.[s.favClipLabel] || s[`audioPath_${s.favClipLabel}`] || (s.favClipLabel === 'min1' ? s.audioPath : null)))) &&
    (!s.bookTitle || s.bookTitle === hero?.title)
  );
  if (!gm) return '';
  const saver = gm.favSavedBy || gm.lastListenerName || 'Foreldri';
  const clipPath = gm.favClipPath || _getClipPathFromSession(gm, gm.favClipLabel);

  _cacheGoldMomentLocal(gm, gm.favClipLabel || 'gold', clipPath, saver, hero);

  return `
    <div class="ph-jn-gm-preview">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="#1dcdd3" stroke="none"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
      <span>${_esc(saver)} varðveitti gullmola</span>
    </div>`;
}

// ── Journey full-screen modal ──
let _jmBookId = null;

export function openJourneyModal(bookId) {
  _jmBookId = bookId;
  const modal = document.getElementById('journey-modal');
  if (!modal) return;
  _renderJourneyModal(bookId);
  modal.style.display = 'flex';
}

export function closeJourneyModal(e) {
  if (e && e.target && e.target !== document.getElementById('journey-modal') && !e.target.closest('.rg-popup-close')) return;
  const modal = document.getElementById('journey-modal');
  if (modal) modal.style.display = 'none';
  const input = document.getElementById('jm-input');
  if (input) {
    input.value = '';
    input.disabled = false;
    input.onkeydown = null;
  }
  const sendBtn = document.getElementById('jm-send');
  if (sendBtn) sendBtn.onclick = null;
  _jmBookId = null;
}

function _renderJourneyModal(bookId) {
  const hero = (S.books || []).find(b => b.id === bookId);
  if (!hero) return;

  const titleEl = document.getElementById('jm-book-title');
  if (titleEl) titleEl.textContent = hero.title || '';

  // Book cover thumbnail in header
  const coverEl = document.getElementById('jm-book-cover');
  if (coverEl) {
    const coverSrc = hero.imagePath || hero.coverUrl || hero.coverBase64 || '';
    if (coverSrc) {
      coverEl.innerHTML = `<img src="${_esc(coverSrc)}" alt="" class="jm-cover-img">`;
    } else {
      const c1 = hero.c1 || '#2b8f91';
      const c2 = hero.c2 || '#0a2341';
      coverEl.innerHTML = `<div class="jm-cover-placeholder" style="background:linear-gradient(135deg,${c1},${c2})"><span>${_esc((hero.title||'').charAt(0))}</span></div>`;
    }
  }

  const feed = document.getElementById('jm-feed');
  if (!feed) return;

  const entries = (hero.journeyEntries || []);

  if (!entries.length) {
    feed.innerHTML = '<div class="jm-empty">Engar færslur enn.</div>';
    return;
  }

  feed.innerHTML = entries.map((entry, originalIndex) => ({ entry, originalIndex })).reverse().map(({ entry: e, originalIndex }) => {
    const reactions = (e.reactions || []).map((r, reactionIndex) =>
      _renderReactionBubble(r, originalIndex, reactionIndex)
    ).join('');
    // Neat short timestamp: "30. apr. · bls. 10–15"
    let meta = '';
    if (e.date) {
      const p = e.date.split('-');
      if (p.length === 3) meta = `${parseInt(p[2])}. ${IS_MONTHS_SHORT[parseInt(p[1]) - 1] || ''}`;
    }
    const pageRange = e.pageFrom ? `bls. ${e.pageFrom}–${e.pageTo}` : '';
    if (pageRange) meta += (meta ? ' · ' : '') + pageRange;
    return `
      <div class="jm-entry">
        ${meta ? `<div class="jm-entry-meta">${_esc(meta)}</div>` : ''}
        ${e.note ? `<div class="jm-entry-note">\u201C${_esc(e.note)}\u201D</div>` : ''}
        ${reactions ? `<div class="jm-reactions-list">${reactions}</div>` : ''}
      </div>`;
  }).join('');

  // ── Gullmolar (varðveitt upptaka) ──
  _renderGoldMoments(hero, feed);

  feed.querySelectorAll('.jm-reaction-delete').forEach(btn => {
    btn.addEventListener('click', ev => {
      ev.stopPropagation();
      _deleteJourneyReaction(bookId, Number(btn.dataset.entryIndex), Number(btn.dataset.reactionIndex));
    });
  });

  // Scroll to bottom (newest is first visually, feed is reversed)
  feed.scrollTop = 0;

  // Wire up compose — overwrite old handlers so comments never go to a stale book/child.
  const input = document.getElementById('jm-input');
  const sendBtn = document.getElementById('jm-send');
  if (sendBtn) {
    sendBtn.onclick = () => {
      if (!_jmBookId) return;
      _sendJourneyReaction(_jmBookId, _getListenerName(), true);
    };
  }
  if (input) {
    input.onkeydown = ev => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        if (!_jmBookId) return;
        _sendJourneyReaction(_jmBookId, _getListenerName(), true);
      }
    };
  }
}

// ── Gullmolar (varðveitt upptaka) í journey feed ──
function _renderGoldMoments(hero, feedEl) {
  const childKey = _phSelectedKey;
  if (!childKey || !hero) return;

  const entries = (hero.journeyEntries || []).filter(e => e?.type === 'gold_moment' && e.clipPath);
  const fromSessions = (S.sessions || [])
    .filter(s =>
      s.childKey === childKey &&
      (s.favClipPath || (s.favClipLabel && _getClipPathFromSession(s, s.favClipLabel))) &&
      (!s.bookTitle || s.bookTitle === hero.title)
    )
    .map(s => ({
      type: 'gold_moment',
      id: `gm_${s._docId || s.id}_${s.favClipLabel || 'gold'}`,
      sessionId: s._docId || s.id || '',
      clipKey: s.favClipLabel || 'gold',
      clipPath: s.favClipPath || _getClipPathFromSession(s, s.favClipLabel),
      date: s.date || '',
      savedBy: s.favSavedBy || s.lastListenerName || 'Foreldri',
      seconds: s.seconds || 0
    }));

  const seen = new Set();
  const goldMoments = [...entries, ...fromSessions].filter(g => {
    const key = g.id || `${g.sessionId}_${g.clipKey}_${g.clipPath}`;
    if (!g.clipPath || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (!goldMoments.length) return;

  goldMoments.forEach(gm => {
    const clipPath = gm.clipPath;
    if (!clipPath) return;

    let dateLbl = '';
    if (gm.date) {
      const p = gm.date.split('-');
      if (p.length === 3) dateLbl = `${parseInt(p[2])}. ${IS_MONTHS_SHORT[parseInt(p[1]) - 1] || ''}`;
    }

    const secs = gm.seconds || 0;
    const durLbl = secs >= 60 ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} mín` : '';
    const saver = gm.savedBy || 'Foreldri';
    const cardId = `gm-${String(gm.id || gm.sessionId || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '')}`;

    const card = document.createElement('div');
    card.className = 'jm-gold-moment';
    card.innerHTML = `
      <div class="jm-gm-header">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="#1dcdd3" stroke="none"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
        <span class="jm-gm-title">Varðveitt upptaka</span>
      </div>
      <div class="jm-gm-meta">${_esc(saver)} varðveitti gullmola${dateLbl ? ' · ' + _esc(dateLbl) : ''}${durLbl ? ' · ' + _esc(durLbl) : ''}</div>
      <button class="jm-gm-play" id="${cardId}-btn" data-gold-path="${_esc(clipPath)}" data-gold-player="${cardId}-player" type="button">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        Hlusta
      </button>
      <div class="jm-gm-player" id="${cardId}-player"><div class="jm-gm-progress"><span></span></div></div>
    `;
    feedEl.appendChild(card);
  });
}

// Custom gold moment player — avoids native browser audio controls
let _jmGoldAudio = null;
let _jmGoldTimer = null;
let _jmGoldButton = null;
let _jmGoldPlayer = null;
let _jmGoldPath = null;

function _resetGoldMomentPlayerUI() {
  clearInterval(_jmGoldTimer);
  if (_jmGoldButton) {
    _jmGoldButton.disabled = false;
    _jmGoldButton.classList.remove('is-playing');
    _jmGoldButton.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg> Hlusta';
  }
  if (_jmGoldPlayer) {
    const fill = _jmGoldPlayer.querySelector('.jm-gm-progress span');
    if (fill) fill.style.width = '0%';
  }
}

async function _toggleGoldMomentPlayback(clipPath, playerId, btn) {
  const playerEl = document.getElementById(playerId);
  if (!clipPath || !playerEl || !btn) return;

  if (_jmGoldAudio && _jmGoldPath === clipPath && _jmGoldPlayer === playerEl) {
    if (_jmGoldAudio.paused) await _jmGoldAudio.play().catch(() => {});
    else _jmGoldAudio.pause();
    return;
  }

  if (_jmGoldAudio) _jmGoldAudio.pause();
  _resetGoldMomentPlayerUI();
  _jmGoldAudio = null;
  _jmGoldPath = clipPath;
  _jmGoldButton = btn;
  _jmGoldPlayer = playerEl;

  playerEl.innerHTML = '<div class="jm-gm-progress"><span></span></div>';
  const fill = playerEl.querySelector('.jm-gm-progress span');
  btn.disabled = true;
  btn.innerHTML = '<span style="opacity:.7">Hleð...</span>';

  const url = await getCachedAudioUrl(clipPath);
  if (!url) {
    playerEl.innerHTML = '<div style="font-size:12px;color:#ff6b6b;margin-top:6px">Ekki tókst að hlaða</div>';
    btn.disabled = false;
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg> Hlusta';
    return;
  }

  _jmGoldAudio = new Audio(url);
  _jmGoldAudio.preload = 'auto';

  _jmGoldAudio.addEventListener('play', () => {
    btn.disabled = false;
    btn.classList.add('is-playing');
    btn.innerHTML = '❚❚ Spilar';
    clearInterval(_jmGoldTimer);
    _jmGoldTimer = setInterval(() => {
      if (!fill || !_jmGoldAudio?.duration) return;
      fill.style.width = Math.min(100, (_jmGoldAudio.currentTime / _jmGoldAudio.duration) * 100) + '%';
    }, 120);
  });

  _jmGoldAudio.addEventListener('pause', () => {
    btn.classList.remove('is-playing');
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg> Hlusta';
    clearInterval(_jmGoldTimer);
  });

  _jmGoldAudio.addEventListener('ended', () => {
    if (fill) fill.style.width = '0%';
    if (_jmGoldAudio) _jmGoldAudio.currentTime = 0;
    _resetGoldMomentPlayerUI();
  });

  await _jmGoldAudio.play().catch(() => {
    btn.disabled = false;
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg> Hlusta';
  });
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.jm-gm-play[data-gold-path]');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  _toggleGoldMomentPlayback(btn.dataset.goldPath, btn.dataset.goldPlayer, btn);
});

function _getListenerName() {
  if (S.role === 'guest' && S.guestName) {
    const roleLabels = { amma: 'Amma', afi: 'Afi', mamma: 'Mamma', pabbi: 'Pabbi', annad: '' };
    const prefix = roleLabels[S.guestRole] || '';
    return prefix ? `${prefix} ${S.guestName}` : S.guestName;
  }
  return S.parentName || 'Foreldri';
}

async function _sendJourneyReaction(bookId, listenerName, fromModal = false) {
  // Modal sends must always target the currently open journal, not an old closure.
  if (fromModal) {
    if (!_jmBookId) return;
    if (bookId !== _jmBookId) {
      console.warn('Blocked stale journal comment send', { attemptedBookId: bookId, openBookId: _jmBookId });
      return;
    }
  }

  if (_jnSending) return;
  const inputId = fromModal ? 'jm-input' : 'ph-jn-input';
  const sentId  = fromModal ? 'jm-sent'  : 'ph-jn-sent';
  const input = document.getElementById(inputId);
  const sentEl = document.getElementById(sentId);
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;

  _jnSending = true;
  input.disabled = true;

  try {
    const currentBookId = fromModal ? _jmBookId : bookId;
    const book = (S.books || []).find(b => b.id === currentBookId);
    if (!book || !book.journeyEntries?.length) return;

    // Extra guard: if a specific child is selected, never write to another child's book.
    if (_phSelectedKey && _phSelectedKey !== 'all' && book.childKey && book.childKey !== _phSelectedKey) {
      console.warn('Blocked journal comment send to wrong child', { bookChildKey: book.childKey, selectedChildKey: _phSelectedKey, bookId: currentBookId });
      return;
    }

    const entries = (book.journeyEntries || []).map(e => ({
      ...e,
      reactions: Array.isArray(e.reactions) ? [...e.reactions] : []
    }));

    // Attach the comment to the newest real reading entry, not a gold_moment entry.
    let targetIndex = entries.findIndex(e => e && e.type !== 'gold_moment' && (e.note || e.pageFrom || e.pageTo || e.date));
    if (targetIndex < 0) targetIndex = 0;

    const target = { ...entries[targetIndex] };
    target.reactions = [...(target.reactions || []), `${listenerName}: ${text}`];
    entries[targetIndex] = target;

    await updateDoc(doc(db, 'books', currentBookId), {
      journeyEntries: entries,
      updatedAt: serverTimestamp()
    });

    book.journeyEntries = entries;
    input.value = '';
    if (sentEl) {
      sentEl.classList.add('show');
      setTimeout(() => sentEl.classList.remove('show'), 2000);
    }

    if (fromModal && _jmBookId === currentBookId) {
      _renderJourneyModal(currentBookId);
    }
    renderJourneyCard();
  } catch (e) {
    console.error('Journey reaction villa:', e);
  } finally {
    _jnSending = false;
    if (input) input.disabled = false;
  }
}

// ── Markmið kort ──

function _getPeriodStart(period) {
  const now = new Date();
  if (period === 'week') {
    const d = new Date(now); d.setDate(d.getDate() - d.getDay() + 1);
    d.setHours(0,0,0,0); return d.getTime();
  }
  if (period === 'month') {
    return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  }
  return new Date(now.getFullYear(), 0, 1).getTime();
}

function _calcGoalProgress(g, books, sessions) {
  if (!g) return { done: 0, target: 1, pct: 0 };
  const start = Math.max(_getPeriodStart(g.period || 'week'), g.createdAt || 0);
  const target = g.target || 1;
  let done = 0;

  if (g.type === 'books') {
    done = books.filter(b => b.status === 'done' && bookTs(b, 'lastReadAt') >= start).length;
  } else if (g.type === 'pages') {
    done = sessions.filter(s => (s.timestamp || 0) >= start && (s.seconds || 0) >= 60)
      .reduce((sum, s) => sum + (s.pagesRead || 0), 0);
  } else if (g.type === 'minutes') {
    done = Math.floor(sessions.filter(s => (s.timestamp || 0) >= start && (s.seconds || 0) >= 60)
      .reduce((sum, s) => sum + (s.seconds || 0), 0) / 60);
  } else if (g.type === 'days') {
    const daySet = new Set();
    sessions.filter(s => (s.timestamp || 0) >= start && (s.seconds || 0) >= 60)
      .forEach(s => daySet.add(s.date || ''));
    done = daySet.size;
  }
  return { done, target, pct: Math.min(100, Math.round((done / target) * 100)) };
}

async function renderGoalsCard() {
  const el = document.getElementById('ph-goals-card');
  if (!el) return;

  const childKey = _phSelectedKey && _phSelectedKey !== 'all' ? _phSelectedKey : null;

  // If no specific child selected, show simple book stats
  if (!childKey) {
    const books = S.books || [];
    const doneBooks = books.filter(b => b.status === 'done').length;
    const totalBooks = books.length;
    const bookPct = totalBooks > 0 ? Math.round((doneBooks / totalBooks) * 100) : 0;
    el.innerHTML = `
      <div class="ph-goals-label">Markmið</div>
      <div class="ph-goals-rings">
        <div class="ph-goals-ring-wrap">
          ${_svgRing(bookPct, 32, 4.5)}
          <div class="ph-goals-ring-pct">${bookPct}%</div>
        </div>
      </div>
      <div class="ph-goals-labels">
        <div class="ph-goals-sub">Bækur<br><span>${doneBooks} / ${totalBooks}</span></div>
      </div>`;
    return;
  }

  // Fetch real goals from Firestore
  let goals = [];
  try {
    const goalDoc = await getDoc(doc(db, 'goals', S.familyId + '_' + childKey));
    if (goalDoc.exists()) {
      const data = goalDoc.data();
      if (Array.isArray(data.goals)) goals = data.goals.slice(0, 2);
      else if (data.type) goals = [{ type: data.type, target: data.target, period: data.period || 'week', createdAt: data.createdAt || 0 }];
    }
  } catch (e) {
    console.warn('Goals fetch villa:', e);
  }

  const books = (S.books || []).filter(b => b.childKey === childKey);
  const sessions = (S.sessions || []).filter(s => s.childKey === childKey);

  if (!goals.length) {
    // No goals set — show fallback with book progress
    const activeBook = books.filter(b => b.status === 'reading')
      .sort((a, b) => bookTs(b, 'lastReadAt') - bookTs(a, 'lastReadAt'))[0];
    const currentPage = activeBook?.currentPageTo || 0;
    const totalPages = activeBook?.totalPages || 0;
    const pagePct = totalPages > 0 ? Math.round((currentPage / totalPages) * 100) : 0;
    const doneBooks = books.filter(b => b.status === 'done').length;
    const totalBooks = books.length;
    const bookPct = totalBooks > 0 ? Math.round((doneBooks / totalBooks) * 100) : 0;

    el.innerHTML = `
      <div class="ph-goals-label">Markmið</div>
      <div class="ph-goals-empty-hint">Ekkert markmið sett</div>
      <div class="ph-goals-rings">
        <div class="ph-goals-ring-wrap">
          ${_svgRing(pagePct, 32, 4.5)}
          <div class="ph-goals-ring-pct">${pagePct}%</div>
        </div>
        <div class="ph-goals-ring-wrap">
          ${_svgRing(bookPct, 32, 4.5)}
          <div class="ph-goals-ring-pct">${bookPct}%</div>
        </div>
      </div>
      <div class="ph-goals-labels">
        <div class="ph-goals-sub">Bls.<br><span>${currentPage} / ${totalPages || '?'}</span></div>
        <div class="ph-goals-sub">Bækur<br><span>${doneBooks} / ${totalBooks}</span></div>
      </div>`;
    return;
  }

  // Render real goals
  const ringsHtml = goals.map(g => {
    const p = _calcGoalProgress(g, books, sessions);
    const info = GOAL_TYPES[g.type] || { icon: '🎯', name: g.type, unit: '' };
    const isDone = p.pct >= 100;
    return `
      <div class="ph-goals-goal">
        <div class="ph-goals-ring-wrap">
          ${_svgRing(p.pct, 32, 4.5, isDone)}
          <div class="ph-goals-ring-pct">${p.pct}%</div>
        </div>
        <div class="ph-goals-sub">${info.icon} ${info.name}<br><span>${p.done} / ${p.target} ${info.unit}</span></div>
      </div>`;
  }).join('');

  el.innerHTML = `
    <div class="ph-goals-label">Markmið</div>
    <div class="ph-goals-rings">${ringsHtml}</div>`;
}

function _svgRing(pct, r, stroke, isDone = false) {
  const size = (r + stroke) * 2;
  const circ = 2 * Math.PI * r;
  const offset = circ - (pct / 100) * circ;
  const color = isDone ? '#FFB830' : '#1dcdd3';
  const bgColor = isDone ? 'rgba(255,184,48,0.12)' : 'rgba(29,205,211,0.12)';
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" class="ph-goals-svg">
    <circle cx="${r + stroke}" cy="${r + stroke}" r="${r}" fill="none" stroke="${bgColor}" stroke-width="${stroke}"/>
    <circle cx="${r + stroke}" cy="${r + stroke}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}"
      stroke-dasharray="${circ}" stroke-dashoffset="${offset}"
      stroke-linecap="round" transform="rotate(-90 ${r + stroke} ${r + stroke})"
      style="transition:stroke-dashoffset 0.6s ease"/>
  </svg>`;
}

// ── Bókasafn link ──
function renderBookshelfLink() {
  const el = document.getElementById('ph-bookshelf-link');
  if (!el) return;

  const books = S.books || [];
  const childBooks = !_phSelectedKey || _phSelectedKey === 'all'
    ? books : books.filter(b => b.childKey === _phSelectedKey);
  const count = childBooks.length;
  const doneBooks = childBooks.filter(b => b.status === 'done');

  const childKey = _phSelectedKey && _phSelectedKey !== 'all' ? _phSelectedKey : '';
  const bookshelfUrl = childKey
    ? `bookshelf.html?family=${encodeURIComponent(S.familyId)}&child=${encodeURIComponent(childKey)}&parent=1`
    : 'bookshelf.html';

  // Get up to 3 covers for fan display — any book with a cover
  const covers = childBooks
    .filter(b => b.imagePath || b.coverUrl || b.coverBase64)
    .slice(0, 3)
    .map(b => b.imagePath || b.coverUrl || b.coverBase64);

  let coversHtml = '';
  if (covers.length >= 3) {
    coversHtml = `
      <div class="ph-bs-fan">
        <img class="ph-bs-fan-img ph-bs-fan-left ph-bs-img-loading" src="${_esc(covers[0])}" alt="" onload="this.classList.remove('ph-bs-img-loading');this.classList.add('ph-bs-img-loaded')" onerror="this.classList.remove('ph-bs-img-loading')">
        <img class="ph-bs-fan-img ph-bs-fan-center ph-bs-img-loading" src="${_esc(covers[1])}" alt="" onload="this.classList.remove('ph-bs-img-loading');this.classList.add('ph-bs-img-loaded')" onerror="this.classList.remove('ph-bs-img-loading')">
        <img class="ph-bs-fan-img ph-bs-fan-right ph-bs-img-loading" src="${_esc(covers[2])}" alt="" onload="this.classList.remove('ph-bs-img-loading');this.classList.add('ph-bs-img-loaded')" onerror="this.classList.remove('ph-bs-img-loading')">
      </div>`;
  } else if (covers.length === 2) {
    coversHtml = `
      <div class="ph-bs-fan">
        <img class="ph-bs-fan-img ph-bs-fan-left ph-bs-img-loading" src="${_esc(covers[0])}" alt="" onload="this.classList.remove('ph-bs-img-loading');this.classList.add('ph-bs-img-loaded')" onerror="this.classList.remove('ph-bs-img-loading')">
        <img class="ph-bs-fan-img ph-bs-fan-center ph-bs-img-loading" src="${_esc(covers[1])}" alt="" onload="this.classList.remove('ph-bs-img-loading');this.classList.add('ph-bs-img-loaded')" onerror="this.classList.remove('ph-bs-img-loading')">
      </div>`;
  } else if (covers.length === 1) {
    coversHtml = `
      <div class="ph-bs-fan">
        <img class="ph-bs-fan-img ph-bs-fan-center ph-bs-img-loading" src="${_esc(covers[0])}" alt="" onload="this.classList.remove('ph-bs-img-loading');this.classList.add('ph-bs-img-loaded')" onerror="this.classList.remove('ph-bs-img-loading')">
      </div>`;
  } else {
    coversHtml = `
      <div class="ph-bs-icon-wrap">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5Z"/>
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
          <path d="M9 7h6"/>
        </svg>
      </div>`;
  }

  el.innerHTML = `
    <a href="${bookshelfUrl}" class="ph-bs-link-card" title="Opna bókasafn">
      <div class="ph-bs-label">Bókasafn</div>
      ${coversHtml}
      <div class="ph-bs-count">${count} ${count === 1 ? 'bók' : 'bækur'}</div>
    </a>`;
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
  _initHeatmapTap(el);
}

// ── Tooltip for heatmap — hover (desktop) + tap (mobile) ──
let _hmTooltipTimer = null;
function _removeTooltip(container) {
  const old = container.querySelector('.ph-hm-tooltip');
  if (old) old.remove();
  if (_hmTooltipTimer) { clearTimeout(_hmTooltipTimer); _hmTooltipTimer = null; }
}

function _showTooltip(cell, container) {
  const tip = cell.dataset.tip;
  if (!tip) return;
  _removeTooltip(container);
  const el = document.createElement('div');
  el.className = 'ph-hm-tooltip';
  el.textContent = tip;
  cell.style.position = 'relative';
  el.style.position = 'absolute';
  el.style.bottom = '110%';
  el.style.left = '50%';
  el.style.transform = 'translateX(-50%)';
  cell.appendChild(el);
  _hmTooltipTimer = setTimeout(() => el.remove(), 2500);
}

function _initHeatmapTap(container) {
  // Tap (mobile + desktop click)
  container.addEventListener('click', (e) => {
    const cell = e.target.closest('[data-tip]');
    if (!cell) return;
    _showTooltip(cell, container);
  });
  // Hover (desktop)
  container.addEventListener('mouseenter', (e) => {
    const cell = e.target.closest('[data-tip]');
    if (!cell) return;
    _showTooltip(cell, container);
  }, true);
  container.addEventListener('mouseleave', (e) => {
    const cell = e.target.closest('[data-tip]');
    if (!cell) return;
    const tip = cell.querySelector('.ph-hm-tooltip');
    if (tip) tip.remove();
  }, true);
}

function minsToLevel(mins) {
  if (mins === 0) return 0; if (mins < 10) return 1;
  if (mins < 20)  return 2; if (mins < 35) return 3; return 4;
}
function levelClass(l) { return ['ph-hm-c0','ph-hm-c1','ph-hm-c2','ph-hm-c3','ph-hm-c4'][l]; }

function legendHtml() {
  return `<div class="ph-hm-legend">
    <span class="ph-hm-leg-lbl">Minna</span>
    <div class="ph-hm-leg-cell ph-hm-c0"></div><div class="ph-hm-leg-cell ph-hm-c1"></div>
    <div class="ph-hm-leg-cell ph-hm-c2"></div><div class="ph-hm-leg-cell ph-hm-c3"></div>
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
    const d = new Date(ts), dow = (d.getDay() + 6) % 7, h = d.getHours();
    if (h < 13 || h > 22) return;
    const k = `${dow}_${h}`;
    map[k] = (map[k] || 0) + Math.floor((s.seconds||0) / 60);
  });
  const todayDow = (new Date().getDay() + 6) % 7;
  const dayHdrs = DAYS.map((d, i) =>
    `<div class="ph-hm-day-lbl ${i === todayDow ? 'ph-hm-today-lbl' : ''}">${d}</div>`).join('');
  const rows = HOURS.map(h => {
    const cells = DAYS.map((d, di) => {
      const mins = map[`${di}_${h}`] || 0;
      return `<div class="ph-hm-cell ${levelClass(minsToLevel(mins))}" data-tip="${d} ${h}:00 — ${mins > 0 ? mins + ' mín' : 'Ekki lesið'}">${mins > 0 ? mins : ''}</div>`;
    }).join('');
    return `<div class="ph-hm-row"><div class="ph-hm-hour-lbl">${h}:00</div>${cells}</div>`;
  }).join('');
  return `<div class="ph-hm-wrap"><div class="ph-hm-day-row"><div class="ph-hm-hour-spacer"></div>${dayHdrs}</div><div class="ph-hm-rows">${rows}</div>${legendHtml()}</div>`;
}

function buildMonthHeatmap(sessions) {
  const DAYS = ['Mán','Þri','Mið','Fim','Fös','Lau','Sun'];
  const MONTHS_FULL = ['Janúar','Febrúar','Mars','Apríl','Maí','Júní','Júlí','Ágúst','September','Október','Nóvember','Desember'];
  const map = {};
  sessions.forEach(s => {
    if ((s.seconds||0) < 60 || !s.date) return;
    const k = normDate(s.date);
    map[k] = (map[k] || 0) + Math.floor((s.seconds||0) / 60);
  });
  const y = _hmYear, m = _hmMonth;
  const firstDay = new Date(y, m, 1), lastDay = new Date(y, m + 1, 0);
  const startDow = (firstDay.getDay() + 6) % 7;
  const todayKey = makeDateKey(new Date());
  const isNow    = y === new Date().getFullYear() && m === new Date().getMonth();
  const prevFn   = m === 0  ? `switchHeatmapMonth(${y-1},11)` : `switchHeatmapMonth(${y},${m-1})`;
  const nextFn   = m === 11 ? `switchHeatmapMonth(${y+1},0)`  : `switchHeatmapMonth(${y},${m+1})`;
  const dayHdrs  = DAYS.map(d => `<div class="ph-hm-mcal-lbl">${d}</div>`).join('');
  let cells = Array(startDow).fill(`<div class="ph-hm-mcal-cell ph-hm-mcal-empty"></div>`).join('');
  for (let day = 1; day <= lastDay.getDate(); day++) {
    const key = `${y}-${m+1}-${day}`, mins = map[key] || 0, isToday = key === todayKey;
    cells += `<div class="ph-hm-mcal-cell ${levelClass(minsToLevel(mins))} ${isToday ? 'ph-hm-today-cell' : ''}" data-tip="${day}. ${IS_MONTHS[m]} — ${mins > 0 ? mins + ' mín' : 'Ekki lesið'}"><span class="ph-hm-mcal-num">${day}</span></div>`;
  }
  return `<div class="ph-hm-wrap"><div class="ph-hm-mnav"><button class="ph-hm-nav-btn" onclick="${prevFn}">‹</button><div class="ph-hm-mname">${MONTHS_FULL[m]} ${y}</div><button class="ph-hm-nav-btn" onclick="${nextFn}" ${isNow ? 'disabled' : ''}>›</button></div><div class="ph-hm-mcal-grid">${dayHdrs}${cells}</div>${legendHtml()}</div>`;
}

function buildYearHeatmap(sessions) {
  const map = {};
  sessions.forEach(s => {
    if ((s.seconds||0) < 60 || !s.date) return;
    const k = normDate(s.date);
    map[k] = (map[k] || 0) + Math.floor((s.seconds||0) / 60);
  });
  const today = new Date(); today.setHours(12,0,0,0);
  const todayKey = makeDateKey(today);
  const start = new Date(today); start.setDate(today.getDate() - 363);
  const startDow = (start.getDay() + 6) % 7; start.setDate(start.getDate() - startDow);
  const weeks = []; let cur = new Date(start);
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
      return `<div class="ph-hm-yr-cell ${levelClass(minsToLevel(cell.mins))} ${cell.isToday ? 'ph-hm-today-cell' : ''}" data-tip="${fmtDateIS(cell.key)}: ${cell.mins > 0 ? cell.mins + ' mín' : 'Ekki lesið'}"></div>`;
    }).join('');
    return `<div class="ph-hm-yr-week">${days}</div>`;
  }).join('');
  return `<div class="ph-hm-wrap"><div class="ph-hm-yr-mlbl-row" style="grid-template-columns:repeat(${weeks.length},1fr)">${mlbls}</div><div class="ph-hm-yr-grid"><div class="ph-hm-yr-daycol"><div></div><div class="ph-hm-yr-dlbl">Þri</div><div></div><div class="ph-hm-yr-dlbl">Fim</div><div></div><div class="ph-hm-yr-dlbl">Lau</div><div></div></div><div class="ph-hm-yr-weeks">${cols}</div></div>${legendHtml()}</div>`;
}

// ══════════════════════════════════════════════
// RECORDINGS
// ══════════════════════════════════════════════

function renderRecordings() {
  const list    = document.getElementById('ph-recordings-list');
  const tileHdr = document.getElementById('ph-rec-tile-header');
  if (!list) return;
  if (_isPlayingAudio) return;

  const sessions = S.sessions || [];

  // 1. Filter by child
  let withAudio = (!_phSelectedKey || _phSelectedKey === 'all'
    ? sessions : sessions.filter(s => s.childKey === _phSelectedKey)
  ).filter(s => s.hasAudio);

  // 2. Split into tabs
  let filtered;
  if (_recTab === 'saved') {
    // Varðveitt: allar sessions sem hafa einhverja favorite clip
    filtered = withAudio.filter(s =>
      (s.favorites && Object.values(s.favorites).some(v => v)) || s.favClipLabel || s.favClipPath
    );
  } else {
    // Nýlegt: síðustu 14 dagar
    const cutoff = Date.now() - (_recDays * 24 * 60 * 60 * 1000);
    filtered = withAudio.filter(s => {
      const ts = s.timestamp || (s.createdAt?.seconds ? s.createdAt.seconds * 1000 : null);
      return ts && ts >= cutoff;
    });
  }

  const totalClips  = filtered.length;

  // ── Tile header: tabs ──
  if (tileHdr) {
    tileHdr.innerHTML = `
      <div class="ph-rec-tabs">
        <button class="ph-rec-tab ${_recTab === 'recent' ? 'ph-rec-tab-active' : ''}"
          onclick="switchRecTab('recent')">Nýlegt</button>
        <button class="ph-rec-tab ${_recTab === 'saved' ? 'ph-rec-tab-active' : ''}"
          onclick="switchRecTab('saved')">★ Varðveitt</button>
      </div>
      <div class="ph-rec-count">${totalClips} ${totalClips === 1 ? 'lota' : 'lotur'}</div>`;
  }

  if (!filtered.length) {
    list.innerHTML = `<div class="ph-rec-empty">${
      _recTab === 'saved'
        ? 'Engar vistaðar klippingar — hlustaðu á klippingu og smelltu á ★ til að vista.'
        : 'Engar klippingar.'
    }</div>`;
    return;
  }

  const clipDefs = [
    { key: 'audioPath_min1',  label: 'Mín. 1' },
    { key: 'audioPath_min2',  label: 'Mín. 2' },
    { key: 'audioPath_min5',  label: 'Mín. 5' },
    { key: 'audioPath_min8',  label: 'Mín. 8' },
    { key: 'audioPath_min9',  label: 'Mín. 9' },
    { key: 'audioPath_min10', label: 'Mín. 10' },
    { key: 'audioPath_min13', label: 'Mín. 13' }
  ];

  list.innerHTML = filtered.slice(0, 30).map((s, idx) => {
    const mins  = Math.floor((s.seconds||0) / 60);
    const label = `${fmtDateIS(s.date)}`;
    const timeLabel = `${mins} mín`;

    // Finna available clips
    const available = clipDefs.filter(({key}) => s[key] || (key === 'audioPath_min1' && s.audioPath));
    const clipCount = available.length || (s.audioPath ? 1 : 0);

    // Teal ljós — eitt per clip sem er til
    const dots = Array(clipCount).fill('<span class="ph-clip-dot"></span>').join('');

    // Separator
    const sep = '<span class="ph-rec-sep">─</span>';

    // Hefur einhver clip verið stjörnumerkt?
    const hasFav = (s.favorites && Object.values(s.favorites).some(v => v)) || !!s.favClipLabel || !!s.favClipPath;

    // Clip takkar inni í accordion
    const clips = (available.length ? available : (s.audioPath ? [{ key: 'audioPath_min1', label: 'Mín. 1' }] : [])).map(({key: pathKey, label: clipLabel}, i) => {
      const path     = s[pathKey] || (pathKey === 'audioPath_min1' ? s.audioPath : null);
      const clipKey  = pathKey.replace('audioPath_', '') || 'min1';
      const btnId    = `ph-clipbtn-${s._docId}-${i}`;
      const playerId = `ph-clipplay-${s._docId}-${i}`;
      const clipStarId = `ph-clipstar-${s._docId}-${clipKey}`;
      const isClipFav  = !!(s.favorites && s.favorites[clipKey]);
      if (!path) return '';
      return `
        <div class="ph-clip-item">
          <div class="ph-clip-row">
            <button id="${btnId}" class="ph-clip-btn"
              onclick="event.stopPropagation();phPlayClip('${path}','${playerId}','${btnId}','${S.familyId}','${s.childKey}','${s._docId}','${clipKey}')">
              ▶ ${clipLabel}
            </button>
            <button id="${clipStarId}" class="ph-clip-fav-star ${isClipFav ? 'ph-clip-fav-active' : ''}"
              style="display:${isClipFav ? 'inline-flex' : 'none'}"
              onclick="event.stopPropagation();toggleClipFav('${s._docId}','${clipKey}','${clipStarId}')"
              title="${isClipFav ? 'Fjarlægja úr uppáhaldi' : 'Vista klippingu'}">${isClipFav ? '★' : '☆'}</button>
          </div>
          <div id="${playerId}" class="ph-clip-player"></div>
        </div>`;
    }).join('');

    return `
      <div class="ph-rec-item" id="ph-rec-${idx}">
        <button class="ph-rec-header" onclick="toggleRec(${idx})">
          <div class="ph-rec-label">
            <span class="ph-rec-date">${label}</span>
            <span class="ph-rec-time">${timeLabel}</span>
            <span class="ph-clip-dots">${dots}</span>
          </div>
          <div class="ph-rec-right">
            ${sep}
            <span id="ph-rowstar-${s._docId}" class="ph-row-star ${hasFav ? 'ph-clip-fav-active' : ''}"
              style="display:${hasFav ? 'inline-flex' : 'none'}">★</span>
            <span class="ph-rec-chevron" id="ph-chev-${idx}">›</span>
          </div>
        </button>
        <div class="ph-rec-clips" id="ph-clips-${idx}" style="display:none">${clips}</div>
      </div>`;
  }).join('');

  // Restore open accordion
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

export async function phPlayClip(path, playerId, btnId, familyId, childKey, docId, clipKey) {
  const playerEl = document.getElementById(playerId);
  const btnEl    = document.getElementById(btnId);
  if (!playerEl) return;

  if (playerEl.style.display !== 'none' && playerEl.innerHTML !== '') {
    const audio = playerEl.querySelector('audio');
    if (audio) audio.pause();
    playerEl.style.display = 'none';
    playerEl.innerHTML = '';
    if (btnEl) btnEl.classList.remove('ph-clip-playing');
    _isPlayingAudio = false;
    return;
  }

  if (btnEl) btnEl.classList.add('ph-clip-playing');
  playerEl.style.display = '';
  playerEl.innerHTML = '<div class="ph-clip-loading">⏳ Hleður...</div>';
  _isPlayingAudio = true;

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
      const onEnded = () => {
        onDone();
        // Sýna ★ takka eftir hlustun — aðeins á ended, ekki pause
        if (clipKey) {
          const starId = `ph-clipstar-${docId}-${clipKey}`;
          const starEl = document.getElementById(starId);
          if (starEl) starEl.style.display = 'inline-flex';
        }
      };
      audio.addEventListener('ended', onEnded);
      audio.addEventListener('pause', onDone);
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
  // Guest: nota guestName (t.d. "Amma Sigga"), annars parentName
  let listenerName;
  if (S.role === 'guest' && S.guestName) {
    const roleLabels = { amma: 'Amma', afi: 'Afi', mamma: 'Mamma', pabbi: 'Pabbi', annad: '' };
    const prefix = roleLabels[S.guestRole] || '';
    listenerName = prefix ? `${prefix} ${S.guestName}` : S.guestName;
  } else {
    listenerName = S.parentName || 'Foreldri';
  }
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
    if (!statusEl) { statusEl = document.createElement('div'); statusEl.className = 'ph-listen-status'; playerEl.appendChild(statusEl); }
    statusEl.textContent = '✓ Hlustunarskilaboð sent';
  }
}

// ══════════════════════════════════════════════
// TAB / MISC
// ══════════════════════════════════════════════

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

export async function playClip(path, playerId, btnId, familyId, childKey, sessionDocId, clipKey) {
  await phPlayClip(path, playerId, btnId, familyId, childKey, sessionDocId, clipKey);
}

// ── Account Dropdown ──
export function toggleAccountDD(e) {
  if (e) e.stopPropagation();
  const dd = document.getElementById('account-dd');
  if (!dd) return;

  const isOpen = dd.style.display !== 'none';

  if (isOpen) {
    closeAccountDD();
    return;
  }

  // Populate email
  const emailEl = document.getElementById('acc-email-display');
  if (emailEl) emailEl.textContent = S.parentEmail || document.getElementById('ph-user-email')?.textContent || '—';

  // Populate family code
  const codeEl = document.getElementById('acc-famcode');
  if (codeEl) {
    const srcCode = document.getElementById('ph-family-code');
    codeEl.textContent = srcCode?.textContent || S.familyCode || '—';
  }

  // Sync theme icon
  const themeIcon  = document.getElementById('acc-theme-icon');
  const themeLabel = document.getElementById('acc-theme-label');
  const screen = document.getElementById('screen-parent-home');
  const isDark = !screen?.classList.contains('ph-light');
  if (themeIcon)  themeIcon.innerHTML  = isDark ? _THEME_SVG_SUN : _THEME_SVG_MOON;
  if (themeLabel) themeLabel.textContent = isDark ? 'Ljóst þema' : 'Dökkt þema';

  dd.style.display = 'block';

  // Close on click outside
  setTimeout(() => {
    document.addEventListener('click', _closeAccountDDOutside, { once: true });
  }, 10);
}

function _closeAccountDDOutside(e) {
  const dd = document.getElementById('account-dd');
  const wrap = document.querySelector('.ph-account-wrap');
  if (dd && wrap && !wrap.contains(e.target)) {
    closeAccountDD();
  } else if (dd && dd.style.display !== 'none') {
    document.addEventListener('click', _closeAccountDDOutside, { once: true });
  }
}

export function closeAccountDD() {
  const dd = document.getElementById('account-dd');
  if (dd) dd.style.display = 'none';
}

// Expose to window for inline onclick handlers
window.toggleAccountDD  = toggleAccountDD;
window.closeAccountDD   = closeAccountDD;
window.openJourneyModal  = openJourneyModal;
window.closeJourneyModal = closeJourneyModal;
