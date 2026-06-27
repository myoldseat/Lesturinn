// ─── Authentication & user processing ───
// TODO: Bæta við emailVerified check í firebaseLogin, parentLoginFromPopup og onAuthStateChanged
import {
  auth, db, functions,
  signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signInWithPopup, GoogleAuthProvider,
  sendEmailVerification, sendPasswordResetEmail,
  onAuthStateChanged, signOut, signInAnonymously,
  setPersistence, browserLocalPersistence, browserSessionPersistence,
  httpsCallable,
  collection, setDoc, doc, getDoc, getDocs, query, where, serverTimestamp
} from './firebase-config.js';
import { S }  from './state.js';
import { goTo } from './helpers.js';
import { setupChildHome, cancelReading } from './child-view.js';
import { startFamilyListener, startBooksListener, renderDashboard } from './parent-view.js';

let _signupInProgress = false;
let _anonymousLoginInProgress = false;

function consumeChildRedirectSkip() {
  const params = new URLSearchParams(window.location.search);
  const skipOnce =
    params.get('skipChild') === '1' ||
    sessionStorage.getItem('upphatt_skip_child_redirect_once') ||
    localStorage.getItem('upphatt_skip_child_redirect_once');
  if (!skipOnce) return false;
  sessionStorage.removeItem('upphatt_skip_child_redirect_once');
  localStorage.removeItem('upphatt_skip_child_redirect_once');
  localStorage.removeItem('upphatt_child');
  localStorage.removeItem('childName');
  S.role = null; S.familyId = null; S.childKey = null; S.childName = null;
  if (params.get('skipChild') === '1') {
    window.history.replaceState({}, document.title, window.location.pathname);
  }
  return true;
}

// ══════════════════════════════════════════
// KÓÐA BÚNINGUR
// ══════════════════════════════════════════

// FAM####LL — 4 tölur + 2 bókstafir — t.d. FAM4161AB
// Gefur ~4.7 milljón mögulegar samsetningar
function makeFamilyCode() {
  const nums  = Math.floor(1000 + Math.random() * 9000);
  const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const l1    = alpha[Math.floor(Math.random() * alpha.length)];
  const l2    = alpha[Math.floor(Math.random() * alpha.length)];
  return `FAM${nums}${l1}${l2}`;
}

function makeChildCode(name) {
  const prefix = name.replace(/\s/g, '').substr(0, 3).toUpperCase();
  const chars  = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
  const suffix = Array.from({length: 4}, () =>
    chars[Math.floor(Math.random() * chars.length)]).join('');
  return prefix + suffix;
}

// ══════════════════════════════════════════
// RESTORE MISSING CODE DOCS
// ══════════════════════════════════════════

async function restoreMissingCodeDocsFromProfile(familyId, children) {
  if (!familyId || !Array.isArray(children) || !children.length) return;
  await Promise.all(children.map(async (c) => {
    const code = (c?.code || '').toString().trim().toUpperCase();
    if (!code || !c?.key || !c?.name) return;
    try {
      const snap = await getDoc(doc(db, 'codes', code));
      if (!snap.exists()) await setDoc(doc(db, 'codes', code), {
        familyId, childKey: c.key, childName: c.name
      });
    } catch (e) { console.warn('Could not restore code doc for', code, e); }
  }));
}

// ══════════════════════════════════════════
// PROCESS AUTHENTICATED PARENT
// ══════════════════════════════════════════

function _showInviteError(msg) {
  const ids = ['popup-login-error', 'login-error', 'signup-error', 'reg-error'];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) { el.textContent = msg; return; }
  }
  try { alert(msg); } catch (_) {}
}

