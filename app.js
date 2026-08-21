(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    tabs: $('categoryTabs'),
    grid: $('soundGrid'),
    title: $('categoryTitle'),
    meta: $('categoryMeta'),
    selectedCount: $('selectedCount'),
    playedCount: $('playedCount'),
    loadStatus: $('loadStatus'),
    selectedOnlyBtn: $('selectedOnlyBtn'),
    unplayedOnlyBtn: $('unplayedOnlyBtn'),
    exportBtn: $('exportBtn'),
    importBtn: $('importBtn'),
    importInput: $('importInput'),
    packBtn: $('packBtn'),
    packInput: $('packInput'),
    empty: $('emptyState'),
    nowMain: $('nowMain'),
    waveCanvas: $('waveCanvas'),
    waveNowName: $('waveNowName'),
    waveNowEc: $('waveNowEc'),
    wavePinName: $('wavePinName'),
    wavePinEc: $('wavePinEc'),
    pinBtn: $('pinBtn')
  };

  let manifest = null;
  let activeCategory = null;
  let selectedOnly = false;
  let unplayedOnly = false;

  let packBuffer = null;
  let audioContext = null;
  let currentSource = null;
  let currentId = null;
  let pendingSound = null;

  let currentSound = null;
  let currentAnalysis = null;
  let pinnedId = null;
  let pinnedAnalysis = null;

  const decoded = new Map();
  const analyses = new Map();
  let selected = new Set();
  let played = new Set();

  const DB_NAME = 'TinderSEAudioDB';
  const DB_STORE = 'packs';
  const WAVE_WINDOW_MS = 130;
  const WAVE_BUCKETS = 768;
  const stateKey = (kind) => `tinderse:${manifest.version}:${kind}`;

  function saveState() {
    localStorage.setItem(stateKey('selected'), JSON.stringify([...selected]));
    localStorage.setItem(stateKey('played'), JSON.stringify([...played]));
  }

  function savePinnedState() {
    if (pinnedId) localStorage.setItem(stateKey('pinned'), pinnedId);
    else localStorage.removeItem(stateKey('pinned'));
  }

  function loadState() {
    try {
      selected = new Set(JSON.parse(localStorage.getItem(stateKey('selected')) || '[]'));
      played = new Set(JSON.parse(localStorage.getItem(stateKey('played')) || '[]'));
    } catch {
      selected = new Set();
      played = new Set();
    }

    const valid = new Set(manifest.sounds.map((s) => s.id));
    selected = new Set([...selected].filter((id) => valid.has(id)));
    played = new Set([...played].filter((id) => valid.has(id)));

    const storedPinned = localStorage.getItem(stateKey('pinned'));
    pinnedId = storedPinned && valid.has(storedPinned) ? storedPinned : null;
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(DB_STORE)) {
          req.result.createObjectStore(DB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbGet(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readonly');
      const req = tx.objectStore(DB_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    });
  }

  async function dbPut(key, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(value, key);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  }

  async function loadManifest() {
    const r = await fetch('mapping.csv', { cache: 'no-store' });
    if (!r.ok) throw new Error(`mapping.csv: ${r.status}`);

    const rows = parseCsv((await r.text()).replace(/^\uFEFF/, ''));
    const headers = rows[0].map((h) => h.trim());
    const pos = Object.fromEntries(headers.map((h, i) => [h, i]));
    const categoryOrder = ['Kick', 'SnareClap', 'Tom', 'RimStick', 'HiHat', 'Cymbal', 'Percussion'];
    const labels = {
      Kick: 'Kick',
      SnareClap: 'Snare / Clap',
      Tom: 'Tom / Timbale',
      RimStick: 'Rim / Stick',
      HiHat: 'Hi-Hat',
      Cymbal: 'Cymbal',
      Percussion: 'Percussion'
    };

    let offset = 0;
    const sounds = rows.slice(1).map((row) => {
      const filename = row[pos.new_name];
      const category = row[pos.category];
      const length = Number(row[pos.byte_length]);
      const m = /_(\d+)_\((RF|SC)_(\d+)Hz\)\.wav$/.exec(filename);
      const sound = {
        id: filename.slice(0, -4),
        category,
        categoryDisplay: labels[category],
        index: m ? Number(m[1]) : 0,
        filename,
        sourceName: row[pos.original_name],
        metric: row[pos.metric],
        frequencyHz: Number(row[pos.frequency_hz]),
        durationMs: Number(row[pos.final_duration_ms]),
        sampleRate: Number(row[pos.sample_rate]),
        offset,
        length
      };
      offset += length;
      return sound;
    });

    manifest = {
      version: '2026-08-21-v1',
      title: 'TinderSE',
      count: sounds.length,
      packFile: 'TinderSE_audio.pack',
      packSize: offset,
      categories: categoryOrder.map((id) => ({
        id,
        label: labels[id],
        count: sounds.filter((s) => s.category === id).length
      })),
      sounds
    };

    loadState();
    activeCategory = manifest.categories[0]?.id || null;
  }

  function setPackStatus(state, text) {
    els.loadStatus.classList.remove('ready', 'error');
    els.packBtn.classList.remove('ready');
    if (state) els.loadStatus.classList.add(state);
    els.loadStatus.textContent = text;

    if (state === 'ready') {
      els.packBtn.textContent = '音源パック ✓';
      els.packBtn.classList.add('ready');
    } else {
      els.packBtn.textContent = '音源パック読込';
    }
  }

  function validatePack(buf) {
    if (!(buf instanceof ArrayBuffer)) return false;
    if (manifest.packSize && buf.byteLength !== manifest.packSize) return false;

    const bytes = new Uint8Array(buf);
    for (const s of [manifest.sounds[0], manifest.sounds[Math.floor(manifest.sounds.length / 2)], manifest.sounds.at(-1)]) {
      if (!s) continue;
      const o = s.offset;
      if (String.fromCharCode(...bytes.slice(o, o + 4)) !== 'RIFF') return false;
      if (String.fromCharCode(...bytes.slice(o + 8, o + 12)) !== 'WAVE') return false;
    }
    return true;
  }

  async function restorePack() {
    try {
      setPackStatus('', '保存済み音源を確認中…');
      const saved = await dbGet(manifest.version);
      if (saved) {
        const buf = saved instanceof ArrayBuffer ? saved : await saved.arrayBuffer();
        if (validatePack(buf)) {
          packBuffer = buf;
          setPackStatus('ready', `音源 ${manifest.count}件 準備完了`);
          return true;
        }
      }
    } catch (err) {
      console.warn('pack restore failed', err);
    }

    setPackStatus('', '音源パックを1回読み込んでください');
    return false;
  }

  async function importPack(file) {
    setPackStatus('', '音源パックを読み込み中…');
    const buf = await file.arrayBuffer();
    if (!validatePack(buf)) throw new Error('このTinderSE用の音源パックではありません。');

    packBuffer = buf;
    decoded.clear();
    analyses.clear();
    currentAnalysis = null;
    pinnedAnalysis = null;

    await dbPut(manifest.version, new Blob([buf], { type: 'application/octet-stream' }));
    setPackStatus('ready', `音源 ${manifest.count}件 準備完了`);
    updateWaveDock();
  }

  async function ensureAudioContext() {
    if (!audioContext) {
      const AC = window.AudioContext || window.webkitAudioContext;
      audioContext = new AC({ latencyHint: 'interactive' });
    }
    if (audioContext.state !== 'running') await audioContext.resume();
  }

  async function decodeSound(sound) {
    if (decoded.has(sound.id)) return decoded.get(sound.id);
    if (!packBuffer) throw new Error('NO_PACK');

    const chunk = packBuffer.slice(sound.offset, sound.offset + sound.length);
    const audio = await audioContext.decodeAudioData(chunk.slice(0));
    decoded.set(sound.id, audio);
    return audio;
  }

  function analyzeAudio(sound, audio) {
    if (analyses.has(sound.id)) return analyses.get(sound.id);

    const sampleRate = audio.sampleRate;
    const channels = audio.numberOfChannels;
    const frameCount = audio.length;
    const min = new Float32Array(WAVE_BUCKETS);
    const max = new Float32Array(WAVE_BUCKETS);
    const channelData = Array.from({ length: channels }, (_, ch) => audio.getChannelData(ch));
    const windowFrames = Math.round((WAVE_WINDOW_MS / 1000) * sampleRate);

    for (let b = 0; b < WAVE_BUCKETS; b++) {
      const start = Math.floor((b / WAVE_BUCKETS) * windowFrames);
      const end = Math.min(frameCount, Math.max(start + 1, Math.floor(((b + 1) / WAVE_BUCKETS) * windowFrames)));

      if (start >= frameCount) {
        min[b] = 0;
        max[b] = 0;
        continue;
      }

      let lo = 1;
      let hi = -1;
      for (let i = start; i < end; i++) {
        for (let ch = 0; ch < channels; ch++) {
          const v = channelData[ch][i];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      min[b] = lo;
      max[b] = hi;
    }

    let energySum = 0;
    let weightedTime = 0;
    for (let i = 0; i < frameCount; i++) {
      let e = 0;
      for (let ch = 0; ch < channels; ch++) {
        const v = channelData[ch][i];
        e += v * v;
      }
      e /= channels;
      energySum += e;
      weightedTime += (i / sampleRate) * 1000 * e;
    }

    const centroidMs = energySum > 0 ? weightedTime / energySum : 0;
    const analysis = { sound, min, max, centroidMs };
    analyses.set(sound.id, analysis);
    return analysis;
  }

  async function ensureAnalysis(sound) {
    if (analyses.has(sound.id)) return analyses.get(sound.id);
    const audio = await decodeSound(sound);
    return analyzeAudio(sound, audio);
  }

  async function ensurePinnedAnalysis() {
    if (!pinnedId || pinnedAnalysis || !packBuffer || !audioContext) return;
    const sound = manifest.sounds.find((s) => s.id === pinnedId);
    if (!sound) return;

    try {
      pinnedAnalysis = await ensureAnalysis(sound);
      updateWaveDock();
    } catch (err) {
      console.warn('pinned waveform restore failed', err);
    }
  }

  async function playSound(sound) {
    try {
      await ensureAudioContext();

      if (!packBuffer) {
        pendingSound = sound;
        els.packInput.click();
        return;
      }

      const audio = await decodeSound(sound);
      currentAnalysis = analyzeAudio(sound, audio);
      currentSound = sound;

      if (currentSource) {
        try { currentSource.stop(0); } catch {}
        try { currentSource.disconnect(); } catch {}
      }

      const src = audioContext.createBufferSource();
      src.buffer = audio;
      src.connect(audioContext.destination);
      currentSource = src;
      currentId = sound.id;

      played.add(sound.id);
      saveState();
      updateWaveDock();
      renderGrid();
      updateSummary();

      if (pinnedId && pinnedId !== sound.id && !pinnedAnalysis) {
        ensurePinnedAnalysis();
      }

      src.onended = () => {
        if (currentSource === src) {
          currentSource = null;
          currentId = null;
          renderGrid();
        }
      };
      src.start(0);
    } catch (err) {
      console.error(err);
      alert(err.message === 'NO_PACK'
        ? '音源パックを読み込んでください。'
        : '音源を再生できませんでした。ページを再読み込みして再試行してください。');
    }
  }

  function togglePin() {
    if (!currentSound || !currentAnalysis) return;

    if (pinnedId === currentSound.id) {
      pinnedId = null;
      pinnedAnalysis = null;
    } else {
      pinnedId = currentSound.id;
      pinnedAnalysis = currentAnalysis;
    }

    savePinnedState();
    updateWaveDock();
  }

  function cssColor(name, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  }

  function drawAnalysis(ctx, analysis, width, height, pinned) {
    if (!analysis) return;

    const padTop = 5;
    const padBottom = 5;
    const mid = height / 2;
    const amp = (height - padTop - padBottom) / 2;
    const n = analysis.min.length;

    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * width;
      const y = mid - analysis.max[i] * amp;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    for (let i = n - 1; i >= 0; i--) {
      const x = (i / (n - 1)) * width;
      const y = mid - analysis.min[i] * amp;
      ctx.lineTo(x, y);
    }
    ctx.closePath();

    if (pinned) {
      ctx.strokeStyle = cssColor('--wave-pin', '#8f9aa7');
      ctx.lineWidth = 1.25;
      ctx.setLineDash([5, 4]);
      ctx.globalAlpha = 0.8;
      ctx.stroke();
    } else {
      ctx.strokeStyle = cssColor('--wave-now', '#26384b');
      ctx.fillStyle = 'rgba(38,56,75,.055)';
      ctx.lineWidth = 1.45;
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.fill();
      ctx.stroke();
    }

    const centroidX = Math.max(0, Math.min(width, (analysis.centroidMs / WAVE_WINDOW_MS) * width));
    ctx.beginPath();
    ctx.moveTo(centroidX, 2);
    ctx.lineTo(centroidX, height - 2);
    ctx.strokeStyle = pinned ? cssColor('--wave-pin', '#8f9aa7') : cssColor('--centroid', '#d94f47');
    ctx.lineWidth = pinned ? 1 : 1.4;
    ctx.setLineDash(pinned ? [3, 3] : []);
    ctx.globalAlpha = pinned ? 0.72 : 0.95;
    ctx.stroke();
    ctx.restore();
  }

  function drawWaveform() {
    const canvas = els.waveCanvas;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = rect.width;
    const h = rect.height;
    ctx.clearRect(0, 0, w, h);

    ctx.save();
    ctx.strokeStyle = '#e3e8ee';
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    ctx.strokeStyle = '#edf1f5';
    for (const ms of [25, 50, 75, 100]) {
      const x = (ms / WAVE_WINDOW_MS) * w;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    ctx.restore();

    if (pinnedAnalysis) drawAnalysis(ctx, pinnedAnalysis, w, h, true);
    if (currentAnalysis) drawAnalysis(ctx, currentAnalysis, w, h, false);
  }

  function updateWaveDock() {
    if (!manifest) return;

    if (currentSound && currentAnalysis) {
      els.nowMain.textContent = currentSound.filename;
      els.waveNowName.textContent = `NOW ${currentSound.filename}`;
      els.waveNowEc.textContent = `Energy Centroid ${currentAnalysis.centroidMs.toFixed(1)} ms`;
      els.pinBtn.disabled = false;
    } else {
      els.nowMain.textContent = '音源をタップしてください';
      els.waveNowName.textContent = 'NOW —';
      els.waveNowEc.textContent = 'Energy Centroid —';
      els.pinBtn.disabled = true;
    }

    const pinnedSound = pinnedId ? manifest.sounds.find((s) => s.id === pinnedId) : null;
    if (pinnedSound) {
      els.wavePinName.textContent = `PIN ${pinnedSound.filename}`;
      els.wavePinEc.textContent = pinnedAnalysis
        ? `Energy Centroid ${pinnedAnalysis.centroidMs.toFixed(1)} ms`
        : 'Energy Centroid —';
    } else {
      els.wavePinName.textContent = 'PIN —';
      els.wavePinEc.textContent = '';
    }

    const same = Boolean(currentSound && pinnedId === currentSound.id);
    els.pinBtn.textContent = same ? 'ピン解除' : (pinnedId ? 'この波形で置換' : '波形をピン止め');
    els.pinBtn.classList.toggle('pinned', Boolean(pinnedId));

    requestAnimationFrame(drawWaveform);
  }

  function toggleSelected(id) {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    saveState();
    renderGrid();
    updateSummary();
  }

  function renderTabs() {
    els.tabs.innerHTML = '';
    manifest.categories.forEach((cat) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `category-tab${cat.id === activeCategory ? ' active' : ''}`;
      b.innerHTML = `${escapeHtml(cat.label)}<span class="count">${cat.count}</span>`;
      b.addEventListener('click', () => {
        activeCategory = cat.id;
        selectedOnly = false;
        unplayedOnly = false;
        els.selectedOnlyBtn.setAttribute('aria-pressed', 'false');
        els.unplayedOnlyBtn.setAttribute('aria-pressed', 'false');
        renderTabs();
        renderGrid();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
      els.tabs.appendChild(b);
    });
  }

  function visibleSounds() {
    return manifest.sounds.filter((s) =>
      s.category === activeCategory &&
      (!selectedOnly || selected.has(s.id)) &&
      (!unplayedOnly || !played.has(s.id))
    );
  }

  function renderGrid() {
    if (!manifest || !activeCategory) return;

    const cat = manifest.categories.find((c) => c.id === activeCategory);
    const all = manifest.sounds.filter((s) => s.category === activeCategory);
    els.title.textContent = cat.label;
    els.meta.textContent = `${cat.count}件 ・ 採用 ${all.filter((s) => selected.has(s.id)).length} ・ 試聴 ${all.filter((s) => played.has(s.id)).length}`;

    const sounds = visibleSounds();
    els.grid.innerHTML = '';
    els.empty.hidden = sounds.length !== 0;

    const frag = document.createDocumentFragment();
    for (const sound of sounds) {
      const card = document.createElement('article');
      const isSelected = selected.has(sound.id);
      const isPlayed = played.has(sound.id);
      const isPlaying = currentId === sound.id;
      card.className = `sound-card${isSelected ? ' selected' : ''}${isPlayed ? ' played' : ''}${isPlaying ? ' playing' : ''}`;

      const play = document.createElement('button');
      play.type = 'button';
      play.className = 'play-area';
      play.setAttribute('aria-label', `${sound.filename} を再生`);
      play.innerHTML = `<div class="card-top"><div class="index">${String(sound.index).padStart(2, '0')}</div><div class="play-mark">${isPlaying ? '■' : '▶'}</div></div><div class="metric"><strong>${escapeHtml(sound.metric)} ${sound.frequencyHz.toLocaleString()} Hz</strong></div><div class="duration">${sound.durationMs.toFixed(1)} ms</div>`;
      play.addEventListener('click', () => playSound(sound));

      const row = document.createElement('div');
      row.className = 'select-row';
      const sel = document.createElement('button');
      sel.type = 'button';
      sel.className = 'select-btn';
      sel.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
      sel.innerHTML = `<span class="select-check">${isSelected ? '✓' : '○'}</span>${isSelected ? '採用中' : '採用'}`;
      sel.addEventListener('click', () => toggleSelected(sound.id));

      row.appendChild(sel);
      card.append(play, row);
      frag.appendChild(card);
    }
    els.grid.appendChild(frag);
  }

  function updateSummary() {
    els.selectedCount.textContent = `採用 ${selected.size}`;
    els.playedCount.textContent = `試聴 ${played.size} / ${manifest.count}`;
  }

  function csvEscape(value) {
    const s = String(value ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  }

  function exportCsv() {
    const rows = manifest.sounds.filter((s) => selected.has(s.id));
    if (!rows.length) {
      alert('採用音源がまだ選択されていません。');
      return;
    }

    const lines = [['filename', 'category', 'metric', 'frequency_hz', 'source_name'].join(',')];
    rows.forEach((s) => {
      lines.push([s.filename, s.category, s.metric, s.frequencyHz, s.sourceName].map(csvEscape).join(','));
    });

    const blob = new Blob(['\uFEFF' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const d = new Date();
    const stamp = [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('');
    a.download = `TinderSE_selection_${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    const u = a.href;
    a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 1000);
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') {
          field += '"';
          i++;
        } else if (ch === '"') {
          quoted = false;
        } else {
          field += ch;
        }
      } else if (ch === '"') {
        quoted = true;
      } else if (ch === ',') {
        row.push(field);
        field = '';
      } else if (ch === '\n') {
        row.push(field.replace(/\r$/, ''));
        rows.push(row);
        row = [];
        field = '';
      } else {
        field += ch;
      }
    }

    if (field.length || row.length) {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
    }
    return rows.filter((r) => r.some((v) => v.trim() !== ''));
  }

  async function importCsv(file) {
    const rows = parseCsv((await file.text()).replace(/^\uFEFF/, ''));
    if (rows.length < 2) throw new Error('CSVに選択データがありません。');

    const headers = rows[0].map((h) => h.trim().toLowerCase());
    let idx = headers.indexOf('filename');
    if (idx < 0) idx = 0;

    const byName = new Map(manifest.sounds.map((s) => [s.filename, s.id]));
    const imported = new Set();
    for (const row of rows.slice(1)) {
      const id = byName.get((row[idx] || '').trim());
      if (id) imported.add(id);
    }

    if (!imported.size) throw new Error('このTinderSEに一致するファイル名が見つかりません。');

    const replace = confirm(`CSVから ${imported.size}件 読み込みます。現在の採用選択を置き換えますか？\n\nOK: 置き換え / キャンセル: 追加`);
    selected = replace ? imported : new Set([...selected, ...imported]);
    saveState();
    renderGrid();
    updateSummary();
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    })[c]);
  }

  els.selectedOnlyBtn.addEventListener('click', () => {
    selectedOnly = !selectedOnly;
    els.selectedOnlyBtn.setAttribute('aria-pressed', selectedOnly ? 'true' : 'false');
    renderGrid();
  });

  els.unplayedOnlyBtn.addEventListener('click', () => {
    unplayedOnly = !unplayedOnly;
    els.unplayedOnlyBtn.setAttribute('aria-pressed', unplayedOnly ? 'true' : 'false');
    renderGrid();
  });

  els.exportBtn.addEventListener('click', exportCsv);
  els.importBtn.addEventListener('click', () => els.importInput.click());
  els.packBtn.addEventListener('click', () => els.packInput.click());
  els.pinBtn.addEventListener('click', togglePin);

  els.importInput.addEventListener('change', async () => {
    const file = els.importInput.files?.[0];
    els.importInput.value = '';
    if (!file) return;
    try {
      await importCsv(file);
    } catch (err) {
      console.error(err);
      alert(err.message || 'CSVを読み込めませんでした。');
    }
  });

  els.packInput.addEventListener('change', async () => {
    const file = els.packInput.files?.[0];
    els.packInput.value = '';
    if (!file) return;

    try {
      await importPack(file);
      const next = pendingSound;
      pendingSound = null;
      if (next) await playSound(next);
    } catch (err) {
      console.error(err);
      setPackStatus('error', '音源パックを読み込めませんでした');
      alert(err.message || '音源パックを読み込めませんでした。');
    }
  });

  if ('ResizeObserver' in window) {
    const ro = new ResizeObserver(() => drawWaveform());
    ro.observe(els.waveCanvas);
  } else {
    window.addEventListener('resize', drawWaveform);
  }

  (async function init() {
    try {
      await loadManifest();
      renderTabs();
      renderGrid();
      updateSummary();
      updateWaveDock();
      await restorePack();
    } catch (err) {
      console.error(err);
      els.title.textContent = '読み込みエラー';
      els.meta.textContent = 'ページを再読み込みしてください。';
      setPackStatus('error', 'データを読み込めませんでした');
    }
  })();
})();
