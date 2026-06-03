// ─── js/book-catalog.js ───
// Bóka-uppfletting: Firestore FYRST, Gemini bara ef ekkert finnst.
// Markmið tvíþætt: (1) spara Gemini-köll, (2) byggja upp íslenskt
// barnabóka-gagnasafn sem batnar með hverri bók.
//
//   Leitarröð:  bookCatalog → bookMetadataCache → (Gemini hjá kallanda)
//
//     • bookCatalog        = staðfest/curated gögn. Admin/backend skrifar,
//                            frontend les. Hæsta traust.
//     • bookMetadataCache  = Gemini-niðurstöður vistaðar (frontend les+skrifar)
//                            svo sama bók kosti ekki Gemini-kall aftur. Miðlungs traust.
//
// FIREBASE-ÓHÁÐ MEÐ VILJA: normalize* eru hrein föll, og Firestore-föllin taka
// `fs` (db + helpers) sem inntak. Þannig getur child.html (eigin Firebase init)
// og síður sem nota firebase-config.js deilt SÖMU lógík án tveggja-app árekstrar.
//
// ── Gagnaskema ──────────────────────────────────────────────────────────────
// bookCatalog/{key}   key = "isbn_<isbn>"  EÐA  "<titleKey>__<authorKey>"
//   title, author, isbn?,
//   titleKey, authorKey,
//   totalPages,                          // STAÐREYND ef ISBN/útgáfa staðfest
//   wordsPerTextPage,                    // mat
//   progressWordsPerPage,                // mat
//   readingLevelKey, readingLevelLabel,  // curated mat
//   lengthLabel, layoutType,
//   metadataSource: 'verified',
//   factsConfidence: 1,                  // bókfræðilegar staðreyndir (titill/höf./bls.)
//   readingEstimateConfidence: 0.85,     // lestrar-mat (0..1) — EKKI staðreynd
//   updatedAt
//
// bookMetadataCache/{key}  — sama lögun, en metadataSource:'gemini',
//   factsConfidence: 1 ef ISBN annars 0.7,  readingEstimateConfidence: 0.6
//
// book (snapshot á barni)  — geymir AFRIT + tilvísun svo catalog-uppfærsla
//   breyti ekki afturvirkt nema beðið sé sérstaklega um "refresh":
//   { title, author, catalogKey, metadataSource, totalPages,
//     wordsPerTextPage, progressWordsPerPage, readingLevelKey }
// ─────────────────────────────────────────────────────────────────────────────

/* Íslensk → ASCII. Athugið: þ/ð/æ eru EKKI díakritík (hafa engan ASCII-grunn),
   svo þau þarf að kortleggja sérstaklega — NFD-strip nær þeim ekki. */
const _ICE_MAP = {
  'á':'a','é':'e','í':'i','ó':'o','ú':'u','ý':'y',
  'þ':'th','ð':'d','æ':'ae','ö':'o','ø':'o','å':'a','ä':'a'
};

/**
 * Hrein normalisering á einum streng (titill EÐA höfundur).
 * ÞETTA VERÐUR AÐ VERA EINA ÚTGÁFAN — frontend og backend nota þessa sömu.
 * Reglur (deterministískar): lágstafir → íslensk-fold → afgangs-díakritík burt →
 * allt sem er ekki [a-z0-9] verður bandstrik → trim.
 */
