(() => {
'use strict';

const DISPLAY_MS = 160;
const FOCUS_MS = 60;
const FOCUS_SHARE = 0.85;
const HOP_MS = 0.25;
const WINDOW_MS = 3;
const REF_KA = new Float32Array([0.607436,0.619275,0.618506,0.622232,0.629653,0.632056,0.633882,0.640500,0.645313,0.653162,0.672116,0.700428,0.730889,0.762725,0.795161,0.818655,0.830855,0.837625,0.837317,0.832214,0.830081,0.831965,0.832363,0.834287,0.841741,0.847608,0.849702,0.852723,0.851000,0.837479,0.817373,0.790348,0.753790,0.714624,0.679651,0.648471,0.626131,0.626301,0.646151,0.669221,0.690465,0.710224,0.721869,0.723831,0.719492,0.710080,0.697692,0.685195,0.670566,0.649969,0.626342,0.605666,0.589456,0.576432,0.565930,0.559266,0.552354,0.540121,0.523733,0.506004,0.490414,0.474112,0.450871,0.422620,0.393456,0.364177,0.340870,0.330712,0.338000,0.356532,0.379744,0.400952,0.414212,0.417636,0.412153,0.400015,0.384357,0.368883,0.351765,0.333267,0.314868,0.300128,0.288605,0.281420,0.278729,0.281470,0.288526,0.296446,0.304944,0.311811,0.316489,0.314887,0.305332,0.288754,0.269228,0.250056,0.236578,0.237896,0.258494,0.287745,0.314433,0.334861,0.346749,0.349916,0.343425,0.328568,0.308666,0.288091,0.270571,0.254880,0.241912,0.238048,0.244568,0.253953,0.260925,0.263781,0.264680,0.264195,0.260957,0.255839,0.248946,0.241179,0.229448,0.211546,0.188456,0.165165,0.144522,0.127353,0.115815,0.112528,0.118433,0.127099,0.135190,0.140017,0.140573,0.136822,0.129256,0.119293,0.109014,0.100233,0.091853,0.082737,0.074520,0.069916,0.068389,0.068968,0.071595,0.075374,0.078123,0.078403,0.076823,0.074177,0.070796,0.066814,0.062342,0.057797,0.053780,0.049991,0.045160,0.039855,0.036508,0.036382,0.037488,0.038544,0.039248,0.039346,0.038031,0.035403,0.032576,0.030204,0.028841,0.028433,0.027398,0.025448,0.022805,0.019426,0.015544,0.011761,0.009605,0.009805,0.010279,0.010507,0.010379,0.009914,0.009187,0.008364,0.007598,0.007096,0.006740,0.006446,0.006222,0.006392,0.006709,0.006875,0.006787,0.006386,0.005651,0.004602]);
const REF_DON = new Float32Array([0.637562,0.690233,0.729644,0.756155,0.769133,0.777609,0.786273,0.809437,0.823267,0.832720,0.839988,0.844601,0.849608,0.853931,0.855200,0.855536,0.856479,0.857969,0.860538,0.862523,0.862841,0.862670,0.862582,0.864825,0.868681,0.872043,0.874098,0.874498,0.875733,0.878674,0.882352,0.886111,0.888477,0.888501,0.887669,0.887341,0.887582,0.888662,0.888738,0.886688,0.882771,0.876945,0.869057,0.859641,0.847908,0.833043,0.815835,0.797201,0.778001,0.759754,0.744296,0.731212,0.720149,0.710362,0.700818,0.691312,0.682784,0.674266,0.665722,0.657467,0.649859,0.643152,0.637573,0.632634,0.628410,0.624834,0.621613,0.618549,0.615661,0.611953,0.607292,0.601884,0.596108,0.590998,0.587663,0.585102,0.582613,0.579493,0.575130,0.569765,0.564758,0.559708,0.553967,0.547079,0.538797,0.529892,0.522364,0.515751,0.509335,0.502601,0.495063,0.487035,0.480281,0.474224,0.467546,0.459930,0.451279,0.442305,0.435378,0.430397,0.425471,0.419552,0.411624,0.401447,0.391216,0.382818,0.374995,0.366284,0.355090,0.340513,0.324522,0.310718,0.299330,0.289089,0.278235,0.265093,0.250223,0.236890,0.226404,0.217764,0.209325,0.199196,0.186876,0.174626,0.164432,0.156062,0.148526,0.140361,0.130656,0.120696,0.112445,0.105944,0.100146,0.093422,0.084462,0.073802,0.063434,0.056758,0.052927,0.050667,0.047878,0.042188,0.034002,0.024853,0.015194,0.006644,0.004652,0.004381,0.001785]);

let currentEnvelope = null;
let playheadMs = null;
let animationToken = 0;
const envelopeCache = new WeakMap();

const css = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

function timeRatio(ms) {
  const t = Math.max(0, Math.min(DISPLAY_MS, ms));
  if (t <= FOCUS_MS) return (t / FOCUS_MS) * FOCUS_SHARE;
  return FOCUS_SHARE + ((t - FOCUS_MS) / (DISPLAY_MS - FOCUS_MS)) * (1 - FOCUS_SHARE);
}

function canvasState() {
  const canvas = document.getElementById('energyEnvelopeCanvas');
  const stage = document.querySelector('.wave-stage');
  if (!canvas || !stage) return null;
  const rect = stage.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const pw = Math.max(1, Math.round(rect.width * dpr));
  const ph = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, rect };
}

function drawGuide(ctx, w, h) {
  const padX = 2.5;
  const x = padX + FOCUS_SHARE * (w - padX * 2);
  ctx.save();
  ctx.strokeStyle = css('--energy-guide', '#858a90');
  ctx.globalAlpha = 0.14;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, 2);
  ctx.lineTo(x, h - 2);
  ctx.stroke();
  ctx.restore();
}