async function processAuthUser(user) {
  // ── Co-parent boð: ganga í fjölskylduna ÁÐUR en claims/familyId leysast ──
  const inviteToken = localStorage.getItem('upphattParentInvite');
  const wasInvite = !!inviteToken;
  if (inviteToken) {
    try {
      await httpsCallable(functions, 'acceptParentInvite')({
        token: inviteToken, name: user.displayName || undefined
      });
      await user.getIdToken(true);                  // force-refresh: role+familyId claims STRAX
      localStorage.removeItem('upphattParentInvite');
    } catch (e) {
      console.warn('acceptParentInvite villa:', e);
      localStorage.removeItem('upphattParentInvite');
      // Boð mistókst (útrunnið / notað / annað familyId) → STÖÐVA flæðið.
      // EKKI redirecta í parent.html með ranga/uid-fjölskyldu. Skrá út + sýna villu.
      try { await signOut(auth); } catch (_) {}
      _showInviteError((e && e.message) || 'Boðið er ógilt eða útrunnið.');
      return;
    }
  }

  // Ensure parent has custom claims before making any Firestore reads
  const tokenResult = await user.getIdTokenResult();
  if (tokenResult.claims.role !== 'parent') {
    try {
      await httpsCallable(functions, 'setParentClaims')();
      await user.getIdToken(true); // force-refresh token with new claims
    } catch (e) { console.warn('setParentClaims villa:', e); }
  }

  const snap    = await getDoc(doc(db, 'users', user.uid));
  const profile = snap.exists() ? snap.data() : null;

  // Invite-user sem tókst EKKI að tengja við familyId → ekki falla á uid (phantom-fjölskylda).
  if (wasInvite && !profile?.familyId) {
    try { await signOut(auth); } catch (_) {}
    _showInviteError('Tókst ekki að tengja við fjölskyldu. Reyndu boðið aftur.');
    return;
  }

  S.role            = 'parent';
  S.familyId        = profile?.familyId || user.uid;
  S.parentName      = (profile?.name || 'Foreldri').split(' ')[0];
  S.parentEmail     = user.email || '';
  S.parentChildren  = profile?.children || [];
  S.expandedChildren = {};

  // Auto-migration: ef familyCode vantar, búum við til og vistum.
  // Sleppt fyrir co-parent — hann erfir familyCode fjölskyldunnar (acceptParentInvite afritar hann).
  if (!profile?.familyCode && profile?.access !== 'coParent') {
    const newCode = makeFamilyCode();
    try {
      await setDoc(doc(db, 'users', user.uid), { familyCode: newCode }, { merge: true });
      // Vista líka í familycodes collection
      await setDoc(doc(db, 'familycodes', newCode), {
        familyId:  S.familyId,
        parentUid: user.uid,
        parentName: profile?.name || 'Foreldri',
        createdAt: serverTimestamp()
      });
      S.familyCode = newCode;
    } catch(e) { console.warn('Could not save familyCode:', e); S.familyCode = '—'; }
  } else {
    S.familyCode = profile.familyCode;
  }

  await restoreMissingCodeDocsFromProfile(S.familyId, S.parentChildren);

  // ── Gátt: foreldri fer á parent.html ──
  // Claims (setParentClaims) og familyCode-migration er búið hér að ofan,
  // svo parent.html getur bootað beint úr claims + users-prófíl.
  window.location.href = 'parent.html';
}

// ══════════════════════════════════════════
// PARENT LOGIN (screen — legacy)
// ══════════════════════════════════════════

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
  ['a','b','c','d'].forEach(v => {
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
  const famInput = document.getElementById('fam-code-input');
  const famErr   = document.getElementById('fam-code-error');
  if (famInput) famInput.value = '';
  if (famErr)   famErr.textContent = '';
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
    const remember = document.getElementById('remember-me')?.checked ?? true;
    await setPersistence(auth, remember ? browserLocalPersistence : browserSessionPersistence);
    const cred = await signInWithEmailAndPassword(auth, email, pw);
    closeParentLoginPopup();
    await processAuthUser(cred.user);
  } catch (e) {
    errEl.textContent = 'Innskráning mistókst — athugaðu netfang og lykilorð.';
    emailEl.disabled = false; pwEl.disabled = false;
    if (btn) { btn.textContent = 'Skrá inn'; btn.disabled = false; }
  }
}

// ══════════════════════════════════════════
// GOOGLE INNSKRÁNING (innskráning + nýskráning)
// ══════════════════════════════════════════

export async function googleSignIn() {
  const errEl = document.getElementById('popup-login-error') || document.getElementById('signup-error');
  try {
    const remember = document.getElementById('remember-me')?.checked ?? true;
    await setPersistence(auth, remember ? browserLocalPersistence : browserSessionPersistence);
    const cred = await signInWithPopup(auth, new GoogleAuthProvider());
    const user = cred.user;

    // Nýr notandi → Google gefur ekkert users-skjal, svo við búum það til (eins og venjuleg nýskráning)
    const snap = await getDoc(doc(db, 'users', user.uid));
    if (!snap.exists()) {
      const inviteToken = localStorage.getItem('upphattParentInvite');
      if (inviteToken) {
        // Boðinn co-parent via Google: ENGIN createFamily — acceptParentInvite (í processAuthUser) linkar.
        await setDoc(doc(db, 'users', user.uid), {
          name: user.displayName || 'Foreldri', email: user.email || '', role: 'parent',
          children: [], createdAt: serverTimestamp(),
          consentCompleted: true, consentVersion: 'TERMS-2026-06', consentTimestamp: serverTimestamp()
        });
      } else {
        const { familyId, familyCode } =
          (await httpsCallable(functions, 'createFamily')({ name: user.displayName || 'Foreldri' })).data;
        await setDoc(doc(db, 'users', user.uid), {
          name: user.displayName || 'Foreldri', email: user.email || '', role: 'parent',
          familyId, familyCode, children: [], createdAt: serverTimestamp(),
          consentCompleted: true, consentVersion: 'TERMS-2026-06', consentTimestamp: serverTimestamp()
        });
        // Pilot-merking ef komið frá Sumarspretti
        const pilotGroup = localStorage.getItem('upphattPilotGroup');
        if (pilotGroup) {
          await setDoc(doc(db, 'pilots', familyId), {
            familyId, pilotGroup, uid: user.uid, email: user.email || null, status: 'active', joinedAt: serverTimestamp()
          });
          await setDoc(doc(db, 'users', user.uid), { pilotGroup }, { merge: true });
          localStorage.removeItem('upphattPilotGroup');
        }
      }
    }

    closeParentLoginPopup();
    if (typeof closeSignupPopup === 'function') closeSignupPopup();
    await processAuthUser(user);
  } catch (e) {
    if (errEl) errEl.textContent = 'Google innskráning mistókst.';
    console.warn('googleSignIn villa:', e);
  }
}
// Tengja raunverulegu Google-innskráninguna á window (yfirskrifar placeholder í index.html)
window.googleSignIn = googleSignIn;

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
// FAM KÓÐA LOGIN — amma, afi, frændi o.fl.
// Notar familycodes collection — document ID er kóðinn
// ══════════════════════════════════════════

