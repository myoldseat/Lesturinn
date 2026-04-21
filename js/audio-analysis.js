// ─── audio-analysis.js ───────────────────────────────────
// Pure analysis engine — no DOM, no UI, no side effects.
// Accepts File, Blob, or AudioBuffer.
//
// Public API:
//   analyzeAudio(input, cfg)        → full analysis result
//   analyzeSnippetBlob(blob, cfg?)  → { usable, quality, reason, summary }
//   isSnippetUsable(summary)        → { usable, quality, reason }
// ──────────────────────────────────────────────────────────

const BENCHMARK_RAW_SCORE = 93.2;

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

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((p / 100) * (sorted.length - 1)))
  );
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

function topPercentMean(arr, pct = 0.25) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => b - a);
  const n = Math.max(1, Math.ceil(s.length * pct));
  return mean(s.slice(0, n));
}

function cv(arr) {
  const m = mean(arr);
  if (!arr.length || m <= 0) return 0;
  return stddev(arr) / m;
}

function scaleHigherBetter(value, low, high) {
  return clamp(((value - low) / (high - low)) * 100, 0, 100);
}

function scaleLowerBetter(value, low, high) {
  return clamp(((high - value) / (high - low)) * 100, 0, 100);
}

function normalizeToBenchmark(rawScore, benchmarkScore = BENCHMARK_RAW_SCORE) {
  if (!benchmarkScore || benchmarkScore <= 0) return 0;
  return Number(clamp((rawScore / benchmarkScore) * 100, 0, 100).toFixed(1));
}

// ══════════════════════════════════════════
// SCORING
// ══════════════════════════════════════════

function buildReadingScore(summary) {
  const speechScore = scaleHigherBetter(summary.praatSpeechRate, 1.5, 5.0);
  const articulationScore = scaleHigherBetter(summary.praatArticulationRate, 4.0, 9.0);
  const burstScore = scaleHigherBetter(summary.longestBurst, 0.4, 3.6);
  const fragmentationNorm = scaleLowerBetter(summary.fragmentationScore, 45, 85);
  const flowNorm = scaleHigherBetter(summary.flowScore, 10, 40);

  const score =
    speechScore * 0.24 +
    articulationScore * 0.18 +
    burstScore * 0.26 +
    fragmentationNorm * 0.18 +
    flowNorm * 0.14;

  return Number(score.toFixed(1));
}

// ══════════════════════════════════════════
// PAUSE CLASSIFICATION
// ══════════════════════════════════════════

function classifyPause(seconds) {
  if (seconds < 0.12) return 'micro_gap';
  if (seconds < 0.30) return 'breath';
  if (seconds < 0.85) return 'phrase';
  if (seconds < 1.60) return 'hesitation';
  return 'break';
}

function pausePenalty(duration) {
  if (duration < 0.12) return 0.01;
  if (duration < 0.30) return lerp(0.01, 0.05, (duration - 0.12) / 0.18);
  if (duration < 0.85) return lerp(0.02, 0.12, (duration - 0.30) / 0.55);
  if (duration < 1.60) return lerp(0.18, 0.78, (duration - 0.85) / 0.75);
  return 0.78 + (duration - 1.60) * 0.90;
}

function healthyPhraseReward(duration) {
  if (duration < 0.12) return 0.05;
  if (duration < 0.28) return 0.22;
  if (duration < 0.75) return 1.0;
  if (duration < 1.0) return 0.55;
  if (duration < 1.25) return 0.18;
  return 0;
}

function countTransitions(flags) {
  let count = 0;
  for (let i = 1; i < flags.length; i++) {
    if (flags[i] !== flags[i - 1]) count++;
  }
  return count;
}

// ══════════════════════════════════════════
// AUDIO DECODE
// ══════════════════════════════════════════

