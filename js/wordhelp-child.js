/* ═══════════════════════════════════════════════════════════════════════
   wordhelp-child.js — Orðahjálp í barnaviðmótinu

   <script type="module" src="wordhelp-child.js"></script>  á undan </body>

   SJÁLFSTÆTT. Snertir engan núverandi kóða. Allt sem það þarf er í
   localStorage og Firebase-registrinu:
     upphatt_child                        -> { familyId, childKey, childName }
     upphatt_child_reading_setup_{key}    -> { bookId, pageFrom, ... }
     getApp()                             -> appið sem child.html ræsti

   child.html er ESM (v12.11.0), EKKI compat eins og admin. Labbið er
   ekki afritanlegt beint.

   ── HVAÐ ÞETTA ER EKKI ──────────────────────────────────────────────
   Ekkert Lab, ekkert T1/T2, engir dómarar, engar plöntur. Barnið dæmir
   ekki skýringar — það les þær. Mælingin er í admin og á að vera þar.

   ── VISTUN ──────────────────────────────────────────────────────────
   childWords/{familyId}_{childKey}_{inoId}_{sense}
   Lyklað á ino_id + merkingu, ekki streng:
     · sama orð tvisvar -> count++, engin tvítekning
     · "fjöldi uppflettinga" fyrir foreldrið er ókeypis
     · stöðugt milli ÍNO-útgáfa
   ÖLL niðurstaðan geymist í skjalinu (simple, dæmi, heimild) svo
   Bókahillan geti lesið hana beint — ekkert AI-kall þegar barnið opnar
   vistað orð aftur.
   ═══════════════════════════════════════════════════════════════════════ */

import { getApp } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-app.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-functions.js';
import { getFirestore, doc, getDoc, setDoc, increment, serverTimestamp }
  from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';

const app = getApp();
const fns = getFunctions(app, 'europe-west1');
const db  = getFirestore(app);

const lookupWord = httpsCallable(fns, 'lookupWordHelp');
const lookupPara = httpsCallable(fns, 'lookupWordParadigm');

// ── Samhengi ────────────────────────────────────────────────────────
function session() {
  try {
    const d = JSON.parse(localStorage.getItem('upphatt_child') || 'null');
    return (d && d.familyId && d.childKey) ? d : null;
  } catch { return null; }
}
function readingSetup() {
  const cs = session();
  if (!cs) return null;
  // Sami lykill og child.html notar. Ef hann breytist þar brotnar þetta —
  // en hljóðlega, svo bookId verður bara null og orðið vistast án bókar.
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith('upphatt_child_reading_setup_')) {
      try { return JSON.parse(localStorage.getItem(k)); } catch { }
    }
  }
  return null;
}
// (bookTitle-hjálpar fjarlægt: childWords geymir bookId, ekki bookTitle —
//  titill er endurreiknaður úr bookId við birtingu.)

// ── DOM ─────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s)
  .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let _last = null;          // síðasta niðurstaða
let _word = '';            // það sem barnið sló inn
let _busy = false;
const _looked = [];        // orð skoðuð í þessari lotu -> kubbar á skrefi 2

// ── Overlay ─────────────────────────────────────────────────────────
function open() {
  const o = $('wh-overlay');
  if (!o) return;
  $('wh-word').value = '';
  $('wh-out').innerHTML = '';
  _last = null; _word = '';
  o.classList.add('open');
  o.setAttribute('aria-hidden', 'false');
  setTimeout(() => $('wh-word') && $('wh-word').focus(), 80);
}

function close() {
  const o = $('wh-overlay');
  if (o) { o.classList.remove('open'); o.setAttribute('aria-hidden', 'true'); }
  // Kubbar á skrefi 2 — barnið sér hvað það skoðaði.
  if (_looked.length) {
    const box = $('post-save-words'), list = $('post-save-words-list');
    if (box && list) {
      list.innerHTML = _looked.map((w) =>
        `<span class="post-save-word-chip">${esc(w)}</span>`).join('');
      box.hidden = false;
    }
  }
  if (window.__postSaveShowJourney) window.__postSaveShowJourney();
}

// ── Leit ────────────────────────────────────────────────────────────
async function search(id, sense) {
  const el = $('wh-word');
  const word = ((el ? el.value : _word) || '').trim();
  // Ekkert þögult return: ef reiturinn er tómur á barnið að sjá af hverju.
  if (!word) { msg('Sláðu inn orð fyrst.'); return; }
  if (_busy) return;
  _word = word; _busy = true;
  $('wh-go').disabled = true;
  msg('Leita…');
  try {
    const r = (await lookupWord({
      mode: 'easy', word,
      ...(id != null ? { id, sense } : {})
    })).data;
    _last = { ...r, word };
    render();
  } catch (e) {
    // TÆKNIN brást (Vertex 429, net, o.s.frv.) — EKKI orðið. Að segja "fundum
    // ekki orðið" hér kennir barninu ranglega að rétt orð sé rangt. Mjúkt og
    // satt: reyndu aftur. Nákvæma villan fer í console fyrir okkur, aldrei á skjá.
    msg('Þetta virkaði ekki alveg núna.<br>Prófaðu aftur eftir smá.');
    console.error('lookupWordHelp', e);
  }
  _busy = false;
  if ($('wh-go')) $('wh-go').disabled = false;
}

