(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const els = {
    tabs: $('categoryTabs'), grid: $('soundGrid'), title: $('categoryTitle'), meta: $('categoryMeta'),
    selectedCount: $('selectedCount'), playedCount: $('playedCount'), loadStatus: $('loadStatus'),
    selectedOnlyBtn: $('selectedOnlyBtn'), unplayedOnlyBtn: $('unplayedOnlyBtn'),
    exportBtn: $('exportBtn'), importBtn: $('importBtn'), importInput: $('importInput'),
    packBtn: $('packBtn'), packInput: $('packInput'),
    nowMain: $('nowMain'), nowSource: $('nowSource'), empty: $('emptyState')
  };

  let manifest = null, activeCategory = null, selectedOnly = false, unplayedOnly = false;
  let packBuffer = null, audioContext = null, currentSource = null, currentId = null, pendingSound = null;
  const decoded = new Map();
  let selected = new Set(), played = new Set();
  const DB_NAME = 'TinderSEAudioDB', DB_STORE = 'packs';
  const stateKey = (kind) => `tinderse:${manifest.version}:${kind}`;

  function saveState() {
    localStorage.setItem(stateKey('selected'), JSON.stringify([...selected]));
    localStorage.setItem(stateKey('played'), JSON.stringify([...played]));
  }
  function loadState() {
    try {
      selected = new Set(JSON.parse(localStorage.getItem(stateKey('selected')) || '[]'));
      played = new Set(JSON.parse(localStorage.getItem(stateKey('played')) || '[]'));
    } catch { selected = new Set(); played = new Set(); }
    const valid = new Set(manifest.sounds.map(s => s.id));
    selected = new Set([...selected].filter(id => valid.has(id)));
    played = new Set([...played].filter(id => valid.has(id)));
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
    const r = await fetch('mapping.csv', { cache: 'no-store' });
    if (!r.ok) throw new Error(`mapping.csv: ${r.status}`);
    const rows = parseCsv((await r.text()).replace(/^\uFEFF/,''));
    const headers = rows[0].map(h => h.trim());
    const pos = Object.fromEntries(headers.map((h,i)=>[h,i]));
    const categoryOrder = ['Kick','SnareClap','Tom','RimStick','HiHat','Cymbal','Percussion'];
    const labels = {Kick:'Kick',SnareClap:'Snare / Clap',Tom:'Tom / Timbale',RimStick:'Rim / Stick',HiHat:'Hi-Hat',Cymbal:'Cymbal',Percussion:'Percussion'};
    let offset = 0;
    const sounds = rows.slice(1).map(row => {
      const filename=row[pos.new_name], category=row[pos.category], length=Number(row[pos.byte_length]);
      const m=/_(\d+)_\((RF|SC)_(\d+)Hz\)\.wav$/.exec(filename);
      const sound={id:filename.slice(0,-4),category,categoryDisplay:labels[category],index:m?Number(m[1]):0,filename,sourceName:row[pos.original_name],metric:row[pos.metric],frequencyHz:Number(row[pos.frequency_hz]),durationMs:Number(row[pos.final_duration_ms]),sampleRate:Number(row[pos.sample_rate]),offset,length};
      offset += length; return sound;
    });
    manifest={version:'2026-08-21-v1',title:'TinderSE',count:sounds.length,packFile:'TinderSE_audio.pack',packSize:offset,categories:categoryOrder.map(id=>({id,label:labels[id],count:sounds.filter(s=>s.category===id).length})),sounds};
    loadState();
    activeCategory = manifest.categories[0]?.id || null;
  }

  function setPackStatus(state, text) {
    els.loadStatus.classList.remove('ready','error');
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
    for (const s of [manifest.sounds[0], manifest.sounds[Math.floor(manifest.sounds.length/2)], manifest.sounds.at(-1)]) {
      if (!s) continue;
      const o=s.offset;
      if (String.fromCharCode(...bytes.slice(o,o+4)) !== 'RIFF') return false;
      if (String.fromCharCode(...bytes.slice(o+8,o+12)) !== 'WAVE') return false;
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
    } catch (err) { console.warn('pack restore failed', err); }
    setPackStatus('', '音源パックを1回読み込んでください');
    return false;
  }

  async function importPack(file) {
    setPackStatus('', '音源パックを読み込み中…');
    const buf = await file.arrayBuffer();
    if (!validatePack(buf)) throw new Error('このTinderSE用の音源パックではありません。');
    packBuffer = buf;
    decoded.clear();
    await dbPut(manifest.version, new Blob([buf], { type: 'application/octet-stream' }));
    setPackStatus('ready', `音源 ${manifest.count}件 準備完了`);
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
  async function playSound(sound) {
    try {
      await ensureAudioContext();
      if (!packBuffer) {
        pendingSound = sound;
        els.packInput.click();
        return;
      }
      const audio = await decodeSound(sound);
      if (currentSource) {
        try { currentSource.stop(0); } catch {}
        try { currentSource.disconnect(); } catch {}
      }
      const src = audioContext.createBufferSource();
      src.buffer = audio;
      src.connect(audioContext.destination);
      currentSource = src; currentId = sound.id;
      played.add(sound.id); saveState();
      els.nowMain.textContent = sound.filename;
      els.nowSource.textContent = `元素材: ${sound.sourceName}`;
      renderGrid(); updateSummary();
      src.onended = () => {
        if (currentSource === src) { currentSource = null; currentId = null; renderGrid(); }
      };
      src.start(0);
    } catch (err) {
      console.error(err);
      alert(err.message === 'NO_PACK' ? '音源パックを読み込んでください。' : '音源を再生できませんでした。ページを再読み込みして再試行してください。');
    }
  }

  function toggleSelected(id) {
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    saveState(); renderGrid(); updateSummary();
  }
  function renderTabs() {
    els.tabs.innerHTML='';
    manifest.categories.forEach(cat => {
      const b=document.createElement('button');
      b.type='button'; b.className='category-tab'+(cat.id===activeCategory?' active':'');
      b.innerHTML=`${escapeHtml(cat.label)}<span class="count">${cat.count}</span>`;
      b.addEventListener('click',()=>{
        activeCategory=cat.id; selectedOnly=false; unplayedOnly=false;
        els.selectedOnlyBtn.setAttribute('aria-pressed','false'); els.unplayedOnlyBtn.setAttribute('aria-pressed','false');
        renderTabs(); renderGrid(); window.scrollTo({top:0,behavior:'smooth'});
      });
      els.tabs.appendChild(b);
    });
  }
  function visibleSounds() {
    return manifest.sounds.filter(s => s.category===activeCategory && (!selectedOnly||selected.has(s.id)) && (!unplayedOnly||!played.has(s.id)));
  }
  function renderGrid() {
    if (!manifest||!activeCategory) return;
    const cat=manifest.categories.find(c=>c.id===activeCategory);
    const all=manifest.sounds.filter(s=>s.category===activeCategory);
    els.title.textContent=cat.label;
    els.meta.textContent=`${cat.count}件 ・ 採用 ${all.filter(s=>selected.has(s.id)).length} ・ 試聴 ${all.filter(s=>played.has(s.id)).length}`;
    const sounds=visibleSounds(); els.grid.innerHTML=''; els.empty.hidden=sounds.length!==0;
    const frag=document.createDocumentFragment();
    for(const sound of sounds){
      const card=document.createElement('article');
      const isSelected=selected.has(sound.id), isPlayed=played.has(sound.id), isPlaying=currentId===sound.id;
      card.className='sound-card'+(isSelected?' selected':'')+(isPlayed?' played':'')+(isPlaying?' playing':'');
      const play=document.createElement('button'); play.type='button'; play.className='play-area';
      play.setAttribute('aria-label',`${sound.filename} を再生`);
      play.innerHTML=`<div class="card-top"><div class="index">${String(sound.index).padStart(2,'0')}</div><div class="play-mark">${isPlaying?'■':'▶'}</div></div><div class="metric"><strong>${escapeHtml(sound.metric)} ${sound.frequencyHz.toLocaleString()} Hz</strong></div><div class="duration">${sound.durationMs.toFixed(1)} ms</div>`;
      play.addEventListener('click',()=>playSound(sound));
      const row=document.createElement('div'); row.className='select-row';
      const sel=document.createElement('button'); sel.type='button'; sel.className='select-btn'; sel.setAttribute('aria-pressed',isSelected?'true':'false');
      sel.innerHTML=`<span class="select-check">${isSelected?'✓':'○'}</span>${isSelected?'採用中':'採用'}`;
      sel.addEventListener('click',()=>toggleSelected(sound.id)); row.appendChild(sel); card.append(play,row); frag.appendChild(card);
    }
    els.grid.appendChild(frag);
  }
  function updateSummary(){ els.selectedCount.textContent=`採用 ${selected.size}`; els.playedCount.textContent=`試聴 ${played.size} / ${manifest.count}`; }

  function csvEscape(value){ const s=String(value??''); return /[",\n\r]/.test(s)?`"${s.replaceAll('"','""')}"`:s; }
  function exportCsv(){
    const rows=manifest.sounds.filter(s=>selected.has(s.id));
    if(!rows.length){alert('採用音源がまだ選択されていません。');return;}
    const lines=[['filename','category','metric','frequency_hz','source_name'].join(',')];
    rows.forEach(s=>lines.push([s.filename,s.category,s.metric,s.frequencyHz,s.sourceName].map(csvEscape).join(',')));
    const blob=new Blob(['\uFEFF'+lines.join('\r\n')+'\r\n'],{type:'text/csv;charset=utf-8'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
    const d=new Date(),stamp=[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join(''); a.download=`TinderSE_selection_${stamp}.csv`;
    document.body.appendChild(a); a.click(); const u=a.href; a.remove(); setTimeout(()=>URL.revokeObjectURL(u),1000);
  }
  function parseCsv(text){
    const rows=[];let row=[],field='',quoted=false;
    for(let i=0;i<text.length;i++){const ch=text[i];if(quoted){if(ch==='"'&&text[i+1]==='"'){field+='"';i++;}else if(ch==='"')quoted=false;else field+=ch;}else{if(ch==='"')quoted=true;else if(ch===','){row.push(field);field='';}else if(ch==='\n'){row.push(field.replace(/\r$/,''));rows.push(row);row=[];field='';}else field+=ch;}}
    if(field.length||row.length){row.push(field.replace(/\r$/,''));rows.push(row);}return rows.filter(r=>r.some(v=>v.trim()!==''));
  }
  async function importCsv(file){
    const rows=parseCsv((await file.text()).replace(/^\uFEFF/,'')); if(rows.length<2)throw new Error('CSVに選択データがありません。');
    const headers=rows[0].map(h=>h.trim().toLowerCase());let idx=headers.indexOf('filename');if(idx<0)idx=0;
    const byName=new Map(manifest.sounds.map(s=>[s.filename,s.id])), imported=new Set();
    for(const row of rows.slice(1)){const id=byName.get((row[idx]||'').trim());if(id)imported.add(id);} if(!imported.size)throw new Error('このTinderSEに一致するファイル名が見つかりません。');
    const replace=confirm(`CSVから ${imported.size}件 読み込みます。現在の採用選択を置き換えますか？\n\nOK: 置き換え / キャンセル: 追加`);
    selected=replace?imported:new Set([...selected,...imported]);saveState();renderGrid();updateSummary();
  }
  function escapeHtml(value){return String(value).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}

  els.selectedOnlyBtn.addEventListener('click',()=>{selectedOnly=!selectedOnly;els.selectedOnlyBtn.setAttribute('aria-pressed',selectedOnly?'true':'false');renderGrid();});
  els.unplayedOnlyBtn.addEventListener('click',()=>{unplayedOnly=!unplayedOnly;els.unplayedOnlyBtn.setAttribute('aria-pressed',unplayedOnly?'true':'false');renderGrid();});
  els.exportBtn.addEventListener('click',exportCsv); els.importBtn.addEventListener('click',()=>els.importInput.click()); els.packBtn.addEventListener('click',()=>els.packInput.click());
  els.importInput.addEventListener('change',async()=>{const f=els.importInput.files?.[0];if(!f)return;try{await importCsv(f);}catch(err){alert(err.message||'CSVの読み込みに失敗しました。');}finally{els.importInput.value='';}});
  els.packInput.addEventListener('change',async()=>{const f=els.packInput.files?.[0];if(!f){pendingSound=null;return;}try{await importPack(f);const s=pendingSound;pendingSound=null;if(s)await playSound(s);}catch(err){setPackStatus('error','音源パックが不正です');alert(err.message||'音源パックの読み込みに失敗しました。');}finally{els.packInput.value='';}});

  (async()=>{try{await loadManifest();renderTabs();renderGrid();updateSummary();await restorePack();}catch(err){console.error(err);els.title.textContent='読み込みエラー';els.meta.textContent='ページを再読み込みしてください。';setPackStatus('error','初期化に失敗');}})();
})();