let _selectedGuestRole = '';

export function showFamJoin() {
  _selectedGuestRole = '';
  const nameEl = document.getElementById('fam-guest-name');
  if (nameEl) nameEl.value = '';
  document.querySelectorAll('.rg-role-btn').forEach(b => b.classList.remove('rg-role-active'));
  _loginShowView('d');
  setTimeout(() => document.getElementById('fam-code-input')?.focus(), 80);
}

export function selectGuestRole(btn) {
  document.querySelectorAll('.rg-role-btn').forEach(b => b.classList.remove('rg-role-active'));
  btn.classList.add('rg-role-active');
  _selectedGuestRole = btn.dataset.role || '';
}

export async function famCodeLogin() {
  const input = document.getElementById('fam-code-input');
  const errEl = document.getElementById('fam-code-error');
  const btn   = document.getElementById('fam-code-btn');
  const code  = (input?.value || '').trim().toUpperCase();
  const guestNameEl = document.getElementById('fam-guest-name');
  const guestName   = (guestNameEl?.value || '').trim();
  errEl.textContent = '';
  if (!code) { errEl.textContent = 'Sláðu inn fjölskyldukóða.'; return; }
  if (!guestName) { errEl.textContent = 'Sláðu inn nafnið þitt.'; return; }
  if (!_selectedGuestRole) { errEl.textContent = 'Veldu hlutverk.'; return; }
  if (btn) { btn.textContent = 'Leita...'; btn.disabled = true; }
  try {
    _anonymousLoginInProgress = true;
    // Sign in anonymously so the Cloud Function can set custom claims
    const cred = await signInAnonymously(auth);

    // Cloud Function verifies the code and sets { role:'guest', familyId, ... } claims
    let result;
    try {
      result = await httpsCallable(functions, 'verifyFamilyCode')({
        code, guestName, guestRole: _selectedGuestRole
      });
    } catch (fnErr) {
      await signOut(auth);
      _anonymousLoginInProgress = false;
      errEl.textContent = fnErr.code === 'functions/not-found'
        ? 'Kóðinn fannst ekki — athugaðu með fjölskyldumeðlim.'
        : 'Villa — reyndu aftur.';
      if (btn) { btn.textContent = 'Tengjast fjölskyldu'; btn.disabled = false; }
      return;
    }

    const data = result.data;
    // Force-refresh token so new claims take effect immediately
    await cred.user.getIdToken(true);

    S.role           = 'guest';
    S.familyId       = data.familyId;
    S.guestName      = guestName;
    S.guestRole      = _selectedGuestRole;
    S.parentName     = guestName;
    S.parentEmail    = '';
    S.parentChildren = data.children || [];
    S.familyCode     = code;
    S.expandedChildren = {};

    // Vista guest info í localStorage (incl. children fyrir endurkomu)
    localStorage.setItem('upphatt_guest', JSON.stringify({
      familyId: data.familyId,
      guestName,
      guestRole: _selectedGuestRole,
      familyCode: code,
      children: data.children || []
    }));

    // ── Gátt: gestur fer á parent.html ──
    // parent.html bootar í gesta-ham úr claims + upphatt_guest og beitir
    // takmörkunum (body.role-guest) þar.
    closeParentLoginPopup();
    _anonymousLoginInProgress = false;
    window.location.href = 'parent.html';
  } catch(e) {
    _anonymousLoginInProgress = false;
    errEl.textContent = 'Villa — reyndu aftur.';
    console.error('FAM code login villa:', e);
    if (btn) { btn.textContent = 'Tengjast fjölskyldu'; btn.disabled = false; }
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
  if (pw.length < 12) { errEl.textContent = 'Lykilorð verður að vera minnst 12 stafir.'; return; }
  if (pw !== pw2)    { errEl.textContent = 'Lykilorðin passa ekki saman.'; return; }
  try {
    _signupInProgress = true;
    ['su-name','su-email','su-pw','su-pw2'].forEach(id => {
      const el = document.getElementById(id); if (el) el.disabled = true;
    });
    if (btn) { btn.textContent = 'Stofna...'; btn.disabled = true; }
    const cred       = await createUserWithEmailAndPassword(auth, email, pw);
    const user       = cred.user;

    const inviteToken = localStorage.getItem('upphattParentInvite');
    if (inviteToken) {
      // Boðinn co-parent: ENGIN createFamily. familyId/familyCode/role-tenging
      // kemur frá acceptParentInvite við innskráningu (eftir email-staðfestingu).
      await setDoc(doc(db, 'users', user.uid), {
        name, email, role: 'parent', children: [], createdAt: serverTimestamp(),
        consentCompleted: true, consentVersion: 'TERMS-2026-06', consentTimestamp: serverTimestamp()
      });
      // (token helst í localStorage — neytt í processAuthUser)
    } else {
      // Venjuleg ný fjölskylda — familyId + familyCode SERVER-megin (einstök, árekstrar-frí).
      // createFamily skrifar líka familycodes/{code} + families/{familyId}.
      const { familyId, familyCode } =
        (await httpsCallable(functions, 'createFamily')({ name })).data;

      await setDoc(doc(db, 'users', user.uid), {
        name, email, role: 'parent', familyId, familyCode, children: [], createdAt: serverTimestamp(),
        consentCompleted: true, consentVersion: 'TERMS-2026-06', consentTimestamp: serverTimestamp()
      });

      // Pilot-merking (aðeins ný fjölskylda; co-parent erfir fjölskyldu-pilot)
      const pilotGroup = localStorage.getItem('upphattPilotGroup');
      if (pilotGroup) {
        await setDoc(doc(db, 'pilots', familyId), {
          familyId, pilotGroup, uid: user.uid, email, status: 'active', joinedAt: serverTimestamp()
        });
        await setDoc(doc(db, 'users', user.uid), { pilotGroup }, { merge: true });
        localStorage.removeItem('upphattPilotGroup');
      }
    }

    await sendEmailVerification(user);
    await signOut(auth);
    localStorage.removeItem('upphatt_child');
    document.getElementById('signup-view-form').style.display    = 'none';
    document.getElementById('signup-view-success').style.display = '';
  } catch (e) {
    _signupInProgress = false;
    let msg = 'Villa við skráningu. Reyndu aftur.';
    if (e.code === 'auth/email-already-in-use') msg = 'Þetta netfang er þegar skráð.';
    if (e.code === 'auth/invalid-email')        msg = 'Netfang er ekki gilt.';
    if (e.code === 'auth/password-does-not-meet-requirements')
      msg = 'Lykilorð verður að vera minnst 12 stafir.';
    errEl.textContent = msg;
    ['su-name','su-email','su-pw','su-pw2'].forEach(id => {
      const el = document.getElementById(id); if (el) el.disabled = false;
    });
    if (btn) { btn.textContent = 'Stofna aðgang'; btn.disabled = false; }
  }
}

// ══════════════════════════════════════════
// STILLINGAR POPUP
// ══════════════════════════════════════════

export function openSettingsPopup() {
  const modal = document.getElementById('settings-modal');
  if (!modal) return;
  const emailEl = document.getElementById('st-email');
  const famEl   = document.getElementById('st-famcode');
  if (emailEl) emailEl.textContent = S.parentEmail || '—';
  if (famEl)   famEl.textContent   = S.familyCode  || '—';
  const kidsList = document.getElementById('st-kids-list');
  if (kidsList) {
    if (!S.parentChildren?.length) {
      kidsList.innerHTML = '<div class="st-empty">Engin börn skráð</div>';
    } else {
      kidsList.innerHTML = S.parentChildren.map(c => `
        <div class="st-kid-row" id="st-kid-${c.key}">
          <div class="st-kid-info">
            <div class="st-kid-name">${c.name}</div>
            <div class="st-kid-code">${c.code || ''}</div>
          </div>
          <button class="st-delete-btn" onclick="confirmDeleteChild('${c.key}')">Eyða</button>
        </div>`).join('');
    }
  }
  modal.style.display = 'grid';
}

export function closeSettingsPopup() {
  const modal = document.getElementById('settings-modal');
  if (modal) modal.style.display = 'none';
}

// ══════════════════════════════════════════
// ENDURNÝJA FJÖLSKYLDULYKIL
// Kallar resetFamilyCode CF, uppfærir birta kóðann. Engin gögn eytt.
// ══════════════════════════════════════════
export async function resetFamilyCode() {
  const res  = await httpsCallable(functions, 'resetFamilyCode')();
  const code = res?.data?.familyCode;
  if (code) {
    S.familyCode = code;
    const el = document.getElementById('settings-family-code');
    if (el) el.textContent = code;
  }
  return code;
}

export function confirmDeleteChild(key) {
  const row = document.getElementById('st-kid-' + key);
  if (!row) return;
  const btn = row.querySelector('.st-delete-btn');
  if (!btn) return;
  if (btn.dataset.confirming === 'true') {
    _deleteChild(key);
  } else {
    btn.textContent = 'Ertu viss?';
    btn.dataset.confirming = 'true';
    btn.classList.add('st-delete-btn-confirm');
    setTimeout(() => {
      if (btn.dataset.confirming === 'true') {
        btn.textContent = 'Eyða';
        btn.dataset.confirming = '';
        btn.classList.remove('st-delete-btn-confirm');
      }
    }, 3000);
  }
}

async function _deleteChild(key) {
  try {
    const child = S.parentChildren.find(c => c.key === key);
    if (!child) return;
    if (child.code) {
      await setDoc(doc(db, 'codes', child.code), { deleted: true }, { merge: true });
    }
    const updatedChildren = S.parentChildren.filter(c => c.key !== key);
    if (auth.currentUser) {
      await setDoc(doc(db, 'users', auth.currentUser.uid), {
        children: updatedChildren
      }, { merge: true });
    }
    S.parentChildren = updatedChildren;
    renderDashboard();
    openSettingsPopup();
  } catch(e) {
    console.error('Delete child villa:', e);
  }
}

// ══════════════════════════════════════════
// EYÐA AÐGANGI — soft delete
// ══════════════════════════════════════════

export function confirmDeleteAccount() {
  const btn = document.getElementById('st-delete-account-btn');
  if (!btn) return;
  if (btn.dataset.confirming === 'true') {
    _softDeleteAccount();
  } else {
    btn.textContent = 'Ertu alveg viss? Smelltu aftur';
    btn.dataset.confirming = 'true';
    btn.classList.add('st-delete-btn-confirm');
    setTimeout(() => {
      if (btn.dataset.confirming === 'true') {
        btn.textContent = 'Eyða aðgangi og öllum gögnum';
        btn.dataset.confirming = '';
        btn.classList.remove('st-delete-btn-confirm');
      }
    }, 4000);
  }
}

async function _softDeleteAccount() {
  const btn = document.getElementById('st-delete-account-btn');
  if (btn) { btn.textContent = 'Eyðir...'; btn.disabled = true; }
  try {
    const user = auth.currentUser;
    if (!user) return;
    // Merkja user doc sem eytt
    await setDoc(doc(db, 'users', user.uid), {
      deleted: true,
      deletedAt: serverTimestamp()
    }, { merge: true });
    // Merkja alla barnakóða sem eytt
    for (const child of (S.parentChildren || [])) {
      if (child.code) {
        try { await setDoc(doc(db, 'codes', child.code), { deleted: true }, { merge: true }); }
        catch(e) { console.warn('Code delete:', e); }
      }
    }
    // Merkja familycode sem eytt
    if (S.familyCode) {
      try { await setDoc(doc(db, 'familycodes', S.familyCode), { deleted: true }, { merge: true }); }
      catch(e) { console.warn('FamCode delete:', e); }
    }
    // Skrá út
    closeSettingsPopup();
    await signOut(auth);
    localStorage.clear();
    location.reload();
  } catch(e) {
    console.error('Delete account villa:', e);
    if (btn) { btn.textContent = 'Villa — reyndu aftur'; btn.disabled = false; btn.dataset.confirming = ''; btn.classList.remove('st-delete-btn-confirm'); }
  }
}

// ══════════════════════════════════════════
// YEAR PICKER — iOS scroll wheel stíll
// ══════════════════════════════════════════

const YEARS  = Array.from({length: 11}, (_, i) => 2010 + i);
const ITEM_H = 36;

function buildYearPicker(containerId, selectedYear) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = `
    <div class="yp-wrap">
      <div class="yp-fade-top"></div>
      <div class="yp-drum" id="yp-drum"></div>
      <div class="yp-selector"></div>
      <div class="yp-fade-bottom"></div>
    </div>`;
  const drum = container.querySelector('.yp-drum');
  const pad  = 2;
  for (let p = 0; p < pad; p++) {
    const el = document.createElement('div'); el.className = 'yp-item yp-padding'; drum.appendChild(el);
  }
  YEARS.forEach(y => {
    const el = document.createElement('div');
    el.className = 'yp-item'; el.textContent = y; el.dataset.year = y;
    drum.appendChild(el);
  });
  for (let p = 0; p < pad; p++) {
    const el = document.createElement('div'); el.className = 'yp-item yp-padding'; drum.appendChild(el);
  }
  const initIdx = YEARS.indexOf(selectedYear || 2015);
  drum.scrollTop = initIdx * ITEM_H;
  _updateYearHighlight(drum);
  let scrollTimer;
  drum.addEventListener('scroll', () => {
    _updateYearHighlight(drum);
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => _snapToNearest(drum), 120);
  }, { passive: true });
  drum.addEventListener('wheel', (e) => {
    e.preventDefault(); e.stopPropagation();
    const dir     = e.deltaY > 0 ? 1 : -1;
    const current = Math.round(drum.scrollTop / ITEM_H);
    const next    = Math.max(0, Math.min(YEARS.length - 1, current + dir));
    drum.scrollTo({ top: next * ITEM_H, behavior: 'smooth' });
  }, { passive: false });
}

