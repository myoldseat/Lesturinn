// ─── reading-syllables.js ─────────────────────────────────
// LÉTT framenda-greining: BARA Praat-atkvæði + lestrarflæði,
// yfir ALLA lotuna (ekki 15-sek búta).
//
// Hvað er SLEPPT miðað við audio-analysis.js / bakenda-vélina:
//   • Formantar (F1/F2, LPC)  → dýri hlutinn, þarf ekki fyrir atkvæði
//   • Búta-sýnataka (snippets) → við greinum alla lotuna í einni yfirferð
//   • Einkunnagjöf (grade)     → bakendinn á einkunnirnar áfram
//
// Föllin hér að neðan eru ORÐRÉTT úr upprunalegu audio-analysis.js
// (decode, frames, VAD, segmentun, Praat-toppar, lesmælar) — svo
// atkvæðatalningin er IDENTÍSK þeirri sem bakendinn gerir, sömu þröskuldar.
//
// Public API:
//   analyzeFullSessionSyllables(input, cfg?) → summary (sjá neðst)
//   input: File | Blob | AudioBuffer (sama og analyzeAudio tók við)
// ──────────────────────────────────────────────────────────

// ── MATH HELPERS (úr audio-analysis.js) ──
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}
function quantile(values, q) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = clamp(q, 0, 1) * (sorted.length - 1);
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}
function rmsToDb(rms) { return 20 * Math.log10(Math.max(rms, 1e-8)); }

// ── AUDIO DECODE / MONO (úr audio-analysis.js) ──
async function decodeAudioInput(input) {
  if (typeof AudioBuffer !== 'undefined' && input instanceof AudioBuffer) return input;
  const arrayBuffer = await input.arrayBuffer();
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    return await audioCtx.decodeAudioData(arrayBuffer);
  } finally {
    await audioCtx.close();
  }
}
function monoData(audioBuffer) {
  const channels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;
  const out = new Float32Array(length);
  for (let c = 0; c < channels; c++) {
    const data = audioBuffer.getChannelData(c);
    for (let i = 0; i < length; i++) out[i] += data[i] / channels;
  }
  return out;
}

// ── FRAME BUILDING — 20ms (úr audio-analysis.js) ──
function buildFrames(samples, sampleRate, frameMs = 20) {
  const frameSize = Math.max(1, Math.round(sampleRate * frameMs / 1000));
  const frames = [];
  for (let i = 0; i < samples.length; i += frameSize) {
    const end = Math.min(samples.length, i + frameSize);
    const len = Math.max(1, end - i);
    let sumSq = 0, crossings = 0, prev = samples[i] || 0;
    for (let j = i; j < end; j++) {
      const v = samples[j];
      sumSq += v * v;
      if ((prev >= 0 && v < 0) || (prev < 0 && v >= 0)) crossings++;
      prev = v;
    }
    const rms = Math.sqrt(sumSq / len);
    frames.push({ t: i / sampleRate, duration: len / sampleRate, rms, db: rmsToDb(rms), zcr: crossings / len });
  }
  return frames;
}

// ── VAD (úr audio-analysis.js) ──
function smoothVad(rawFlags, minSpeechFrames = 3, minSilenceFrames = 2) {
  const flags = [...rawFlags];
  let i = 0;
  while (i < flags.length) {
    const value = flags[i];
    let j = i;
    while (j < flags.length && flags[j] === value) j++;
    const len = j - i;
    if (value && len < minSpeechFrames) { for (let k = i; k < j; k++) flags[k] = false; }
    if (!value && len < minSilenceFrames) { for (let k = i; k < j; k++) flags[k] = true; }
    i = j;
  }
  return flags;
}
function buildPermissiveSpeechFlags(frames, vadQuantile) {
  const rmsValues = frames.map(f => f.rms);
  const zcrValues = frames.map(f => f.zcr);
  const rmsThreshold = percentile(rmsValues, vadQuantile);
  const zcrMedian = median(zcrValues);
  const speechRmsValues = rmsValues.filter(v => v > rmsThreshold * 0.7);
  const speechRmsMedian = median(speechRmsValues.length ? speechRmsValues : rmsValues);
  let rawFlags = frames.map(f => {
    const strongEnergy = f.rms > rmsThreshold * 0.78;
    const moderateEnergy = f.rms > speechRmsMedian * 0.55;
    const acceptableZcr = f.zcr < zcrMedian * 3.8 + 0.035;
    return (strongEnergy || moderateEnergy) && acceptableZcr;
  });
  rawFlags = smoothVad(rawFlags, 3, 2);
  return { rawFlags, rmsThreshold, zcrMedian, speechRmsMedian };
}

