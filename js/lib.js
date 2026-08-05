// ─── js/lib.js ───
// Sameiginleg UI-laus föll.
//   - writeListenEvent  (FASI 3B: hlustun → push á barn)
//   - commitReadingMessage (FASI 3C: komment → push á barn)   ← NÝTT
//
// ATH: writeBatch verður að vera flutt inn úr firebase-config.js. Ef firebase-config
// endurútflytur það ekki nú þegar, bættu 'writeBatch' við export-lista þess (ein lína).

import { db, doc, setDoc, addDoc, collection, serverTimestamp, writeBatch } from './firebase-config.js';

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
export async function writeListenEvent({ familyId, childKey, listenerName, listenerId, sessionDocId } = {}) {
  if (!familyId || !childKey) return false;

  const now = Date.now();
  const key = familyId + '_' + childKey;                 // listens/{key} doc-id — ÓBREYTT (barn áskrifar sig að þessu)
  const cdKey = key + '_' + (listenerId || '');          // FASI 3B: cooldown PER HLUSTANDA — svo tveir ólíkir
                                                          // hlustendur innan 5s dropi ekki hvor öðrum ("nýr listener → nýtt push").
  if (_cooldown[cdKey] && now - _cooldown[cdKey] < _COOLDOWN_MS) return false;

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
      familyId, childKey, listenerName: name,
      listenerId: listenerId || null,        // FASI 3B: stöðugt hlustanda-uid fyrir dedup (sessionDocId × listenerId)
      sessionDocId: sessionDocId || null,    // FASI 3B: notifyChildOnListen þarf þetta (var EKKI skrifað áður)
      timestamp: now, createdAt: serverTimestamp(),
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

  if (wrote) _cooldown[cdKey] = now;
  return wrote;
}

/**
 * FASI 3C — skrifar komment-reactionið OG comment-event í SAMA atóm-batch.
 *
 * Hvers vegna hér (ekki í parent.html): writeBatch verður að nota EINA Firestore-instance.
 * Helperinn á batchinn á lib.js EIGIN `db` og tekur aðeins við HREINUM gögnum (bookId,
 * fullbúið `entries`-array, meta) — engum db-bundnum refs frá kallanda. Þannig getur batchinn
 * aldrei spannað tvær instances.
 *
 * commentEvents/{commentId}:
 *   - commentId er STÖÐUGT id (búið til í kallanda, líka stimplað á reactionið).
 *   - Af því reglan leyfir ENGA client-update: retry sem endurkeyrir sama batch reynir að
 *     `set` skjal sem er til → metið sem update → hafnað → allur batchinn rúllar til baka
 *     → reactionið tvöfaldast EKKI. (Idempotency „ókeypis" af doc-id.)
 *   - pushStatus:'pending' — backend (notifyChildOnComment, Admin SDK) færir hann áfram.
 *   - Pushið er ÓHÁÐ journeyEntry.sessionId; entrySessionId er aðeins geymt EF til (framtíðar-deeplink).
 *
 * @param {object} p
 * @param {string}  p.bookId
 * @param {Array}   p.entries          fullbúið journeyEntries-array (með nýja reactioninu, incl. commentId)
 * @param {string}  p.commentId        stöðugt id — líka document-id í commentEvents
 * @param {string}  p.familyId
 * @param {string}  p.childKey         book.childKey (authoritative — rétt barn í fjölbarna-fjölskyldu)
 * @param {string}  p.senderName       birtingarnafn sendanda (t.d. „Mamma", „Amma", nafn gests)
 * @param {string}  [p.senderRole]     'parent' | 'guest'
 * @param {string}  [p.entrySessionId] stöðugt entry-handle ef mark-entry hefur sessionId (annars null)
 * @returns {Promise<boolean>} true ef batchinn committaðist
 */
export async function commitReadingMessage({
  bookId, entries, commentId, familyId, childKey,
  senderName, senderRole = null, entrySessionId = null
} = {}) {
  if (!bookId || !commentId || !familyId || !childKey || !Array.isArray(entries)) {
    console.error('commitReadingMessage: skyldureit vantar');
    return false;
  }

  try {
    const batch = writeBatch(db);

    // SKRIF 1 — bókin (birting kommenta óbreytt: reactionið er þegar í `entries`).
    batch.update(doc(db, 'books', bookId), {
      journeyEntries: entries,
      updatedAt: serverTimestamp()
    });

    // SKRIF 2 — óbreytanlegt trigger-event fyrir barnapush (3C). Enginn skilaboðatexti.
    batch.set(doc(db, 'commentEvents', commentId), {
      type: 'reading_message',
      familyId,
      childKey,
      bookId,
      commentId,
      entrySessionId: entrySessionId || null,
      senderName: senderName || null,
      senderRole: senderRole || null,
      createdAt: serverTimestamp(),
      pushStatus: 'pending'
    });

    await batch.commit();
    return true;
  } catch (e) {
    console.error('commitReadingMessage:', e);
    return false;
  }
}
