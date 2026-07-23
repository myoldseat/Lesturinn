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
import { getFirestore, doc, setDoc, updateDoc, increment, serverTimestamp }
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
  // NÝR SANNLEIKUR: __postSaveContext er byggt í child.html við lestrarvistun úr
  // réttum gögnum (pendingSavePayload.bookId). Það leysir bookId:null vandann —
  // localStorage-setup er tómt/úrelt í post-save flæðinu. Notum context ef hann
  // er til og ber bók; annars föllum við í localStorage (t.d. WordHelp opnað
  // utan post-save flæðis).
  const ctx = window.__postSaveContext;
  if (ctx && ctx.bookId) {
    return { bookId: ctx.bookId, bookTitle: ctx.bookTitle || '',
             pageFrom: ctx.pageFrom || null, pageTo: ctx.pageTo || null };
  }
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
let _history = [];         // stafli af fyrri niðurstöðum -> "← fyrra orð" í samheita-keðju

// Við tölum alltaf um "orð" við börn: nafnorð, sagnorð, lýsingarorð — ekki "sögn".
// Vörpun úr (mögulega tæknilegum) posLabel bakendans í barnvænt heilt orð.
function childPos(label) {
  const k = String(label == null ? '' : label).trim().toLowerCase();
  const map = {
    'sögn': 'sagnorð', 'so': 'sagnorð', 'sagnorð': 'sagnorð',
    'no': 'nafnorð', 'nafnorð': 'nafnorð',
    'lo': 'lýsingarorð', 'lýsingarorð': 'lýsingarorð',
    'ao': 'atviksorð', 'atviksorð': 'atviksorð',
    'to': 'töluorð', 'töluorð': 'töluorð',
    'fn': 'fornafn', 'fs': 'forsetning', 'st': 'samtenging', 'uh': 'upphrópun'
  };
  return map[k] || label || '';
}

// ── Panel (Orðahjálp er nú panel í post-save kortinu, ekki sér-overlay) ──
// Navigation á heima í child.html (PostSaveFlow). Þessi skrá á aðeins orðalénið
// og afhendir stjóranum þrjú föll: enter / reset / getLooked.

const LOADER_DELAY = 250;   // ekki sýna loader ef svar kemur strax → ekkert flökt
const LOADER_MIN   = 400;   // ef hann birtist, halda a.m.k. svona lengi → ekkert blikk
const LOOKUP_TIMEOUT = 15000;  // þak á bið: hangandi kall má ekki festa barnið
let _loaderTimer = null;
let _loaderShownAt = 0;

const LOADER_HTML =
  '<div class="wh-loader">'
  + '<div class="wh-loader-logo"><b>Upp</b>Hátt</div>'
  + '<div class="wh-loader-mark"></div>'
  + '<div class="wh-loader-text">Finn orðið þitt…</div>'
  + '</div>';

// Hreinsar núverandi leit en HELDUR _looked (fyrri orð lotunnar). Fókus aftur í
// reitinn. Notað bæði við inngöngu í panelinn og af "Skoða annað orð".
function reset() {
  if ($('wh-word')) $('wh-word').value = '';
  if ($('wh-out')) $('wh-out').innerHTML = '';
  _history = [];                               // ný leit = ný keðja (bakör hverfur)
  const head = $('wh-search-head');
  if (head) head.hidden = false;              // leitarreitur + titill aftur sýnileg
  const skip = $('wh-skip');
  if (skip) skip.hidden = false;
  _last = null; _word = '';
  setTimeout(() => $('wh-word') && $('wh-word').focus(), 60);
}
function enter() { reset(); }                 // fyrsta innganga = sama hreina ástand
function getLooked() { return _looked.slice(); }