// ── SEGMENTATION (úr audio-analysis.js) ──
function segmentFrames(frames, speechFlags) {
  const bursts = [], pauses = [];
  let i = 0;
  while (i < frames.length) {
    const isSpeech = speechFlags[i];
    let j = i;
    while (j < frames.length && speechFlags[j] === isSpeech) j++;
    const start = frames[i].t;
    const end = frames[j - 1].t + frames[j - 1].duration;
    const duration = end - start;
    if (isSpeech) bursts.push({ start, end, duration });
    else pauses.push({ start, end, duration });
    i = j;
  }
  return { bursts, pauses };
}
function mergeCloseBursts(bursts, maxGap = 0.24) {
  if (!bursts.length) return [];
  const merged = [{ ...bursts[0] }];
  for (let i = 1; i < bursts.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = bursts[i];
    const gap = curr.start - prev.end;
    if (gap <= maxGap) { prev.end = curr.end; prev.duration = prev.end - prev.start; }
    else merged.push({ ...curr });
  }
  return merged;
}

// ── PRAAT-STYLE SYLLABLE DETECTION (úr audio-analysis.js) ──
function estimatePraatStyleMetrics(frames, speechFlags, cfg) {
  const speechFrames = frames.filter((_, idx) => speechFlags[idx]);
  if (!speechFrames.length) {
    return { nSyllables: 0, speechRate: 0, articulationRate: 0, phonationTime: 0, peaks: [] };
  }
  const dbValues = speechFrames.map(f => f.db);
  const max99 = quantile(dbValues, 0.99);
  const minDb = Math.min(...dbValues);
  let thresholdDb = max99 + (cfg.praatSilenceDb ?? -25);
  if (thresholdDb < minDb) thresholdDb = minDb;

  const candidatePeaks = [];
  for (let i = 1; i < frames.length - 1; i++) {
    if (!speechFlags[i]) continue;
    const current = frames[i], prev = frames[i - 1], next = frames[i + 1];
    const localPeak = current.db > prev.db && current.db >= next.db;
    const voicedish = current.zcr <= (cfg.praatVoicedZcrMax ?? 0.22);
    if (localPeak && current.db > thresholdDb && voicedish) {
      candidatePeaks.push({ index: i, t: current.t, db: current.db });
    }
  }

  const validPeaks = [];
  let previousPeak = null;
  for (const peak of candidatePeaks) {
    if (!previousPeak) { previousPeak = peak; continue; }
    let minDip = Infinity;
    for (let j = previousPeak.index; j <= peak.index; j++) minDip = Math.min(minDip, frames[j].db);
    const dipAmount = previousPeak.db - minDip;
    if (dipAmount > (cfg.praatMinDipDb ?? 2)) validPeaks.push(previousPeak);
    previousPeak = peak;
  }
  if (previousPeak) validPeaks.push(previousPeak);

  const phonationTime = speechFrames.reduce((sum, f) => sum + f.duration, 0);
  const totalDuration = frames.length ? frames[frames.length - 1].t + frames[frames.length - 1].duration : 0;
  const nSyllables = validPeaks.length;

  return {
    nSyllables,
    speechRate: Number((nSyllables / Math.max(totalDuration, 1e-6)).toFixed(2)),
    articulationRate: Number((nSyllables / Math.max(phonationTime, 1e-6)).toFixed(2)),
    phonationTime: Number(phonationTime.toFixed(2)),
    peaks: validPeaks.map(p => ({ t: Number(p.t.toFixed(3)), db: Number(p.db.toFixed(2)) }))
  };
}

