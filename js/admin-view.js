// ─── Admin dashboard — hidden behind secret code ───
import {
  db,
  collection, getDocs, query, where, onSnapshot, doc, getDoc
} from './firebase-config.js';
import { S } from './state.js';
import { goTo } from './helpers.js';

const ADMIN_CODE = 'ADMIN001';

let _adminSessions = [];
let _adminFamilies = {};
let _adminUnsub = null;

// ══════════════════════════════════════════
// ADMIN TUNING — only these 3 metrics matter
// ══════════════════════════════════════════

const ADMIN_RULES = {
  early: {
    maxSyllables: 45,
    minFragmentation: 70,
    maxLongestBurst: 1.2
  },
  developing: {
    maxSyllables: 65,
    minFragmentation: 55,
    maxLongestBurst: 2.0
  },
  steady: {
    minSyllables: 55,
    maxFragmentation: 65,
    minLongestBurst: 1.6
  },
  flowing: {
    minSyllables: 70,
    maxFragmentation: 50,
    minLongestBurst: 2.4
  }
};

function getAdminMetrics(s) {
  const analysis = s.analysis || {};
  const session = analysis.session || {};
  const snippets = analysis.snippets || {};

  const usableSnippetBursts = [
    snippets.min1,
    snippets.min2,
    snippets.min4,
    snippets.min7,
    snippets.min10
  ]
    .filter(sn => sn && sn.usable)
    .map(sn => Number(sn.longestBurst || 0))
    .filter(v => v > 0);

  const longestBurst = usableSnippetBursts.length
    ? Math.max(...usableSnippetBursts)
    : 0;

  return {
    praatSyllables: Number(session.praatSyllables || 0),
    fragmentationScore: Number(session.fragmentationScore || 0),
    longestBurst
  };
}

function getAdminProfileFromMetrics({ praatSyllables, fragmentationScore, longestBurst }) {
  if (!praatSyllables && !fragmentationScore && !longestBurst) return 'unknown';

  if (
    praatSyllables < ADMIN_RULES.early.maxSyllables &&
    fragmentationScore >= ADMIN_RULES.early.minFragmentation &&
    longestBurst < ADMIN_RULES.early.maxLongestBurst
  ) {
    return 'early';
  }

  if (
    praatSyllables < ADMIN_RULES.developing.maxSyllables &&
    fragmentationScore >= ADMIN_RULES.developing.minFragmentation &&
    longestBurst < ADMIN_RULES.developing.maxLongestBurst
  ) {
    return 'developing';
  }

  if (
    praatSyllables >= ADMIN_RULES.flowing.minSyllables &&
    fragmentationScore < ADMIN_RULES.flowing.maxFragmentation &&
    longestBurst >= ADMIN_RULES.flowing.minLongestBurst
  ) {
    return 'flowing';
  }

  if (
    praatSyllables >= ADMIN_RULES.steady.minSyllables &&
    fragmentationScore < ADMIN_RULES.steady.maxFragmentation &&
    longestBurst >= ADMIN_RULES.steady.minLongestBurst
  ) {
    return 'steady';
  }

  return 'mixed';
}

function getAdminProfileLabel(key) {
  if (key === 'early') return 'Að fóta sig';
  if (key === 'developing') return 'Á leiðinni';
  if (key === 'steady') return 'Orðið stöðugra';
  if (key === 'flowing') return 'Flæðandi';
  if (key === 'mixed') return 'Blandað';
  return 'Engin túlkun';
}

function getAdminProfileColor(key) {
  if (key === 'early') return '#f87171';
  if (key === 'developing') return '#fbbf24';
  if (key === 'steady') return '#60a5fa';
  if (key === 'flowing') return '#4ade80';
  if (key === 'mixed') return '#c084fc';
  return '#94a3b8';
}

// ══════════════════════════════════════════
// AUTH CHECK
// ══════════════════════════════════════════

export function isAdminCode(code) {
  return code === ADMIN_CODE;
}

export function openAdminDashboard() {
  S.role = 'admin';
  loadAllSessions();
  goTo('screen-admin');
}

export function closeAdmin() {
  if (_adminUnsub) { _adminUnsub(); _adminUnsub = null; }
  _adminSessions = [];
  _adminFamilies = {};
  S.role = null;
  goTo('screen-child-login');
}