function _updateYearHighlight(drum) {
  const centerIdx = Math.round(drum.scrollTop / ITEM_H);
  drum.querySelectorAll('.yp-item:not(.yp-padding)').forEach((el, i) => {
    const dist = Math.abs(i - centerIdx);
    el.classList.toggle('yp-item-selected', i === centerIdx);
    el.classList.toggle('yp-item-near',     dist === 1);
    el.classList.toggle('yp-item-far',      dist >= 2);
  });
}

function _snapToNearest(drum) {
  const idx = Math.round(drum.scrollTop / ITEM_H);
  drum.scrollTo({ top: idx * ITEM_H, behavior: 'smooth' });
}

function _getSelectedYear() {
  const drum = document.querySelector('#add-child-popup .yp-drum');
  if (!drum) return null;
  const idx = Math.round(drum.scrollTop / ITEM_H);
  return YEARS[idx] ?? null;
}

// ══════════════════════════════════════════
// BÆTA VIÐ BARNI — popup
// ══════════════════════════════════════════

export function openAddChildPopup() {
  let popup = document.getElementById('add-child-popup');
  if (!popup) {
    popup = document.createElement('div');
    popup.id = 'add-child-popup';
    popup.className = 'modal-overlay';
    popup.innerHTML = `
      <div class="rg-popup-card" style="max-height:90vh;overflow-y:auto">
        <div class="rg-popup-glow-line"></div>
        <button class="rg-popup-close" onclick="closeAddChildPopup()" aria-label="Loka">✕</button>
        <div class="rg-popup-header">
          <div class="rg-popup-brand"><span class="rg-popup-brand-read">Upp</span><span class="rg-popup-brand-glow">Hátt</span></div>
          <p class="rg-popup-subtitle">Bæta við barni</p>
        </div>
        <div class="rg-popup-body">
          <div style="text-align:center;margin-bottom:14px">
            <div style="width:48px;height:48px;border-radius:50%;background:rgba(29,205,211,0.15);border:2px solid rgba(29,205,211,0.3);display:flex;align-items:center;justify-content:center;margin:0 auto">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#1dcdd3" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            </div>
          </div>
          <div class="rg-field">
            <label class="rg-label" for="ac-name">Nafn barns</label>
            <input id="ac-name" class="rg-input" type="text" placeholder="t.d. Jón Jónsson" autocomplete="off">
          </div>
          <div class="rg-field">
            <label class="rg-label">Fæðingarár</label>
            <div id="ac-year-picker"></div>
          </div>
          <div id="ac-code-display" style="display:none;background:rgba(29,205,211,0.08);border:1px solid rgba(29,205,211,0.25);border-radius:10px;padding:14px;text-align:center;margin-bottom:12px">
            <div style="font-size:11px;font-weight:700;color:#7a8fa0;text-transform:uppercase;letter-spacing:.6px;margin-bottom:6px">Innskráningarkóði barns</div>
            <div id="ac-code-val" style="font-family:Georgia,serif;font-size:28px;font-weight:800;color:#1dcdd3;letter-spacing:4px"></div>
            <div style="font-size:11px;color:#7a8fa0;margin-top:6px">Gefðu barninu þennan kóða</div>
          </div>
          <div id="ac-error" class="rg-popup-error"></div>
          <button id="ac-btn" class="rg-popup-btn" onclick="submitAddChild()">Bæta við barni</button>
        </div>
      </div>
      <style>
        .yp-wrap { position:relative;height:${ITEM_H*5}px;overflow:hidden;border-radius:10px;background:rgba(29,205,211,0.04);border:1px solid rgba(29,205,211,0.16);margin:4px 0 6px; }
        .yp-drum { height:100%;overflow-y:scroll;scrollbar-width:none;-ms-overflow-style:none; }
        .yp-drum::-webkit-scrollbar { display:none; }
        .yp-item { height:${ITEM_H}px;display:flex;align-items:center;justify-content:center;font-family:Georgia,serif;font-size:15px;font-weight:700;color:rgba(29,205,211,0.2);cursor:pointer;transition:color 0.12s ease,font-size 0.12s ease;user-select:none; }
        .yp-item-near     { color:rgba(29,205,211,0.45);font-size:16px; }
        .yp-item-selected { color:#1dcdd3;font-size:22px;text-shadow:0 0 14px rgba(29,205,211,0.35); }
        .yp-item-far      { color:rgba(29,205,211,0.12);font-size:13px; }
        .yp-padding       { color:transparent !important; }
        .yp-selector { position:absolute;top:50%;left:10%;right:10%;height:${ITEM_H}px;transform:translateY(-50%);border-top:1px solid rgba(29,205,211,0.3);border-bottom:1px solid rgba(29,205,211,0.3);pointer-events:none; }
        .yp-fade-top { position:absolute;top:0;left:0;right:0;height:${ITEM_H*2}px;background:linear-gradient(to bottom,rgba(6,14,26,0.92) 0%,transparent 100%);pointer-events:none;z-index:2; }
        .yp-fade-bottom { position:absolute;bottom:0;left:0;right:0;height:${ITEM_H*2}px;background:linear-gradient(to top,rgba(6,14,26,0.92) 0%,transparent 100%);pointer-events:none;z-index:2; }
      </style>`;
    document.body.appendChild(popup);
    window.closeAddChildPopup = closeAddChildPopup;
    window.submitAddChild     = submitAddChild;
  }
  document.getElementById('ac-name').value = '';
  document.getElementById('ac-error').textContent = '';
  document.getElementById('ac-code-display').style.display = 'none';
  const btn = document.getElementById('ac-btn');
  if (btn) { btn.textContent = 'Bæta við barni'; btn.disabled = false; btn.onclick = submitAddChild; }
  popup.style.display = 'grid';
  buildYearPicker('ac-year-picker', 2015);
  setTimeout(() => document.getElementById('ac-name')?.focus(), 80);
}