// ── READING METRICS — inter-peak bil (úr audio-analysis.js) ──
function computeReadingMetrics(praatPeaks, totalDuration) {
  const peaks = praatPeaks || [];
  if (peaks.length < 2) {
    return { syllables: peaks.length, cleanReadingRatio: 0, disruptionCount: 0,
      debug: { cleanTime: 0, totalIntervalTime: 0, cleanIntervals: 0, totalIntervals: 0 } };
  }
  const intervals = [];
  for (let i = 1; i < peaks.length; i++) {
    intervals.push({ gap: peaks[i].t - peaks[i - 1].t });
  }
  const validIntervals = intervals.filter(x => x.gap >= 0.1);
  const cleanIntervals = validIntervals.filter(x => x.gap <= 0.7);
  const disruptions = validIntervals.filter(x => x.gap > 0.7);
  const cleanTime = cleanIntervals.reduce((sum, x) => sum + x.gap, 0);
  const totalIntervalTime = validIntervals.reduce((sum, x) => sum + x.gap, 0);
  const cleanReadingRatio = totalIntervalTime > 0 ? Number((cleanTime / totalIntervalTime).toFixed(3)) : 0;
  return {
    syllables: peaks.length,
    cleanReadingRatio,
    disruptionCount: disruptions.length,
    debug: {
      cleanTime: Number(cleanTime.toFixed(2)),
      totalIntervalTime: Number(totalIntervalTime.toFixed(2)),
      cleanIntervals: cleanIntervals.length,
      totalIntervals: validIntervals.length
    }
  };
}

// ── CONFIG — sömu þröskuldar og bakendinn ──
const DEFAULT_CFG = {
  vadQuantile: 70,
  praatSilenceDb: -25,
  praatMinDipDb: 2,
  praatMinPauseSec: 0.3,
  praatVoicedZcrMax: 0.22
};
const SYLLABLES_PER_WORD = 1.95; // sama og wpmCalculator_v1 í lotu-skjalinu

// ══════════════════════════════════════════
// AÐAL: full-lotu atkvæðagreining (engir formantar, engin búta-sýnataka)
// ══════════════════════════════════════════
export async function analyzeFullSessionSyllables(input, cfg) {
  const mergedCfg = { ...DEFAULT_CFG, ...(cfg || {}) };

  const audioBuffer = await decodeAudioInput(input);
  const samples = monoData(audioBuffer);
  const frames = buildFrames(samples, audioBuffer.sampleRate, 20);
  const totalDuration = audioBuffer.duration;

  // Sama VAD-flæði og analyzeAudio: VAD → segment → merge → endurbyggja flags
  const { rawFlags } = buildPermissiveSpeechFlags(frames, mergedCfg.vadQuantile);
  const segmentation = segmentFrames(frames, rawFlags);
  const mergedBursts = mergeCloseBursts(segmentation.bursts, 0.24);
  const speechFlags = frames.map(frame => {
    const fStart = frame.t, fEnd = fStart + frame.duration;
    return mergedBursts.some(b => fEnd > b.start && fStart < b.end);
  });
  const speakingTime = mergedBursts.reduce((sum, b) => sum + b.duration, 0);

  const praatLike = estimatePraatStyleMetrics(frames, speechFlags, mergedCfg);
  const reading = computeReadingMetrics(praatLike.peaks, totalDuration);

  // ── WPM úr atkvæðum (sama 1.95 atkvæði/orð og audioWpmEstimate) ──
  const syllables = reading.syllables;
  const words = syllables / SYLLABLES_PER_WORD;
  const minutes = totalDuration / 60;
  const activeMinutes = praatLike.phonationTime / 60;
  // wpmFull  = pace yfir ALLA lotuna (þagnir taldar með) — heiðarleg heildar-tala
  // wpmActive = hraði MEÐAN lesið er (taltími einn) — sambærilegt búta-wpm bakendans
  const wpmFull = minutes > 0 ? Math.round(words / minutes) : 0;
  const wpmActive = activeMinutes > 0 ? Math.round(words / activeMinutes) : 0;

  return {
    source: 'client',
    fullSession: true,
    version: 'clientSyll_v1',
    config: mergedCfg,

    sessionDuration: Number(totalDuration.toFixed(1)),
    speakingTime: Number(speakingTime.toFixed(1)),
    phonationTime: praatLike.phonationTime,

    syllables,
    words: Number(words.toFixed(1)),
    wpmFull,
    wpmActive,

    cleanReadingPct: Number((reading.cleanReadingRatio * 100).toFixed(1)),
    disruptionCount: reading.disruptionCount,
    articulationRate: praatLike.articulationRate,
    speechRate: praatLike.speechRate,

    debug: reading.debug,
    analyzedAt: new Date().toISOString()
    // ATH: peaks/intervals eru EKKI skilað — yfir 10 mín geta þau verið
    // þúsundir og eiga ekki að fara í Firestore. Bæti við ef þú vilt lifandi mæli.
  };
}
