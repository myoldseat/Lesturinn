// ══════════════════════════════════════════
// Reading fluency analyzer — clean version
// Four metrics only: Syllables, Clean reading %, Disruptions, Pace steadiness
// Source of truth: Praat inter-peak intervals
// ══════════════════════════════════════════

const audioFileInput = document.getElementById('audioFile');
const analyzeBtn = document.getElementById('analyzeBtn');
const clearBtn = document.getElementById('clearBtn');
const audioPlayer = document.getElementById('audioPlayer');
const jsonOutput = document.getElementById('jsonOutput');
const summaryCards = document.getElementById('summaryCards');
const snippetButtons = document.getElementById('snippetButtons');
const snippetTableWrap = document.getElementById('snippetTableWrap');
const statusEl = document.getElementById('status');

let selectedFile = null;
let currentResult = null;
let stopPlaybackTimer = null;
let currentObjectUrl = null;

// ══════════════════════════════════════════
// UI HELPERS
// ══════════════════════════════════════════

function setStatus(message, kind = 'idle') {
  statusEl.textContent = message;
  statusEl.className = `status ${kind}`;
}

function clearOutput() {
  currentResult = null;
  if (stopPlaybackTimer) { clearInterval(stopPlaybackTimer); stopPlaybackTimer = null; }
  audioPlayer.removeAttribute('src');
  audioPlayer.load();
  summaryCards.className = 'cards empty-state';
  summaryCards.innerHTML = 'No analysis yet.';
  snippetButtons.innerHTML = '';
  snippetTableWrap.className = 'empty-state';
  snippetTableWrap.innerHTML = 'No snippets yet.';
  jsonOutput.textContent = '{}';
  setStatus('Choose an audio file to begin.', 'idle');
}

function fmtSeconds(sec) {
  return `${sec.toFixed(1)}s`;
}

// ══════════════════════════════════════════
// MATH UTILITIES
// ══════════════════════════════════════════

function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function variance(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return mean(arr.map(v => (v - m) ** 2));
}

