(() => {
'use strict';

const DISPLAY_MS = 160;
const FOCUS_MS = 50;
const FOCUS_SHARE = 0.75;
const MAIN_MAX_MS = 130.5;
const PREROLL_MS = 500;
const HOP_MS = 0.25;
const WINDOW_MS = 3;
const DISPLAY_POINTS = Math.round(DISPLAY_MS / HOP_MS) + 1;

const padRef = (src) => {
  const out = new Float32Array(DISPLAY_POINTS);
  out.set(src.subarray(0, Math.min(src.length, out.length)));
  return { values: out, hopMs: HOP_MS, durationMs: DISPLAY_MS };
};

const REF_KA = padRef(new Float32Array([0.6074,0.6193,0.6185,0.6222,0.6297,0.6321,0.6339,0.6405,0.6453,0.6532,0.6721,0.7004,0.7309,0.7627,0.7952,0.8187,0.8309,0.8376,0.8373,0.8322,0.8301,0.8320,0.8324,0.8343,0.8417,0.8476,0.8497,0.8527,0.8510,0.8375,0.8174,0.7903,0.7538,0.7146,0.6797,0.6485,0.6261,0.6263,0.6462,0.6692,0.6905,0.7102,0.7219,0.7238,0.7195,0.7101,0.6977,0.6852,0.6706,0.6500,0.6263,0.6057,0.5895,0.5764,0.5659,0.5593,0.5524,0.5401,0.5237,0.5060,0.4904,0.4741,0.4509,0.4226,0.3935,0.3642,0.3409,0.3307,0.3380,0.3565,0.3797,0.4010,0.4142,0.4176,0.4122,0.4000,0.3844,0.3689,0.3518,0.3333,0.3149,0.3001,0.2886,0.2814,0.2787,0.2815,0.2885,0.2964,0.3049,0.3118,0.3165,0.3149,0.3053,0.2888,0.2692,0.2501,0.2366,0.2379,0.2585,0.2877,0.3144,0.3349,0.3467,0.3499,0.3434,0.3286,0.3087,0.2881,0.2706,0.2549,0.2419,0.2380,0.2446,0.2540,0.2609,0.2638,0.2647,0.2642,0.2610,0.2558,0.2489,0.2412,0.2294,0.2115,0.1885,0.1652,0.1445,0.1274,0.1158,0.1125,0.1184,0.1271,0.1352,0.1400,0.1406,0.1368,0.1293,0.1193,0.1090,0.1002,0.0919,0.0827,0.0745,0.0699,0.0684,0.0690,0.0716,0.0754,0.0781,0.0784,0.0768,0.0742,0.0708,0.0668,0.0623,0.0578,0.0538,0.0500,0.0452,0.0399,0.0365,0.0364,0.0375,0.0385,0.0392,0.0393,0.0380,0.0354,0.0326,0.0302,0.0288,0.0284,0.0274,0.0254,0.0228,0.0194,0.0155,0.0118,0.0096,0.0098,0.0103,0.0105,0.0104,0.0099,0.0092,0.0084,0.0076,0.0071,0.0067,0.0064,0.0062,0.0064,0.0067,0.0069,0.0068,0.0064,0.0057,0.0046,0.0043,0.0041,0.0040]));
const REF_DON = padRef(new Float32Array([0.6376,0.6902,0.7296,0.7562,0.7691,0.7776,0.7863,0.8094,0.8233,0.8327,0.8400,0.8446,0.8496,0.8539,0.8552,0.8555,0.8565,0.8580,0.8605,0.8625,0.8628,0.8627,0.8626,0.8648,0.8687,0.8720,0.8741,0.8745,0.8757,0.8787,0.8824,0.8861,0.8885,0.8885,0.8877,0.8873,0.8876,0.8887,0.8887,0.8867,0.8828,0.8769,0.8691,0.8596,0.8479,0.8330,0.8158,0.7972,0.7780,0.7598,0.7443,0.7312,0.7201,0.7104,0.7008,0.6913,0.6828,0.6743,0.6657,0.6575,0.6499,0.6432,0.6376,0.6326,0.6284,0.6248,0.6216,0.6185,0.6157,0.6120,0.6073,0.6019,0.5961,0.5910,0.5877,0.5851,0.5826,0.5795,0.5751,0.5698,0.5648,0.5597,0.5540,0.5471,0.5388,0.5299,0.5224,0.5158,0.5093,0.5026,0.4951,0.4870,0.4803,0.4742,0.4675,0.4599,0.4513,0.4423,0.4354,0.4304,0.4255,0.4196,0.4116,0.4014,0.3912,0.3828,0.3750,0.3663,0.3551,0.3405,0.3245,0.3107,0.2993,0.2891,0.2782,0.2651,0.2502,0.2369,0.2264,0.2178,0.2093,0.1992,0.1869,0.1746,0.1644,0.1561,0.1485,0.1404,0.1307,0.1207,0.1124,0.1059,0.1001,0.0934,0.0845,0.0738,0.0634,0.0568,0.0529,0.0507,0.0479,0.0422,0.0340,0.0249,0.0152,0.0066,0.0047,0.0044,0.0018]));

let canvas = null;
let viewMode = 'normal';
let currentEnvelope = null;
let extendedDurationMs = null;
let playheadMs = null;
let activeRun = null;
let animToken = 0;

const sourceRuns = new WeakMap();
const envelopeCache = new WeakMap();
const css = (name, fallback) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

const clamp01 = (v) => Math.max(0, Math.min(1, v));

function normalTimeRatio(ms) {
  const t = Math.max(0, Math.min(DISPLAY_MS, ms));
  if (t <= FOCUS_MS) return (t / FOCUS_MS) * FOCUS_SHARE;
  return FOCUS_SHARE + ((t - FOCUS_MS) / (DISPLAY_MS - FOCUS_MS)) * (1 - FOCUS_SHARE);
}

function timeRatio(ms) {
  if (viewMode === 'extended') {
    return extendedDurationMs > 0 ? clamp01(ms / extendedDurationMs) : 0;
  }
  return normalTimeRatio(ms);
}

function ensureCanvas() {
  if (canvas?.isConnected) return canvas;
  const stage = document.querySelector('.wave-stage');
  if (!stage) return null;
  canvas = document.createElement('canvas');
  canvas.id = 'energyEnvelopeCanvas';
  canvas.className = 'energy-envelope-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  stage.appendChild(canvas);
  return canvas;
}

function sized() {
  const c = ensureCanvas();
  const stage = document.querySelector('.wave-stage');
  if (!c || !stage) return null;
  const rect = stage.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const dpr = Math.min(devicePixelRatio || 1, 3);
  const pw = Math.max(1, Math.round(rect.width * dpr));
  const ph = Math.max(1, Math.round(rect.height * dpr));
  if (c.width !== pw || c.height !== ph) {
    c.width = pw;
    c.height = ph;
  }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, rect };
}

function drawGuide(ctx, w, h, ratio, color, alpha = 0.18, dashed = false) {
  const padX = 2.5;
  const x = padX + clamp01(ratio) * (w - padX * 2);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = 1;
  ctx.setLineDash(dashed ? [4, 5] : []);
  ctx.beginPath();
  ctx.moveTo(x, 2);
  ctx.lineTo(x, h - 2);
  ctx.stroke();
  ctx.restore();
}

function drawEnvelope(ctx, env, w, h, color, dashed, width, alpha, fill) {
  if (!env?.values?.length) return;

  const padX = 2.5;
  const padTop = 3;
  const padBottom = 3;
  const usableW = w - padX * 2;
  const usableH = h - padTop - padBottom;
  const base = h - padBottom;

  ctx.save();
  ctx.beginPath();

  let lastX = padX;
  for (let i = 0; i < env.values.length; i++) {
    const ms = i * env.hopMs;
    if (viewMode === 'normal' && ms > DISPLAY_MS) break;
    if (viewMode === 'extended' && ms > extendedDurationMs + env.hopMs) break;
    const x = padX + timeRatio(ms) * usableW;
    const y = base - clamp01(env.values[i]) * usableH;
    if (i) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
    lastX = x;
  }

  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.globalAlpha = alpha;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.setLineDash(dashed ? [6, 5] : []);
  ctx.stroke();

  if (fill) {
    ctx.lineTo(lastX, base);
    ctx.lineTo(padX, base);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.05;
    ctx.setLineDash([]);
    ctx.fill();
  }

  ctx.restore();
}

function drawPlayhead(ctx, w, h) {
  if (playheadMs == null || viewMode !== 'normal') return;
  const padX = 2.5;
  const x = padX + normalTimeRatio(playheadMs) * (w - padX * 2);
  const color = css('--playhead', '#a78352');

  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.55;
  ctx.globalAlpha = 0.96;
  ctx.beginPath();
  ctx.moveTo(x, 3);
  ctx.lineTo(x, h - 3);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - 4.5, 1);
  ctx.lineTo(x + 4.5, 1);
  ctx.lineTo(x, 7);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function draw() {
  const sizedCanvas = sized();
  if (!sizedCanvas) return;
  const { ctx, rect } = sizedCanvas;
  const w = rect.width;
  const h = rect.height;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = css('--energy-stage-bg', '#e7e9eb');
  ctx.fillRect(0, 0, w, h);

  if (viewMode === 'normal') {
    drawGuide(ctx, w, h, FOCUS_SHARE, css('--energy-guide', '#858a90'), 0.16, false);
    drawEnvelope(ctx, REF_KA, w, h, css('--energy-ka', '#668eac'), true, 1.75, 0.88, false);
    drawEnvelope(ctx, REF_DON, w, h, css('--energy-don', '#b47175'), true, 1.75, 0.88, false);
    if (currentEnvelope) {
      drawEnvelope(ctx, currentEnvelope, w, h, css('--energy-current', '#405b58'), false, 2.4, 1, true);
    }
    drawPlayhead(ctx, w, h);
    return;
  }

  if (extendedDurationMs > 130) {
    drawGuide(
      ctx, w, h, 130 / extendedDurationMs,
      css('--energy-cut', '#6f7479'), 0.52, true
    );
  }
  if (currentEnvelope) {
    drawEnvelope(ctx, currentEnvelope, w, h, css('--energy-current', '#405b58'), false, 2.45, 1, true);
  }
}

function computeEnvelope(buffer, fixedDisplayMs = null) {
  if (envelopeCache.has(buffer)) return envelopeCache.get(buffer);

  const sampleRate = buffer.sampleRate;
  const channels = buffer.numberOfChannels;
  const channelData = Array.from({ length: channels }, (_, i) => buffer.getChannelData(i));
  const durationMs = fixedDisplayMs ?? (buffer.duration * 1000);
  const points = Math.max(2, Math.round(durationMs / HOP_MS) + 1);
  const half = Math.max(1, Math.round((WINDOW_MS / 1000) * sampleRate / 2));
  const values = new Float32Array(points);

  for (let p = 0; p < points; p++) {
    const center = Math.round((p * HOP_MS / 1000) * sampleRate);
    if (center >= buffer.length + half) continue;

    const start = Math.max(0, center - half);
    const end = Math.min(buffer.length, center + half + 1);
    const span = Math.max(1, end - start - 1);

    let weightedEnergy = 0;
    let weightSum = 0;

    for (let i = start; i < end; i++) {
      const rel = (i - start) / span;
      const weight = 0.5 - 0.5 * Math.cos(2 * Math.PI * rel);
      let energy = 0;
      for (let ch = 0; ch < channels; ch++) {
        const value = channelData[ch][i];
        energy += value * value;
      }
      energy /= channels;
      weightedEnergy += energy * weight;
      weightSum += weight;
    }

    values[p] = weightSum > 0 ? Math.sqrt(weightedEnergy / weightSum) : 0;
  }

  const env = { values, hopMs: HOP_MS, durationMs };
  envelopeCache.set(buffer, env);
  return env;
}

function startHead(run) {
  const token = ++animToken;
  activeRun = run;

  const frame = (now) => {
    if (token !== animToken || run.cancelled) return;

    if (now < run.start) {
      playheadMs = 0;
      draw();
      requestAnimationFrame(frame);
      return;
    }

    const elapsed = now - run.start;
    if (elapsed <= run.duration) {
      playheadMs = Math.min(elapsed, run.duration);
      draw();
      requestAnimationFrame(frame);
      return;
    }

    const fade = Math.max(0, 1 - (elapsed - run.duration) / 150);
    if (fade > 0) {
      playheadMs = run.duration;
      draw();
      requestAnimationFrame(frame);
    } else {
      playheadMs = null;
      if (activeRun === run) activeRun = null;
      draw();
    }
  };

  requestAnimationFrame(frame);
}

function cancelRun(run) {
  if (!run) return;
  run.cancelled = true;
  if (activeRun === run) {
    ++animToken;
    activeRun = null;
    playheadMs = null;
    draw();
  }
}

function patchAudio() {
  if (!window.AudioBufferSourceNode || AudioBufferSourceNode.prototype.__tinderseEnergyV5) return;

  const previousStart = AudioBufferSourceNode.prototype.start;
  const previousStop = AudioBufferSourceNode.prototype.stop;

  AudioBufferSourceNode.prototype.start = function(...args) {
    const ms = (this.buffer?.duration || 0) * 1000;

    if (this.buffer && ms > 0 && ms <= MAIN_MAX_MS) {
      viewMode = 'normal';
      extendedDurationMs = null;
      currentEnvelope = computeEnvelope(this.buffer, DISPLAY_MS);
      draw();

      const queued = performance.now();
      const run = {
        start: queued + PREROLL_MS,
        duration: Math.min(ms, DISPLAY_MS),
        cancelled: false
      };
      sourceRuns.set(this, run);
      startHead(run);
    } else if (this.buffer && ms > MAIN_MAX_MS) {
      if (activeRun) cancelRun(activeRun);
      ++animToken;
      playheadMs = null;
      activeRun = null;
      viewMode = 'extended';
      extendedDurationMs = ms;
      currentEnvelope = computeEnvelope(this.buffer);
      draw();
    }

    return previousStart.apply(this, args);
  };

  AudioBufferSourceNode.prototype.stop = function(...args) {
    cancelRun(sourceRuns.get(this));
    return previousStop.apply(this, args);
  };

  Object.defineProperty(AudioBufferSourceNode.prototype, '__tinderseEnergyV5', { value: true });
}

function stripLegacyUi() {
  for (const selector of ['.compare-head', '.wave-meta', '.wave-axis', '#pinBtn', '#playheadCanvas']) {
    document.querySelectorAll(selector).forEach((el) => { el.style.display = 'none'; });
  }
}

function splitDurationLabels() {
  document.querySelectorAll('.duration.original-duration').forEach((el) => {
    if (el.querySelector('.duration-original-line')) return;
    const text = el.textContent.trim();
    const match = /^(.*?\sms)\s+(\([^)]*ms\))$/.exec(text);
    if (!match) return;

    const top = document.createElement('span');
    top.className = 'duration-original-line';
    top.textContent = match[1];

    const bottom = document.createElement('span');
    bottom.className = 'duration-cut-line';
    bottom.textContent = match[2];

    el.replaceChildren(top, document.createTextNode(' '), bottom);
  });
}

function observeDurationLabels() {
  const grid = document.getElementById('soundGrid');
  if (!grid) return;
  const observer = new MutationObserver(() => queueMicrotask(splitDurationLabels));
  observer.observe(grid, { childList: true, subtree: true, characterData: true });
  splitDurationLabels();
}

patchAudio();
stripLegacyUi();
ensureCanvas();
draw();
observeDurationLabels();

if ('ResizeObserver' in window) {
  const stage = document.querySelector('.wave-stage');
  if (stage) new ResizeObserver(draw).observe(stage);
} else {
  addEventListener('resize', draw);
}
})();