function drawEnvelope(ctx, values, w, h, color, dashed, width, alpha, fill) {
  if (!values?.length) return;
  const padX = 2.5, padTop = 3, padBottom = 3;
  const usableW = w - padX * 2;
  const usableH = h - padTop - padBottom;
  const base = h - padBottom;
  ctx.save();
  ctx.beginPath();
  let lastX = padX;
  for (let i = 0; i < values.length; i++) {
    const ms = i * HOP_MS;
    if (ms > DISPLAY_MS) break;
    const x = padX + timeRatio(ms) * usableW;
    const y = base - clamp01(values[i]) * usableH;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
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
    ctx.globalAlpha = 0.045;
    ctx.setLineDash([]);
    ctx.fill();
  }
  ctx.restore();
}

function drawPlayhead(ctx, w, h) {
  if (playheadMs == null) return;
  const padX = 2.5;
  const x = padX + timeRatio(playheadMs) * (w - padX * 2);
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
  const state = canvasState();
  if (!state) return;
  const {ctx, rect} = state;
  const w = rect.width, h = rect.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = css('--energy-stage-bg', '#e7e8ea');
  ctx.fillRect(0, 0, w, h);
  drawGuide(ctx, w, h);
  drawEnvelope(ctx, REF_KA, w, h, css('--energy-ka', '#668eac'), true, 1.75, 0.9, false);
  drawEnvelope(ctx, REF_DON, w, h, css('--energy-don', '#b47175'), true, 1.75, 0.9, false);
  if (currentEnvelope) drawEnvelope(ctx, currentEnvelope, w, h, css('--energy-current', '#465c52'), false, 2.5, 1, true);
  drawPlayhead(ctx, w, h);
}

function computeEnvelope(buffer) {
  if (envelopeCache.has(buffer)) return envelopeCache.get(buffer);
  const sr = buffer.sampleRate;
  const channels = buffer.numberOfChannels;
  const data = Array.from({length: channels}, (_, i) => buffer.getChannelData(i));
  const points = Math.round(DISPLAY_MS / HOP_MS) + 1;
  const half = Math.max(1, Math.round((WINDOW_MS / 1000) * sr / 2));
  const out = new Float32Array(points);
  for (let p = 0; p < points; p++) {
    const center = Math.round((p * HOP_MS / 1000) * sr);
    if (center >= buffer.length + half) continue;
    const start = Math.max(0, center - half);
    const end = Math.min(buffer.length, center + half + 1);
    const span = Math.max(1, end - start - 1);
    let sum = 0, weightSum = 0;
    for (let i = start; i < end; i++) {
      const rel = (i - start) / span;
      const weight = 0.5 - 0.5 * Math.cos(2 * Math.PI * rel);
      let e = 0;
      for (let c = 0; c < channels; c++) { const v = data[c][i]; e += v * v; }
      e /= channels;
      sum += e * weight;
      weightSum += weight;
    }
    out[p] = weightSum ? Math.sqrt(sum / weightSum) : 0;
  }
  envelopeCache.set(buffer, out);
  return out;
}

function showBuffer(buffer) {
  currentEnvelope = computeEnvelope(buffer);
  playheadMs = null;
  draw();
}

function stopPlayhead() {
  animationToken++;
  playheadMs = null;
  draw();
}

function startPlayhead(audioDurationMs, prerollMs = 500) {
  const token = ++animationToken;
  const queued = performance.now();
  const start = queued + prerollMs;
  const visibleDuration = Math.min(Math.max(0, audioDurationMs), DISPLAY_MS);
  const frame = (now) => {
    if (token !== animationToken) return;
    if (now < start) {
      playheadMs = 0;
      draw();
      requestAnimationFrame(frame);
      return;
    }
    const elapsed = now - start;
    if (elapsed <= visibleDuration) {
      playheadMs = elapsed;
      draw();
      requestAnimationFrame(frame);
      return;
    }
    playheadMs = null;
    draw();
  };
  requestAnimationFrame(frame);
}

window.TinderSEEnergyV5 = { showBuffer, startPlayhead, stopPlayhead, draw };
if ('ResizeObserver' in window) {
  const stage = document.querySelector('.wave-stage');
  if (stage) new ResizeObserver(draw).observe(stage);
} else {
  addEventListener('resize', draw);
}
draw();
})();