// ══════════════════════════════════════════
// DATA LOADING
// ══════════════════════════════════════════

async function loadAllSessions() {
  const el = document.getElementById('admin-content');
  if (!el) return;
  el.innerHTML = '<div class="admin-loading">Hleð gögnum...</div>';

  try {
    // Load all sessions
    const snap = await getDocs(collection(db, 'sessions'));
    _adminSessions = snap.docs
      .map(d => ({ _docId: d.id, ...d.data() }))
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    // Group by familyId
    _adminFamilies = {};
    _adminSessions.forEach(s => {
      if (!s.familyId) return;
      if (!_adminFamilies[s.familyId]) {
        _adminFamilies[s.familyId] = { sessions: [], children: new Set() };
      }
      _adminFamilies[s.familyId].sessions.push(s);
      if (s.childName) _adminFamilies[s.familyId].children.add(s.childName);
    });

    renderAdmin();
  } catch (e) {
    console.error('Admin load failed:', e);
    el.innerHTML = `<div class="admin-error">Villa: ${e.message}</div>`;
  }
}

// ══════════════════════════════════════════
// RENDER
// ══════════════════════════════════════════

function renderAdmin() {
  const el = document.getElementById('admin-content');
  if (!el) return;

  const totalSessions = _adminSessions.length;
  const totalFamilies = Object.keys(_adminFamilies).length;
  const totalMins = Math.round(_adminSessions.reduce((a, s) => a + (s.seconds || 0), 0) / 60);
  const withAnalysis = _adminSessions.filter(s => s.analysis).length;
  const withAudio = _adminSessions.filter(s => s.hasAudio).length;

  // Analysis stats
  const analyzed = _adminSessions.filter(s => s.analysis?.overall);
  const avgUsable = analyzed.length
    ? (analyzed.reduce((a, s) => a + (s.analysis.overall.usableCount || 0), 0) / analyzed.length).toFixed(1)
    : '—';
  const avgScore = analyzed.filter(s => s.analysis?.overall?.avgScore > 0).length
    ? (
        analyzed.reduce((a, s) => a + (s.analysis?.overall?.avgScore || 0), 0) /
        analyzed.filter(s => s.analysis?.overall?.avgScore > 0).length
      ).toFixed(1)
    : '—';

  // Admin profile distribution — based only on:
  // praatSyllables, fragmentationScore, longestBurst
  const profiles = {
    early: 0,
    developing: 0,
    steady: 0,
    flowing: 0,
    mixed: 0,
    unknown: 0
  };

  analyzed.forEach(s => {
    const metrics = getAdminMetrics(s);
    const p = getAdminProfileFromMetrics(metrics);
    if (profiles[p] !== undefined) profiles[p]++;
  });

  // Quality distribution
  const qualities = { good: 0, fair: 0, poor: 0 };
  analyzed.forEach(s => {
    const q = s.analysis?.overall?.readingQuality;
    if (q && qualities[q] !== undefined) qualities[q]++;
  });

  el.innerHTML = `
    <div class="admin-stats">
      <div class="admin-stat"><div class="admin-stat-val">${totalFamilies}</div><div class="admin-stat-lbl">Fjölskyldur</div></div>
      <div class="admin-stat"><div class="admin-stat-val">${totalSessions}</div><div class="admin-stat-lbl">Lotur</div></div>
      <div class="admin-stat"><div class="admin-stat-val">${totalMins}</div><div class="admin-stat-lbl">Mínútur</div></div>
      <div class="admin-stat"><div class="admin-stat-val">${withAudio}</div><div class="admin-stat-lbl">Með hljóð</div></div>
      <div class="admin-stat"><div class="admin-stat-val">${withAnalysis}</div><div class="admin-stat-lbl">Greind</div></div>
      <div class="admin-stat"><div class="admin-stat-val">${avgUsable}</div><div class="admin-stat-lbl">Meðal nothæf</div></div>
      <div class="admin-stat"><div class="admin-stat-val">${avgScore}</div><div class="admin-stat-lbl">Meðal skor</div></div>
    </div>

    ${analyzed.length ? `
    <div class="admin-section">
      <h3>Lestrarstíll (admin túlkun)</h3>
      <div class="admin-bar-row">
        <div class="admin-bar-item"><span class="admin-bar-dot" style="background:#f87171"></span> Að fóta sig: ${profiles.early}</div>
        <div class="admin-bar-item"><span class="admin-bar-dot" style="background:#fbbf24"></span> Á leiðinni: ${profiles.developing}</div>
        <div class="admin-bar-item"><span class="admin-bar-dot" style="background:#60a5fa"></span> Orðið stöðugra: ${profiles.steady}</div>
        <div class="admin-bar-item"><span class="admin-bar-dot" style="background:#4ade80"></span> Flæðandi: ${profiles.flowing}</div>
        <div class="admin-bar-item"><span class="admin-bar-dot" style="background:#c084fc"></span> Blandað: ${profiles.mixed}</div>
        <div class="admin-bar-item"><span class="admin-bar-dot" style="background:#94a3b8"></span> Engin túlkun: ${profiles.unknown}</div>
      </div>
    </div>

    <div class="admin-section">
      <h3>Lestrargæði</h3>
      <div class="admin-bar-row">
        <div class="admin-bar-item"><span class="admin-bar-dot" style="background:#4ade80"></span> Good: ${qualities.good}</div>
        <div class="admin-bar-item"><span class="admin-bar-dot" style="background:#fbbf24"></span> Fair: ${qualities.fair}</div>
        <div class="admin-bar-item"><span class="admin-bar-dot" style="background:#f87171"></span> Poor: ${qualities.poor}</div>
      </div>
    </div>
    ` : '<div class="admin-section"><p style="color:var(--ph-soft)">Engar greindar lotur enn — greining bætist við næstu lotur.</p></div>'}

    <div class="admin-section">
      <h3>Fjölskyldur (${totalFamilies})</h3>
      ${Object.entries(_adminFamilies).map(([fid, fam]) => {
        const children = [...fam.children].join(', ') || 'Engin börn';
        const famMins = Math.round(fam.sessions.reduce((a, s) => a + (s.seconds || 0), 0) / 60);
        const famAnalyzed = fam.sessions.filter(s => s.analysis?.overall);
        const famAvgScore = famAnalyzed.length
          ? (famAnalyzed.reduce((a, s) => a + (s.analysis?.overall?.avgScore || 0), 0) / famAnalyzed.length).toFixed(1)
          : '—';
        return `
          <div class="admin-family-card">
            <div class="admin-family-header">
              <div class="admin-family-id">${fid}</div>
              <div class="admin-family-children">${children}</div>
            </div>
            <div class="admin-family-stats">
              <span>${fam.sessions.length} lotur</span>
              <span>${famMins} mín</span>
              <span>Skor: ${famAvgScore}</span>
              <span>${famAnalyzed.length} greindar</span>
            </div>
          </div>`;
      }).join('')}
    </div>

    <div class="admin-section">
      <h3>Nýjustu lotur með greiningu</h3>
      ${analyzed.slice(0, 20).map(s => {
        const a = s.analysis;
        const metrics = getAdminMetrics(s);
        const adminProfile = getAdminProfileFromMetrics(metrics);
        return `
          <div class="admin-session-row">
            <div class="admin-session-info">
              <strong>${s.childName || '?'}</strong>
              <span>${s.title || 'Lestur'}</span>
              <span>${s.date || ''}</span>
            </div>
            <div class="admin-session-metrics">
              <span>Skor: ${a.overall?.avgScore || '—'}</span>
              <span>Nothæf: ${a.overall?.usableCount || 0}/${a.overall?.totalSnippets || '?'}</span>
              <span>Gæði: ${a.overall?.readingQuality || '—'}</span>
              <span style="color:${getAdminProfileColor(adminProfile)}">Admin flokkur: ${getAdminProfileLabel(adminProfile)}</span>
              <span>Syllables: ${metrics.praatSyllables || '—'}</span>
              <span>Fragmentation: ${metrics.fragmentationScore || '—'}</span>
              <span>Longest burst: ${metrics.longestBurst || '—'}</span>
              ${a.session ? `<span>Gamalt profile: ${a.session.profile}</span>` : ''}
            </div>
          </div>`;
      }).join('') || '<p style="color:var(--ph-soft)">Engar greindar lotur enn.</p>'}
    </div>
  `;
}
