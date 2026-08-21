(() => {
'use strict';

const $ = (id) => document.getElementById(id);
const els = {
  tabs: $('categoryTabs'), grid: $('soundGrid'), title: $('categoryTitle'), meta: $('categoryMeta'),
  selectedCount: $('selectedCount'), consultCount: $('consultCount'), playedCount: $('playedCount'),
  loadStatus: $('loadStatus'), selectedOnlyBtn: $('selectedOnlyBtn'), consultOnlyBtn: $('consultOnlyBtn'),
  unplayedOnlyBtn: $('unplayedOnlyBtn'), exportBtn: $('exportBtn'), importBtn: $('importBtn'),
  importInput: $('importInput'), packBtn: $('packBtn'), packInput: $('packInput'), empty: $('emptyState')
};

const VERSION = '2026-08-22-v5';
const PACK_FILE = 'TinderSE_audio_v5.pack';
const PACK_INDEX_FILE = 'pack-v5.csv';
const PREROLL_MS = 500;
const DB_NAME = 'TinderSEAudioDB';
const DB_STORE = 'packs';
const OLD_PACK_KEYS = ['2026-08-21-v1', '2026-08-21-v2'];

const CATEGORY_LABELS = {
  Kick: 'Kick', SnareClap: 'Snare / Clap', Tom: 'Tom / Timbale', RimStick: 'Rim / Stick',
  HiHat: 'Hi-Hat', Cymbal: 'Cymbal', Percussion: 'Percussion'
};
const CATEGORY_ORDER = ['Kick', 'SnareClap', 'Tom', 'RimStick', 'HiHat', 'Cymbal', 'Percussion'];

let manifest = null;
let activeCategory = null;
let selectedOnly = false;
let consultOnly = false;
let unplayedOnly = false;
let selected = new Set();
let consult = new Set();
let played = new Set();
let packBuffer = null;
let audioContext = null;
let currentSource = null;
let currentId = null;
let pendingPlayback = null;
let endToken = 0;
const decoded = new Map();

const stateKey = (kind) => `tinderse:${VERSION}:${kind}`;

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

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function saveState() {
  localStorage.setItem(stateKey('selected'), JSON.stringify([...selected]));
  localStorage.setItem(stateKey('consult'), JSON.stringify([...consult]));
  localStorage.setItem(stateKey('played'), JSON.stringify([...played]));
}

function loadState() {
  const read = (kind) => {
    try { return JSON.parse(localStorage.getItem(stateKey(kind)) || '[]'); }
    catch { return []; }
  };
  const valid = new Set(manifest.sounds.map((s) => s.id));
  selected = new Set(read('selected').filter((id) => valid.has(id)));
  consult = new Set(read('consult').filter((id) => valid.has(id) && !selected.has(id)));
  played = new Set(read('played').filter((id) => valid.has(id)));
  saveState();
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

async function dbDeleteMany(keys) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      const store = tx.objectStore(DB_STORE);
      keys.forEach((key) => store.delete(key));
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    console.warn('Old pack cleanup skipped', err);
  }
}

async function loadManifest() {
  const [mapRes, packRes] = await Promise.all([
    fetch('mapping.csv', { cache: 'no-store' }),
    fetch(PACK_INDEX_FILE, { cache: 'no-store' })
  ]);
  if (!mapRes.ok) throw new Error(`mapping.csv: ${mapRes.status}`);
  if (!packRes.ok) throw new Error(`${PACK_INDEX_FILE}: ${packRes.status}`);

  const mapRows = parseCsv((await mapRes.text()).replace(/^\uFEFF/, ''));
  const mapHeaders = mapRows[0].map((h) => h.trim());
  const mp = Object.fromEntries(mapHeaders.map((h, i) => [h, i]));
  const bySource = new Map(mapRows.slice(1).map((r) => [r[mp.original_name], {
    filename: r[mp.new_name], category: r[mp.category], metric: r[mp.metric],
    frequencyHz: Number(r[mp.frequency_hz])
  }]));

  const packRows = parseCsv((await packRes.text()).replace(/^\uFEFF/, ''));
  const packHeaders = packRows[0].map((h) => h.trim());
  const pp = Object.fromEntries(packHeaders.map((h, i) => [h, i]));
  const sounds = packRows.slice(1).map((r) => {
    const sourceName = r[pp.source_name];
    const meta = bySource.get(sourceName);
    if (!meta) throw new Error(`mapping missing: ${sourceName}`);
    const match = /_(\d+)_\(/.exec(meta.filename);
    return {
      id: meta.filename.replace(/\.wav$/i, ''), filename: meta.filename, sourceName,
      category: meta.category, index: match ? Number(match[1]) : 0,
      metric: meta.metric, frequencyHz: meta.frequencyHz,
      offset: Number(r[pp.offset]), length: Number(r[pp.byte_length]), durationMs: Number(r[pp.duration_ms])
    };
  });

  const categories = CATEGORY_ORDER
    .filter((id) => sounds.some((s) => s.category === id))
    .map((id) => ({ id, label: CATEGORY_LABELS[id] || id, count: sounds.filter((s) => s.category === id).length }));
  const packSize = sounds.reduce((m, s) => Math.max(m, s.offset + s.length), 0);
  manifest = { version: VERSION, packFile: PACK_FILE, packSize, sounds, categories };
  loadState();
  activeCategory = categories[0]?.id || null;
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
  if (!(buf instanceof ArrayBuffer) || buf.byteLength !== manifest.packSize) return false;
  const bytes = new Uint8Array(buf);
  const probes = [manifest.sounds[0], manifest.sounds[Math.floor(manifest.sounds.length / 2)], manifest.sounds.at(-1)];
  return probes.every((s) => {
    if (!s) return true;
    const o = s.offset;
    return String.fromCharCode(...bytes.slice(o, o + 4)) === 'RIFF' &&
      String.fromCharCode(...bytes.slice(o + 8, o + 12)) === 'WAVE';
  });
}

async function restorePack() {
  setPackStatus('', '保存済み音源を確認中…');
  try {
    const saved = await dbGet(VERSION);
    if (saved) {
      const buf = saved instanceof ArrayBuffer ? saved : await saved.arrayBuffer();
      if (validatePack(buf)) {
        packBuffer = buf;
        setPackStatus('ready', `完成素材 ${manifest.sounds.length}件 準備完了`);
        return true;
      }
    }
  } catch (err) {
    console.warn('Pack restore failed', err);
  }
  setPackStatus('', '完成素材の音源パックを1回読み込んでください');
  return false;
}

async function importPack(file) {
  const buf = await file.arrayBuffer();
  if (!validatePack(buf)) throw new Error('今回の完成素材116音源用パックではありません。');
  stopCurrent();
  packBuffer = buf;
  decoded.clear();
  await dbPut(VERSION, new Blob([buf], { type: 'application/octet-stream' }));
  setPackStatus('ready', `完成素材 ${manifest.sounds.length}件 準備完了`);
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

function stopCurrent() {
  endToken++;
  if (currentSource) {
    try { currentSource.stop(0); } catch {}
    try { currentSource.disconnect(); } catch {}
  }
  currentSource = null;
  currentId = null;
  window.TinderSEEnergyV5?.stopPlayhead();
  renderGrid();
}

async function playSound(sound) {
  try {
    await ensureAudioContext();
    if (!packBuffer) {
      pendingPlayback = sound;
      els.packInput.click();
      return;
    }
    if (currentSource && currentId === sound.id) {
      stopCurrent();
      return;
    }

    const audio = await decodeSound(sound);
    stopCurrent();
    played.add(sound.id);
    saveState();
    window.TinderSEEnergyV5?.showBuffer(audio);

    const src = audioContext.createBufferSource();
    src.buffer = audio;
    src.connect(audioContext.destination);
    currentSource = src;
    currentId = sound.id;
    const myToken = ++endToken;
    renderGrid();
    updateSummary();

    const target = audioContext.currentTime + PREROLL_MS / 1000;
    window.TinderSEEnergyV5?.startPlayhead(audio.duration * 1000, PREROLL_MS);
    src.start(target);
    src.onended = () => {
      if (myToken !== endToken || currentSource !== src) return;
      currentSource = null;
      currentId = null;
      renderGrid();
      window.TinderSEEnergyV5?.stopPlayhead();
    };
  } catch (err) {
    console.error(err);
    setPackStatus('error', err?.message || '再生できませんでした');
  }
}

function toggleSelected(id) {
  if (selected.has(id)) selected.delete(id);
  else { selected.add(id); consult.delete(id); }
  saveState(); renderGrid(); updateSummary();
}

function toggleConsult(id) {
  if (consult.has(id)) consult.delete(id);
  else { consult.add(id); selected.delete(id); }
  saveState(); renderGrid(); updateSummary();
}

function visibleSounds() {
  return manifest.sounds.filter((s) => {
    if (s.category !== activeCategory) return false;
    if (selectedOnly && !selected.has(s.id)) return false;
    if (consultOnly && !consult.has(s.id)) return false;
    if (unplayedOnly && played.has(s.id)) return false;
    return true;
  });
}

function renderTabs() {
  els.tabs.innerHTML = '';
  for (const cat of manifest.categories) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `category-tab${cat.id === activeCategory ? ' active' : ''}`;
    b.dataset.category = cat.id;
    b.innerHTML = `${cat.label}<span class="count">${cat.count}</span>`;
    b.addEventListener('click', () => {
      activeCategory = cat.id;
      renderTabs(); renderGrid(); renderCategoryHead();
    });
    els.tabs.appendChild(b);
  }
}

function renderCategoryHead() {
  const cat = manifest.categories.find((c) => c.id === activeCategory);
  els.title.textContent = cat?.label || '';
  els.meta.textContent = cat ? `${cat.count} sounds` : '';
  document.documentElement.dataset.activeCategory = activeCategory || '';
}

function renderGrid() {
  const sounds = visibleSounds();
  els.grid.innerHTML = '';
  els.empty.hidden = sounds.length > 0;

  for (const s of sounds) {
    const card = document.createElement('article');
    card.className = 'sound-card';
    card.dataset.category = s.category;
    if (played.has(s.id)) card.classList.add('played');
    if (selected.has(s.id)) card.classList.add('selected');
    if (consult.has(s.id)) card.classList.add('consult');
    if (currentId === s.id) card.classList.add('playing-main');

    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'play-area';
    play.setAttribute('aria-label', `${s.index} を再生`);
    play.innerHTML = `
      <div class="card-top">
        <div class="index">${String(s.index).padStart(2, '0')}</div>
        <div class="play-mark">${currentId === s.id ? '■' : '▶'}</div>
      </div>
      <div class="metric"><strong>${s.metric} ${s.frequencyHz}Hz</strong></div>`;
    play.addEventListener('click', () => playSound(s));

    const decisions = document.createElement('div');
    decisions.className = 'decision-row';
    decisions.innerHTML = `
      <button class="select-btn" type="button"><span class="select-check">${selected.has(s.id) ? '✓' : ''}</span>採用</button>
      <button class="consult-btn" type="button" aria-label="要相談">?</button>`;
    decisions.querySelector('.select-btn').addEventListener('click', () => toggleSelected(s.id));
    decisions.querySelector('.consult-btn').addEventListener('click', () => toggleConsult(s.id));

    card.append(play, decisions);
    els.grid.appendChild(card);
  }
}

function updateSummary() {
  els.selectedCount.textContent = `✓ ${selected.size}`;
  els.consultCount.textContent = `? ${consult.size}`;
  els.playedCount.textContent = `試聴 ${played.size}`;
}

function syncFilterButtons() {
  els.selectedOnlyBtn.setAttribute('aria-pressed', String(selectedOnly));
  els.consultOnlyBtn.setAttribute('aria-pressed', String(consultOnly));
  els.unplayedOnlyBtn.setAttribute('aria-pressed', String(unplayedOnly));
}

function exportCsv() {
  const rows = [['filename','category','decision','metric','frequency_hz','source_name']];
  for (const s of manifest.sounds) {
    const decision = selected.has(s.id) ? 'selected' : consult.has(s.id) ? 'consult' : '';
    if (!decision) continue;
    rows.push([s.filename, s.category, decision, s.metric, s.frequencyHz, s.sourceName]);
  }
  const text = rows.map((r) => r.map(csvEscape).join(',')).join('\r\n');
  const blob = new Blob(['\uFEFF', text], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  a.href = URL.createObjectURL(blob);
  a.download = `TinderSE_selection_${ymd}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importCsv(file) {
  const rows = parseCsv((await file.text()).replace(/^\uFEFF/, ''));
  if (!rows.length) return;
  const headers = rows[0].map((h) => h.trim());
  const pos = Object.fromEntries(headers.map((h, i) => [h, i]));
  if (pos.filename == null || pos.decision == null) throw new Error('filename / decision 列が必要です。');
  const byFilename = new Map(manifest.sounds.map((s) => [s.filename, s.id]));
  selected.clear(); consult.clear();
  for (const r of rows.slice(1)) {
    const id = byFilename.get(r[pos.filename]);
    if (!id) continue;
    const d = String(r[pos.decision] || '').trim().toLowerCase();
    if (d === 'selected') selected.add(id);
    else if (d === 'consult') consult.add(id);
  }
  saveState(); renderGrid(); updateSummary();
}

function bindUi() {
  els.selectedOnlyBtn.addEventListener('click', () => { selectedOnly = !selectedOnly; syncFilterButtons(); renderGrid(); });
  els.consultOnlyBtn.addEventListener('click', () => { consultOnly = !consultOnly; syncFilterButtons(); renderGrid(); });
  els.unplayedOnlyBtn.addEventListener('click', () => { unplayedOnly = !unplayedOnly; syncFilterButtons(); renderGrid(); });
  els.packBtn.addEventListener('click', () => els.packInput.click());
  els.packInput.addEventListener('change', async () => {
    const file = els.packInput.files?.[0];
    if (!file) return;
    try {
      setPackStatus('', '完成素材を読み込み中…');
      await importPack(file);
      if (pendingPlayback) {
        const s = pendingPlayback; pendingPlayback = null;
        await playSound(s);
      }
    } catch (err) {
      setPackStatus('error', err?.message || '音源パックを読み込めませんでした');
    } finally {
      els.packInput.value = '';
    }
  });
  els.exportBtn.addEventListener('click', exportCsv);
  els.importBtn.addEventListener('click', () => els.importInput.click());
  els.importInput.addEventListener('change', async () => {
    const file = els.importInput.files?.[0];
    if (!file) return;
    try { await importCsv(file); }
    catch (err) { alert(err?.message || 'CSVを読み込めませんでした'); }
    finally { els.importInput.value = ''; }
  });
}

async function init() {
  try {
    bindUi();
    syncFilterButtons();
    await loadManifest();
    await dbDeleteMany(OLD_PACK_KEYS);
    renderTabs(); renderCategoryHead(); renderGrid(); updateSummary();
    await restorePack();
  } catch (err) {
    console.error(err);
    setPackStatus('error', err?.message || '初期化に失敗しました');
  }
}

init();
})();