export function normalizeToken(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[áéíóúýþðæöøåä]/g, ch => _ICE_MAP[ch] || ch)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // afgangs-díakritík
    .replace(/&/g, ' og ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** ISBN → aðeins tölustafir (+ X fyrir ISBN-10 checksum), hástafir. */
export function normalizeIsbn(isbn) {
  return String(isbn == null ? '' : isbn).replace(/[^0-9xX]/g, '').toUpperCase();
}

/** Titill__höfundur lykill (fallback þegar ekkert ISBN). */
export function normalizeBookKey(title, author) {
  const t = normalizeToken(title);
  const a = normalizeToken(author);
  return a ? `${t}__${a}` : t;
}

/** Aðallykill: ISBN ef til (best — útgáfu-nákvæmt), annars titill__höfundur. */
export function bookKeyFrom({ isbn, title, author } = {}) {
  const i = normalizeIsbn(isbn);
  return i ? `isbn_${i}` : normalizeBookKey(title, author);
}

/**
 * Fletta upp bók í catalog → cache. Skilar gögnum (með _source: 'catalog'|'cache')
 * eða null ef ekkert finnst (þá keyrir kallandi Gemini og vistar með cacheBookMetadata).
 *
 * @param {{db:any, doc:Function, getDoc:Function}} fs  Firestore-helpers (sprautað inn)
 * @param {{isbn?:string, title?:string, author?:string}} q
 * @returns {Promise<object|null>}
 */
export async function lookupBookMetadata(fs, { isbn, title, author } = {}) {
  const { db, doc, getDoc } = fs;
  const keys = [];
  const i = normalizeIsbn(isbn);
  if (i) keys.push(`isbn_${i}`);            // ISBN fyrst (nákvæmast)
  const ta = normalizeBookKey(title, author);
  if (ta && !keys.includes(ta)) keys.push(ta);

  // Röð skiptir máli: staðfest catalog á undan Gemini-cache.
  for (const col of ['bookCatalog', 'bookMetadataCache']) {
    for (const key of keys) {
      try {
        const snap = await getDoc(doc(db, col, key));   // deterministískur lykill → ódýr getDoc, engin index
        if (snap.exists()) {
          return { ...snap.data(), _key: key, _source: (col === 'bookCatalog' ? 'catalog' : 'cache') };
        }
      } catch (e) { /* lestrar-villa → halda áfram; versta fall = Gemini-fallback */ }
    }
  }
  return null;
}

/**
 * Vista Gemini-niðurstöðu í CACHE (ekki catalog — það er aðeins admin/backend).
 * Kallað EFTIR Gemini-kall svo sama bók kosti ekki aftur.
 *
 * @param {{db:any, doc:Function, setDoc:Function, serverTimestamp:Function}} fs
 * @param {object} meta  niðurstaða (title, author, isbn?, totalPages, ... )
 * @returns {Promise<object|null>}  vistuðu gögnin eða null
 */
export async function cacheBookMetadata(fs, meta = {}) {
  const { db, doc, setDoc, serverTimestamp } = fs;
  const key = bookKeyFrom(meta);
  if (!key) return null;
  const hasIsbn = !!normalizeIsbn(meta.isbn);
  const payload = {
    title:                meta.title  || null,
    author:               meta.author || null,
    isbn:                 hasIsbn ? normalizeIsbn(meta.isbn) : null,
    titleKey:             normalizeToken(meta.title),
    authorKey:            normalizeToken(meta.author),
    totalPages:           meta.totalPages ?? null,
    wordsPerTextPage:     meta.wordsPerTextPage ?? null,
    progressWordsPerPage: meta.progressWordsPerPage ?? null,
    readingLevelKey:      meta.readingLevelKey ?? null,
    readingLevelLabel:    meta.readingLevelLabel ?? null,
    lengthLabel:          meta.lengthLabel ?? null,
    layoutType:           meta.layoutType ?? null,
    metadataSource:       'gemini',
    factsConfidence:          hasIsbn ? 1 : 0.7,   // ISBN → bls. treystanlegar; annars Gemini-mat
    readingEstimateConfidence: 0.6,                // lestrar-mat úr Gemini er veikt
    updatedAt:            serverTimestamp()
  };
  try {
    await setDoc(doc(db, 'bookMetadataCache', key), payload, { merge: true });
    return { ...payload, _key: key, _source: 'cache' };
  } catch (e) {
    console.warn('cacheBookMetadata failed:', e);
    return null;
  }
}

/**
 * Búa til snapshot til að geyma Á BÓKINNI hjá barni (afrit + tilvísun).
 * Þannig breytir catalog-uppfærsla ekki gögnum barnsins afturvirkt.
 */
export function bookSnapshotFrom(meta = {}) {
  return {
    title:                meta.title || null,
    author:               meta.author || null,
    catalogKey:           meta._key || bookKeyFrom(meta) || null,
    metadataSource:       meta.metadataSource || meta._source || 'manual',
    totalPages:           meta.totalPages ?? null,
    wordsPerTextPage:     meta.wordsPerTextPage ?? null,
    progressWordsPerPage: meta.progressWordsPerPage ?? null,
    readingLevelKey:      meta.readingLevelKey ?? null
  };
}
