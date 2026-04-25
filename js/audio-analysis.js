// ─── audio-analysis.js ───────────────────────────────────
// Pure analysis engine — no DOM, no UI, no side effects.
// Accepts File, Blob, or AudioBuffer.
//
// Four metrics: Syllables, Clean reading %, Articulation rate, Speech rate
// Source of truth: Praat inter-peak intervals
//
// Public API:
//   analyzeAudio(input, cfg)        → full analysis result
//   analyzeSnippetBlob(blob, cfg?)  → { usable, quality, reason, summary }
//   isSnippetUsable(summary)        → { usable, quality, reason }
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
// AUDIO DECODE
// ══════════════════════════════════════════

async function decodeAudioInput(input) {
  if (input instanceof AudioBuffer) return input;
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
// THE FOUR METRICS — all from Praat inter-peak intervals
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

  //  < 0.1s  → ignore (measurement artifact)
  //  0.1–0.7s → clean reading (includes normal breath pauses)
  //  > 0.7s  → disruption
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
// MAIN ANALYSIS
// ══════════════════════════════════════════

export async function analyzeAudio(input, cfg) {
  const audioBuffer = await decodeAudioInput(input);
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

  const snippets = pickSnippets(totalDuration, frames, speechFlags, cfg);

  return {
    sessionSummary: {
      sessionDuration: Number(totalDuration.toFixed(1)),
      speakingTime: Number(speakingTime.toFixed(1)),

      // The four metrics
      syllables: reading.syllables,
      cleanReadingPct: Number((reading.cleanReadingRatio * 100).toFixed(1)),
      articulationRate: praatLike.articulationRate,
      speechRate: praatLike.speechRate,

      // Supporting
      disruptionCount: reading.disruptionCount,
      phonationTime: praatLike.phonationTime,
    },
    snippets,
    rawMetrics: {
      config: cfg,
      praatPeaks: praatLike.peaks,
      intervals: reading.intervals,
      debug: reading.debug
    }
  };
}

// ══════════════════════════════════════════
// SNIPPET USABILITY GATE
// ══════════════════════════════════════════

export function isSnippetUsable(summary) {
  const silenceTime = summary.sessionDuration - summary.speakingTime;

  // Regla 1: Of mikil þögn — meira en 1/3 af snippeti
  if (silenceTime > summary.sessionDuration / 3) {
    return { usable: false, quality: null, reason: 'too_much_silence' };
  }

  // Regla 2: Of fá atkvæði
  if (summary.syllables < 3) {
    return { usable: false, quality: null, reason: 'too_few_syllables' };
  }

  // Regla 3: Ekkert tal greinist
  if (summary.speakingTime < 0.5) {
    return { usable: false, quality: null, reason: 'no_speech' };
  }

  // Nothæft
  return { usable: true, quality: 'ok', reason: null };
}

// ══════════════════════════════════════════
// CONVENIENCE: ANALYZE A SINGLE SNIPPET BLOB
// ══════════════════════════════════════════

const DEFAULT_SNIPPET_CFG = {
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

export async function analyzeSnippetBlob(blob, cfg) {
  const mergedCfg = { ...DEFAULT_SNIPPET_CFG, ...(cfg || {}) };

  const result = await analyzeAudio(blob, mergedCfg);
  const usability = isSnippetUsable(result.sessionSummary);

  return {
    usable: usability.usable,
    quality: usability.quality,
    reason: usability.reason,
    summary: result.sessionSummary
  };
}
