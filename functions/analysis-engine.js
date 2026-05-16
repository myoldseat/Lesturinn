// ─── analysis-engine.js ───────────────────────────────────
// Pure analysis engine for Firebase Functions (Node.js).
// Zero browser dependencies — operates on Float32Array + sampleRate.
//
// Ported from frontend audio-analysis.js.
// Removed: decodeAudioInput, monoData, analyzeSnippetBlob (browser-only).
// Removed: gradeReading, AGE_THRESHOLDS, GRADE_LABELS (moved to Function 2 / Firestore config).
//
// Seven raw metrics:
//   1. Syllables          (Praat dB-toppar)
//   2. Clean reading %    (Praat inter-peak bil 0.1–0.7s)
//   3. Articulation rate  (atkvæði / taltími)
//   4. Speech rate        (atkvæði / heildartími)
//   5. F1 variation       (LPC formendagreining)
//   6. F2 variation       (LPC formendagreining)
//   7. Formant variation  (samansett sqrt(F1² + F2²))
//
// Public API:
//   analyzeFromPCM(samples, sampleRate, cfg) → { sessionSummary, snippets, rawMetrics }
//   isSnippetUsable(summary)                 → { usable, quality, reason }
// ──────────────────────────────────────────────────────────

// ══════════════════════════════════════════
// MATH HELPERS
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
// Finds F1 and F2 per frame.
// ══════════════════════════════════════════

function estimateFormants(samples, sampleRate, startIdx, frameSize, lpcOrder = 10) {
  const preEmph = new Float32Array(frameSize);
  preEmph[0] = samples[startIdx] || 0;
  for (let i = 1; i < frameSize; i++) {
    const idx = startIdx + i;
    preEmph[i] = (samples[idx] || 0) - 0.97 * (samples[idx - 1] || 0);
  }

  for (let i = 0; i < frameSize; i++) {
    preEmph[i] *= 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (frameSize - 1));
  }

  const r = new Float64Array(lpcOrder + 1);
  for (let lag = 0; lag <= lpcOrder; lag++) {
    let sum = 0;
    for (let i = 0; i < frameSize - lag; i++) {
      sum += preEmph[i] * preEmph[i + lag];
    }
    r[lag] = sum;
  }

  if (r[0] < 1e-12) return null;

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

  const formants = [];
  for (let k = 1; k < nFreqBins - 1; k++) {
    if (magnitudes[k] > magnitudes[k - 1] && magnitudes[k] > magnitudes[k + 1]) {
      const freqHz = (k / nFreqBins) * (sampleRate / 2);
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
      if (len < frameSize * 0.5) continue;

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
// SEGMENTATION
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
// READING METRICS — from Praat inter-peak intervals
// ══════════════════════════════════════════

function computeReadingMetrics(praatPeaks, totalDuration) {
  const peaks = praatPeaks || [];

  if (peaks.length < 2) {
    return {
      syllables: peaks.length,
      cleanReadingRatio: 0,
      disruptionCount: 0,
      intervals: [],
      debug: { cleanTime: 0, totalIntervalTime: 0, cleanIntervals: 0, totalIntervals: 0 }
    };
  }

  const intervals = [];
  for (let i = 1; i < peaks.length; i++) {
    const gap = peaks[i].t - peaks[i - 1].t;
    intervals.push({ gap, from: peaks[i - 1].t, to: peaks[i].t });
  }

  const validIntervals = intervals.filter(x => x.gap >= 0.1);
  const cleanIntervals = validIntervals.filter(x => x.gap <= 0.7);
  const disruptions = validIntervals.filter(x => x.gap > 0.7);

  const cleanTime = cleanIntervals.reduce((sum, x) => sum + x.gap, 0);
  const totalIntervalTime = validIntervals.reduce((sum, x) => sum + x.gap, 0);
  const cleanReadingRatio = totalIntervalTime > 0
    ? Number((cleanTime / totalIntervalTime).toFixed(3))
    : 0;

  return {
    syllables: peaks.length,
    cleanReadingRatio,
    disruptionCount: disruptions.length,
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
// SNIPPET USABILITY GATE
// ══════════════════════════════════════════

function isSnippetUsable(summary) {
  if (summary.speakingTime < 0.5) {
    return { usable: false, quality: null, reason: 'no_speech' };
  }

  if (summary.syllables < 3) {
    return { usable: false, quality: null, reason: 'too_few_syllables' };
  }

  const silenceTime = summary.sessionDuration - summary.speakingTime;
  const silenceRatio = summary.sessionDuration > 0
    ? silenceTime / summary.sessionDuration
    : 1;

  if (silenceRatio > 0.6) {
    return { usable: true, quality: 'low', reason: 'much_silence' };
  }

  return { usable: true, quality: 'ok', reason: null };
}

// ══════════════════════════════════════════
// MAIN ANALYSIS — accepts raw PCM samples
// ══════════════════════════════════════════

const DEFAULT_CFG = {
  snippetDurationSec: 15,
  minSnippets: 1,
  maxSnippets: 1,
  earlyAnchorSec: 5,
  vadQuantile: 70,
  minSpeechRatio: 0.4,
  praatSilenceDb: -25,
  praatMinDipDb: 2,
  praatMinPauseSec: 0.3,
  praatVoicedZcrMax: 0.22
};

function analyzeFromPCM(samples, sampleRate, userCfg) {
  const cfg = { ...DEFAULT_CFG, ...(userCfg || {}) };

  const frames = buildFrames(samples, sampleRate, 20);
  const totalDuration = samples.length / sampleRate;

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

  const formants = computeBurstFormantVariation(samples, sampleRate, mergedBursts);

  const snippets = pickSnippets(totalDuration, frames, speechFlags, cfg);

  const sessionSummary = {
    sessionDuration: Number(totalDuration.toFixed(1)),
    speakingTime: Number(speakingTime.toFixed(1)),

    // Seven metrics
    syllables: reading.syllables,
    cleanReadingPct: Number((reading.cleanReadingRatio * 100).toFixed(1)),
    articulationRate: praatLike.articulationRate,
    speechRate: praatLike.speechRate,
    meanF1Variation: formants.meanF1Variation,
    meanF2Variation: formants.meanF2Variation,
    formantVariation: formants.formantVariation,

    // Supporting
    disruptionCount: reading.disruptionCount,
    phonationTime: praatLike.phonationTime,
  };

  const usability = isSnippetUsable(sessionSummary);

  return {
    sessionSummary,
    usability,
    snippets,
    rawMetrics: {
      config: cfg,
      praatPeaks: praatLike.peaks,
      intervals: reading.intervals,
      debug: reading.debug
    }
  };
}

module.exports = { analyzeFromPCM, isSnippetUsable };
