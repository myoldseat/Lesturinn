// ─── js/lib.js ───
// Sameiginleg UI-laus föll. Skref 1: AÐEINS writeListenEvent.
// (Cover-cache, dagsetningar, getStreak koma síðar, eftir þörf.)

import { db, doc, setDoc, addDoc, collection, serverTimestamp } from './firebase-config.js';

const _cooldown = {};
const _COOLDOWN_MS = 5000;

/**
 * Skráir „hlustun" þegar fjölskyldumeðlimur spilar upptöku barns.
 * Skrifar á þrjá staði (eins og gamla parent-view): `listens/{fid}_{ck}`,
 * `listenEvents`, og `lastListenedAt/lastListenerName` á session-skjalið.
 * UI-laust og án `S` — kallarinn reiknar `listenerName` (t.d. „Pabbi Pétur").
 *
 * @param {object} p
 * @param {string} p.familyId
 * @param {string} p.childKey
 * @param {string} p.listenerName   tilbúið birtingarnafn ("Amma Guðný" / "Pabbi Pétur")
 * @param {string} [p.sessionDocId] ef til, merkir session sem síðast-hlustaða
 * @returns {Promise<boolean>} true ef eitthvað var skrifað (annars cooldown/villa)
 */
export async function writeListenEvent({ familyId, childKey, listenerName, sessionDocId } = {}) {
  if (!familyId || !childKey) return false;

  const now = Date.now();
  const key = familyId + '_' + childKey;
  if (_cooldown[key] && now - _cooldown[key] < _COOLDOWN_MS) return false;

  const name = listenerName || 'Einhver';
  let wrote = false;

  // 1) legacy single-doc (barn áskrifar sig að þessu)
  try {
    await setDoc(doc(db, 'listens', key), { listenerName: name, familyId, childKey, timestamp: now });
    wrote = true;
  } catch (e) { console.error('writeListenEvent (listens):', e); }

  // 2) event-stream
  try {
    await addDoc(collection(db, 'listenEvents'), {
      familyId, childKey, listenerName: name, timestamp: now, createdAt: serverTimestamp(),
    });
    wrote = true;
  } catch (e) { console.error('writeListenEvent (listenEvents):', e); }

  // 3) merkja session (fallback-leiðin í barninu)
  if (sessionDocId) {
    try {
      await setDoc(doc(db, 'sessions', sessionDocId),
        { lastListenedAt: now, lastListenerName: name }, { merge: true });
      wrote = true;
    } catch (e) { console.error('writeListenEvent (session):', e); }
  }

  if (wrote) _cooldown[key] = now;
  return wrote;
}