export function closeAddChildPopup() {
  const popup = document.getElementById('add-child-popup');
  if (popup) popup.style.display = 'none';
}

export async function submitAddChild() {
  const name      = document.getElementById('ac-name').value.trim();
  const birthYear = _getSelectedYear();
  const errEl     = document.getElementById('ac-error');
  const btn       = document.getElementById('ac-btn');
  errEl.textContent = '';
  if (!name)      { errEl.textContent = 'Sláðu inn nafn barns.'; return; }
  if (!birthYear) { errEl.textContent = 'Veldu fæðingarár.'; return; }
  btn.textContent = 'Hleður...'; btn.disabled = true;
  try {
    const code     = makeChildCode(name);
    const childKey = Math.random().toString(36).substr(2, 10);
    await setDoc(doc(db, 'codes', code), {
      familyId: S.familyId, childKey, childName: name, birthYear: parseInt(birthYear)
    });
    const newChild = { name, key: childKey, code, birthYear: parseInt(birthYear), totalPagesRead: 0 };
    const updatedChildren = [...(S.parentChildren || []), newChild];
    await setDoc(doc(db, 'users', auth.currentUser.uid), {
      children: updatedChildren
    }, { merge: true });
    S.parentChildren = updatedChildren;
    document.getElementById('ac-code-val').textContent = code;
    document.getElementById('ac-code-display').style.display = '';
    btn.textContent = 'Loka'; btn.disabled = false;
    btn.onclick = closeAddChildPopup;
    renderDashboard();
  } catch(e) {
    errEl.textContent = 'Villa — reyndu aftur.';
    console.error('Add child villa:', e);
    btn.textContent = 'Bæta við barni'; btn.disabled = false;
  }
}