// ── Leit ────────────────────────────────────────────────────────────
// forceWord: notað þegar smellt er á samheiti — við leitum að ÞVÍ orði,
// ekki gildi (falda) leitarreitsins.
async function search(id, sense, forceWord) {
  const el = $('wh-word');
  const word = ((forceWord != null ? forceWord : (el ? el.value : _word)) || '').trim();
  // Ekkert þögult return: ef reiturinn er tómur á barnið að sjá af hverju.
  if (!word) { msg('Sláðu inn orð fyrst.'); return; }
  if (_busy) return;
  _word = word; _busy = true;
  if (el && forceWord != null) el.value = word;   // halda ástandi samræmdu
  if ($('wh-go')) $('wh-go').disabled = true;

  // Seinkuð hleðsla: boot-stíll birtist AÐEINS ef uppflettingin er hæg (>250ms).
  // "Sleppa" helst sýnilegt á meðan: barn á aldrei að vera fast í bið án útgöngu.
  const loadSkip = $('wh-skip');
  if (loadSkip) loadSkip.hidden = false;
  _loaderShownAt = 0;
  _loaderTimer = setTimeout(() => {
    _loaderShownAt = Date.now();
    if ($('wh-out')) $('wh-out').innerHTML = LOADER_HTML;
  }, LOADER_DELAY);

  let result = null, failed = false;
  try {
    // Þak á bið: hangandi net má ekki snúa hleðslunni endalaust.
    result = (await Promise.race([
      lookupWord({ mode: 'easy', word, ...(id != null ? { id, sense } : {}) }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('wordhelp timeout')), LOOKUP_TIMEOUT))
    ])).data;
  } catch (e) {
    // TÆKNIN brást (Vertex 429, net, o.s.frv.) — EKKI orðið. Að segja "fundum
    // ekki orðið" hér kennir barninu ranglega að rétt orð sé rangt. Mjúkt og
    // satt: reyndu aftur. Nákvæma villan fer í console fyrir okkur, aldrei á skjá.
    failed = true;
    console.error('lookupWordHelp', e);
  }

  // Slökkva á væntanlegum loader; ef hann NÁÐI að birtast, halda lágmarkstíma
  // svo hann blikki ekki inn og út.
  clearTimeout(_loaderTimer);
  if (_loaderShownAt) {
    const wait = LOADER_MIN - (Date.now() - _loaderShownAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  _loaderShownAt = 0;

  try {
    if (failed) {
      msg('Þetta virkaði ekki alveg núna.<br>Prófaðu aftur eftir smá.');
    } else {
      _last = { ...result, word };
      render();
    }
  } catch (e) {
    // Jafnvel þótt birtingin sjálf klikki (gölluð gögn) á barnið að fá leið út,
    // ekki auðan eða frosinn skjá.
    console.error('wordhelp render', e);
    msg('Þetta virkaði ekki alveg núna.<br>Prófaðu aftur eftir smá.');
  } finally {
    // ALLTAF losa: annars hunsar search() þöglar allar frekari leitir (frysting).
    _busy = false;
    clearTimeout(_loaderTimer);
    _loaderShownAt = 0;
    if ($('wh-go')) $('wh-go').disabled = false;
  }
}

// Sérhvert msg-ástand (villa, ekki-fannst, tómt) á ALDREI að vera blindgata:
// tryggjum að leitarreiturinn (reyna aftur) OG "Sleppa — áfram í setningu"
// (halda áfram) séu sýnileg. Annars getur misheppnuð uppfletting fest barnið.
function msg(html) {
  const head = $('wh-search-head');
  if (head) head.hidden = false;
  const skip = $('wh-skip');
  if (skip) skip.hidden = false;
  $('wh-out').innerHTML = `<div class="wh-msg">${html}</div>`;
}

// ── Samheiti í dæmi 2 ────────────────────────────────────────────────
// Dæmin tvö eru oftast sama setning með einu orði skipt út (veifaði→vinkaði).
// Finnum það EINA orð sem er ólíkt og gerum aðeins það smellanlegt. Ef fleiri
// en eitt orð er ólíkt (ótengt annað dæmi) skilum við null → engin smellun.
function synonymDiff(ex1, ex2) {
  if (!ex1 || !ex2) return null;
  const norm = (s) => String(s).replace(/[.,;:!?"'„“”()]/g, '').trim().toLowerCase();
  const set1 = new Set(ex1.split(/\s+/).map(norm).filter(Boolean));
  const raw2 = ex2.split(/\s+/);
  const diff = [];
  raw2.forEach((tok, i) => { const n = norm(tok); if (n && !set1.has(n)) diff.push(i); });
  if (diff.length !== 1) return null;             // aðeins hreint eins-orðs skipti
  const i = diff[0];
  const clean = raw2[i].replace(/^[„“"'(]+|[.,;:!?"'“”)]+$/g, '');
  if (clean.length < 2) return null;
  return { index: i, token: clean };
}

// Skilar HTML fyrir dæmi 2 með samheitið sem smellanlegan hlekk (ef það finnst).
function renderExample2(ex1, ex2) {
  const d = synonymDiff(ex1, ex2);
  if (!d) return esc(ex2);
  return ex2.split(/\s+/).map((w, i) => i === d.index
    ? `<a class="wh-syn" data-syn="${esc(d.token)}" role="button" tabindex="0">${esc(w)}</a>`
    : esc(w)).join(' ');
}

// ── Birting ─────────────────────────────────────────────────────────
// opts.replay: true þegar við sýnum orð aftur úr sögu-stafla (bakör) — þá
// vistum við EKKI aftur (það var þegar vistað) og ýtum ekki í _looked.
function render(opts) {
  opts = opts || {};
  const replay = !!opts.replay;
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
    // Útgönguleið: ef engin merking passar á barnið að geta leitað að öðru orði
    // eða haldið áfram. Án þessa er valskjárinn blindgata.
    const chHead = $('wh-search-head');
    if (chHead) chHead.hidden = false;
    const chSkip = $('wh-skip');
    if (chSkip) chSkip.hidden = false;
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
  const hasEx = (r.example1 || r.example2);
  $('wh-out').innerHTML = `
    ${_history.length ? `
      <a class="wh-back-word" id="wh-back-word" role="button" tabindex="0">&larr; ${esc(_history[_history.length - 1].lemma || 'til baka')}</a>` : ''}

    <div class="wh-card">
      <div class="wh-lemma">${esc(r.lemma || '')}</div>
      <div class="wh-pos">${esc(childPos(r.posLabel))}</div>
      ${r.simple
        ? `<div class="wh-meaning">${esc(r.simple)}</div>`
        : `<div class="wh-meaning wh-meaning-fallback">Ég næ ekki að útskýra þetta orð nógu vel.<br>
             Orðabókin segir: <b>${esc(src.text || '—')}</b></div>`}
    </div>

    ${hasEx ? `
      <div class="wh-ex-block">
        <div class="wh-ex-lab">Dæmi</div>
        <div class="wh-ex-wrap">
          ${r.example1 ? `<div class="wh-ex-1">${esc(r.example1)}</div>` : ''}
          ${r.example2 ? `<div class="wh-ex-2">${renderExample2(r.example1, r.example2)}</div>` : ''}
        </div>
      </div>` : ''}

    ${beygingSupported(r.pos) || (r.options && r.options.length > 1) ? `
      <div class="wh-micro">
        ${beygingSupported(r.pos) ? `
          <a class="wh-micro-link" id="wh-para" role="button" tabindex="0">Skoða beygingu</a>` : ''}
        ${r.options && r.options.length > 1 ? `
          <a class="wh-micro-link" id="wh-other" role="button" tabindex="0">Ég var að leita að öðru orði.</a>` : ''}
      </div>` : ''}

    <div id="wh-save-note"></div>

    <div class="wh-actions">
      <button class="wh-secondary" id="wh-again" type="button">Skoða annað orð</button>
      <button class="wh-primary" id="wh-next" type="button">Áfram</button>
    </div>

    <div class="wh-attrib">${esc(src.text || '')}
      ${src.url ? `<br><a href="${esc(src.url)}" target="_blank" rel="noopener">Íslensk nútímamálsorðabók</a> · Árnastofnun · CC BY-SA 4.0` : ''}
      <br>Skýringin er einfölduð fyrir börn. <a href="/heimildir" target="_blank" rel="noopener">Sjá hvernig</a>
    </div>`;

  const other = $('wh-other');
  if (other) other.addEventListener('click', () => {
    _last = { ...r, needsChoice: true }; render();
  });
  const para = $('wh-para');
  if (para) para.addEventListener('click', paradigm);

  // Bakör: aftur í fyrra orð úr keðjunni. Endursýnir án nýrrar uppflettingar/vistunar.
  const backWord = $('wh-back-word');
  if (backWord) backWord.addEventListener('click', () => {
    const prev = _history.pop();
    if (prev) { _last = prev; _word = prev.word || ''; render({ replay: true }); }
  });

  // Smellanlegt samheiti í dæmi 2 → leitar að ÞVÍ orði. Núverandi orð fer á
  // sögu-staflann svo "← fyrra orð" virki. Nýja orðið fær sitt eigið samheiti
  // (keðjan heldur áfram sjálfkrafa því render er eins fyrir hvert orð).
  $('wh-out').querySelectorAll('.wh-syn').forEach((a) => {
    a.addEventListener('click', () => {
      if (_busy) return;
      _history.push(_last);
      search(null, null, a.dataset.syn);
    });
  });

  // Niðurstaða til staðar → kortið á að sitja efst: fela leitarhaus og "Sleppa".
  const head = $('wh-search-head');
  if (head) head.hidden = true;
  const skip = $('wh-skip');
  if (skip) skip.hidden = true;

  // Samstundis í _looked (dedup) svo getLooked() sé rétt STRAX, óháð því hvenær
  // save() (Firestore) klárast. save() ýtir líka en hoppar yfir ef þegar til.
  // Við endursýningu (bakör) er orðið þegar vistað — sleppum því.
  if (!replay && r.lemma && !_looked.includes(r.lemma)) _looked.push(r.lemma);

  // Tvær skýrar aðgerðir eftir niðurstöðu. Navigation fer í gegnum PostSaveFlow.
  const again = $('wh-again');
  if (again) again.addEventListener('click', () => {
    if (window.PostSaveFlow) window.PostSaveFlow.restartWordSearch();  // hreinsar leit, HELDUR _looked
    else reset();
  });
  const next = $('wh-next');
  if (next) next.addEventListener('click', () => {
    if (window.PostSaveFlow) {
      window.PostSaveFlow.renderWordChips(getLooked());
      window.PostSaveFlow.goTo('journey');
    } else if (window.__postSaveShowJourney) {
      window.__postSaveShowJourney();
    }
  });

  if (!replay) save();   // sjálfvirkt — en ekki aftur við endursýningu úr sögu
}

// ════════════════════════════════════════════════════════════════════
//  BEYGING — stór sér-modal ofan á merkingar-modalnum.
//  Þrír flokkar (nafnorð, lýsingarorð, sögn) fá læsilega töflu;
//  aðrir flokkar fá engan hnapp. Hráu BÍN-mörkin (NFET, FSB-KK-NFET,
//  GM-FH-NT-3P-ET…) eru þáttuð HÉR í læsilegan íslenskan texta.
//  Engin ný gögn, sama lookupWordParadigm-kall. Modalinn opnast yfir
//  merkingunni; "← til baka" / "✕" skila í hana óraskaða.
// ════════════════════════════════════════════════════════════════════

const CASE_LBL = { NF: 'Nefnifall', ÞF: 'Þolfall', ÞGF: 'Þágufall', EF: 'Eignarfall' };
const CASE_ORDER = ['NF', 'ÞF', 'ÞGF', 'EF'];
// Hjálparorð sem kalla fram fallið — brú milli málfræðiheitisins og máls sem
// barn talar. Virka á öll nafnorð og lýsingarorð (forsetningin er utan orðsins).
const CASE_PREP = { NF: 'hér er', ÞF: 'um', ÞGF: 'frá', EF: 'til' };
const HATTUR_LBL = {
  FH: 'Framsöguháttur', VH: 'Viðtengingarháttur', BH: 'Boðháttur',
  NH: 'Nafnháttur', LHNT: 'Lýsingarháttur nútíðar', LHÞT: 'Lýsingarháttur þátíðar',
  SAGNB: 'Sagnbót', SP: 'Spurnarmyndir'
};

// ── Þáttun: forms = [{form, mark}] úr lookupWordParadigm ──────────────
function findForm(forms, mark) {
  const h = forms.find((f) => f.mark === mark);
  return h ? h.form : null;
}

function parseNoun(forms) {
  const table = (tala) => CASE_ORDER.map((fall) => ({
    fall, label: CASE_LBL[fall],
    plain: findForm(forms, fall + tala),
    def: findForm(forms, fall + tala + 'gr')
  }));
  const ft = table('FT');
  return { et: table('ET'), ft: ft.some((r) => r.plain || r.def) ? ft : null };
}

function parseAdj(forms) {
  const genderTable = (kyn) => CASE_ORDER.map((fall) => ({
    fall, label: CASE_LBL[fall], form: findForm(forms, `FSB-${kyn}-${fall}ET`)
  }));
  return {
    stig: {
      frum: findForm(forms, 'FSB-KK-NFET'),
      mid: findForm(forms, 'MST-KK-NFET'),
      efsta: findForm(forms, 'ESB-KK-NFET')
    },
    kk: genderTable('KK'), kvk: genderTable('KVK'), hk: genderTable('HK')
  };
}

function parseVerb(forms) {
  const pers = [['ég', '1'], ['þú', '2'], ['hann/hún/það', '3']];
  return {
    nafnhattur: findForm(forms, 'GM-NH'),
    nutid: pers.map(([p, n]) => ({ p, form: findForm(forms, `GM-FH-NT-${n}P-ET`) })),
    thatid: pers.map(([p, n]) => ({ p, form: findForm(forms, `GM-FH-ÞT-${n}P-ET`) })),
    forms // geymt fyrir "Meira" (myndir + hættir)
  };
}

// ── Render: byggir HTML fyrir modalinn ───────────────────────────────
function renderNoun(n, lemma) {
  const rows = (tbl) => tbl.map((r) => `
    <tr><th>${esc(r.label)} <span class="bg-ab">(${r.fall})</span></th>
        <td class="bg-prep">${esc(CASE_PREP[r.fall])}</td>
        <td>${esc(r.plain || '—')}</td><td>${esc(r.def || '—')}</td></tr>`).join('');
  return `
    <div class="bg-help-key">Fall · hjálparorð · orð</div>
    <table class="bg-table">
      <thead><tr><th>Eintala</th><th></th><th>án greinis</th><th>með greini</th></tr></thead>
      <tbody>${rows(n.et)}</tbody>
    </table>
    ${n.ft ? `
      <button class="bg-more" data-more="noun-ft">Sýna fleirtölu</button>
      <div class="bg-hidden" data-panel="noun-ft">
        <table class="bg-table">
          <thead><tr><th>Fleirtala</th><th></th><th>án greinis</th><th>með greini</th></tr></thead>
          <tbody>${rows(n.ft)}</tbody>
        </table>
      </div>` : ''}`;
}

function renderAdj(a, lemma) {
  const s = a.stig;
  const genderTbl = (tbl, heading) => `
    <table class="bg-table">
      <thead><tr><th colspan="3">${esc(heading)}</th></tr></thead>
      <tbody>${tbl.map((r) => `
        <tr><th>${esc(r.label)} <span class="bg-ab">(${r.fall})</span></th>
            <td class="bg-prep">${esc(CASE_PREP[r.fall])}</td>
            <td>${esc(r.form || '—')}</td></tr>`).join('')}</tbody>
    </table>`;
  return `
    ${(s.frum || s.mid || s.efsta) ? `
      <div class="bg-stig">
        <span class="bg-stig-lbl">Stigbreyting</span>
        <span class="bg-stig-forms">${esc(s.frum || '—')} · ${esc(s.mid || '—')} · ${esc(s.efsta || '—')}</span>
      </div>` : ''}
    <div class="bg-help-key">Fall · hjálparorð · orð</div>
    ${genderTbl(a.kk, 'Eintala — karlkyn')}
    <button class="bg-more" data-more="adj-gender">Sýna önnur kyn</button>
    <div class="bg-hidden" data-panel="adj-gender">
      ${genderTbl(a.kvk, 'Eintala — kvenkyn')}
      ${genderTbl(a.hk, 'Eintala — hvorugkyn')}
    </div>`;
}

function renderVerb(v, lemma) {
  const persTbl = (title, rows) => `
    <table class="bg-table bg-verb">
      <thead><tr><th colspan="2">${esc(title)}</th></tr></thead>
      <tbody>${rows.map((r) => `
        <tr><th>${esc(r.p)}</th><td>${esc(r.form || '—')}</td></tr>`).join('')}</tbody>
    </table>`;
  // "Meira": myndir (GM/MM) og hættir — flokka allar myndir
  const byMynd = { GM: [], MM: [] };
  for (const { form, mark } of v.forms) {
    const parts = mark.split('-');
    const mynd = parts.includes('GM') ? 'GM' : (parts.includes('MM') ? 'MM' : null);
    if (!mynd || !form) continue;
    const hp = parts.find((p) => HATTUR_LBL[p]);
    byMynd[mynd].push({ form, hattur: hp ? HATTUR_LBL[hp] : mark });
  }
  // Dregur saman einstakar myndir í eina línu per hátt (fyrst fáein afbrigði).
  const groupByHattur = (arr) => {
    const groups = {};
    for (const x of arr) {
      if (!groups[x.hattur]) groups[x.hattur] = new Set();
      groups[x.hattur].add(x.form);
    }
    return Object.entries(groups).map(([h, set]) => `
      <div class="bg-more-row"><span class="bg-more-h">${esc(h)}</span>
        <span class="bg-more-f">${[...set].map(esc).join(' · ')}</span></div>`).join('');
  };
  return `
    <div class="bg-nh">Nafnháttur: <b>að ${esc(v.nafnhattur || lemma)}</b></div>
    <div class="bg-verb-grid">
      ${persTbl('Nútíð (eintala)', v.nutid)}
      ${persTbl('Þátíð (eintala)', v.thatid)}
    </div>
    <div class="bg-more-head">Meira</div>
    <button class="bg-more" data-more="verb-all">Sýna allar myndir og hætti</button>
    <div class="bg-hidden" data-panel="verb-all">
      <div class="bg-more-sub">Germynd</div>${groupByHattur(byMynd.GM)}
      ${byMynd.MM.length ? `<div class="bg-more-sub">Miðmynd</div>${groupByHattur(byMynd.MM)}` : ''}
    </div>`;
}

// ── FASTUR SAMNINGUR við lookupWordHelp ──────────────────────────────
// Fallið skilar `pos` BEINT úr lexicon.json (ÍNO partOfSpeech). Beygingar-
// modalinn styður NÁKVÆMLEGA þrjú gildi:
//     n   = nafnorð
//     adj = lýsingarorð
//     v   = sögn
// Ef fallið breytist einhvern tíma og skilar öðru merki (kk/lo/so, noun/verb,
// íslenskum heitum…) þá fær orðið ENGAN beygingarhnapp — ÞÖGULT. Til að það
// verði ekki ósýnilegt (§ "eitthvað mistókst og enginn sá það") skrifum við
// viðvörun í console þegar pos er til staðar en óþekkt. Barnið sér ekkert;
// þið sjáið viðvörunina. Lágstöfun ver gegn N/ADJ/V ef hástafir læðast inn.
const BEYGING_POS = new Set(['n', 'adj', 'v']);
function beygingSupported(pos) {
  const p = String(pos || '').trim().toLowerCase();
  if (BEYGING_POS.has(p)) return true;
  // Óþekkt EN ekki tómt/samsett (prae/adv o.þ.h. eru þekkt-óstudd, þögð).
  // Aðeins vara við ef þetta lítur út eins og brotinn samningur: einfalt
  // merki sem er hvorki n/adj/v né þekkt samsett gildi.
  if (p && !p.includes('/') && !p.includes(' ') &&
      !['adv', 'prae', 'conj', 'pron', 'num', 'int', 'gr', 'forl', 'inf', 'skst'].includes(p)) {
    console.warn(`wordhelp: óþekkt pos '${pos}' — enginn beygingarhnappur. ` +
      `Samningur við lookupWordHelp er n/adj/v; athugaðu hvort fallið hafi breyst.`);
  }
  return false;
}
const POS_HEITI = { n: 'nafnorð', adj: 'lýsingarorð', v: 'sögn' };

// ── Opna beygingar-modal ─────────────────────────────────────────────
async function paradigm() {
  const modal = $('bg-modal');
  const body = $('bg-body');
  const title = $('bg-title');
  if (!modal || !body) return;
  const lemma = _last.lemma || '';
  const pos = String(_last.pos || '').trim().toLowerCase();
  title.textContent = `Beyging — ${lemma}`;
  $('bg-sub').textContent = POS_HEITI[pos] || '';
  body.innerHTML = '<div class="wh-msg">Hleð beygingu…</div>';
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');

  try {
    const r = (await lookupPara({ id: _last.id })).data;
    if (!r.found || !r.forms || !r.forms.length) {
      body.innerHTML = '<div class="wh-msg">Engin beyging til fyrir þetta orð.</div>';
      return;
    }
    let html;
    if (pos === 'n') html = renderNoun(parseNoun(r.forms), lemma);
    else if (pos === 'adj') html = renderAdj(parseAdj(r.forms), lemma);
    else if (pos === 'v') html = renderVerb(parseVerb(r.forms), lemma);
    else {
      // óstuddur flokkur — læsileg röð frekar en hrár kóði (öryggisnet)
      html = `<div class="bg-fallback">${r.forms.map((f) =>
        `<span class="bg-chip"><b>${esc(f.form)}</b></span>`).join('')}</div>`;
    }
    body.innerHTML = html;
    // Tengja expand-hnappa
    body.querySelectorAll('.bg-more').forEach((btn) => {
      btn.addEventListener('click', () => {
        const panel = body.querySelector(`[data-panel="${btn.dataset.more}"]`);
        if (panel) {
          const open = panel.classList.toggle('show');
          btn.classList.toggle('open', open);
          btn.textContent = btn.textContent.replace(/^Sýna |^Fela /, open ? 'Fela ' : 'Sýna ');
        }
      });
    });
  } catch (e) {
    body.innerHTML = '<div class="wh-msg">Beygingin sóttist ekki núna. Prófaðu aftur.</div>';
    console.error('lookupWordParadigm', e && e.code, e && e.message);
  }
}

function closeBeyging() {
  const modal = $('bg-modal');
  if (modal) { modal.classList.remove('open'); modal.setAttribute('aria-hidden', 'true'); }
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
  // Ef WordHelp er opnað úr post-save lestrarflæði á bookId ALDREI að vera null.
  // Ef context er til staðar en bók vantar er eitthvað að — gerum það sýnilegt.
  if (!bookId && window.__postSaveContext) {
    console.warn('WordHelp: orð vistað án bókar þótt post-save context sé virkur — bookId vantar.');
  }
  const key = `${cs.familyId}_${cs.childKey}_${_last.id}_${_last.sense || 0}`;
  const ref = doc(db, 'childWords', key);

  // ── UPDATE-FYRST, CREATE Á FALLI — ENGINN getDoc-LESTUR ─────────────
  // save() las áður getDoc(ref) til að velja grein. En fyrir skjal sem er
  // EKKI TIL er `resource` == null, svo read-reglan (resource.data-bundin,
  // réttilega) hafnaði lestrinum — barnið mátti ekki einu sinni spyrja hvort
  // skjalið væri til. Það var rótin: save() féll á getDoc, ekki á setDoc.
  //
  // Lausn án þess að veikja regluna: UPDATE fyrst. updateDoc krefst þess að
  // skjalið SÉ til — svo það heppnast á enduruppflettingu (algengasta leiðin)
  // og fellur með 'not-found' á fyrstu uppflettingu. Þá — og aðeins þá —
  // gerum við CREATE. Kóðinn gerir aldrei hættulega yfirskrift; hann treystir
  // ekki á regluna til að stöðva sig. Read-reglan er aldrei metin gegn
  // `resource` == null því við lesum aldrei skjal sem er ekki til.
  //
  // firstAt er write-once: AÐEINS í create-payloadinu. update snertir það
  // aldrei, svo "fyrsta uppfletting" helst rétt. count hækkar með increment
  // (update) eða byrjar í 1 (create).
  const updatePayload = {
    searchedForm: _word,
    simpleSnapshot: _last.simple || null,
    bookId: bookId,
    count: increment(1),
    lastAt: serverTimestamp()
  };
  const createPayload = {
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
  };

  try {
    // UPDATE: heppnast á enduruppflettingu. Fellur með 'not-found' ef skjalið
    // er ekki til enn (fyrsta uppfletting orðsins).
    await updateDoc(ref, updatePayload);
    if (!_looked.includes(_last.lemma)) _looked.push(_last.lemma);
    if (note) note.innerHTML = '<div class="wh-saved">✓ Vistað í Orðin mín</div>';
  } catch (eUpdate) {
    // Skjalið er ekki til → CREATE. setDoc með create-payload stenst
    // create-regluna (count==1, firstAt==request.time, tíu reitir).
    try {
      await setDoc(ref, createPayload);
      if (!_looked.includes(_last.lemma)) _looked.push(_last.lemma);
      if (note) note.innerHTML = '<div class="wh-saved">✓ Vistað í Orðin mín</div>';
    } catch (eCreate) {
      // Bæði féllu → raunveruleg villa (regla, net), ekki update/create
      // ruglingur. Mjúkt á skjá, nákvæmt í console.
      if (note) note.innerHTML = '<div class="wh-saved err">Orðið geymdist ekki. Prófaðu aftur.</div>';
      console.error('childWords update failed:', eUpdate && eUpdate.code, eUpdate && eUpdate.message);
      console.error('childWords create failed:', eCreate && eCreate.code, eCreate && eCreate.message);
    }
  }
}

// ── Beygingar-modal: markup + stíll, sprautað einu sinni ─────────────
// Notar CSS-breytur appsins (--card, --accent, --soft, --serif, --radius…)
// svo modalinn líti út eins og hluti af child.html, ekki aðskotahlutur.
function injectBeygingModal() {
  if ($('bg-modal')) return;
  const css = `
    #bg-modal { position: fixed; inset: 0; z-index: 200; display: none;
      align-items: flex-end; justify-content: center;
      background: rgba(5,11,20,.72); backdrop-filter: blur(3px); }
    #bg-modal.open { display: flex; }
    .bg-sheet { width: 100%; max-width: 480px; max-height: 88vh; overflow-y: auto;
      background: var(--card, rgba(12,22,38,.98)); border-top-left-radius: 22px;
      border-top-right-radius: 22px; border: 1px solid var(--border-hl, rgba(29,205,211,.25));
      border-bottom: none; padding: 0 20px calc(24px + var(--safe, 0px));
      animation: bg-up .26s cubic-bezier(.22,1,.36,1); }
    @keyframes bg-up { from { transform: translateY(100%); } to { transform: translateY(0); } }
    @media (prefers-reduced-motion: reduce) { .bg-sheet { animation: none; } }
    .bg-head { position: sticky; top: 0; background: var(--card, rgba(12,22,38,.98));
      display: flex; align-items: center; justify-content: space-between;
      padding: 16px 0 12px; border-bottom: 1px solid var(--line, rgba(29,205,211,.14)); z-index: 1; }
    .bg-back { background: none; border: none; color: var(--accent, #1dcdd3);
      font-size: 14px; font-weight: 600; cursor: pointer; padding: 6px 4px; }
    .bg-x { background: none; border: none; color: var(--soft, #7a8fa0);
      font-size: 22px; line-height: 1; cursor: pointer; padding: 4px 8px; }
    .bg-titles { text-align: center; flex: 1; }
    #bg-title { font-family: var(--serif); font-size: 19px; color: var(--text, #e8eef4);
      font-weight: 400; }
    #bg-sub { font-size: 10px; font-weight: 800; color: var(--soft, #7a8fa0);
      text-transform: uppercase; letter-spacing: .6px; margin-top: 2px; }
    #bg-body { padding-top: 16px; }
    .bg-table { width: 100%; border-collapse: collapse; margin: 6px 0 14px; }
    .bg-table thead th { font-size: 10px; font-weight: 800; color: var(--soft, #7a8fa0);
      text-transform: uppercase; letter-spacing: .5px; text-align: left;
      padding: 6px 8px; border-bottom: 1px solid var(--line, rgba(29,205,211,.14)); }
    .bg-table tbody th { font-size: 13px; font-weight: 600; color: var(--soft, #7a8fa0);
      text-align: left; padding: 9px 8px; white-space: nowrap; }
    .bg-table tbody td { font-size: 15px; color: var(--text, #e8eef4); padding: 9px 8px;
      font-family: var(--serif); }
    .bg-table tbody tr + tr th, .bg-table tbody tr + tr td {
      border-top: 1px solid var(--accent-dim, rgba(29,205,211,.08)); }
    .bg-ab { font-size: 10px; font-weight: 700; color: var(--accent, #1dcdd3); opacity: .8; }
    .bg-prep { font-size: 13px; color: var(--accent, #1dcdd3); font-style: italic;
      white-space: nowrap; opacity: .85; }
    .bg-help-key { font-size: 10px; font-weight: 700; letter-spacing: .5px;
      text-transform: uppercase; color: var(--soft, #7a8fa0); margin: 4px 0 8px;
      text-align: center; opacity: .7; }
    .bg-stig { display: flex; flex-direction: column; gap: 3px; padding: 12px;
      background: var(--accent-dim, rgba(29,205,211,.08)); border-radius: 12px; margin: 4px 0 16px; }
    .bg-stig-lbl { font-size: 10px; font-weight: 800; color: var(--soft, #7a8fa0);
      text-transform: uppercase; letter-spacing: .5px; }
    .bg-stig-forms { font-family: var(--serif); font-size: 17px; color: var(--text, #e8eef4); }
    .bg-nh { font-size: 15px; color: var(--soft, #7a8fa0); margin: 4px 0 14px; }
    .bg-nh b { font-family: var(--serif); color: var(--text, #e8eef4); font-weight: 400; }
    .bg-verb-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    @media (max-width: 380px) { .bg-verb-grid { grid-template-columns: 1fr; } }
    .bg-more-head { font-size: 10px; font-weight: 800; color: var(--soft, #7a8fa0);
      text-transform: uppercase; letter-spacing: .6px; margin: 18px 0 8px;
      padding-top: 14px; border-top: 1px solid var(--line, rgba(29,205,211,.14)); }
    .bg-more { width: 100%; text-align: left; background: none;
      border: 1px solid var(--line, rgba(29,205,211,.14)); border-radius: 10px;
      color: var(--accent, #1dcdd3); font-size: 13px; font-weight: 600;
      padding: 11px 14px; margin: 6px 0; cursor: pointer; display: flex;
      justify-content: space-between; align-items: center; }
    .bg-more::after { content: '▸'; transition: transform .2s; opacity: .7; }
    .bg-more.open::after { transform: rotate(90deg); }
    .bg-hidden { display: none; padding-top: 4px; }
    .bg-hidden.show { display: block; }
    .bg-more-sub { font-size: 11px; font-weight: 800; color: var(--accent, #1dcdd3);
      text-transform: uppercase; letter-spacing: .5px; margin: 12px 0 6px; }
    .bg-more-row { display: flex; justify-content: space-between; gap: 12px;
      padding: 7px 8px; border-top: 1px solid var(--accent-dim, rgba(29,205,211,.08)); }
    .bg-more-h { font-size: 12px; color: var(--soft, #7a8fa0); flex-shrink: 0; }
    .bg-more-f { font-size: 13px; color: var(--text, #e8eef4); font-family: var(--serif);
      text-align: right; }
    .bg-fallback { display: flex; flex-wrap: wrap; gap: 6px; }
    .bg-chip { font-size: 13px; color: var(--text, #e8eef4);
      background: var(--accent-dim, rgba(29,205,211,.08)); border-radius: 7px; padding: 4px 9px;
      font-family: var(--serif); }`;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const modal = document.createElement('div');
  modal.id = 'bg-modal';
  modal.setAttribute('aria-hidden', 'true');
  modal.setAttribute('role', 'dialog');
  modal.innerHTML = `
    <div class="bg-sheet">
      <div class="bg-head">
        <button class="bg-back" id="bg-back" type="button">← til baka</button>
        <div class="bg-titles"><div id="bg-title"></div><div id="bg-sub"></div></div>
        <button class="bg-x" id="bg-x" type="button" aria-label="Loka">✕</button>
      </div>
      <div id="bg-body"></div>
    </div>`;
  document.body.appendChild(modal);

  $('bg-back').addEventListener('click', closeBeyging);
  $('bg-x').addEventListener('click', closeBeyging);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeBeyging(); });
}

// ── Tengja ──────────────────────────────────────────────────────────
function wire() {
  if (!$('post-save-step-wordhelp')) return;   // eldri child.html — gerum ekkert
  injectBeygingModal();
  $('wh-go').addEventListener('click', () => search());
  $('wh-word').addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
  // Skrá orðalénið hjá flæðisstjóranum. Navigation (Já-hnappur, panel-skipti,
  // "Skoða annað orð", "Áfram í setningu") á heima í child.html / PostSaveFlow.
  if (window.PostSaveFlow && window.PostSaveFlow.attachWordHelp) {
    window.PostSaveFlow.attachWordHelp({ enter, reset, getLooked });
  }
}

if (document.readyState === 'loading')
  document.addEventListener('DOMContentLoaded', wire);
else wire();