async function decodeAudioInput(input) {
  // Accept File, Blob, or AudioBuffer
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
// FRAME BUILDING
// ══════════════════════════════════════════

function buildFrames(samples, sampleRate, frameMs = 20) {
  const frameSize = Math.max(1, Math.round(sampleRate * frameMs / 1000));
  const frames = [];

  for (let i = 0; i < samples.length; i += frameSize) {
    const end = Math.min(samples.length, i + frameSize);
    const len = Math.max(1, end - i);

    let sumSq = 0;
    let absSum = 0;
    let crossings = 0;
    let prev = samples[i] || 0;

    for (let j = i; j < end; j++) {
      const v = samples[j];
      sumSq += v * v;
      absSum += Math.abs(v);
      if ((prev >= 0 && v < 0) || (prev < 0 && v >= 0)) crossings++;
      prev = v;
    }

    const rms = Math.sqrt(sumSq / len);

    frames.push({
      t: i / sampleRate,
      duration: len / sampleRate,
      rms,
      db: rmsToDb(rms),
      zcr: crossings / len,
      absMean: absSum / len
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

  return {
    rawFlags,
    rmsThreshold,
    zcrMedian,
    speechRmsMedian
  };
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
      pauses.push({ start, end, duration, kind: classifyPause(duration) });
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

function pausesFromBursts(bursts, totalDuration) {
  const pauses = [];

  if (!bursts.length) {
    return [{
      start: 0,
      end: totalDuration,
      duration: totalDuration,
      kind: classifyPause(totalDuration)
    }];
  }

  if (bursts[0].start > 0) {
    pauses.push({
      start: 0,
      end: bursts[0].start,
      duration: bursts[0].start,
      kind: classifyPause(bursts[0].start)
    });
  }

  for (let i = 1; i < bursts.length; i++) {
    const start = bursts[i - 1].end;
    const end = bursts[i].start;
    const duration = end - start;
    pauses.push({
      start,
      end,
      duration,
      kind: classifyPause(duration)
    });
  }

  if (bursts[bursts.length - 1].end < totalDuration) {
    const start = bursts[bursts.length - 1].end;
    const end = totalDuration;
    const duration = end - start;
    pauses.push({
      start,
      end,
      duration,
      kind: classifyPause(duration)
    });
  }

  return pauses;
}

// ══════════════════════════════════════════
// PRAAT-STYLE METRICS
// ══════════════════════════════════════════

function estimatePraatStyleMetrics(frames, speechFlags, cfg) {
  const speechFrames = frames.filter((_, idx) => speechFlags[idx]);

  if (!speechFrames.length) {
    return {
      thresholdDb: -Infinity,
      nSyllables: 0,
      speechRate: 0,
      articulationRate: 0,
      averageSyllableDuration: 0,
      phonationTime: 0,
      pauseCount: 0,
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
    if (!previousPeak) {
      previousPeak = peak;
      continue;
    }

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

  const mergedSegmentation = segmentFrames(frames, speechFlags);
  const pauseCount = mergedSegmentation.pauses.filter(
    p => p.duration >= (cfg.praatMinPauseSec ?? 0.3)
  ).length;

  const nSyllables = validPeaks.length;

  return {
    thresholdDb: Number(thresholdDb.toFixed(2)),
    nSyllables,
    speechRate: Number((nSyllables / Math.max(totalDuration, 1e-6)).toFixed(2)),
    articulationRate: Number((nSyllables / Math.max(phonationTime, 1e-6)).toFixed(2)),
    averageSyllableDuration: Number((phonationTime / Math.max(nSyllables, 1)).toFixed(3)),
    phonationTime: Number(phonationTime.toFixed(2)),
    pauseCount,
    peaks: validPeaks.map(p => ({
      t: Number(p.t.toFixed(3)),
      db: Number(p.db.toFixed(2))
    }))
  };
}

// ══════════════════════════════════════════
// READING-ONLY PAUSE LOGIC
// ══════════════════════════════════════════

function classifyReadingPause(pause, prevBurst, nextBurst, totalDuration) {
  const isBoundaryPause =
    pause.start < 0.6 || pause.end > totalDuration - 0.6;

  if (isBoundaryPause) {
    return { kind: 'boundary', penalty: 0, reward: 0 };
  }

  if (!prevBurst || !nextBurst) {
    return { kind: 'boundary', penalty: 0, reward: 0 };
  }

  const prevShort = prevBurst.duration < 0.75;
  const nextShort = nextBurst.duration < 0.75;
  const prevLong = prevBurst.duration >= 1.2;
  const nextLong = nextBurst.duration >= 1.2;

  if (pause.duration < 0.12) {
    return { kind: 'micro_gap', penalty: 0, reward: 0 };
  }

  if (pause.duration >= 0.12 && pause.duration <= 0.9 && (prevLong || nextLong)) {
    return {
      kind: 'phrase_pause',
      penalty: 0.15,
      reward: healthyPhraseReward(pause.duration)
    };
  }

  if (pause.duration >= 0.12 && pause.duration <= 1.2 && prevShort && nextShort) {
    return { kind: 'decoding_pause', penalty: 1.0, reward: 0 };
  }

  if (pause.duration > 1.2 && prevShort && nextShort) {
    return { kind: 'hesitation_pause', penalty: 1.5, reward: 0 };
  }

  return { kind: 'neutral_internal', penalty: 0.35, reward: 0 };
}

function scoreReadingOnlyPauses(bursts, pauses, totalDuration) {
  let readingPenalty = 0;
  let readingReward = 0;

  let boundaryPauseCount = 0;
  let phrasePauseCount = 0;
  let decodingPauseCount = 0;
  let hesitationPauseCount = 0;
  let neutralInternalPauseCount = 0;

  const classifiedPauses = [];

  for (let i = 0; i < pauses.length; i++) {
    const pause = pauses[i];
    const prevBurst = bursts[i];
    const nextBurst = bursts[i + 1];

    const result = classifyReadingPause(pause, prevBurst, nextBurst, totalDuration);

    readingPenalty += result.penalty;
    readingReward += result.reward;

    if (result.kind === 'boundary') boundaryPauseCount++;
    if (result.kind === 'phrase_pause') phrasePauseCount++;
    if (result.kind === 'decoding_pause') decodingPauseCount++;
    if (result.kind === 'hesitation_pause') hesitationPauseCount++;
    if (result.kind === 'neutral_internal') neutralInternalPauseCount++;

    classifiedPauses.push({
      ...pause,
      readingKind: result.kind,
      readingPenalty: result.penalty,
      readingReward: result.reward
    });
  }

  return {
    readingPenalty: Number(readingPenalty.toFixed(3)),
    readingReward: Number(readingReward.toFixed(3)),
    boundaryPauseCount,
    phrasePauseCount,
    decodingPauseCount,
    hesitationPauseCount,
    neutralInternalPauseCount,
    classifiedPauses
  };
}

// ══════════════════════════════════════════
// WINDOW SPEECH RATIOS
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

function computeWindowSpeechRatios(totalDuration, frames, speechFlags, windowSec = 2, stepSec = 1) {
  const ratios = [];
  if (totalDuration <= 0) return ratios;

  const latestStart = Math.max(0, totalDuration - windowSec);

  for (let t = 0; t <= latestStart; t += stepSec) {
    ratios.push(speechRatioInWindow(frames, speechFlags, t, t + windowSec));
  }

  if (!ratios.length) {
    ratios.push(speechRatioInWindow(frames, speechFlags, 0, totalDuration));
  }

  return ratios;
}

// ══════════════════════════════════════════
// SNIPPET PICKER
// ══════════════════════════════════════════

function pickSnippets(totalDuration, frames, speechFlags, cfg) {
  const candidates = [];
  const duration = cfg.snippetDurationSec;
  const scanStep = 1;
  const latestStart = Math.max(0, totalDuration - duration);

  for (let t = 0; t <= latestStart; t += scanStep) {
    const ratio = speechRatioInWindow(frames, speechFlags, t, t + duration);
    const center = (t + duration / 2) / Math.max(1, totalDuration);

    candidates.push({
      start: t,
      end: t + duration,
      speechRatio: ratio,
      center
    });
  }

  const targets = [];
  const earlyAnchorCenter = clamp(
    (cfg.earlyAnchorSec + duration / 2) / Math.max(1, totalDuration),
    0,
    1
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
      chosen.push(best);
      usedStarts.add(Math.round(best.start));
    }
  }

  if (chosen.length < cfg.minSnippets) {
    const fallbackStart = Math.max(0, totalDuration - duration);
    const fallback = {
      start: fallbackStart,
      end: fallbackStart + duration,
      speechRatio: speechRatioInWindow(frames, speechFlags, fallbackStart, fallbackStart + duration),
      center: (fallbackStart + duration / 2) / Math.max(1, totalDuration)
    };

    if (!chosen.some(c => Math.abs(c.start - fallback.start) < duration * 0.7)) {
      chosen.push(fallback);
    }
  }

  return chosen
    .sort((a, b) => a.start - b.start)
    .slice(0, cfg.maxSnippets)
    .map((s, idx) => ({
      index: idx + 1,
      start: s.start,
      end: s.end,
      duration,
      positionPercent: totalDuration > 0 ? (s.start / totalDuration) * 100 : 0,
      speechRatio: s.speechRatio,
      selectionScore: Number((((s.speechRatio * 0.72) + (1 - Math.abs(s.center - 0.5)) * 0.28) * 100).toFixed(1))
    }));
}

// ══════════════════════════════════════════
// PROFILE CLASSIFICATION
// ══════════════════════════════════════════

function interpretProfile(fragmentationScore, flowScore, efficiencyScore, controlScore) {
  if (fragmentationScore >= 65 && flowScore < 40) return 'stop_start';
  if (flowScore >= 60 && fragmentationScore < 45) return 'flowing';
  if (controlScore >= 55 && fragmentationScore < 60) return 'steady';
  return 'mixed';
}

// ══════════════════════════════════════════
// MAIN ANALYSIS
// ══════════════════════════════════════════

export async function analyzeAudio(input, cfg) {
  const audioBuffer = await decodeAudioInput(input);
  const samples = monoData(audioBuffer);
  const frames = buildFrames(samples, audioBuffer.sampleRate, 20);
  const totalDuration = audioBuffer.duration;

  const {
    rawFlags,
    rmsThreshold,
    zcrMedian,
    speechRmsMedian
  } = buildPermissiveSpeechFlags(frames, cfg.vadQuantile);

  const initialSegmentation = segmentFrames(frames, rawFlags);
  const mergedBursts = mergeCloseBursts(initialSegmentation.bursts, 0.24);
  const bursts = mergedBursts;
  const pauses = pausesFromBursts(bursts, totalDuration);

  const speechFlagsFromMergedBursts = frames.map(frame => {
    const fStart = frame.t;
    const fEnd = fStart + frame.duration;
    return bursts.some(b => fEnd > b.start && fStart < b.end);
  });

  const speakingTime = bursts.reduce((sum, b) => sum + b.duration, 0);
  const silenceTime = Math.max(0, totalDuration - speakingTime);
  const activeRatio = speakingTime / Math.max(totalDuration, 1);

  const burstDurations = bursts.map(b => b.duration);
  const pauseDurations = pauses.map(p => p.duration);

  const microGapCount = pauses.filter(p => p.kind === 'micro_gap').length;
  const breathCount = pauses.filter(p => p.kind === 'breath').length;
  const phraseCount = pauses.filter(p => p.kind === 'phrase').length;
  const hesitationCount = pauses.filter(p => p.kind === 'hesitation').length;
  const breakCount = pauses.filter(p => p.kind === 'break').length;

  const microBurstCount = burstDurations.filter(d => d < 0.40).length;
  const shortBurstCount = burstDurations.filter(d => d < 0.70).length;
  const microBurstRatio = bursts.length ? microBurstCount / bursts.length : 0;
  const shortBurstRatio = bursts.length ? shortBurstCount / bursts.length : 0;

  const transitions = countTransitions(speechFlagsFromMergedBursts);
  const transitionsPerSecond = transitions / Math.max(totalDuration, 1);

  const burstMedian = median(burstDurations);
  const burstTopMean = topPercentMean(burstDurations, 0.25);
  const longestBurst = Math.max(...burstDurations, 0);

  const windowRatios = computeWindowSpeechRatios(totalDuration, frames, speechFlagsFromMergedBursts, 2, 1);
  const windowSpeechMean = mean(windowRatios);
  const windowSpeechStd = stddev(windowRatios);
  const windowConsistency = windowSpeechMean > 0
    ? 1 - clamp(windowSpeechStd / Math.max(windowSpeechMean, 0.001), 0, 1)
    : 0;

  const readingOnly = scoreReadingOnlyPauses(bursts, pauses, totalDuration);

  const pauseCountPerSecond = pauses.length / Math.max(totalDuration, 1);
  const burstCv = cv(burstDurations);
  const pauseCv = cv(pauseDurations);

  const praatLike = estimatePraatStyleMetrics(frames, speechFlagsFromMergedBursts, cfg);

  // Reading-only fragmentation
  const fragmentationRaw =
    (shortBurstRatio * 36) +
    (microBurstRatio * 30) +
    (transitionsPerSecond * 14) +
    (readingOnly.decodingPauseCount * 3.5) +
    (readingOnly.hesitationPauseCount * 4.5) +
    (readingOnly.neutralInternalPauseCount * 0.8);

  const fragmentationScore = Number(clamp(fragmentationRaw, 0, 100).toFixed(1));

  const efficiencyRaw =
    (praatLike.speechRate * 18) +
    (praatLike.articulationRate * 3.5);

  const efficiencyScore = Number(clamp(efficiencyRaw, 0, 100).toFixed(1));

  const controlRaw =
    72
    - (burstCv * 18)
    - (pauseCv * 8)
    - (microBurstRatio * 18)
    - (transitionsPerSecond * 2.8)
    - (readingOnly.readingPenalty * 4.5)
    + (Math.min(longestBurst, 1.2) * 10)
    + (readingOnly.readingReward * 1.8);

  const controlScore = Number(clamp(controlRaw, 0, 100).toFixed(1));

  const flowRaw =
    (windowConsistency * 36) +
    (readingOnly.readingReward * 16) +
    (Math.min(burstTopMean, 1.2) * 16) +
    (Math.min(longestBurst, 1.5) * 10) -
    (fragmentationScore * 0.45) -
    (readingOnly.decodingPauseCount * 2.2) -
    (readingOnly.hesitationPauseCount * 3.0);

  const flowScore = Number(clamp(flowRaw, 0, 100).toFixed(1));

  const profile = interpretProfile(
    fragmentationScore,
    flowScore,
    efficiencyScore,
    controlScore
  );

  const snippets = pickSnippets(totalDuration, frames, speechFlagsFromMergedBursts, cfg);

  const result = {
    sessionSummary: {
      sessionDuration: Number(totalDuration.toFixed(1)),
      speakingTime: Number(speakingTime.toFixed(1)),
      silenceTime: Number(silenceTime.toFixed(1)),
      activeRatio: Number(activeRatio.toFixed(3)),
      speechDetectionLooksTooSparse: activeRatio < 0.45,

      burstCount: bursts.length,
      averageBurst: Number(mean(burstDurations).toFixed(2)),
      medianBurst: Number(burstMedian.toFixed(2)),
      longestBurst: Number(longestBurst.toFixed(2)),
      topBurstMean: Number(burstTopMean.toFixed(2)),
      microBurstCount,
      microBurstRatio: Number(microBurstRatio.toFixed(3)),
      shortBurstCount,
      shortBurstRatio: Number(shortBurstRatio.toFixed(3)),

      pauseCount: pauses.length,
      pauseCountPerSecond: Number(pauseCountPerSecond.toFixed(2)),
      averagePause: Number(mean(pauseDurations).toFixed(2)),
      microGapCount,
      breathCount,
      phraseCount,
      hesitationCount,
      breakCount,

      boundaryPauseCount: readingOnly.boundaryPauseCount,
      readingPhrasePauseCount: readingOnly.phrasePauseCount,
      decodingPauseCount: readingOnly.decodingPauseCount,
      hesitationPauseCount: readingOnly.hesitationPauseCount,
      neutralInternalPauseCount: readingOnly.neutralInternalPauseCount,
      readingPenalty: readingOnly.readingPenalty,
      readingReward: readingOnly.readingReward,

      transitions,
      transitionsPerSecond: Number(transitionsPerSecond.toFixed(2)),

      windowSpeechMean: Number(windowSpeechMean.toFixed(3)),
      windowSpeechStd: Number(windowSpeechStd.toFixed(3)),
      windowConsistency: Number(windowConsistency.toFixed(3)),

      praatSyllables: praatLike.nSyllables,
      praatSpeechRate: praatLike.speechRate,
      praatArticulationRate: praatLike.articulationRate,
      praatPhonationTime: praatLike.phonationTime,
      praatPauseCount: praatLike.pauseCount,

      fragmentationScore,
      flowScore,
      efficiencyScore,
      controlScore,
      profile,

      rawTotalScore: 0,
      totalScore: 0
    },
    snippets,
    rawMetrics: {
      config: cfg,
      frameCount: frames.length,
      rmsThreshold,
      zcrMedian,
      speechRmsMedian,
      initialBursts: initialSegmentation.bursts,
      mergedBursts: bursts,
      pauses,
      classifiedPauses: readingOnly.classifiedPauses,
      windowRatios,
      praatLike
    }
  };

  const rawTotalScore = buildReadingScore(result.sessionSummary);
  result.sessionSummary.rawTotalScore = rawTotalScore;
  result.sessionSummary.totalScore = normalizeToBenchmark(rawTotalScore, BENCHMARK_RAW_SCORE);

  return result;
}

// ══════════════════════════════════════════
// SNIPPET USABILITY CHECK
// ══════════════════════════════════════════

export function isSnippetUsable(summary) {
  // Regla 1: Of lítið tal
  if (summary.activeRatio < 0.35) {
    return { usable: false, quality: null, reason: 'silence' };
  }

  // Regla 2: Enginn hljóðstyrkur (speaking < 0.5s í 10+ sek snippeti)
  if (summary.speakingTime < 0.5 && summary.sessionDuration > 10) {
    return { usable: false, quality: null, reason: 'no_signal' };
  }

  // Regla 3: Hávaði, ekki tal (VAD segir tal en Praat finnur engin atkvæði)
  if (summary.activeRatio > 0.5 && summary.praatSyllables < 3) {
    return { usable: false, quality: null, reason: 'noise_not_speech' };
  }

  // Regla 4: Ekkert samfelld tal
  if (summary.longestBurst < 0.5) {
    return { usable: false, quality: null, reason: 'fragmented' };
  }

  // Veikt en nothæft
  if (summary.activeRatio < 0.55) {
    return { usable: true, quality: 'weak', reason: null };
  }

  // Gott
  return { usable: true, quality: 'good', reason: null };
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
    totalScore: result.sessionSummary.totalScore,
    profile: result.sessionSummary.profile,
    activeRatio: result.sessionSummary.activeRatio,
    speakingTime: result.sessionSummary.speakingTime,
    praatSyllables: result.sessionSummary.praatSyllables,
    longestBurst: result.sessionSummary.longestBurst,
    fragmentationScore: result.sessionSummary.fragmentationScore,
    flowScore: result.sessionSummary.flowScore,
    efficiencyScore: result.sessionSummary.efficiencyScore,
    controlScore: result.sessionSummary.controlScore,
    summary: result.sessionSummary
  };
}