// ── Old screen signup (back-compat) ──
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
    const userCred   = await createUserWithEmailAndPassword(auth, email, pw);
    const uid        = userCred.user.uid;
    // familyId + familyCode SERVER-megin (createFamily skrifar líka familycodes + families).
    const { familyId, familyCode } =
      (await httpsCallable(functions, 'createFamily')({ name })).data;
    const childrenArray = [];
    // User doc must exist BEFORE code docs (codes/create rule reads users/{uid}.familyId)
    await setDoc(doc(db, 'users', uid), {
      name, email, role: 'parent', familyId, familyCode, children: [], createdAt: serverTimestamp()
    });
    // LEGACY (óvirkt í núverandi UI): barna-stofnun hér ætti að nota createChild.
    for (const cName of childNames) {
      const loginCode = makeChildCode(cName);
      const childKey  = Math.random().toString(36).substr(2, 10);
      await setDoc(doc(db, 'codes', loginCode), { familyId, childKey, childName: cName });
      childrenArray.push({ name: cName, key: childKey, code: loginCode });
    }
    // Update user doc with children list now that all codes are written
    await setDoc(doc(db, 'users', uid), { children: childrenArray }, { merge: true });
    await signOut(auth);
    localStorage.removeItem('upphatt_child');
    _signupInProgress = false;
    goTo('screen-parent-login');
  } catch (e) {
    _signupInProgress = false;
    errorEl.style.color = 'var(--coral)';
    errorEl.textContent = 'Villa: ' + e.message;
    try { await signOut(auth); } catch (_) {}
  }
}