function stddev(arr) {
  return Math.sqrt(variance(arr));
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

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

function rmsToDb(rms) {
  return 20 * Math.log10(Math.max(rms, 1e-8));
}

// ══════════════════════════════════════════
// AUDIO DECODE
// ══════════════════════════════════════════

async function decodeAudio(file) {
  const arrayBuffer = await file.arrayBuffer();
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

// ══════════════════════════════════════════
// FRAME BUILDING (20ms frames)
// ══════════════════════════════════════════

function buildFrames(samples, sampleRate, frameMs = 20) {
  const frameSize = Math.max(1, Math.round(sampleRate * frameMs / 1000));
  const frames = [];

  for (let i = 0; i < samples.length; i += frameSize) {
    const end = Math.min(samples.length, i + frameSize);
    const len = Math.max(1, end - i);

    let sumSq = 0;
    let crossings = 0;
    let prev = samples[i] || 0;

    for (let j = i; j < end; j++) {
      const v = samples[j];
      sumSq += v * v;
      if ((prev >= 0 && v < 0) || (prev < 0 && v >= 0)) crossings++;
      prev = v;
    }

    const rms = Math.sqrt(sumSq / len);

    frames.push({
      t: i / sampleRate,
      duration: len / sampleRate,
      rms,
      db: rmsToDb(rms),
      zcr: crossings / len
    });
  }

  return frames;
}

// ══════════════════════════════════════════
// LPC FORMANT ESTIMATION
// Based on Levinson-Durbin autocorrelation method.
// Finds F1 and F2 per frame — the two formants that define
// which vowel is being produced (ref: Ásta Svavarsdóttir et al. 1982).
// ══════════════════════════════════════════

function estimateFormants(samples, sampleRate, startIdx, frameSize, lpcOrder = 10) {
  // Pre-emphasis to boost high frequencies
  const preEmph = new Float32Array(frameSize);
  preEmph[0] = samples[startIdx] || 0;
  for (let i = 1; i < frameSize; i++) {
    const idx = startIdx + i;
    preEmph[i] = (samples[idx] || 0) - 0.97 * (samples[idx - 1] || 0);
  }

  // Hamming window
  for (let i = 0; i < frameSize; i++) {
    preEmph[i] *= 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (frameSize - 1));
  }

  // Autocorrelation
  const r = new Float64Array(lpcOrder + 1);
  for (let lag = 0; lag <= lpcOrder; lag++) {
    let sum = 0;
    for (let i = 0; i < frameSize - lag; i++) {
      sum += preEmph[i] * preEmph[i + lag];
    }
    r[lag] = sum;
  }

  if (r[0] < 1e-12) return null; // silence

  // Levinson-Durbin recursion
  const a = new Float64Array(lpcOrder + 1);
  const aTemp = new Float64Array(lpcOrder + 1);
  a[0] = 1;
  let err = r[0];

  for (let i = 1; i <= lpcOrder; i++) {
    let lambda = 0;
    for (let j = 1; j < i; j++) {
      lambda += a[j] * r[i - j];
    }
    lambda = -(r[i] + lambda) / err;

    for (let j = 1; j < i; j++) {
      aTemp[j] = a[j] + lambda * a[i - j];
    }
    aTemp[i] = lambda;
    for (let j = 1; j <= i; j++) {
      a[j] = aTemp[j];
    }

    err *= (1 - lambda * lambda);
    if (err <= 0) return null;
  }

  // Find roots of LPC polynomial using companion matrix eigenvalues
  // Simplified: evaluate frequency response and find peaks
  const nFreqBins = 256;
  const magnitudes = new Float64Array(nFreqBins);

  for (let k = 0; k < nFreqBins; k++) {
    const freq = (k / nFreqBins) * (sampleRate / 2);
    const omega = 2 * Math.PI * freq / sampleRate;
    let realPart = 1;
    let imagPart = 0;
    for (let j = 1; j <= lpcOrder; j++) {
      realPart += a[j] * Math.cos(-j * omega);
      imagPart += a[j] * Math.sin(-j * omega);
    }
    const mag = 1.0 / Math.sqrt(realPart * realPart + imagPart * imagPart);
    magnitudes[k] = mag;
  }

  // Find peaks in frequency response → formants
  const formants = [];
  for (let k = 1; k < nFreqBins - 1; k++) {
    if (magnitudes[k] > magnitudes[k - 1] && magnitudes[k] > magnitudes[k + 1]) {
      const freqHz = (k / nFreqBins) * (sampleRate / 2);
      // Only keep formants in speech range (200–5500 Hz)
      if (freqHz >= 200 && freqHz <= 5500) {
        formants.push(freqHz);
      }
    }
  }

  formants.sort((a, b) => a - b);

  return {
    f1: formants[0] || 0,
    f2: formants[1] || 0
  };
}

// ══════════════════════════════════════════
// BURST FORMANT VARIATION
// Measures how much F1/F2 change within each burst.
// Real reading: F1/F2 jump between vowels → high variation (hundreds of Hz)
// Elongated sound: F1/F2 stay constant → low variation (~30-60 Hz)
// Ref: Ásta Svavarsdóttir et al. (1982) — within-vowel SD ~30-60 Hz,
//      between-vowel differences ~200-400 Hz
// ══════════════════════════════════════════

function computeBurstFormantVariation(samples, sampleRate, bursts, frameMs = 20) {
  if (!bursts.length) return { meanF1Variation: 0, meanF2Variation: 0, formantVariation: 0 };

  const frameSize = Math.max(1, Math.round(sampleRate * frameMs / 1000));
  const burstF1Vars = [];
  const burstF2Vars = [];

  for (const burst of bursts) {
    const startSample = Math.floor(burst.start * sampleRate);
    const endSample = Math.floor(burst.end * sampleRate);

    const f1Values = [];
    const f2Values = [];

    for (let i = startSample; i < endSample; i += frameSize) {
      const len = Math.min(frameSize, endSample - i);
      if (len < frameSize * 0.5) continue; // skip partial frames

      const result = estimateFormants(samples, sampleRate, i, len);
      if (result && result.f1 > 0 && result.f2 > 0) {
        f1Values.push(result.f1);
        f2Values.push(result.f2);
      }
    }

    if (f1Values.length >= 2) {
      burstF1Vars.push(stddev(f1Values));
      burstF2Vars.push(stddev(f2Values));
    }
  }

  if (!burstF1Vars.length) return { meanF1Variation: 0, meanF2Variation: 0, formantVariation: 0 };

  const meanF1Var = mean(burstF1Vars);
  const meanF2Var = mean(burstF2Vars);

  // Combined: Euclidean distance in F1/F2 space
  const formantVariation = Math.sqrt(meanF1Var * meanF1Var + meanF2Var * meanF2Var);

  return {
    meanF1Variation: Number(meanF1Var.toFixed(1)),
    meanF2Variation: Number(meanF2Var.toFixed(1)),
    formantVariation: Number(formantVariation.toFixed(1))
  };
}

// ══════════════════════════════════════════
// VAD (Voice Activity Detection)
// ══════════════════════════════════════════

function smoothVad(rawFlags, minSpeechFrames = 3, minSilenceFrames = 2) {
  const flags = [...rawFlags];
  let i = 0;
  while (i < flags.length) {
    const value = flags[i];
    let j = i;
    while (j < flags.length && flags[j] === value) j++;
    const len = j - i;
    if (value && len < minSpeechFrames) {
      for (let k = i; k < j; k++) flags[k] = false;
    }
    if (!value && len < minSilenceFrames) {
      for (let k = i; k < j; k++) flags[k] = true;
    }
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

// ══════════════════════════════════════════
// SEGMENTATION (needed for VAD → Praat pipeline)
// ══════════════════════════════════════════

function segmentFrames(frames, speechFlags) {
  const bursts = [];
  const pauses = [];
  let i = 0;

  while (i < frames.length) {
    const isSpeech = speechFlags[i];
    let j = i;
    while (j < frames.length && speechFlags[j] === isSpeech) j++;

    const start = frames[i].t;
    const end = frames[j - 1].t + frames[j - 1].duration;
    const duration = end - start;

    if (isSpeech) {
      bursts.push({ start, end, duration });
    } else {
      pauses.push({ start, end, duration });
    }
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

    if (gap <= maxGap) {
      prev.end = curr.end;
      prev.duration = prev.end - prev.start;
    } else {
      merged.push({ ...curr });
    }
  }

  return merged;
}

// ══════════════════════════════════════════
// PRAAT-STYLE SYLLABLE DETECTION
// ══════════════════════════════════════════

function estimatePraatStyleMetrics(frames, speechFlags, cfg) {
  const speechFrames = frames.filter((_, idx) => speechFlags[idx]);

  if (!speechFrames.length) {
    return {
      nSyllables: 0,
      speechRate: 0,
      articulationRate: 0,
      phonationTime: 0,
      peaks: []
    };
  }

  const dbValues = speechFrames.map(f => f.db);
  const max99 = quantile(dbValues, 0.99);
  const minDb = Math.min(...dbValues);

  let thresholdDb = max99 + (cfg.praatSilenceDb ?? -25);
  if (thresholdDb < minDb) thresholdDb = minDb;

  const candidatePeaks = [];
  for (let i = 1; i < frames.length - 1; i++) {
    if (!speechFlags[i]) continue;
    const current = frames[i];
    const prev = frames[i - 1];
    const next = frames[i + 1];
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
    for (let j = previousPeak.index; j <= peak.index; j++) {
      minDip = Math.min(minDip, frames[j].db);
    }

    const dipAmount = previousPeak.db - minDip;
    if (dipAmount > (cfg.praatMinDipDb ?? 2)) {
      validPeaks.push(previousPeak);
    }
    previousPeak = peak;
  }
  if (previousPeak) validPeaks.push(previousPeak);

  const phonationTime = speechFrames.reduce((sum, f) => sum + f.duration, 0);
  const totalDuration = frames.length
    ? frames[frames.length - 1].t + frames[frames.length - 1].duration
    : 0;

  const nSyllables = validPeaks.length;

  return {
    nSyllables,
    speechRate: Number((nSyllables / Math.max(totalDuration, 1e-6)).toFixed(2)),
    articulationRate: Number((nSyllables / Math.max(phonationTime, 1e-6)).toFixed(2)),
    phonationTime: Number(phonationTime.toFixed(2)),
    peaks: validPeaks.map(p => ({ t: Number(p.t.toFixed(3)), db: Number(p.db.toFixed(2)) }))
  };
}

// ══════════════════════════════════════════
// THE FOUR METRICS — all from Praat inter-peak intervals
// ══════════════════════════════════════════

function computeReadingMetrics(praatPeaks, totalDuration) {
  const peaks = praatPeaks || [];

  if (peaks.length < 2) {
    return {
      syllables: peaks.length,
      cleanReadingRatio: 0,
      disruptionCount: 0,
      paceSteadiness: 0,
      intervals: [],
      debug: { cleanTime: 0, totalIntervalTime: 0, cleanIntervals: 0, totalIntervals: 0 }
    };
  }

  // All inter-peak intervals
  const intervals = [];
  for (let i = 1; i < peaks.length; i++) {
    const gap = peaks[i].t - peaks[i - 1].t;
    intervals.push({ gap, from: peaks[i - 1].t, to: peaks[i].t });
  }

  // Classify:
  //  < 0.1s  → ignore (measurement artifact)
  //  0.1–0.7s → clean reading (includes normal breath pauses)
  //  > 0.7s  → disruption
  const validIntervals = intervals.filter(x => x.gap >= 0.1);
  const cleanIntervals = validIntervals.filter(x => x.gap <= 0.7);
  const disruptions = validIntervals.filter(x => x.gap > 0.7);

  // Clean reading ratio (time-based)
  const cleanTime = cleanIntervals.reduce((sum, x) => sum + x.gap, 0);
  const totalIntervalTime = validIntervals.reduce((sum, x) => sum + x.gap, 0);
  const cleanReadingRatio = totalIntervalTime > 0
    ? Number((cleanTime / totalIntervalTime).toFixed(3))
    : 0;

  // Pace steadiness (inverse CV on clean intervals → 0–100)
  let paceSteadiness = 0;
  if (cleanIntervals.length >= 2) {
    const cleanGaps = cleanIntervals.map(x => x.gap);
    const m = mean(cleanGaps);
    const s = stddev(cleanGaps);
    const cvVal = m > 0 ? s / m : 0;
    paceSteadiness = Number(clamp((1 - cvVal) * 100, 0, 100).toFixed(1));
  }

  return {
    syllables: peaks.length,
    cleanReadingRatio,
    disruptionCount: disruptions.length,
    paceSteadiness,
    intervals: validIntervals.map(x => ({
      gap: Number(x.gap.toFixed(3)),
      from: Number(x.from.toFixed(3)),
      to: Number(x.to.toFixed(3)),
      kind: x.gap <= 0.7 ? 'clean' : 'disruption'
    })),
    debug: {
      cleanTime: Number(cleanTime.toFixed(2)),
      totalIntervalTime: Number(totalIntervalTime.toFixed(2)),
      cleanIntervals: cleanIntervals.length,
      totalIntervals: validIntervals.length
    }
  };
}

// ══════════════════════════════════════════
// SNIPPET PICKER
// ══════════════════════════════════════════

function speechRatioInWindow(frames, speechFlags, start, end) {
  let speech = 0;
  let total = 0;
  for (let i = 0; i < frames.length; i++) {
    const fStart = frames[i].t;
    const fEnd = fStart + frames[i].duration;
    if (fEnd <= start || fStart >= end) continue;
    const overlap = Math.min(fEnd, end) - Math.max(fStart, start);
    total += overlap;
    if (speechFlags[i]) speech += overlap;
  }
  return total > 0 ? speech / total : 0;
}

function pickSnippets(totalDuration, frames, speechFlags, cfg) {
  const candidates = [];
  const duration = cfg.snippetDurationSec;
  const latestStart = Math.max(0, totalDuration - duration);

  for (let t = 0; t <= latestStart; t += 1) {
    const ratio = speechRatioInWindow(frames, speechFlags, t, t + duration);
    const center = (t + duration / 2) / Math.max(1, totalDuration);
    candidates.push({ start: t, end: t + duration, speechRatio: ratio, center });
  }

  const targets = [];
  const earlyAnchorCenter = clamp(
    (cfg.earlyAnchorSec + duration / 2) / Math.max(1, totalDuration), 0, 1
  );
  targets.push(earlyAnchorCenter);
  if (cfg.maxSnippets >= 2) targets.push(0.35);
  if (cfg.maxSnippets >= 3) targets.push(0.65);
  if (cfg.maxSnippets >= 4) targets.push(0.9);

  const chosen = [];
  const usedStarts = new Set();

  for (const target of targets) {
    const viable = candidates
      .filter(c => c.speechRatio >= cfg.minSpeechRatio)
      .map(c => ({
        ...c,
        score: (1 - Math.abs(c.center - target)) * 0.50 + c.speechRatio * 0.50
      }))
      .sort((a, b) => b.score - a.score);

    const best = viable.find(v => {
      const rounded = Math.round(v.start);
      if (usedStarts.has(rounded)) return false;
      for (const existing of chosen) {
        if (Math.abs(existing.start - v.start) < duration * 0.7) return false;
      }
      return true;
    });

    if (best) {
      usedStarts.add(Math.round(best.start));
      chosen.push(best);
    }
  }

  if (!chosen.length && candidates.length) {
    chosen.push(candidates.sort((a, b) => b.speechRatio - a.speechRatio)[0]);
  }

  return chosen.map((c, idx) => ({
    index: idx + 1,
    start: Number(c.start.toFixed(1)),
    end: Number(c.end.toFixed(1)),
    speechRatio: Number(c.speechRatio.toFixed(3)),
    positionPercent: Number((c.center * 100).toFixed(1)),
    selectionScore: Number((c.score || 0).toFixed(3))
  }));
}

// ══════════════════════════════════════════
// READING LEVEL GRADING
// Grunnur: articulation rate á móti aldursviðmiðum
// Hækkað um eitt ef clean reading % er hátt
// Lækkað um eitt ef syllables eru of fá
// Viðmið eru stillanleg per fæðingarár
// ══════════════════════════════════════════

// Grading thresholds — F1 variation as primary, syllables and cleanReading as gates
// Lower levels: ONE bad value is enough to hold back (OR logic)
// Upper levels: ALL must be good (AND logic)
const GRADE_THRESHOLDS = {
  // [Á réttri leið, Á réttum stað, Góð tök, Mjög góð tök]
  f1Var:        [150, 300, 450, 600],
  syllables:    [25,  40,  50,  60],
  cleanReading: [0,   50,  60,  65]
};

const GRADE_LABELS = [
  'Að ná tökum',
  'Á réttri leið',
  'Á réttum stað',
  'Góð tök',
  'Mjög góð tök'
];

function gradeReading(summary, birthYear) {
  const T = GRADE_THRESHOLDS;
  const f1 = summary.meanF1Variation || 0;
  const syl = summary.syllables || 0;
  const clean = summary.cleanReadingPct || 0;

  let level = 0;

  if (f1 >= T.f1Var[3] && syl >= T.syllables[3] && clean >= T.cleanReading[3]) {
    level = 4;
  }
  else if (f1 >= T.f1Var[2] && syl >= T.syllables[2] && clean >= T.cleanReading[2]) {
    level = 3;
  }
  else if (f1 >= T.f1Var[1] && syl >= T.syllables[1] && clean >= T.cleanReading[1]) {
    level = 2;
  }
  else if (f1 >= T.f1Var[0] || syl >= T.syllables[0]) {
    level = 1;
  }
  else {
    level = 0;
  }

  return {
    level,
    label: GRADE_LABELS[level],
    thresholdsUsed: T,
    birthYear: birthYear || 'default'
  };
}

// ══════════════════════════════════════════
// MAIN ANALYSIS
// ══════════════════════════════════════════

async function analyzeAudio(file, cfg) {
  const audioBuffer = await decodeAudio(file);
  const samples = monoData(audioBuffer);
  const frames = buildFrames(samples, audioBuffer.sampleRate, 20);
  const totalDuration = audioBuffer.duration;

  const { rawFlags } = buildPermissiveSpeechFlags(frames, cfg.vadQuantile);

  const segmentation = segmentFrames(frames, rawFlags);
  const mergedBursts = mergeCloseBursts(segmentation.bursts, 0.24);

  const speechFlags = frames.map(frame => {
    const fStart = frame.t;
    const fEnd = fStart + frame.duration;
    return mergedBursts.some(b => fEnd > b.start && fStart < b.end);
  });

  const speakingTime = mergedBursts.reduce((sum, b) => sum + b.duration, 0);

  const praatLike = estimatePraatStyleMetrics(frames, speechFlags, cfg);

  const reading = computeReadingMetrics(praatLike.peaks, totalDuration);

  // Formant variation — how much F1/F2 change within bursts
  const formants = computeBurstFormantVariation(samples, audioBuffer.sampleRate, mergedBursts);

  const snippets = pickSnippets(totalDuration, frames, speechFlags, cfg);

  const summaryData = {
    sessionDuration: Number(totalDuration.toFixed(1)),
    speakingTime: Number(speakingTime.toFixed(1)),

    syllables: reading.syllables,
    cleanReadingPct: Number((reading.cleanReadingRatio * 100).toFixed(1)),
    articulationRate: praatLike.articulationRate,
    speechRate: praatLike.speechRate,

    disruptionCount: reading.disruptionCount,
    phonationTime: praatLike.phonationTime,

    // Formant variation — high = diverse vowels (real reading), low = elongated sound
    formantVariation: formants.formantVariation,
    meanF1Variation: formants.meanF1Variation,
    meanF2Variation: formants.meanF2Variation,
  };

  // Grade — birthYear kemur úr cfg ef til staðar
  const grade = gradeReading(summaryData, cfg.birthYear || null);
  summaryData.grade = grade.label;
  summaryData.gradeLevel = grade.level;

  return {
    sessionSummary: summaryData,
    snippets,
    rawMetrics: {
      config: cfg,
      praatPeaks: praatLike.peaks,
      intervals: reading.intervals,
      debug: reading.debug,
      gradeDetails: grade
    }
  };
}

// ══════════════════════════════════════════
// RENDER
// ══════════════════════════════════════════

function renderSummary(summary) {
  const items = [
    ['Einkunn', summary.grade || '—'],
    ['Session', fmtSeconds(summary.sessionDuration)],
    ['Speaking', fmtSeconds(summary.speakingTime)],
    ['Syllables', String(summary.syllables)],
    ['Clean reading', `${summary.cleanReadingPct}%`],
    ['Articulation rate', String(summary.articulationRate)],
    ['Speech rate', String(summary.speechRate)],
    ['Formant variation', String(summary.formantVariation)],
    ['F1 variation', String(summary.meanF1Variation)],
    ['F2 variation', String(summary.meanF2Variation)],
  ];

  summaryCards.className = 'cards';
  summaryCards.innerHTML = items.map(([label, value]) => `
    <div class="card">
      <div class="label">${label}</div>
      <div class="value">${value}</div>
    </div>
  `).join('');
}

function renderSnippets(snippets) {
  if (!snippets.length) {
    snippetTableWrap.className = 'empty-state';
    snippetTableWrap.innerHTML = 'No snippets selected.';
    snippetButtons.innerHTML = '';
    return;
  }

  snippetTableWrap.className = '';
  snippetTableWrap.innerHTML = `
    <table class="table">
      <thead>
        <tr><th>#</th><th>Start</th><th>End</th><th>Speech ratio</th></tr>
      </thead>
      <tbody>
        ${snippets.map(s => `
          <tr>
            <td>${s.index}</td>
            <td>${fmtSeconds(s.start)}</td>
            <td>${fmtSeconds(s.end)}</td>
            <td>${(s.speechRatio * 100).toFixed(0)}%</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;

  snippetButtons.innerHTML = snippets.map(s =>
    `<button data-start="${s.start}" data-end="${s.end}">Play snippet ${s.index}</button>`
  ).join('');

  [...snippetButtons.querySelectorAll('button')].forEach(btn => {
    btn.addEventListener('click', () => {
      playSegment(Number(btn.dataset.start), Number(btn.dataset.end));
    });
  });
}

function playSegment(start, end) {
  if (!audioPlayer.src) return;
  audioPlayer.currentTime = start;
  audioPlayer.play();
  if (stopPlaybackTimer) clearInterval(stopPlaybackTimer);
  stopPlaybackTimer = setInterval(() => {
    if (audioPlayer.currentTime >= end || audioPlayer.paused) {
      audioPlayer.pause();
      clearInterval(stopPlaybackTimer);
      stopPlaybackTimer = null;
    }
  }, 60);
}

// ══════════════════════════════════════════
// EVENT LISTENERS
// ══════════════════════════════════════════

audioFileInput.addEventListener('change', () => {
  const file = audioFileInput.files?.[0] || null;
  if (currentObjectUrl) { URL.revokeObjectURL(currentObjectUrl); currentObjectUrl = null; }
  selectedFile = file;
  analyzeBtn.disabled = !selectedFile;
  if (selectedFile) {
    currentObjectUrl = URL.createObjectURL(selectedFile);
    audioPlayer.src = currentObjectUrl;
    setStatus(`Loaded: ${selectedFile.name}`, 'ok');
  } else {
    clearOutput();
  }
});

analyzeBtn.addEventListener('click', async () => {
  if (!selectedFile) return;

  const cfg = {
    snippetDurationSec: Number(document.getElementById('snippetDuration').value || 15),
    minSnippets: Number(document.getElementById('minSnippets').value || 1),
    maxSnippets: Number(document.getElementById('maxSnippets').value || 1),
    earlyAnchorSec: Number(document.getElementById('earlyAnchor').value || 5),
    vadQuantile: Number(document.getElementById('vadQuantile').value || 70),
    minSpeechRatio: Number(document.getElementById('minSpeechRatio').value || 0.4),
    praatSilenceDb: -25,
    praatMinDipDb: 2,
    praatMinPauseSec: 0.3,
    praatVoicedZcrMax: 0.22
  };

  try {
    if (selectedFile.size > 50 * 1024 * 1024) {
      throw new Error('File is too large. Try a file under 50 MB.');
    }
    setStatus('Analyzing…', 'busy');
    analyzeBtn.disabled = true;

    currentResult = await analyzeAudio(selectedFile, cfg);
    renderSummary(currentResult.sessionSummary);
    renderSnippets(currentResult.snippets);
    jsonOutput.textContent = JSON.stringify(currentResult, null, 2);

    setStatus('Analysis complete.', 'ok');
  } catch (error) {
    console.error(error);
    setStatus(`Analysis failed: ${error.message}`, 'error');
  } finally {
    analyzeBtn.disabled = false;
  }
});

clearBtn.addEventListener('click', () => {
  audioFileInput.value = '';
  selectedFile = null;
  analyzeBtn.disabled = true;
  if (currentObjectUrl) { URL.revokeObjectURL(currentObjectUrl); currentObjectUrl = null; }
  clearOutput();
});

clearOutput();
