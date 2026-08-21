(() => {
  'use strict';

  const MAIN_MAX_MS = 130.5;
  const PREROLL_MS = 500;
  const WAVE_WINDOW_MS = 130;

  const CATEGORY_BY_LABEL = {
    'Kick': 'Kick',
    'Snare / Clap': 'SnareClap',
    'Tom / Timbale': 'Tom',
    'Rim / Stick': 'RimStick',
    'Hi-Hat': 'HiHat',
    'Cymbal': 'Cymbal',
    'Percussion': 'Percussion'
  };

  let durationByKey = new Map();
  let animationToken = 0;
  let overlay = null;
  let activeRun = null;
  let sequence = 0;
  const sourceRuns = new WeakMap();

  function parseCsv(text) {
    const rows = [];
    let row = [], field = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (ch === '"') quoted = false;
        else field += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
      else field += ch;
    }
    if (field.length || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
    return rows.filter((r) => r.some((v) => v.trim() !== ''));
  }

  async function loadDurations() {
    try {
      const res = await fetch('mapping.csv', { cache: 'no-store' });
      if (!res.ok) return;
      const rows = parseCsv((await res.text()).replace(/^\uFEFF/, ''));
      const headers = rows[0].map((h) => h.trim());
      const pos = Object.fromEntries(headers.map((h, i) => [h, i]));
      durationByKey = new Map();
      for (const row of rows.slice(1)) {
        const filename = row[pos.new_name] || '';
        const category = row[pos.category] || '';
        const match = /_(\d+)_\(/.exec(filename);
        if (!match) continue;
        durationByKey.set(`${category}:${Number(match[1])}`, {
          original: Number(row[pos.original_duration_ms]),
          final: Number(row[pos.final_duration_ms])
        });
      }
      decorateGrid();
    } catch (err) {
      console.warn('TinderSE duration decoration skipped', err);
    }
  }

  function activeCategory() {
    const label = document.getElementById('categoryTitle')?.textContent.trim() || '';
    return CATEGORY_BY_LABEL[label] || null;
  }

  function decorateTabs() {
    document.querySelectorAll('#categoryTabs .category-tab').forEach((tab) => {
      const text = tab.textContent.trim();
      for (const [label, category] of Object.entries(CATEGORY_BY_LABEL)) {
        if (text.startsWith(label)) {
          tab.dataset.category = category;
          break;
        }
      }
    });
  }

  function formatDelta(value) {
    if (!Number.isFinite(value) || Math.abs(value) < 0.05) return '0.0 ms';
    return `${value > 0 ? '+' : ''}${value.toFixed(1)} ms`;
  }

  function decorateGrid() {
    const category = activeCategory();
    if (!category) return;
    document.documentElement.dataset.activeCategory = category;

    document.querySelectorAll('#soundGrid .sound-card').forEach((card) => {
      card.dataset.category = category;
      const index = Number(card.querySelector('.index')?.textContent.trim());
      if (!index) return;
      const info = durationByKey.get(`${category}:${index}`);
      const duration = card.querySelector('.duration');
      if (!info || !duration) return;

      const delta = info.final - info.original;
      const next = `${info.original.toFixed(1)} ms (${formatDelta(delta)})`;
      if (duration.textContent !== next) duration.textContent = next;
      duration.classList.add('original-duration');
      duration.setAttribute('aria-label', `元音源 ${info.original.toFixed(1)}ミリ秒、カット後との差 ${formatDelta(delta)}`);
    });
  }

  function decorateAll() {
    decorateTabs();
    decorateGrid();
  }

  function ensureOverlay() {
    if (overlay?.isConnected) return overlay;
    const stage = document.querySelector('.wave-stage');
    const wave = document.getElementById('waveCanvas');
    if (!stage || !wave) return null;

    overlay = document.createElement('canvas');
    overlay.id = 'playheadCanvas';
    overlay.className = 'playhead-canvas';
    overlay.setAttribute('aria-hidden', 'true');
    stage.appendChild(overlay);
    return overlay;
  }

  function clearOverlay() {
    const canvas = ensureOverlay();
    if (!canvas) return;
    const rect = document.getElementById('waveCanvas')?.getBoundingClientRect();
    if (!rect) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    canvas.getContext('2d').clearRect(0, 0, w, h);
  }

  function drawPlayhead(xRatio, alpha = 1, pulse = false) {
    const canvas = ensureOverlay();
    const wave = document.getElementById('waveCanvas');
    if (!canvas || !wave) return;

    const rect = wave.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pxW = Math.max(1, Math.round(rect.width * dpr));
    const pxH = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== pxW || canvas.height !== pxH) { canvas.width = pxW; canvas.height = pxH; }

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    const x = Math.max(1, Math.min(rect.width - 1, xRatio * rect.width));
    const color = getComputedStyle(document.documentElement).getPropertyValue('--playhead').trim() || '#a78352';
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = pulse ? 1.25 : 1.55;
    ctx.beginPath();
    ctx.moveTo(x, 7);
    ctx.lineTo(x, rect.height - 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - 4.5, 1.5);
    ctx.lineTo(x + 4.5, 1.5);
    ctx.lineTo(x, 7.5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function setPrerollCard(on) {
    document.querySelectorAll('.sound-card.preroll').forEach((card) => card.classList.remove('preroll'));
    if (!on) return;
    const card = document.querySelector('.sound-card.playing-main');
    if (card) card.classList.add('preroll');
  }

  function animateRun(run) {
    const token = ++animationToken;
    activeRun = run;
    setPrerollCard(true);

    function frame(now) {
      if (token !== animationToken || run.cancelled) return;

      if (now < run.startPerf) {
        const phase = (now - run.queuedPerf) / PREROLL_MS;
        const alpha = 0.42 + 0.38 * (0.5 + 0.5 * Math.sin(phase * Math.PI * 4));
        drawPlayhead(0, alpha, true);
        requestAnimationFrame(frame);
        return;
      }

      setPrerollCard(false);
      const elapsed = now - run.startPerf;
      const ratio = Math.min(elapsed, run.durationMs) / WAVE_WINDOW_MS;
      if (elapsed <= run.durationMs) {
        drawPlayhead(ratio, 0.98, false);
        requestAnimationFrame(frame);
        return;
      }

      const fade = Math.max(0, 1 - (elapsed - run.durationMs) / 160);
      if (fade > 0) {
        drawPlayhead(Math.min(run.durationMs / WAVE_WINDOW_MS, 1), fade, false);
        requestAnimationFrame(frame);
      } else {
        clearOverlay();
        if (activeRun === run) activeRun = null;
      }
    }

    requestAnimationFrame(frame);
  }

  function cancelRun(run) {
    if (!run) return;
    run.cancelled = true;
    if (activeRun === run) {
      ++animationToken;
      activeRun = null;
      setPrerollCard(false);
      clearOverlay();
    }
  }

  function patchAudioStart() {
    if (!window.AudioBufferSourceNode || AudioBufferSourceNode.prototype.__tindersePreroll) return;

    const originalStart = AudioBufferSourceNode.prototype.start;
    const originalStop = AudioBufferSourceNode.prototype.stop;

    AudioBufferSourceNode.prototype.start = function(when = 0, offset = 0, duration) {
      const durationMs = (this.buffer?.duration || 0) * 1000;
      if (durationMs > 0 && durationMs <= MAIN_MAX_MS) {
        const queuedPerf = performance.now();
        const target = this.context.currentTime + PREROLL_MS / 1000;
        const run = {
          id: ++sequence,
          queuedPerf,
          startPerf: queuedPerf + PREROLL_MS,
          durationMs: Math.min(durationMs, WAVE_WINDOW_MS),
          cancelled: false
        };
        sourceRuns.set(this, run);
        animateRun(run);
        return duration === undefined
          ? originalStart.call(this, target, offset)
          : originalStart.call(this, target, offset, duration);
      }

      return duration === undefined
        ? originalStart.call(this, when, offset)
        : originalStart.call(this, when, offset, duration);
    };

    AudioBufferSourceNode.prototype.stop = function(...args) {
      cancelRun(sourceRuns.get(this));
      return originalStop.apply(this, args);
    };

    Object.defineProperty(AudioBufferSourceNode.prototype, '__tindersePreroll', { value: true });
  }

  function observeUi() {
    const tabs = document.getElementById('categoryTabs');
    const grid = document.getElementById('soundGrid');
    const title = document.getElementById('categoryTitle');
    const observer = new MutationObserver(() => queueMicrotask(decorateAll));
    if (tabs) observer.observe(tabs, { childList: true, subtree: true });
    if (grid) observer.observe(grid, { childList: true, subtree: true });
    if (title) observer.observe(title, { childList: true, subtree: true });
  }

  patchAudioStart();
  observeUi();
  ensureOverlay();
  decorateAll();
  loadDurations();

  if ('ResizeObserver' in window) {
    const wave = document.getElementById('waveCanvas');
    if (wave) new ResizeObserver(() => { clearOverlay(); }).observe(wave);
  }
})();