// ── Child login ──
export async function childLogin() {
  const rawCode = document.getElementById('child-code-input').value || '';
  const code = rawCode.toUpperCase().replace(/[^A-Z0-9]/g, '').trim();
  const err  = document.getElementById('child-code-error');
  err.textContent = '';
  if (code.length < 4) { return; }
  // Admin check
  if (typeof window.isAdminCode === 'function' && window.isAdminCode(code)) {
    document.getElementById('child-code-input').disabled = false;
    document.getElementById('child-code-input').value = '';
    window.openAdminDashboard();
    return;
  }
  try {
    _anonymousLoginInProgress = true;
    document.getElementById('child-code-input').disabled = true;

    // Sign in anonymously so the Cloud Function can set custom claims on the caller
    const cred = await signInAnonymously(auth);

    // Cloud Function verifies the code and sets { role:'child', familyId, childKey, childName } claims
    let result;
    try {
      result = await httpsCallable(functions, 'verifyChildCode')({ code });
    } catch (fnErr) {
      await signOut(auth);
      _anonymousLoginInProgress = false;
      err.textContent = fnErr.code === 'functions/not-found'
        ? 'Kóðinn fannst ekki — athugaðu með foreldri.'
        : 'Villa: ' + (fnErr.message || fnErr.code);
      document.getElementById('child-code-input').disabled = false;
      return;
    }

    const data = result.data;
    // Force-refresh token so new claims take effect immediately
    await cred.user.getIdToken(true);

    S.role = 'child'; S.familyId = data.familyId;
    S.childKey = data.childKey; S.childName = data.childName;
    localStorage.setItem('upphatt_child', JSON.stringify({
      familyId: data.familyId, childKey: data.childKey, childName: data.childName, code
    }));
    localStorage.setItem('childName', data.childName);
    _anonymousLoginInProgress = false;
    window.location.href = 'child.html';
  } catch (e) {
    _anonymousLoginInProgress = false;
    err.textContent = 'Villa: ' + e.message;
    document.getElementById('child-code-input').disabled = false;
  }
}