function msg(html) { $('wh-out').innerHTML = `<div class="wh-msg">${html}</div>`; }

// ── Birting ─────────────────────────────────────────────────────────
function render() {
  const r = _last;

  if (r.found === false) {
    // Satt svar. Orðabókin þekkir ekki orðið — það á ekki að skálda.
    msg(`Ég fann ekki <b>${esc(r.word)}</b> í orðabókinni.<br>`
      + 'Kannski er þetta nafn, eða kannski er stafsetningin önnur.<br>'
      + 'Prófaðu annað orð.');
    return;
  }

  // Fleiri en ein merking og engin valin -> barnið velur. Ekkert AI-kall enn.
  if (r.needsChoice) {
    $('wh-out').innerHTML = `
      <div class="wh-pick-label">Hvaða orð meinarðu?</div>
      ${r.options.map((o) => `
        <button class="wh-opt" type="button" data-id="${esc(o.id)}" data-sense="${o.sense}">
          <b>${esc(o.w)}</b><span>${esc(o.def || '')}</span>
        </button>`).join('')}`;
    $('wh-out').querySelectorAll('.wh-opt').forEach((b) =>
      b.addEventListener('click', () => search(b.dataset.id, Number(b.dataset.sense))));
    return;
  }

  const src = r.source || {};
  $('wh-out').innerHTML = `
    <div class="wh-lemma">${esc(r.lemma || '')}</div>
    <div class="wh-pos">${esc(r.posLabel || '')}</div>

    ${r.simple
      ? `<div class="wh-simple">${esc(r.simple)}</div>`
      : `<div class="wh-msg">Ég næ ekki að útskýra þetta orð nógu vel.<br>
           Orðabókin segir: <b>${esc(src.text || '—')}</b></div>`}

    ${(r.example1 || r.example2) ? `
      <div class="wh-ex">
        ${r.example1 ? `<div class="wh-ex-l">${esc(r.example1)}</div>` : ''}
        ${r.example2 ? `<div class="wh-ex-l">${esc(r.example2)}</div>` : ''}
      </div>` : ''}

    ${r.options && r.options.length > 1 ? `
      <button class="wh-btn-ghost" id="wh-other" type="button">Annað orð átti ég við</button>` : ''}
    <button class="wh-btn-ghost" id="wh-para" type="button" style="margin-left:6px">Skoða beygingu</button>
    <div id="wh-para-out"></div>

    <div class="wh-ino">${esc(src.text || '')}
      ${src.url ? `<br><a href="${esc(src.url)}" target="_blank" rel="noopener">Íslensk nútímamálsorðabók</a> · Árnastofnun · CC BY-SA 4.0` : ''}
    </div>
    <div id="wh-save-note"></div>`;

  const other = $('wh-other');
  if (other) other.addEventListener('click', () => {
    _last = { ...r, needsChoice: true }; render();
  });
  $('wh-para').addEventListener('click', paradigm);

  save();   // sjálfvirkt — barnið á ekki að þurfa að muna að vista
}

// ── Beyging: sérstakt kall, sérstök skrá, aðeins þegar beðið er um ──
async function paradigm() {
  const out = $('wh-para-out');
  out.innerHTML = '<div class="wh-msg">Hleð beygingu…</div>';
  try {
    const r = (await lookupPara({ id: _last.id })).data;
    out.innerHTML = r.found
      ? `<div class="wh-forms">${r.forms.map((f) =>
          `<span class="wh-form"><b>${esc(f.form)}</b> ${esc(f.mark)}</span>`).join('')}</div>`
      : `<div class="wh-msg">Engin beyging til fyrir þetta orð.</div>`;
  } catch (e) {
    out.innerHTML = `<div class="wh-msg">Beygingin sóttist ekki.</div>`;
    console.error('lookupWordParadigm', e);
  }
}

