// ─── Pure utilities — no Firebase, no state mutation ───

// ── Navigation ──
export function goTo(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  window.scrollTo(0, 0);
}

// ── Time formatting ──
export function fmtTime(s) {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ── Date helpers ──
export function makeDateKey(d) {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export function formatLabel(v) {
  const d = v?.toDate ? v.toDate() : (typeof v === 'number' ? new Date(v) : null);
  if (!d || isNaN(d)) return '';
  return d.toLocaleString('is-IS', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function getMonday(date = new Date()) {
  const d = new Date(date);
  d.setHours(12, 0, 0, 0);
  const day = d.getDay();
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  return d;
}

// ── Week dots renderer ──
export function renderWeekDots(sessions, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const mon = getMonday();
  const labels = ['Mán', 'Þri', 'Mið', 'Fim', 'Fös', 'Lau', 'Sun'];
  el.innerHTML = labels.map((lbl, i) => {
    const d = new Date(mon);
    d.setDate(mon.getDate() + i);
    const key = makeDateKey(d);
    const mins = sessions.filter(s => s.date === key)
      .reduce((a, s) => a + Math.floor((s.seconds || 0) / 60), 0);
    const cls = mins >= 15 ? 'full' : mins > 0 ? 'partial' : 'none';
    return `<div class="day-dot ${cls}"><div>${lbl}</div><div>${mins > 0 ? mins + 'm' : '—'}</div></div>`;
  }).join('');
}

// ── Streak calculator ──
export function getStreak(sessions) {
  if (!sessions.length) return 0;
  let streak = 0;
  const d = new Date();
  for (let i = 0; i < 90; i++) {
    const k = makeDateKey(d);
    if (sessions.some(s => s.date === k && (s.seconds || 0) >= 60)) {
      streak++;
      d.setDate(d.getDate() - 1);
    } else if (i === 0) {
      d.setDate(d.getDate() - 1);
    } else break;
  }
  return streak;
}

// ── Sound effects ──
export function playSound(type) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const now = ctx.currentTime;
    const notes = {
      done:      { tones: [[523,0],[659,.15],[784,.3],[1047,.5]],     wave: 'sine',     vol: .3,  dur: .4 },
      milestone: { tones: [[523,0],[659,.1],[784,.2],[1047,.35],[1047,.55]], wave: 'triangle', vol: .35, dur: .5 },
      streak:    { tones: [[392,0],[523,.2],[659,.4],[784,.6],[1047,.8]],    wave: 'sine',     vol: .25, dur: .6 }
    }[type];
    if (!notes) return;
    notes.tones.forEach(([f, dl]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = f; o.type = notes.wave;
      g.gain.setValueAtTime(notes.vol, now + dl);
      g.gain.exponentialRampToValueAtTime(.001, now + dl + notes.dur);
      o.start(now + dl); o.stop(now + dl + notes.dur + .1);
    });
  } catch (e) { /* silent fail */ }
}

// ── Milestones ──
const MILESTONES = [
  { count: 1,  icon: '🌱', title: 'Fyrsta skrefið!',  text: 'Þú kláraðir fyrstu lotuna!' },
  { count: 5,  icon: '⭐', title: 'Fimm lotur!',      text: 'Þú ert að verða lesari!' },
  { count: 10, icon: '🦁', title: 'Sterkur lesari!',  text: 'Tíu lotur — stórkostlegt!' },
  { count: 20, icon: '🏆', title: 'Meistarinn!',      text: 'Tuttugu lotur — þú ert snillingur!' },
  { count: 50, icon: '🚀', title: 'Lestrarhetja!',    text: 'Fimmtíu lotur — ótrúlegt!' },
];

export function checkMilestone(total) {
  const m = MILESTONES.find(x => x.count === total);
  if (!m) return;
  document.getElementById('milestone-icon').textContent  = m.icon;
  document.getElementById('milestone-title').textContent = m.title;
  document.getElementById('milestone-text').textContent  = m.text;
  const card = document.getElementById('milestone-card');
  card.style.display = '';
  setTimeout(() => { card.style.display = 'none'; }, 8000);
  setTimeout(() => playSound('milestone'), 300);
}

// ── Shields ──
export function getShields(childKey) {
  return parseInt(localStorage.getItem('upphatt_shields_' + childKey) || '0');
}

export function setShields(childKey, n) {
  localStorage.setItem('upphatt_shields_' + childKey, Math.max(0, n));
}

export function checkAndGrantShield(childKey, streak) {
  const given  = parseInt(localStorage.getItem('upphatt_shields_given_' + childKey) || '0');
  const earned = Math.floor(streak / 7);
  if (earned > given) {
    const n = earned - given;
    localStorage.setItem('upphatt_shields_given_' + childKey, earned);
    setShields(childKey, getShields(childKey) + n);
    return n;
  }
  return 0;
}

export function getStreakWithShields(sessions, childKey) {
  if (!sessions.length) return 0;
  const shields = getShields(childKey);
  let streak = 0, used = 0;
  const d = new Date();
  for (let i = 0; i < 180; i++) {
    const k = makeDateKey(d);
    const has = sessions.some(s => s.date === k && (s.seconds || 0) >= 60);
    if (has) { streak++; d.setDate(d.getDate() - 1); }
    else if (i === 0) { d.setDate(d.getDate() - 1); }
    else if (used < shields) { used++; streak++; d.setDate(d.getDate() - 1); }
    else break;
  }
  return streak;
}