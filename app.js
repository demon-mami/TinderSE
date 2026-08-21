(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    tabs: $('categoryTabs'), grid: $('soundGrid'), title: $('categoryTitle'), meta: $('categoryMeta'),
    selectedCount: $('selectedCount'), consultCount: $('consultCount'), playedCount: $('playedCount'),
    loadStatus: $('loadStatus'), selectedOnlyBtn: $('selectedOnlyBtn'), consultOnlyBtn: $('consultOnlyBtn'),
    unplayedOnlyBtn: $('unplayedOnlyBtn'), exportBtn: $('exportBtn'), importBtn: $('importBtn'),
    importInput: $('importInput'), packBtn: $('packBtn'), packInput: $('packInput'), empty: $('emptyState'),
    nowMain: $('nowMain'), waveCanvas: $('waveCanvas'), waveNowEc: $('waveNowEc'),
    wavePinRow: $('wavePinRow'), wavePinName: $('wavePinName'), wavePinEc: $('wavePinEc'), pinBtn: $('pinBtn')
  };

  let manifest = null;
  let activeCategory = null;
  let selectedOnly = false;
  let consultOnly = false;
  let unplayedOnly = false;

  let packBuffer = null;
  let audioContext = null;
  let currentSource = null;
  let currentId = null;
  let currentPlaybackKind = null;
  let pendingPlayback = null;

  let currentSound = null;
  let currentAnalysis = null;
  let pinnedId = null;
  let pinnedAnalysis = null;

  const decoded = new Map();
  const analyses = new Map();
  let selected = new Set();
  let consult = new Set();
  let played = new Set();

  const DB_NAME = 'TinderSEAudioDB';
  const DB_STORE = 'packs';
  const WAVE_WINDOW_MS = 130;
  const WAVE_BUCKETS = 768;
  const PREVIOUS_VERSION = '2026-08-21-v1';
  const stateKey = (kind) => `tinderse:${manifest.version}:${kind}`;
  const previousStateKey = (kind) => `tinderse:${PREVIOUS_VERSION}:${kind}`;

  function saveState() {
    localStorage.setItem(stateKey('selected'), JSON.stringify([...selected]));
    localStorage.setItem(stateKey('consult'), JSON.stringify([...consult]));
    localStorage.setItem(stateKey('played'), JSON.stringify([...played]));
  }

  function savePinnedState() {
    if (pinnedId) localStorage.setItem(stateKey('pinned'), pinnedId);
    else localStorage.removeItem(stateKey('pinned'));
  }

  function readStoredArray(kind) {
    const own = localStorage.getItem(stateKey(kind));
    const raw = own ?? localStorage.getItem(previousStateKey(kind));
    if (!raw) return [];
    try { return JSON.parse(raw); } catch { return []; }
  }

  function loadState() {
    selected = new Set(readStoredArray('selected'));
    consult = new Set(readStoredArray('consult'));
    played = new Set(readStoredArray('played'));

    const valid = new Set(manifest.sounds.map((s) => s.id));
    selected = new Set([...selected].filter((id) => valid.has(id)));
    consult = new Set([...consult].filter((id) => valid.has(id) && !selected.has(id)));
    played = new Set([...played].filter((id) => valid.has(id)));

    const ownPinned = localStorage.getItem(stateKey('pinned'));
    const oldPinned = localStorage.getItem(previousStateKey('pinned'));
    const storedPinned = ownPinned ?? oldPinned;
    pinnedId = storedPinned && valid.has(storedPinned) ? storedPinned : null;

    saveState();
    savePinnedState();
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE);
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
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  }

  async function loadManifest() {
    const [mapRes, extRes] = await Promise.all([
      fetch('mapping.csv', { cache: 'no-store' }),
      fetch('extended.csv', { cache: 'no-store' })
    ]);
    if (!mapRes.ok) throw new Error(`mapping.csv: ${mapRes.status}`);
    if (!extRes.ok) throw new Error(`extended.csv: ${extRes.status}`);

    const rows = parseCsv((await mapRes.text()).replace(/^\uFEFF/, ''));
    const headers = rows[0].map((h) => h.trim());
    const pos = Object.fromEntries(headers.map((h, i) => [h, i]));

    const extRows = parseCsv((await extRes.text()).replace(/^\uFEFF/, ''));
    const extHeaders = extRows[0].map((h) => h.trim());
    const extPos = Object.fromEntries(extHeaders.map((h, i) => [h, i]));
    const extByName = new Map(extRows.slice(1).map((row) => [row[extPos.new_name], {
      offset: Number(row[extPos.extended_offset]),
      length: Number(row[extPos.extended_byte_length]),
      durationMs: Number(row[extPos.extended_duration_ms])
    }]));

    const categoryOrder = ['Kick', 'SnareClap', 'Tom', 'RimStick', 'HiHat', 'Cymbal', 'Percussion'];
    const labels = {
      Kick: 'Kick', SnareClap: 'Snare / Clap', Tom: 'Tom / Timbale', RimStick: 'Rim / Stick',
      HiHat: 'Hi-Hat', Cymbal: 'Cymbal', Percussion: 'Percussion'
    };

    let mainOffset = 0;
    const sounds = rows.slice(1).map((row) => {
      const filename = row[pos.new_name];
      const category = row[pos.category];
      const length = Number(row[pos.byte_length]);
      const m = /_(\d+)_\((RF|SC)_(\d+)Hz\)\.wav$/.exec(filename);
      const ext = extByName.get(filename) || null;
      const sound = {
        id: filename.slice(0, -4), category, categoryDisplay: labels[category],
        index: m ? Number(m[1]) : 0, filename, sourceName: row[pos.original_name],
        metric: row[pos.metric], frequencyHz: Number(row[pos.frequency_hz]),
        durationMs: Number(row[pos.final_duration_ms]), sampleRate: Number(row[pos.sample_rate]),
        offset: mainOffset, length,
        extendedAvailable: Boolean(ext),
        extendedOffset: ext?.offset ?? null,
        extendedLength: ext?.length ?? null,
        extendedDurationMs: ext?.durationMs ?? null
      };
      mainOffset += length;
      return sound;
    });

    const packSize = sounds.reduce((max, sound) => Math.max(
      max,
      sound.offset + sound.length,
      sound.extendedAvailable ? sound.extendedOffset + sound.extendedLength : 0
    ), 0);

    manifest = {
      version: '2026-08-21-v2', title: 'TinderSE', count: sounds.length,
      packFile: 'TinderSE_audio_v2.pack', packSize,
      categories: categoryOrder.map((id) => ({ id, label: labels[id], count: sounds.filter((s) => s.category === id).length })),
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
    const probes = [manifest.sounds[0], manifest.sounds[Math.floor(manifest.sounds.length / 2)], manifest.sounds.at(-1)];
    for (const s of probes) {
      if (!s) continue;
      for (const o of [s.offset, s.extendedAvailable ? s.extendedOffset : null]) {
        if (o == null) continue;
        if (String.fromCharCode(...bytes.slice(o, o + 4)) !== 'RIFF') return false;
        if (String.fromCharCode(...bytes.slice(o + 8, o + 12)) !== 'WAVE') return false;
      }
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
    setPackStatus('', '新しい音源パックを1回読み込んでください');
    return false;
  }

  async function importPack(file) {
    setPackStatus('', '音源パックを読み込み中…');
    const buf = await file.arrayBuffer();
    if (!validatePack(buf)) throw new Error('このTinderSE用の音源パックではありません。');

    stopCurrent();
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

  function sliceFor(sound, kind) {
    if (kind === 'extended') {
      if (!sound.extendedAvailable) throw new Error('NO_EXTENDED');
      return [sound.extendedOffset, sound.extendedLength];
    }
    return [sound.offset, sound.length];
  }

  async function decodeSound(sound, kind = 'main') {
    const key = `${sound.id}::${kind}`;
    if (decoded.has(key)) return decoded.get(key);
    if (!packBuffer) throw new Error('NO_PACK');
    const [offset, length] = sliceFor(sound, kind);
    const chunk = packBuffer.slice(offset, offset + length);
    const audio = await audioContext.decodeAudioData(chunk.slice(0));
    decoded.set(key, audio);
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
      if (start >= frameCount) { min[b] = 0; max[b] = 0; continue; }
      let lo = 1, hi = -1;
      for (let i = start; i < end; i++) {
        for (let ch = 0; ch < channels; ch++) {
          const v = channelData[ch][i];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      min[b] = lo; max[b] = hi;
    }

    let energySum = 0, weightedTime = 0;
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
    const audio = await decodeSound(sound, 'main');
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

  function stopCurrent() {
    if (currentSource) {
      try { currentSource.stop(0); } catch {}
      try { currentSource.disconnect(); } catch {}
    }
    currentSource = null;
    currentId = null;
    currentPlaybackKind = null;
  }

  async function playSound(sound, kind = 'main') {
    try {
      await ensureAudioContext();
      if (!packBuffer) {
        pendingPlayback = { sound, kind };
        els.packInput.click();
        return;
      }

      if (currentSource && currentId === sound.id && currentPlaybackKind === kind) {
        stopCurrent();
        renderGrid();
        return;
      }

      const audio = await decodeSound(sound, kind);
      stopCurrent();

      if (kind === 'main') {
        currentAnalysis = analyzeAudio(sound, audio);
        currentSound = sound;
        played.add(sound.id);
        saveState();
        updateWaveDock();
      }

      const src = audioContext.createBufferSource();
      src.buffer = audio;
      src.connect(audioContext.destination);
      currentSource = src;
      currentId = sound.id;
      currentPlaybackKind = kind;
      renderGrid();
      updateSummary();

      if (kind === 'main' && pinnedId && pinnedId !== sound.id && !pinnedAnalysis) ensurePinnedAnalysis();

      src.onended = () => {
        if (currentSource === src) {
          currentSource = null;
          currentId = null;
          currentPlaybackKind = null;
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
    updateWaveDock(true);
  }

  function cssColor(name, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  }

  function drawAnalysis(ctx, analysis, width, height, pinned) {
    if (!analysis) return;
    const padTop = 5, padBottom = 5;
    const mid = height / 2;
    const amp = (height - padTop - padBottom) / 2;
    const n = analysis.min.length;

    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * width;
      const y = mid - analysis.max[i] * amp;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    for (let i = n - 1; i >= 0; i--) {
      const x = (i / (n - 1)) * width;
      const y = mid - analysis.min[i] * amp;
      ctx.lineTo(x, y);
    }
    ctx.closePath();

    if (pinned) {
      ctx.strokeStyle = cssColor('--wave-pin', '#9a7488');
      ctx.lineWidth = 1.35;
      ctx.setLineDash([5, 4]);
      ctx.globalAlpha = 0.9;
      ctx.stroke();
    } else {
      ctx.strokeStyle = cssColor('--wave-now', '#477a84');
      ctx.fillStyle = 'rgba(71,122,132,.07)';
      ctx.lineWidth = 1.55;
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.fill();
      ctx.stroke();
    }

    const centroidX = Math.max(0, Math.min(width, (analysis.centroidMs / WAVE_WINDOW_MS) * width));
    ctx.beginPath();
    ctx.moveTo(centroidX, 2);
    ctx.lineTo(centroidX, height - 2);
    ctx.strokeStyle = pinned ? cssColor('--wave-pin-deep', '#765869') : cssColor('--centroid', '#2f6770');
    ctx.lineWidth = pinned ? 1.05 : 1.45;
    ctx.setLineDash(pinned ? [3, 3] : []);
    ctx.globalAlpha = pinned ? 0.8 : 0.98;
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
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = rect.width, h = rect.height;
    ctx.clearRect(0, 0, w, h);

    ctx.save();
    ctx.strokeStyle = 'rgba(78,111,116,.18)';
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(78,111,116,.10)';
    for (const ms of [25, 50, 75, 100]) {
      const x = (ms / WAVE_WINDOW_MS) * w;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    ctx.restore();

    if (pinnedAnalysis) drawAnalysis(ctx, pinnedAnalysis, w, h, true);
    if (currentAnalysis) drawAnalysis(ctx, currentAnalysis, w, h, false);
  }

  function updateWaveDock(animatePin = false) {
    if (!manifest) return;

    if (currentSound && currentAnalysis) {
      els.nowMain.textContent = currentSound.filename;
      els.waveNowEc.textContent = `EC ${currentAnalysis.centroidMs.toFixed(1)} ms`;
      els.waveNowEc.setAttribute('aria-label', `Energy Centroid ${currentAnalysis.centroidMs.toFixed(1)} ms`);
      els.pinBtn.disabled = false;
    } else {
      els.nowMain.textContent = '音源をタップしてください';
      els.waveNowEc.textContent = 'EC —';
      els.pinBtn.disabled = true;
    }

    const pinnedSound = pinnedId ? manifest.sounds.find((s) => s.id === pinnedId) : null;
    if (pinnedSound) {
      els.wavePinRow.hidden = false;
      els.wavePinName.textContent = pinnedSound.filename;
      els.wavePinEc.textContent = pinnedAnalysis ? `EC ${pinnedAnalysis.centroidMs.toFixed(1)} ms` : 'EC —';
      if (animatePin) {
        els.wavePinRow.classList.remove('fresh');
        void els.wavePinRow.offsetWidth;
        els.wavePinRow.classList.add('fresh');
        setTimeout(() => els.wavePinRow.classList.remove('fresh'), 320);
      }
    } else {
      els.wavePinRow.hidden = true;
      els.wavePinName.textContent = '';
      els.wavePinEc.textContent = '';
    }

    const same = Boolean(currentSound && pinnedId === currentSound.id);
    const state = same ? 'locked' : (pinnedId ? 'replace' : 'empty');
    els.pinBtn.dataset.state = state;
    els.pinBtn.setAttribute('aria-label', same
      ? '固定した比較波形を解除'
      : (pinnedId ? '固定した比較波形を現在の波形へ入れ替え' : '現在の波形を比較基準として固定'));

    els.pinBtn.classList.remove('state-change');
    if (animatePin) {
      void els.pinBtn.offsetWidth;
      els.pinBtn.classList.add('state-change');
      setTimeout(() => els.pinBtn.classList.remove('state-change'), 280);
    }

    requestAnimationFrame(drawWaveform);
  }

  function toggleSelected(id) {
    if (selected.has(id)) {
      selected.delete(id);
    } else {
      selected.add(id);
      consult.delete(id);
    }
    saveState();
    renderGrid();
    updateSummary();
  }

  function toggleConsult(id) {
    if (consult.has(id)) {
      consult.delete(id);
    } else {
      consult.add(id);
      selected.delete(id);
    }
    saveState();
    renderGrid();
    updateSummary();
  }

  function resetCategoryFilters() {
    selectedOnly = false;
    consultOnly = false;
    unplayedOnly = false;
    els.selectedOnlyBtn.setAttribute('aria-pressed', 'false');
    els.consultOnlyBtn.setAttribute('aria-pressed', 'false');
    els.unplayedOnlyBtn.setAttribute('aria-pressed', 'false');
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
        resetCategoryFilters();
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
      (!consultOnly || consult.has(s.id)) &&
      (!unplayedOnly || !played.has(s.id))
    );
  }

  function renderGrid() {
    if (!manifest || !activeCategory) return;
    const cat = manifest.categories.find((c) => c.id === activeCategory);
    const all = manifest.sounds.filter((s) => s.category === activeCategory);
    const selectedN = all.filter((s) => selected.has(s.id)).length;
    const consultN = all.filter((s) => consult.has(s.id)).length;
    const playedN = all.filter((s) => played.has(s.id)).length;
    els.title.textContent = cat.label;
    els.meta.textContent = `${cat.count}件 ・ ✓ ${selectedN} ・ ? ${consultN} ・ 試聴 ${playedN}`;

    const sounds = visibleSounds();
    els.grid.innerHTML = '';
    els.empty.hidden = sounds.length !== 0;
    const frag = document.createDocumentFragment();

    for (const sound of sounds) {
      const card = document.createElement('article');
      const isSelected = selected.has(sound.id);
      const isConsult = consult.has(sound.id);
      const isPlayed = played.has(sound.id);
      const isMainPlaying = currentId === sound.id && currentPlaybackKind === 'main';
      const isExtendedPlaying = currentId === sound.id && currentPlaybackKind === 'extended';
      card.className = `sound-card${isSelected ? ' selected' : ''}${isConsult ? ' consult' : ''}${isPlayed ? ' played' : ''}${isMainPlaying ? ' playing-main' : ''}`;

      const play = document.createElement('button');
      play.type = 'button';
      play.className = 'play-area';
      play.setAttribute('aria-label', `${sound.filename} 130ms版を再生`);
      play.innerHTML = `
        <div class="card-top">
          <div class="index">${String(sound.index).padStart(2, '0')}</div>
          <div class="play-mark">${isMainPlaying ? '■' : '▶'}</div>
        </div>
        <div class="metric"><strong>${escapeHtml(sound.metric)} ${sound.frequencyHz.toLocaleString()} Hz</strong></div>`;
      play.addEventListener('click', () => playSound(sound, 'main'));

      const detail = document.createElement('div');
      detail.className = 'card-detail-row';
      const duration = document.createElement('span');
      duration.className = 'duration';
      duration.textContent = `${sound.durationMs.toFixed(1)} ms`;
      detail.appendChild(duration);

      if (sound.extendedAvailable) {
        const ext = document.createElement('button');
        ext.type = 'button';
        ext.className = `extended-play${isExtendedPlaying ? ' playing' : ''}`;
        ext.textContent = '130+';
        ext.setAttribute('aria-label', `130msカット前を再生 ${sound.extendedDurationMs.toFixed(0)}ms`);
        ext.addEventListener('click', () => playSound(sound, 'extended'));
        detail.appendChild(ext);
      } else {
        const spacer = document.createElement('span');
        spacer.setAttribute('aria-hidden', 'true');
        detail.appendChild(spacer);
      }

      const row = document.createElement('div');
      row.className = 'decision-row';

      const sel = document.createElement('button');
      sel.type = 'button';
      sel.className = 'select-btn';
      sel.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
      sel.innerHTML = `<span class="select-check">${isSelected ? '✓' : '○'}</span>${isSelected ? '採用中' : '採用'}`;
      sel.addEventListener('click', () => toggleSelected(sound.id));

      const ask = document.createElement('button');
      ask.type = 'button';
      ask.className = 'consult-btn';
      ask.textContent = '?';
      ask.setAttribute('aria-label', isConsult ? '要相談を解除' : '要相談にする');
      ask.setAttribute('aria-pressed', isConsult ? 'true' : 'false');
      ask.addEventListener('click', () => toggleConsult(sound.id));

      row.append(sel, ask);
      card.append(play, detail, row);
      frag.appendChild(card);
    }
    els.grid.appendChild(frag);
  }

  function updateSummary() {
    els.selectedCount.textContent = `✓ ${selected.size}`;
    els.consultCount.textContent = `? ${consult.size}`;
    els.playedCount.textContent = `試聴 ${played.size} / ${manifest.count}`;
  }

  function csvEscape(value) {
    const s = String(value ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  }

  function exportCsv() {
    const rows = manifest.sounds.filter((s) => selected.has(s.id) || consult.has(s.id));
    if (!rows.length) {
      alert('採用または要相談の音源がまだありません。');
      return;
    }

    const lines = [['filename', 'category', 'decision', 'metric', 'frequency_hz', 'source_name'].join(',')];
    rows.forEach((s) => {
      const decision = selected.has(s.id) ? 'selected' : 'consult';
      lines.push([s.filename, s.category, decision, s.metric, s.frequencyHz, s.sourceName].map(csvEscape).join(','));
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

  async function importCsv(file) {
    const rows = parseCsv((await file.text()).replace(/^\uFEFF/, ''));
    if (rows.length < 2) throw new Error('CSVに選択データがありません。');
    const headers = rows[0].map((h) => h.trim().toLowerCase());
    let nameIdx = headers.indexOf('filename');
    if (nameIdx < 0) nameIdx = 0;
    const decisionIdx = headers.indexOf('decision');
    const byName = new Map(manifest.sounds.map((s) => [s.filename, s.id]));
    const importedSelected = new Set();
    const importedConsult = new Set();

    for (const row of rows.slice(1)) {
      const id = byName.get((row[nameIdx] || '').trim());
      if (!id) continue;
      const decision = decisionIdx >= 0 ? (row[decisionIdx] || '').trim().toLowerCase() : 'selected';
      if (decision === 'consult') importedConsult.add(id);
      else importedSelected.add(id);
    }
    for (const id of importedSelected) importedConsult.delete(id);
    if (!importedSelected.size && !importedConsult.size) throw new Error('このTinderSEに一致するファイル名が見つかりません。');

    const total = importedSelected.size + importedConsult.size;
    const replace = confirm(`CSVから ${total}件 読み込みます。現在の判断を置き換えますか？\n\nOK: 置き換え / キャンセル: 追加`);
    if (replace) {
      selected = importedSelected;
      consult = importedConsult;
    } else {
      for (const id of importedSelected) { selected.add(id); consult.delete(id); }
      for (const id of importedConsult) { if (!selected.has(id)) consult.add(id); }
    }
    saveState();
    renderGrid();
    updateSummary();
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]);
  }

  els.selectedOnlyBtn.addEventListener('click', () => {
    selectedOnly = !selectedOnly;
    if (selectedOnly) consultOnly = false;
    els.selectedOnlyBtn.setAttribute('aria-pressed', selectedOnly ? 'true' : 'false');
    els.consultOnlyBtn.setAttribute('aria-pressed', consultOnly ? 'true' : 'false');
    renderGrid();
  });

  els.consultOnlyBtn.addEventListener('click', () => {
    consultOnly = !consultOnly;
    if (consultOnly) selectedOnly = false;
    els.consultOnlyBtn.setAttribute('aria-pressed', consultOnly ? 'true' : 'false');
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
    try { await importCsv(file); }
    catch (err) { console.error(err); alert(err.message || 'CSVを読み込めませんでした。'); }
  });

  els.packInput.addEventListener('change', async () => {
    const file = els.packInput.files?.[0];
    els.packInput.value = '';
    if (!file) return;
    try {
      await importPack(file);
      const next = pendingPlayback;
      pendingPlayback = null;
      if (next) await playSound(next.sound, next.kind);
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