// ── Logout — án confirm dialog ──
export async function logout() {
  if (S.familyUnsub) { S.familyUnsub(); S.familyUnsub = null; }
  if (S.role === 'child') {
    localStorage.removeItem('upphatt_child');
    S.role = null; S.familyId = null; S.childKey = null; S.childName = null;
    cancelReading();
    // Sign out the anonymous session so onAuthStateChanged doesn't redirect back
    await signOut(auth).catch(() => {});
    goTo('screen-child-login');
    return;
  }
  if (S.role === 'guest') {
    S.role = null; S.familyId = null;
    localStorage.clear();
    await signOut(auth).catch(() => {});
    location.reload();
    return;
  }
  // Parent
  await signOut(auth);
  localStorage.clear();
  location.reload();
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

// ── Auth state observer ──
export function initAuth() {
  // Keep parent logged in until they explicitly log out
  setPersistence(auth, browserLocalPersistence).catch(e => console.warn('Persistence villa:', e));

  onAuthStateChanged(auth, async (user) => {
    if (_signupInProgress) return;

    if (user) {
      if (user.isAnonymous) {
        if (_anonymousLoginInProgress) return;
        if (consumeChildRedirectSkip()) {
          await signOut(auth).catch(() => {});
          goTo('screen-child-login');
          return;
        }
        // Anonymous user = child or guest — check claims
        try {
          const token = await user.getIdTokenResult(true);
          const role  = token.claims.role;

          if (role === 'child') {
            const saved = localStorage.getItem('upphatt_child');
            if (saved) {
              try {
                const data = JSON.parse(saved);
                S.role = 'child'; S.familyId = data.familyId;
                S.childKey = data.childKey; S.childName = data.childName;
                localStorage.setItem('childName', data.childName || 'Lesari');
                window.location.href = 'child.html';
              } catch (e) {
                localStorage.removeItem('upphatt_child');
                await signOut(auth).catch(() => {});
                goTo('screen-child-login');
              }
            } else {
              // Claims exist but localStorage cleared — sign out the orphaned session
              await signOut(auth).catch(() => {});
              goTo('screen-child-login');
            }
            return;
          }

          if (role === 'guest') {
            const saved = localStorage.getItem('upphatt_guest');
            if (saved) {
              // ── Gátt: gestur fer á parent.html (bootar í gesta-ham úr claims + localStorage) ──
              window.location.href = 'parent.html';
            } else {
              await signOut(auth).catch(() => {});
              goTo('screen-child-login');
            }
            return;
          }

          // Anonymous but no valid role claims — orphaned session
          await signOut(auth).catch(() => {});
          goTo('screen-child-login');
        } catch (e) {
          console.error('Anonymous auth villa:', e);
          await signOut(auth).catch(() => {});
          goTo('screen-child-login');
        }
        return;
      }

      // Non-anonymous user = parent (email/password)
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

    // No user signed in
    if (S.familyUnsub) { S.familyUnsub(); S.familyUnsub = null; }
    S.sessions = [];
    goTo('screen-child-login');
    // Sumarsprettur: sýna pilot-landing aðeins þegar núverandi heimsókn kom með ?pilot=pilot1.
    // upphattPilotGroup er bara cohort-merking fyrir signup, ekki routing-trigger.
    if (window.openSummerPilot && window.openSummerPilot()) return;
  });
}
