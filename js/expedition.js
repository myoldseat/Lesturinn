/* =====================================================================
   UppHátt — ÆVINTÝRAVÉL  (expedition.js)
   ---------------------------------------------------------------------
   Stakt, útskiptanlegt. Veit EKKERT um Firebase eða innihald ævintýra.
   Allt kemur í gegnum `ctx`. Sama vél keyrir standalone (mock ctx) og
   inni í child-appinu (Firebase ctx).

   NOTKUN:
     Expedition.mount(containerEl, ctx)

   CTX-SAMNINGURINN (saumurinn):
   {
     me:        { key, name, initial },        // barnið á tækinu
     partner:   { key, name, initial },        // systkinið (par núna)
     adventure: <ævintýra-hlutur úr adventures.js / Firestore>,
     daysLeft:  number,                        // gluggi áskorunar

     // GÖGN — allt í BLAÐSÍÐUM fyrir þennan glugga:
     weeklyPages(childKey) -> number,          // raunlestur (úr sessions)
     donated(childKey)     -> number,          // aðstoð SEND (úr aðstoðar-færslum)
     received(childKey)    -> number,          // aðstoð MÓTTEKIN

     // AÐGERÐIR (mega skila Promise):
     sendAid(toChildKey, pages),               // skráir aðstoðar-færslu
     onRead(),                                 // valfrjáls: "lesa núna"
     sendCheer(toChildKey),                    // valfrjáls: hvatning
     onLeave()                                 // valfrjáls: ljúka/loka
   }

   STAÐA (reiknuð, read-only):
     leiðangurssíður(barn) = vikulesnar − gefið + móttekið
     liðsstaða = min(beggja)   (sá aftari)   → tindur opnast þegar báðir koma
===================================================================== */
(function (root) {
  'use strict';

  var AID_THRESHOLD_M = 8;   // þegar annar er "aftar"
  var DONATE_PAGES   = 20;   // hve mikið "Lesa hann til þín" sendir í einu

  /* ---- rúmfræði stígsins (340×452 viewBox) ------------------------- */
  function pointAlong(f) {
    f = Math.max(0, Math.min(1, f));
    var y = 430 - f * 388;                 // botn -> toppur
    var amp = 64 * (1 - f * 0.45);         // mjókkar nálægt tindi
    var x = 170 + Math.sin(f * Math.PI * 2.05 + 0.3) * amp;
    return { x: x, y: y };
  }
  var TRAIL_D = (function () {
    var d = '', p, i;
    for (i = 0; i <= 40; i++) {
      p = pointAlong(i / 40);
      d += (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ' ' + p.y.toFixed(1) + ' ';
    }
    return d.trim();
  })();

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function fmtM(m) {
    if (m >= 1000) return (m / 1000).toFixed(m % 1000 ? 1 : 0).replace('.', ',') + ' km';
    return (m >= 10 ? Math.round(m) : m.toFixed(1).replace('.', ',')) + ' m';
  }

  /* ---- útreikningur stöðu ----------------------------------------- */
  function compute(ctx) {
    var adv = ctx.adventure;
    var wps = adv.waypoints;
    var goalM = wps[wps.length - 1].m;
    var cm = adv.cmPerPage || 20;

    function pagesOf(key) {
      var w = ctx.weeklyPages ? (ctx.weeklyPages(key) || 0) : 0;
      var d = ctx.donated ? (ctx.donated(key) || 0) : 0;
      var r = ctx.received ? (ctx.received(key) || 0) : 0;
      return Math.max(0, w - d + r);
    }
    var hasPartner = !!ctx.partner;
    var meM = pagesOf(ctx.me.key) * cm / 100;
    var paM = hasPartner ? pagesOf(ctx.partner.key) * cm / 100 : meM;

    var teamM = hasPartner ? Math.min(meM, paM) : meM;
    var teamIndex = 0, i;
    for (i = 0; i < wps.length; i++) if (wps[i].m <= teamM + 0.001) teamIndex = i;
    var nextWp = wps[teamIndex + 1] || null;
    var pagesToNext = nextWp ? Math.ceil(((nextWp.m - teamM) * 100) / cm) : 0;

    // hve mikið ég á eftir til að gefa = það sem ég hef lesið og ekki gefið
    var avail = ctx.weeklyPages
      ? Math.max(0, (ctx.weeklyPages(ctx.me.key) || 0) - (ctx.donated ? (ctx.donated(ctx.me.key) || 0) : 0))
      : 0;

    return {
      adv: adv, wps: wps, goalM: goalM,
      meM: meM, paM: paM, teamM: teamM, teamIndex: teamIndex,
      nextWp: nextWp, pagesToNext: pagesToNext,
      meFrac: Math.min(1, meM / goalM),
      paFrac: hasPartner ? Math.min(1, paM / goalM) : 0,
      meAtPeak: meM >= goalM, paAtPeak: hasPartner ? paM >= goalM : false,
      bothSummit: hasPartner ? teamM >= goalM : meM >= goalM,
      meAhead: hasPartner && meM > paM + AID_THRESHOLD_M,
      paAhead: hasPartner && paM > meM + AID_THRESHOLD_M,
      hasPartner: hasPartner, avail: avail
    };
  }
  function wpAt(s, m) {
    var last = s.wps[0], i;
    for (i = 0; i < s.wps.length; i++) if (s.wps[i].m <= m + 0.001) last = s.wps[i];
    return last;
  }

  /* ---- SVG göngumaður ---------------------------------------------- */
  function climber(pt, person, accentVar, ink, nudge) {
    var x = pt.x + (nudge ? nudge.x : 0);
    var y = pt.y + (nudge ? nudge.y : 0);
    return '<g transform="translate(' + x + ' ' + y + ')">' +
      '<ellipse cx="0" cy="13" rx="11" ry="3" fill="#000" opacity="0.22"/>' +
      '<circle r="13" fill="var(' + accentVar + ')"/>' +
      '<circle r="13" fill="none" stroke="var(--text)" stroke-width="2"/>' +
      '<text x="0" y="4.5" text-anchor="middle" font-size="13" font-weight="800" fill="' + ink + '">' +
      esc(person.initial) + '</text></g>';
  }

  function trailSvg(s, ctx) {
    var youPt = pointAlong(s.meFrac);
    var broPt = pointAlong(s.paFrac);
    var leadFrac = Math.max(s.meFrac, s.paFrac);

    var steps = '', N = Math.max(2, Math.round(leadFrac * 18)), i, p;
    for (i = 1; i <= N; i++) {
      p = pointAlong((leadFrac * i) / (N + 1));
      steps += '<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="2.6" fill="var(--trail)" opacity="' + (0.35 + (i / (N + 1)) * 0.5).toFixed(2) + '"/>';
    }

    var campsSvg = '';
    s.wps.forEach(function (camp, idx) {
      var slot = pointAlong(camp.m / s.goalM);
      var isPeak = idx === s.wps.length - 1;
      var reached = s.teamM >= camp.m - 0.001;
      var isNext = s.nextWp && camp.name === s.nextWp.name;
      var ahead = !reached && !isNext;
      var labelLeft = slot.x > 168;
      var col = reached || isNext ? 'var(--trail)' : 'var(--text-mute)';
      var stroke = reached || isNext ? 'var(--trail)' : 'var(--border)';
      var peakGate = isPeak && !s.bothSummit;
      var sub = isPeak ? (s.bothSummit ? 'saman á toppnum' : 'opnast þegar báðir koma')
        : isNext ? 'næstu búðir' : reached ? 'í höfn' : camp.cmp;
      campsSvg += '<g transform="translate(' + slot.x.toFixed(1) + ' ' + slot.y.toFixed(1) + ')">' +
        (isNext ? '<circle class="exp-pulse" r="20" fill="none" stroke="var(--trail)" stroke-width="2"/>' : '') +
        (isPeak && s.bothSummit ? '<circle class="exp-pulse" r="22" fill="none" stroke="var(--trail)" stroke-width="2"/>' : '') +
        '<circle r="15" fill="var(--surface-2)" stroke="' + (peakGate ? 'var(--partner)' : stroke) + '" stroke-width="' + (reached || isNext || isPeak ? 3 : 2) + '" ' + (peakGate ? 'stroke-dasharray="3 4"' : '') + ' opacity="' + (ahead && !isPeak ? 0.8 : 1) + '"/>' +
        '<g style="color:' + (peakGate ? 'var(--partner)' : col) + ';opacity:' + (ahead && !isPeak ? 0.8 : 1) + '">' + (camp.glyph || '<circle r="3" fill="currentColor"/>') + '</g>' +
        '<g transform="translate(' + (labelLeft ? -24 : 24) + ' 0)">' +
        '<text x="0" y="-1" text-anchor="' + (labelLeft ? 'end' : 'start') + '" font-size="13" font-weight="700" fill="var(--text)" opacity="' + (ahead && !isPeak ? 0.8 : 1) + '">' + esc(camp.name) + '</text>' +
        '<text x="0" y="14" text-anchor="' + (labelLeft ? 'end' : 'start') + '" font-size="10.5" fill="var(--text-mute)">' + esc(sub) + '</text></g></g>';
    });

    var youNudge = s.meFrac >= 0.985 ? { x: -22, y: 6 } : null;
    var broNudge = s.paFrac >= 0.985 ? { x: 22, y: 6 } : null;
    var youDraw = { x: youPt.x + (youNudge ? youNudge.x : 0), y: youPt.y + (youNudge ? youNudge.y : 0) };
    var broDraw = { x: broPt.x + (broNudge ? broNudge.x : 0), y: broPt.y + (broNudge ? broNudge.y : 0) };

    var bond = s.hasPartner
      ? '<line x1="' + youDraw.x.toFixed(1) + '" y1="' + youDraw.y.toFixed(1) + '" x2="' + broDraw.x.toFixed(1) + '" y2="' + broDraw.y.toFixed(1) + '" stroke="var(--text-dim)" stroke-width="2.5" stroke-dasharray="3 5" stroke-linecap="round" opacity="0.7"/>'
      : '';

    return '<svg viewBox="0 0 340 452" role="img" aria-label="Leiðangur">' +
      '<defs><linearGradient id="exp-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--sky)"/><stop offset="100%" stop-color="var(--bg)"/></linearGradient>' +
      '<radialGradient id="exp-glow" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="var(--sunset)" stop-opacity="0.55"/><stop offset="100%" stop-color="var(--sunset)" stop-opacity="0"/></radialGradient></defs>' +
      '<rect x="0" y="0" width="340" height="452" fill="url(#exp-sky)"/>' +
      '<circle cx="262" cy="64" r="70" fill="url(#exp-glow)"/>' +
      '<g fill="#cfe3f0" opacity="0.5"><circle cx="60" cy="40" r="1"/><circle cx="110" cy="70" r="0.8"/><circle cx="300" cy="110" r="1"/><circle cx="40" cy="120" r="0.8"/><circle cx="200" cy="35" r="0.9"/><circle cx="320" cy="58" r="0.8"/></g>' +
      '<ellipse cx="170" cy="470" rx="320" ry="150" fill="var(--grass)" opacity="0.7"/>' +
      '<ellipse cx="60" cy="410" rx="150" ry="62" fill="var(--sand)" opacity="0.6"/>' +
      '<path d="' + TRAIL_D + '" fill="none" stroke="var(--trail-soft)" stroke-width="16" stroke-linecap="round"/>' +
      '<path d="' + TRAIL_D + '" fill="none" stroke="var(--trail)" stroke-width="3" stroke-linecap="round" stroke-dasharray="1 14" opacity="0.5"/>' +
      steps + campsSvg + bond +
      '<g>' + (s.hasPartner ? climber(broPt, ctx.partner, '--partner', '#2a1c04', broNudge) : '') +
      climber(youPt, ctx.me, '--you', '#04222a', youNudge) + '</g></svg>';
  }

  /* ---- aðstoðar-spjald (frá sjónarhóli MÍNS barns) ----------------- */
  function aidHtml(s, ctx) {
    if (!s.hasPartner) return '';
    if (s.bothSummit) return '';
    var P = ctx.partner.name, peak = ctx.adventure.peakName;
    var book = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>';
    var heart = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>';

    // A) ég á tindinum, bíð eftir hinum — sterkasti togkraftur
    if (s.meAtPeak && !s.paAtPeak) {
      return card('call', 'amber',
        'Þú ert á ' + esc(peak),
        'Tindurinn opnast þegar þið eruð báðir komnir',
        esc(P) + ' á smá eftir. Hver síða sem þú gefur dregur hann nær toppnum.',
        '<button class="exp-btn pull" data-act="donate">' + book + ' Lesa ' + esc(P) + ' til þín</button>');
    }
    // B) ég á undan — gef honum, eða held áfram
    if (s.meAhead) {
      return card('', 'amber',
        esc(P) + ' er aðeins aftar',
        'Lesa hann til þín — eða halda áfram?',
        'Þú ert komin lengra. Þú getur gefið ' + esc(P) + ' af þínum lestri svo þið haldist saman — eða haldið áfram. Þið verðið að toppa saman.',
        '<button class="exp-btn pull" data-act="donate">' + book + ' Lesa hann til þín</button>' +
        '<button class="exp-btn go" data-act="dismiss">Halda áfram</button>');
    }
    // C) hinn á undan og hvetur mig
    if (s.paAhead) {
      return card('call', 'amber',
        esc(P) + ' bíður eftir þér',
        'Hann er kominn lengra og hvetur þig áfram',
        '„Komdu, við klárum þetta saman!" — ' + esc(P),
        '<button class="exp-btn read" data-act="read">' + book + ' Lesa núna</button>');
    }
    // D) saman — mjúkt
    return card('', 'teal',
      'Í dag',
      (s.meM + s.paM > 0 ? 'Þið haldist vel í hendur' : 'Lesið í dag og komist af stað'),
      'Þið eruð hlið við hlið. Lesið áfram og færið ykkur saman að ' + esc(s.nextWp ? s.nextWp.name : peak) + '.',
      '<button class="exp-btn pull" data-act="cheer">' + heart + ' Senda ' + esc(P) + ' hvatningu</button>');

    function card(extra, ic, lbl, ttl, txt, btns) {
      return '<div class="exp-aid ' + extra + '"><div class="exp-aid-head"><div class="exp-aid-ic ' + ic + '"></div>' +
        '<div><div class="exp-aid-lbl">' + lbl + '</div><div class="exp-aid-ttl">' + ttl + '</div></div></div>' +
        '<div class="exp-aid-txt">' + txt + '</div><div class="exp-aid-btns">' + btns + '</div></div>';
    }
  }

  /* ---- búðir-listi ------------------------------------------------- */
  function ladderHtml(s) {
    var from = Math.max(0, s.teamIndex - 1);
    var to = Math.min(s.wps.length - 1, s.teamIndex + 3);
    var rows = '', i, c, cls, tag;
    for (i = from; i <= to; i++) {
      c = s.wps[i]; cls = 'ahead'; tag = '';
      if (i <= s.teamIndex) { cls = 'done'; tag = 'í höfn'; }
      else if (s.nextWp && c.name === s.nextWp.name) { cls = 'next'; tag = 'næstu búðir'; }
      rows += '<div class="exp-camp-row ' + cls + '"><div><div class="exp-camp-name">' + esc(c.name) + '</div>' +
        '<div class="exp-camp-cmp">' + esc(c.cmp) + (tag ? ' · <span class="exp-camp-tag">' + tag + '</span>' : '') + '</div></div>' +
        '<div class="exp-camp-dist">' + fmtM(c.m) + '</div></div>';
    }
    return rows;
  }

  /* ---- meginteikning ----------------------------------------------- */
  function render(container, ctx) {
    var s = compute(ctx);
    var adv = ctx.adventure, C = adv.copy || {};
    var meCamp = wpAt(s, s.meM), paCamp = s.hasPartner ? wpAt(s, s.paM) : null;

    var tent = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 21 14 3l10.5 18"/><path d="M14 3 9 21"/></svg>';
    var peakIc = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m8 3 4 8 5-5 5 15H2L8 3z"/></svg>';
    var dl = (ctx.daysLeft == null ? null : ctx.daysLeft);
    var daysPill = (dl != null && dl > 0)
      ? '<span class="exp-days">' + tent + ' ' + dl + ' ' + (dl === 1 ? 'dagur' : 'dagar') + ' eftir</span>'
      : '<span class="exp-days peak">' + peakIc + ' Á tindinum!</span>';

    var names = ctx.me.name + (s.hasPartner ? ' og ' + ctx.partner.name : '');
    var destSub = s.bothSummit
      ? 'Þið ' + esc(names) + ' komust alla leið — saman. Hvílíkur leiðangur!'
      : 'Þið ' + esc(names) + ' eruð bundin saman ' + esc(C.goingTo || ('á ' + adv.peakName)) + '. Þið verðið að toppa saman.';

    function clRow(person, frac, camp, atPeak, accent) {
      return '<div class="exp-cl-row"><div class="exp-cl-av" style="background:var(' + accent + ')">' + esc(person.initial) + '</div>' +
        '<div class="exp-cl-info"><div class="exp-cl-name">' + esc(person.name) + '</div>' +
        '<div class="exp-cl-at">við <b>' + esc(camp.name) + '</b></div>' +
        '<div class="exp-cl-bar"><div style="width:' + Math.round(frac * 100) + '%;background:var(' + accent + ')"></div></div></div>' +
        '<div class="exp-cl-flag' + (atPeak ? ' top' : '') + '">' + (atPeak ? 'á tindi' : '') + '</div></div>';
    }

    container.innerHTML =
      '<section class="exp-banner"><div class="exp-banner-top"><div class="exp-eyebrow">' + esc(adv.eyebrow || 'Tímabundinn leiðangur') + '</div>' + daysPill + '</div>' +
      '<div class="exp-dest">' + esc(s.bothSummit ? (C.reached || 'Tindinum náð — saman') : (C.goingTo || ('Á ' + adv.peakName))) + '</div>' +
      '<div class="exp-dest-sub">' + destSub + '</div></section>' +

      '<div class="exp-trail-card">' + trailSvg(s, ctx) +
      (s.bothSummit
        ? '<div class="exp-trail-foot"><span><b>Þið toppuðuð saman.</b> Vel klifið, félagar!</span></div>'
        : s.nextWp
          ? '<div class="exp-trail-foot"><span>Saman að <b>' + esc(s.nextWp.name) + '</b> · ' + esc(s.nextWp.cmp) + '</span><span class="exp-pages">' + s.pagesToNext + ' bls.</span></div>'
          : '') + '</div>' +

      '<section class="exp-climbers">' +
      clRow(ctx.me, s.meFrac, meCamp, s.meAtPeak, '--you') +
      (s.hasPartner ? clRow(ctx.partner, s.paFrac, paCamp, s.paAtPeak, '--partner') : '') +
      '</section>' +

      aidHtml(s, ctx) +

      '<section class="exp-camps"><h2>Búðir á leiðinni</h2><div class="exp-sub">Áfangar sem þið hafið tryggt og þeir sem bíða</div>' +
      '<div class="exp-ladder">' + ladderHtml(s) + '</div></section>' +

      '<p class="exp-note">' + esc(C.note || 'Þetta er átak, ekki keppni. Engin stig, enginn sigurvegari — bara þið á sömu leið, alla leið á toppinn.') + '</p>' +
      (ctx.onLeave ? '<button class="exp-leave" data-act="leave">Ljúka leiðangri</button>' : '');

    // víra hnappa
    container.querySelectorAll('.exp-btn[data-act],.exp-leave[data-act]').forEach(function (btn) {
      btn.onclick = function () { handle(btn.getAttribute('data-act'), container, ctx, s); };
    });
  }

  function handle(act, container, ctx, s) {
    function done() { render(container, ctx); }
    if (act === 'donate') {
      if (s.avail <= 0) { toast(container, 'Ekkert eftir að gefa í bili — lestu meira fyrst.'); return; }
      var n = Math.min(DONATE_PAGES, s.avail);
      Promise.resolve(ctx.sendAid ? ctx.sendAid(ctx.partner.key, n) : null)
        .then(function () { toast(container, 'Þú last ' + ctx.partner.name + ' áleiðis — hann færðist nær!'); done(); });
    } else if (act === 'read') {
      if (ctx.onRead) ctx.onRead(); else toast(container, 'Áfram með lesturinn!');
    } else if (act === 'cheer') {
      Promise.resolve(ctx.sendCheer ? ctx.sendCheer(ctx.partner.key) : null)
        .then(function () { toast(container, 'Hvatning send til ' + ctx.partner.name + '!'); });
    } else if (act === 'leave') {
      if (ctx.onLeave) ctx.onLeave();
    } else { /* dismiss */ }
  }

  function toast(container, msg) {
    var t = container.querySelector('.exp-toast');
    if (!t) { t = document.createElement('div'); t.className = 'exp-toast'; container.appendChild(t); }
    t.textContent = msg; t.classList.add('show');
    clearTimeout(t._h); t._h = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }

  /* ---- þema + CSS -------------------------------------------------- */
  function applyTheme(el, t) {
    var map = {
      '--bg': t.bg, '--surface': t.surface, '--surface-2': t.surface2, '--line': t.line,
      '--text': t.text, '--text-dim': t.textDim, '--text-mute': t.textMute, '--border': t.border,
      '--you': t.you, '--partner': t.partner, '--trail': t.trail, '--trail-soft': t.trailSoft,
      '--sky': t.sky, '--grass': t.grass, '--sand': t.sand, '--sunset': t.sunset
    };
    for (var k in map) if (map[k]) el.style.setProperty(k, map[k]);
  }

  function injectStyle() {
    if (document.getElementById('exp-style')) return;
    var css =
      '.exp-root{--bg:#0a1420;color:var(--text);font-family:-apple-system,"DM Sans",system-ui,sans-serif;max-width:440px;margin:0 auto}' +
      '.exp-root *{box-sizing:border-box}' +
      '.exp-banner{padding:4px 2px 10px}' +
      '.exp-banner-top{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:8px}' +
      '.exp-eyebrow{font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--trail)}' +
      '.exp-days{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:800;padding:4px 9px;border-radius:99px;background:var(--surface);border:1px solid var(--border);color:var(--text-dim)}' +
      '.exp-days.peak{background:var(--trail-soft);border-color:var(--trail);color:var(--trail)}' +
      '.exp-dest{font-size:23px;font-weight:800;letter-spacing:-.01em}' +
      '.exp-dest-sub{font-size:13px;color:var(--text-dim);margin-top:3px;line-height:1.4}' +
      '.exp-trail-card{position:relative;border-radius:18px;overflow:hidden;border:1px solid var(--line);background:var(--surface)}' +
      '.exp-trail-card svg{display:block;width:100%}' +
      '.exp-trail-foot{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:11px 14px;border-top:1px solid var(--line);font-size:13px;color:var(--text-dim);background:var(--bg)}' +
      '.exp-trail-foot b{color:var(--text)}.exp-pages{font-weight:800;color:var(--trail)}' +
      '.exp-climbers{display:flex;flex-direction:column;gap:8px;margin:12px 0}' +
      '.exp-cl-row{display:flex;align-items:center;gap:11px;padding:10px 12px;border-radius:14px;background:var(--surface);border:1px solid var(--line)}' +
      '.exp-cl-av{width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:800;color:#04222a;flex:0 0 auto}' +
      '.exp-cl-info{flex:1;min-width:0}.exp-cl-name{font-weight:800;font-size:14px}' +
      '.exp-cl-at{font-size:12px;color:var(--text-mute)}.exp-cl-at b{color:var(--text-dim)}' +
      '.exp-cl-bar{height:5px;border-radius:99px;background:var(--line);margin-top:5px;overflow:hidden}.exp-cl-bar>div{height:100%;border-radius:99px}' +
      '.exp-cl-flag{font-size:10px;font-weight:800;color:var(--trail);text-transform:uppercase;letter-spacing:.04em}.exp-cl-flag.top{}' +
      '.exp-aid{border-radius:16px;padding:14px;background:var(--surface);border:1px solid var(--line);margin-bottom:12px}' +
      '.exp-aid.call{border-color:var(--partner);background:linear-gradient(180deg,rgba(232,176,87,.08),transparent)}' +
      '.exp-aid-head{display:flex;gap:11px;align-items:flex-start;margin-bottom:8px}' +
      '.exp-aid-ic{width:30px;height:30px;border-radius:9px;flex:0 0 auto;background:var(--trail-soft)}' +
      '.exp-aid-ic.amber{background:rgba(232,176,87,.16)}' +
      '.exp-aid-lbl{font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--text-mute)}' +
      '.exp-aid-ttl{font-size:15px;font-weight:800;margin-top:2px}' +
      '.exp-aid-txt{font-size:13px;color:var(--text-dim);line-height:1.45;margin-bottom:11px}' +
      '.exp-aid-btns{display:flex;gap:8px;flex-wrap:wrap}' +
      '.exp-btn{display:inline-flex;align-items:center;gap:6px;padding:10px 14px;border-radius:12px;font-size:13px;font-weight:800;border:1px solid transparent;cursor:pointer;-webkit-tap-highlight-color:transparent}' +
      '.exp-btn.pull,.exp-btn.read{background:var(--trail);color:#04222a}' +
      '.exp-btn.go{background:transparent;border-color:var(--border);color:var(--text-dim)}' +
      '.exp-camps{margin-top:6px}.exp-camps h2{font-size:16px;font-weight:800;margin:0}' +
      '.exp-sub{font-size:12.5px;color:var(--text-mute);margin:2px 0 10px}' +
      '.exp-ladder{display:flex;flex-direction:column;gap:2px}' +
      '.exp-camp-row{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 4px;border-bottom:1px solid var(--line-soft,var(--line))}' +
      '.exp-camp-name{font-weight:700;font-size:14px}.exp-camp-row.ahead .exp-camp-name{color:var(--text-mute)}' +
      '.exp-camp-row.done .exp-camp-name,.exp-camp-row.next .exp-camp-name{color:var(--text)}' +
      '.exp-camp-cmp{font-size:12px;color:var(--text-mute);margin-top:1px}.exp-camp-tag{color:var(--trail);font-weight:800}' +
      '.exp-camp-dist{font-size:13px;font-weight:700;color:var(--text-dim)}' +
      '.exp-note{font-size:12.5px;color:var(--text-mute);line-height:1.5;text-align:center;margin:14px 6px}' +
      '.exp-leave{display:block;width:100%;padding:12px;border-radius:12px;background:transparent;border:1px solid var(--border);color:var(--text-dim);font-weight:800;font-size:13px;cursor:pointer}' +
      '.exp-pulse{transform-origin:center;animation:exp-pulse 2.2s ease-out infinite}' +
      '@keyframes exp-pulse{0%{opacity:.7;transform:scale(.85)}70%{opacity:0;transform:scale(1.5)}100%{opacity:0}}' +
      '.exp-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%) translateY(12px);background:var(--text);color:var(--bg);padding:10px 16px;border-radius:99px;font-size:13px;font-weight:800;opacity:0;pointer-events:none;transition:.25s;z-index:50}' +
      '.exp-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}';
    var st = document.createElement('style');
    st.id = 'exp-style'; st.textContent = css;
    document.head.appendChild(st);
  }

  /* ---- opinbert viðmót -------------------------------------------- */
  root.Expedition = {
    VERSION: '1.0',
    mount: function (container, ctx) {
      if (!container || !ctx || !ctx.me || !ctx.adventure) {
        if (container) container.innerHTML = '<p style="color:#9fb4c7;padding:20px">Leiðangur: vantar ctx (me/adventure).</p>';
        return;
      }
      injectStyle();
      container.classList.add('exp-root');
      applyTheme(container, ctx.adventure.theme || {});
      render(container, ctx);
    }
  };
})(typeof window !== 'undefined' ? window : this);