// ── Vistun ──────────────────────────────────────────────────────────
// TILVÍSUN + LÁGMARKS UI-SNAPSHOT — EKKI afrit af fullri WordHelp-færslu.
//
// wordHelp/{wordHelpId} er kanóníski sannleikurinn (dæmi, source, pos, model).
// childWords geymir aðeins: tilvísunina (wordHelpId) + þrjá snapshot-reiti
// (lemma, searchedForm, simpleSnapshot) svo orðalistinn birtist úr EINNI
// fyrirspurn án wordHelp-lesturs per orð. Full færsla sótt AÐEINS þegar
// smellt er á orð: getDoc(wordHelp/{wordHelpId}).
//
// simpleSnapshot er "skýringin sem barnið fékk ÞÁ" — sögulegt gildi, ekki
// eintak af sannleik. Það uppfærist EKKI þótt wordHelp sé síðar leiðrétt.
//
// TVÆR GREINAR, ekki eitt merge-kall:
//   create → firstAt = now (write-once)
//   update → firstAt ÓSNERT; searchedForm/simpleSnapshot/bookId yfirskrifast
//            svo skjalið endurspegli NÝJUSTU uppflettingu.
// merge:true með increment+serverTimestamp() saman myndi endurskrifa firstAt
// við hverja uppflettingu — þögult rangt. Greinarnar gera write-once að kóða.
async function save() {
  const cs = session();
  const note = $('wh-save-note');
  if (!cs || !_last || !_last.wordHelpId) return;
  const setup = readingSetup() || {};
  const bookId = setup.bookId || null;
  const key = `${cs.familyId}_${cs.childKey}_${_last.id}_${_last.sense || 0}`;
  const ref = doc(db, 'childWords', key);
  try {
    const prev = await getDoc(ref);

    // ── GREINING v2 (tímabundið) — sannreynir að RÉTT skrá sé í loftinu ──
    console.group('%c★ childWords DEBUG v2 ★', 'color:#0a0;font-weight:bold');
    console.log('1. branch     :', prev.exists() ? 'UPDATE' : 'CREATE');
    console.log('2. ref.path   :', ref.path);
    console.log('5. snap.exists:', prev.exists());
    if (prev.exists()) {
      console.log('6. EXISTING doc keys:', Object.keys(prev.data()));
      console.log('6. EXISTING doc     :', prev.data());
    }
    const _pv = prev.exists()
      ? { searchedForm: _word, simpleSnapshot: _last.simple || null, bookId,
          count: '<increment(1)>', lastAt: '<serverTimestamp>' }
      : { familyId: cs.familyId, childKey: cs.childKey, wordHelpId: _last.wordHelpId,
          lemma: _last.lemma || '', searchedForm: _word,
          simpleSnapshot: _last.simple || null, bookId, count: 1,
          firstAt: '<serverTimestamp>', lastAt: '<serverTimestamp>' };
    console.log('3. payload keys:', Object.keys(_pv));
    console.log('4. payload     :', _pv);
    console.log('   familyId    :', typeof cs.familyId, JSON.stringify(cs.familyId));
    console.log('   childKey     :', typeof cs.childKey, JSON.stringify(cs.childKey));
    console.log('   wordHelpId   :', typeof _last.wordHelpId, JSON.stringify(_last.wordHelpId));
    console.log('   bookId       :', typeof bookId, JSON.stringify(bookId));
    console.groupEnd();
    // ── /GREINING ─────────────────────────────────────────────────────

    if (prev.exists()) {
      // Enduruppfletting: nýjasta uppfletting + nýjasta bók. firstAt óbreytt.
      await setDoc(ref, {
        searchedForm: _word,
        simpleSnapshot: _last.simple || null,
        bookId: bookId,
        count: increment(1),
        lastAt: serverTimestamp()
      }, { merge: true });
    } else {
      // Fyrsta uppfletting: allt skjalið, firstAt sett í eina skiptið.
      await setDoc(ref, {
        familyId: cs.familyId,
        childKey: cs.childKey,
        wordHelpId: _last.wordHelpId,
        lemma: _last.lemma || '',
        searchedForm: _word,
        simpleSnapshot: _last.simple || null,
        bookId: bookId,
        count: 1,
        firstAt: serverTimestamp(),
        lastAt: serverTimestamp()
      });
    }
    if (!_looked.includes(_last.lemma)) _looked.push(_last.lemma);
    if (note) note.innerHTML = '<div class="wh-saved">✓ Vistað í Orðin mín</div>';
  } catch (e) {
    // Vistun sem mistekst í hljóði er verri en engin vistun: barnið heldur
    // að orðið sé geymt og það er farið. Mjúkt á skjá, nákvæmt í console.
    if (note) note.innerHTML = '<div class="wh-saved err">Orðið geymdist ekki. Prófaðu aftur.</div>';
    console.error('★ childWords write failed ★');
    console.error('  code   :', e && e.code);
    console.error('  message:', e && e.message);
    console.error('  raw    :', e);
  }
}

// ── Tengja ──────────────────────────────────────────────────────────
function wire() {
  if (!$('wh-overlay')) return;          // eldri child.html — gerum ekkert
  const yes = $('post-save-word-yes');
  if (yes) yes.addEventListener('click', open);
  $('wh-go').addEventListener('click', () => search());
  $('wh-word').addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
  $('wh-back').addEventListener('click', close);
  $('wh-done').addEventListener('click', close);
  $('wh-overlay').addEventListener('click', (e) => { if (e.target === $('wh-overlay')) close(); });
}

if (document.readyState === 'loading')
  document.addEventListener('DOMContentLoaded', wire);
else wire();
