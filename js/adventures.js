/* =====================================================================
   UppHátt — ÆVINTÝRA-PAKKAR  (adventures.js)
   ---------------------------------------------------------------------
   Hvert ævintýri er HREIN GÖGN. Vélin (expedition.js) les þetta og
   teiknar — hún veit ekkert um innihaldið. Til að bæta við ævintýri:
   afritaðu einn hlut hér að neðan og breyttu texta/litum/vegpunktum.

   GRAF-TILBÚIÐ:
     waypoints er keðja núna (línuleg leið). Seinna má bæta `to`/`branch`
     við vegpunkt til að gera krossgötur — vélin er skrifuð til að höndla
     `m` (uppsöfnuð fjarlægð) per vegpunkt, svo línulegt er bara sérstakt
     tilfelli af grafi.

   EITT EVINTÝRI:
   {
     id, title, eyebrow, peakName,
     cmPerPage,                       // 1 bls = X cm   (sama og Ferðalag: 20)
     theme: { ... CSS-breytur fyrir liti/atmo ... },
     waypoints: [ { name, cmp, m, glyph } ],   // m uppsafnað; síðasti = mark
     copy: { ... texti sem vélin sýnir ... }
   }
===================================================================== */
(function (root) {
  // litlar SVG-táknmyndir (teiknast í 0,0 miðju, ~16px)
  var G = {
    gate:   '<g stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"><path d="M-6 6V-3a6 6 0 0 1 12 0V6"/></g>',
    falls:  '<g stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"><path d="M-5 -6V6M0 -6V6M5 -6V6"/></g>',
    tree:   '<g fill="currentColor"><path d="M0 -8 L6 4 H-6 Z"/><rect x="-1.5" y="3" width="3" height="4"/></g>',
    crags:  '<g fill="currentColor"><path d="M-7 6 L-2 -4 L3 6 Z"/><path d="M1 6 L5 -2 L8 6 Z"/></g>',
    wind:   '<g stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"><path d="M-7 -2 Q0 -5 7 -2"/><path d="M-7 3 Q0 0 7 3"/></g>',
    dragon: '<g fill="currentColor"><path d="M-8 6 L0 -8 L8 6 Z"/><path d="M-2.5 -2.5 L0 -8 L2.5 -2.5 Z" fill="var(--bg)"/></g>',
    anchor: '<g stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"><circle cx="0" cy="-5" r="2"/><path d="M0 -3V6M-5 1a5 5 0 0 0 10 0"/></g>',
    rocks:  '<g fill="currentColor"><path d="M-7 6 L-3 0 L1 6 Z"/><path d="M0 6 L4 1 L8 6 Z"/></g>',
    island: '<g fill="currentColor"><path d="M-7 6 Q0 2 7 6 Z"/><path d="M0 2 V-6 M0 -6 Q4 -5 3 -2"/></g>',
    swirl:  '<g stroke="currentColor" stroke-width="2" fill="none"><path d="M5 0a5 5 0 1 1-3-4.6"/></g>',
    castle: '<g fill="currentColor"><path d="M-7 6V-2h2v-3h2v3h2v-3h2v3h2v8 Z"/></g>',
    star:   '<circle r="3" fill="currentColor"/>'
  };

  var ADVENTURES = [

    /* ---- 1) Drekatindur (dökkt rökkur, teal + amber) ------------------ */
    {
      id: 'drekatindur',
      title: 'Drekatindur',
      eyebrow: 'Tímabundinn leiðangur',
      peakName: 'Drekatind',
      cmPerPage: 20,
      theme: {
        bg: '#0a1420', surface: '#122236', surface2: '#16273c',
        line: '#20364f', text: '#eaf2f8', textDim: '#9fb4c7', textMute: '#6b8198',
        border: '#284363',
        you: '#1dcdd3', partner: '#e8b057',      // göngumenn
        trail: '#1dcdd3', trailSoft: 'rgba(29,205,211,0.16)',
        sky: '#16344a', grass: '#123034', sand: '#142536', sunset: '#e8b057'
      },
      waypoints: [
        { name: 'Dalshlið',      cmp: 'hér hefst leiðin',     m: 0,   glyph: G.gate },
        { name: 'Silfurfoss',    cmp: 'yfir glitrandi fossinn', m: 20, glyph: G.falls },
        { name: 'Skuggaskógur',  cmp: 'gegnum dimman skóg',   m: 40,  glyph: G.tree },
        { name: 'Hrafnaklettar', cmp: 'upp hrikalega kletta', m: 60,  glyph: G.crags },
        { name: 'Vindheiðar',    cmp: 'yfir vindbarðar heiðar', m: 80, glyph: G.wind },
        { name: 'Drekatindur',   cmp: 'alla leið á tindinn',  m: 100, glyph: G.dragon }
      ],
      copy: {
        goingTo: 'Á Drekatind',
        reached: 'Tindinum náð — saman',
        note: 'Þetta er átak, ekki keppni. Engin stig, enginn sigurvegari — bara þið tveir á sömu leið, alla leið á toppinn.'
      }
    },

    /* ---- 2) Sækóngsdjúp (kalt blátt haf — sannar að skipti virka) ----- */
    {
      id: 'saekongsdjup',
      title: 'Sækóngsdjúp',
      eyebrow: 'Tímabundinn sjóleiðangur',
      peakName: 'Sækóngshöll',
      cmPerPage: 20,
      theme: {
        bg: '#06121f', surface: '#0e2336', surface2: '#123048',
        line: '#1c3a55', text: '#e8f3fb', textDim: '#97b6cf', textMute: '#5f7e98',
        border: '#234a6b',
        you: '#3fd0e8', partner: '#9b8cff',
        trail: '#3fd0e8', trailSoft: 'rgba(63,208,232,0.16)',
        sky: '#103a55', grass: '#0c2e3e', sand: '#0e2336', sunset: '#7fd1ff'
      },
      waypoints: [
        { name: 'Höfnin',         cmp: 'leggið frá landi',     m: 0,   glyph: G.anchor },
        { name: 'Skerjaklasinn',  cmp: 'milli hvassra skerja', m: 25,  glyph: G.rocks },
        { name: 'Þokueyjan',      cmp: 'gegnum gráa þoku',     m: 50,  glyph: G.island },
        { name: 'Straumröstin',   cmp: 'yfir iðandi röstina',  m: 75,  glyph: G.swirl },
        { name: 'Sækóngshöll',    cmp: 'alla leið í djúpið',   m: 100, glyph: G.castle }
      ],
      copy: {
        goingTo: 'Að Sækóngshöll',
        reached: 'Höllinni náð — saman',
        note: 'Þetta er sjóferð, ekki kappsigling. Engin stig, enginn sigurvegari — bara þið tveir á sömu leið, alla leið í djúpið.'
      }
    }

  ];

  // Loader-viðmót — sama hvort gögnin koma héðan eða úr Firestore seinna.
  root.UPPHATT_ADVENTURES = ADVENTURES;
  root.getAdventure = function (id) {
    return ADVENTURES.find(function (a) { return a.id === id; }) || ADVENTURES[0];
  };
})(typeof window !== 'undefined' ? window : this);
