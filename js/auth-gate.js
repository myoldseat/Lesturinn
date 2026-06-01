// ─── js/auth-gate.js ───
// Sameiginleg auth-gátt fyrir öll entry-points (index, parent.html, child.html).
//
//   • resolveAuth()              → fyrir index: skilar auðkenni eða null, redirect-ar EKKI.
//   • requireRole(roles, opts)   → fyrir síður: skilar auðkenni, redirect-ar ef útskráð/rangt hlutverk.
//
// Eitt `onAuthStateChanged`, claims lesin með retry/backoff svo ferskar custom-claims
// (eftir signup / verifyFamilyCode / setParentClaims) nái að propagera áður en dæmt er.
// Reglurnar (firestore/storage) dæma server-megin — þetta er aðeins routing/auðkenni.

import { auth, db, onAuthStateChanged, getDoc, doc } from './firebase-config.js';

const _DELAYS = [0, 250, 750, 1500, 3000];
const _wait = (ms) => new Promise((r) => setTimeout(r, ms));

function _redirect(to, skipParam) {
  const url = skipParam ? (to + (to.includes('?') ? '&' : '?') + skipParam) : to;
  window.location.replace(url);
}

// Sameinað auðkenni úr einni uppsprettu (claims + parent-prófíll).
async function _buildIdentity(user, claims) {
  const id = {
    user,
    uid:        user.uid,
    role:       claims.role || null,        // 'parent' | 'guest' | 'child'
    familyId:   claims.familyId || null,
    childKey:   claims.childKey || null,    // child
    familyCode: claims.familyCode || null,
    guestName:  claims.guestName || null,   // guest
    guestRole:  claims.guestRole || null,   // guest: 'amma' | 'afi' | ...
    name:       null,                        // parent (úr prófíl)
    roleName:   null,                        // parent: 'Pabbi' / 'Mamma' (úr prófíl)
    children:   null,                        // parent (úr prófíl); gestur leysir á síðu
  };

  if (claims.role === 'parent') {
    try {
      const snap = await getDoc(doc(db, 'users', user.uid));
      if (snap.exists()) {
        const p = snap.data() || {};
        id.name       = p.name || null;
        id.roleName   = p.roleName || null;
        id.children   = p.children || null;
        id.familyCode = id.familyCode || p.familyCode || null;
      }
    } catch (e) { console.warn('auth-gate: prófíll mistókst', e); }
  }

  return id;
}

/**
 * Leysir auth-stöðu án redirect.
 * @returns {Promise<object|null>} auðkenni eða null (enginn notandi / engin nothæf claims)
 */
export function resolveAuth() {
  return new Promise((resolve) => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      unsub();
      if (!user) { resolve(null); return; }
      for (let i = 0; i < _DELAYS.length; i++) {
        if (_DELAYS[i] > 0) await _wait(_DELAYS[i]);
        try {
          // i>0 → force-refresh svo ferskar claims sjáist.
          const token  = await user.getIdTokenResult(i > 0);
          const claims = token.claims || {};
          if (claims.role && claims.familyId) {
            resolve(await _buildIdentity(user, claims));
            return;
          }
        } catch (e) {
          if (i === _DELAYS.length - 1) { resolve(null); return; }
        }
      }
      resolve(null); // notandi en engar nothæfar claims
    });
  });
}

/**
 * Krefst tiltekins hlutverks; annars redirect á index (og kastar).
 * @param {string|string[]} allowedRoles  t.d. 'child' eða ['parent','guest']
 * @param {{redirectTo?:string, skipParam?:string}} [opts]
 * @returns {Promise<object>} auðkenni (ef leyft)
 */
export async function requireRole(allowedRoles, opts = {}) {
  const { redirectTo = 'index.html', skipParam = '' } = opts;
  const allowed = [].concat(allowedRoles);
  const id = await resolveAuth();
  if (!id || (allowed.length && !allowed.includes(id.role))) {
    _redirect(redirectTo, skipParam);
    throw new Error('auth-gate: blokkað (' + (id ? id.role : 'enginn') + ')');
  }
  return id;
}
