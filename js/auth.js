// ─── Authentication & user processing ───
// TODO: Bæta við emailVerified check í firebaseLogin, parentLoginFromPopup og onAuthStateChanged
import {
  auth, db,
  signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendEmailVerification, sendPasswordResetEmail,
  onAuthStateChanged, signOut,
  collection, setDoc, doc, getDoc, getDocs, query, where, serverTimestamp
} from './firebase-config.js';
import { S }  from './state.js';
import { goTo } from './helpers.js';
import { setupChildHome, cancelReading } from './child-view.js';
import { startFamilyListener, renderDashboard } from './parent-view.js';

let _signupInProgress = false;

// ── Restore missing code docs ──
async function restoreMissingCodeDocsFromProfile(familyId, children) {
  if (!familyId || !Array.isArray(children) || !children.length) return;
  await Promise.all(children.map(async (c) => {
    const code = (c?.code || '').toString().trim().toUpperCase();
    if (!code || !c?.key || !c?.name) return;
    try {
      const snap = await getDoc(doc(db, 'codes', code));
      if (!snap.exists()) await setDoc(doc(db, 'codes', code), { familyId, childKey: c.key, childName: c.name });
    } catch (e) { console.warn('Could not restore code doc for', code, e); }
  }));
}

// ── Process authenticated parent ──
async function processAuthUser(user) {
  const snap    = await getDoc(doc(db, 'users', user.uid));
  const profile = snap.exists() ? snap.data() : null;

  S.role            = 'parent';
  S.familyId        = profile?.familyId || user.uid;
  S.parentName      = (profile?.name || 'Foreldri').split(' ')[0];
  S.parentEmail     = user.email || '';
  S.parentChildren  = profile?.children || [];
  S.expandedChildren = {};

  await restoreMissingCodeDocsFromProfile(S.familyId, S.parentChildren);

  document.getElementById('parent-pill').textContent = S.parentName;
  document.getElementById('parent-hero').textContent = `Góðan dag, ${S.parentName}`;

  if (S.parentChildren.length) {
    document.getElementById('codes-list').innerHTML =
      S.parentChildren.map(c => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.15)">
          <div style="font-size:13px;font-weight:800;color:white">👦 ${c.name}</div>
          <div style="font-family:Georgia,serif;font-size:20px;font-weight:700;color:rgba(255,255,255,0.9);letter-spacing:3px">${c.code || '—'}</div>
        </div>`).join('');
  } else {
    try {
      const codesSnap = await getDocs(query(collection(db, 'codes'), where('familyId', '==', S.familyId)));
      if (!codesSnap.empty) {
        const codes = codesSnap.docs.map(d => ({ code: d.id, ...d.data() }));
        S.parentChildren = codes.map(c => ({ name: c.childName, key: c.childKey, code: c.code }));
      }
    } catch (e) { console.error('Kóðaleit villa:', e); }
  }

  const emailEl = document.getElementById('ph-user-email');
  if (emailEl) emailEl.textContent = S.parentEmail;
  const fcEl = document.getElementById('ph-family-code');
  if (fcEl) fcEl.textContent = profile?.familyCode || '—';

  initParentTheme();
  startFamilyListener();
  goTo('screen-parent-home');

  document.getElementById('login-email').disabled    = false;
  document.getElementById('login-pw').disabled       = false;
  document.getElementById('login-error').textContent = '';
}

// ── Parent login (screen) ──
export async function firebaseLogin() {
  const email = document.getElementById('login-email').value.trim();
  const pw    = document.getElementById('login-pw').value;
  const err   = document.getElementById('login-error');
  err.textContent = '';
  if (!email || !pw) { err.textContent = 'Sláðu inn netfang og lykilorð.'; return; }
  try {
    document.getElementById('login-email').disabled = true;
    document.getElementById('login-pw').disabled    = true;
    const cred = await signInWithEmailAndPassword(auth, email, pw);
    await processAuthUser(cred.user);
  } catch (e) {
    err.textContent = 'Innskráning mistókst — athugaðu netfang og lykilorð.';
    document.getElementById('login-email').disabled = false;
    document.getElementById('login-pw').disabled    = false;
  }
}

// ══════════════════════════════════════════
// LOGIN POPUP — 3 views
// ══════════════════════════════════════════

function _loginShowView(view) {
  ['a','b','c'].forEach(v => {
    const el = document.getElementById('login-view-' + v);
    if (el) el.style.display = v === view ? '' : 'none';
  });
}

export function openParentLoginPopup() {
  const modal = document.getElementById('parent-login-popup');
  if (!modal) return;
  _loginShowView('a');
  modal.style.display = 'grid';
  setTimeout(() => document.getElementById('popup-login-email')?.focus(), 80);
}

export function closeParentLoginPopup() {
  const modal = document.getElementById('parent-login-popup');
  if (modal) modal.style.display = 'none';
  document.getElementById('popup-login-error').textContent = '';
  document.getElementById('reset-error').textContent = '';
  const emailEl = document.getElementById('popup-login-email');
  const pwEl    = document.getElementById('popup-login-pw');
  const resetEl = document.getElementById('reset-email');
  if (emailEl) { emailEl.value = ''; emailEl.disabled = false; }
  if (pwEl)    { pwEl.value = '';    pwEl.disabled = false; }
  if (resetEl) { resetEl.value = ''; }
  const btn = document.querySelector('#login-view-a .rg-popup-btn');
  if (btn) { btn.textContent = 'Skrá inn'; btn.disabled = false; }
  _loginShowView('a');
}

export async function parentLoginFromPopup() {
  const emailEl = document.getElementById('popup-login-email');
  const pwEl    = document.getElementById('popup-login-pw');
  const errEl   = document.getElementById('popup-login-error');
  const btn     = document.querySelector('#login-view-a .rg-popup-btn');
  errEl.textContent = '';
  const email = emailEl.value.trim();
  const pw    = pwEl.value;
  if (!email || !pw) { errEl.textContent = 'Sláðu inn netfang og lykilorð.'; return; }
  try {
    emailEl.disabled = true; pwEl.disabled = true;
    if (btn) { btn.textContent = 'Skrá inn...'; btn.disabled = true; }
    const cred = await signInWithEmailAndPassword(auth, email, pw);
    closeParentLoginPopup();
    await processAuthUser(cred.user);
  } catch (e) {
    errEl.textContent = 'Innskráning mistókst — athugaðu netfang og lykilorð.';
    emailEl.disabled = false; pwEl.disabled = false;
    if (btn) { btn.textContent = 'Skrá inn'; btn.disabled = false; }
  }
}

export function showForgotPassword() {
  document.getElementById('reset-error').textContent = '';
  document.getElementById('reset-email').value = document.getElementById('popup-login-email').value || '';
  _loginShowView('b');
  setTimeout(() => document.getElementById('reset-email')?.focus(), 60);
}

export function backToLogin() {
  document.getElementById('reset-error').textContent = '';
  _loginShowView('a');
}

export async function sendPasswordReset() {
  const emailEl = document.getElementById('reset-email');
  const errEl   = document.getElementById('reset-error');
  const btn     = document.querySelector('#login-view-b .rg-popup-btn');
  errEl.textContent = '';
  const email = emailEl.value.trim();
  if (!email) { errEl.textContent = 'Sláðu inn netfangið þitt.'; return; }
  try {
    if (btn) { btn.textContent = 'Sendir...'; btn.disabled = true; }
    await sendPasswordResetEmail(auth, email);
    _loginShowView('c');
  } catch (e) {
    errEl.textContent = 'Ekki tókst að senda — athugaðu netfangið.';
    if (btn) { btn.textContent = 'Senda link'; btn.disabled = false; }
  }
}

// ══════════════════════════════════════════
// SIGNUP POPUP
// ══════════════════════════════════════════

export function openSignupPopup() {
  closeParentLoginPopup();
  const modal = document.getElementById('parent-signup-popup');
  if (!modal) return;
  document.getElementById('signup-view-form').style.display    = '';
  document.getElementById('signup-view-success').style.display = 'none';
  document.getElementById('signup-error').textContent = '';
  modal.style.display = 'grid';
  setTimeout(() => document.getElementById('su-name')?.focus(), 80);
}

export function closeSignupPopup() {
  // Hreinsa _signupInProgress og fara á child-login þegar popup lokar
  _signupInProgress = false;
  const modal = document.getElementById('parent-signup-popup');
  if (modal) modal.style.display = 'none';
  ['su-name','su-email','su-pw','su-pw2'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.value = ''; el.disabled = false; }
  });
  document.getElementById('signup-error').textContent = '';
  const btn = document.querySelector('#signup-view-form .rg-popup-btn');
  if (btn) { btn.textContent = 'Stofna aðgang'; btn.disabled = false; }
  goTo('screen-child-login');
}

export function backToLoginFromSignup() {
  _signupInProgress = false;
  closeSignupPopup();
  openParentLoginPopup();
}

export async function firebaseSignupPopup() {
  const name  = document.getElementById('su-name').value.trim();
  const email = document.getElementById('su-email').value.trim();
  const pw    = document.getElementById('su-pw').value;
  const pw2   = document.getElementById('su-pw2').value;
  const errEl = document.getElementById('signup-error');
  const btn   = document.querySelector('#signup-view-form .rg-popup-btn');
  errEl.textContent = '';
  if (!name)         { errEl.textContent = 'Sláðu inn fullt nafn.'; return; }
  if (!email)        { errEl.textContent = 'Sláðu inn netfang.'; return; }
  if (pw.length < 6) { errEl.textContent = 'Lykilorð verður að vera minnst 6 stafir.'; return; }
  if (pw !== pw2)    { errEl.textContent = 'Lykilorðin passa ekki saman.'; return; }
  try {
    _signupInProgress = true; // Blokkum onAuthStateChanged meðan signup er í gangi
    ['su-name','su-email','su-pw','su-pw2'].forEach(id => {
      const el = document.getElementById(id); if (el) el.disabled = true;
    });
    if (btn) { btn.textContent = 'Stofna...'; btn.disabled = true; }
    const cred     = await createUserWithEmailAndPassword(auth, email, pw);
    const user     = cred.user;
    const familyId = 'FAM-' + Math.random().toString(36).substr(2,5).toUpperCase();
    await setDoc(doc(db, 'users', user.uid), {
      name, email, role: 'parent', familyId, children: [], createdAt: serverTimestamp()
    });
    await sendEmailVerification(user);
    await signOut(auth);
    localStorage.removeItem('upphatt_child'); // TÍMABUNDIÐ — þarf að laga emailVerified check síðar
    // _signupInProgress = false kemur í closeSignupPopup — ekki hér
    document.getElementById('signup-view-form').style.display    = 'none';
    document.getElementById('signup-view-success').style.display = '';
  } catch (e) {
    _signupInProgress = false;
    let msg = 'Villa við skráningu. Reyndu aftur.';
    if (e.code === 'auth/email-already-in-use') msg = 'Þetta netfang er þegar skráð.';
    if (e.code === 'auth/invalid-email')        msg = 'Netfang er ekki gilt.';
    errEl.textContent = msg;
    ['su-name','su-email','su-pw','su-pw2'].forEach(id => {
      const el = document.getElementById(id); if (el) el.disabled = false;
    });
    if (btn) { btn.textContent = 'Stofna aðgang'; btn.disabled = false; }
  }
}

// ── Old screen signup (kept for back-compat) ──
export function addChildInput() {
  const container = document.getElementById('signup-children-list');
  const div = document.createElement('div');
  div.className = 'form-group';
  div.innerHTML = '<input class="child-name-input" type="text" placeholder="Nafn barns">';
  container.appendChild(div);
}

export async function firebaseSignup() {
  const name    = document.getElementById('reg-name').value.trim();
  const email   = document.getElementById('reg-email').value.trim();
  const pw      = document.getElementById('reg-pw').value.trim();
  const errorEl = document.getElementById('reg-error');
  const childNames = Array.from(document.querySelectorAll('.child-name-input'))
    .map(i => i.value.trim()).filter(v => v !== '');
  if (!name || !email || pw.length < 6 || childNames.length === 0) {
    errorEl.textContent = 'Vinsamlegast fylltu út allt og bættu við barni.'; return;
  }
  try {
    errorEl.style.color = 'var(--ocean)';
    errorEl.textContent = 'Stofna fjölskyldu... ⏳';
    _signupInProgress = true;
    const userCred = await createUserWithEmailAndPassword(auth, email, pw);
    const uid      = userCred.user.uid;
    const familyId = 'FAM-' + Math.random().toString(36).substr(2, 5).toUpperCase();
    const childrenArray = [];
    for (const cName of childNames) {
      const loginCode = cName.replace(/\s/g, '').substr(0, 3).toUpperCase() + Math.floor(10 + Math.random() * 90);
      const childKey  = Math.random().toString(36).substr(2, 8);
      await setDoc(doc(db, 'codes', loginCode), { familyId, childKey, childName: cName });
      childrenArray.push({ name: cName, key: childKey, code: loginCode });
    }
    await setDoc(doc(db, 'users', uid), {
      name, email, role: 'parent', familyId, children: childrenArray, createdAt: serverTimestamp()
    });
    await signOut(auth);
    localStorage.removeItem('upphatt_child');
    _signupInProgress = false;
    alert('Aðgangur tilbúinn! Þú getur nú skráð þig inn.');
    goTo('screen-parent-login');
  } catch (e) {
    _signupInProgress = false;
    errorEl.style.color = 'var(--coral)';
    errorEl.textContent = 'Villa: ' + e.message;
    try { await signOut(auth); } catch (_) { /* ok */ }
  }
}

// ── Child login ──
export async function childLogin() {
  const rawCode = document.getElementById('child-code-input').value || '';
  const code = rawCode.toUpperCase().replace(/[^A-Z0-9]/g, '').trim();
  const err  = document.getElementById('child-code-error');
  err.textContent = '';
  if (code.length < 4) { return; }
  try {
    document.getElementById('child-code-input').disabled = true;
    const snap = await getDoc(doc(db, 'codes', code));
    if (!snap.exists()) {
      err.textContent = 'Kóðinn fannst ekki — athugaðu með foreldri.';
      document.getElementById('child-code-input').disabled = false;
      return;
    }
    const data = snap.data();
    S.role = 'child'; S.familyId = data.familyId;
    S.childKey = data.childKey; S.childName = data.childName;
    localStorage.setItem('upphatt_child', JSON.stringify({
      familyId: data.familyId, childKey: data.childKey, childName: data.childName, code
    }));
    localStorage.setItem('childName', data.childName);
    window.location.href = 'child-v2.html';
  } catch (e) {
    err.textContent = 'Villa: ' + e.message;
    document.getElementById('child-code-input').disabled = false;
  }
}

// ── Logout ──
export async function logout() {
  if (S.role === 'child') {
    if (confirm('Skrá þig út? Þú þarft kóðann aftur til að skrá þig inn.')) {
      localStorage.removeItem('upphatt_child');
      S.role = null; S.familyId = null; S.childKey = null; S.childName = null;
      cancelReading();
      goTo('screen-child-login');
    }
    return;
  }
  if (confirm('Viltu skrá þig út?')) {
    if (S.familyUnsub) { S.familyUnsub(); S.familyUnsub = null; }
    await signOut(auth);
    localStorage.clear();
    location.reload();
  }
}

// ── Theme toggle ──
export function initParentTheme() {
  const saved = localStorage.getItem('upphatt_parent_theme') || 'dark';
  const el  = document.getElementById('screen-parent-home');
  const btn = document.getElementById('ph-theme-btn');
  if (saved === 'light') { if (el) el.classList.add('ph-light'); if (btn) btn.textContent = '🌙'; }
  else { if (btn) btn.textContent = '☀️'; }
}

export function toggleParentTheme() {
  const el  = document.getElementById('screen-parent-home');
  const btn = document.getElementById('ph-theme-btn');
  if (!el) return;
  const isLight = el.classList.toggle('ph-light');
  localStorage.setItem('upphatt_parent_theme', isLight ? 'light' : 'dark');
  if (btn) btn.textContent = isLight ? '🌙' : '☀️';
}

// ── Add child placeholder ──
export function openAddChildPopup() {
  alert('Bæta við barni — kemur bráðum!');
}

// ── Auth state observer ──
export function initAuth() {
  onAuthStateChanged(auth, async (user) => {
    if (_signupInProgress) return;
    if (user) {
      try {
        await processAuthUser(user);
      } catch (e) {
        console.error('Auth villa:', e);
        document.getElementById('login-email').disabled    = false;
        document.getElementById('login-pw').disabled       = false;
        document.getElementById('login-error').textContent = 'Villa við innskráningu. Reyndu aftur.';
        goTo('screen-parent-login');
      }
      return;
    }
    if (S.familyUnsub) { S.familyUnsub(); S.familyUnsub = null; }
    S.sessions = [];
    const skipChildRedirectOnce = sessionStorage.getItem('upphatt_skip_child_redirect_once') === '1';
    if (skipChildRedirectOnce) {
      sessionStorage.removeItem('upphatt_skip_child_redirect_once');
      goTo('screen-child-login');
      return;
    }
    const saved = localStorage.getItem('upphatt_child');
    if (saved) {
      try {
        const data = JSON.parse(saved);
        S.role = 'child'; S.familyId = data.familyId;
        S.childKey = data.childKey; S.childName = data.childName;
        localStorage.setItem('childName', data.childName || 'Lesari');
        window.location.href = 'child-v2.html';
        return;
      } catch (e) { localStorage.removeItem('upphatt_child'); }
    }
    goTo('screen-child-login');
  });
}
