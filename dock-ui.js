(() => {
  'use strict';

  const pinBtn = document.getElementById('pinBtn');
  const pinName = document.getElementById('wavePinName');
  const pinRow = document.getElementById('wavePinRow');
  const nowEc = document.getElementById('waveNowEc');
  const pinEc = document.getElementById('wavePinEc');

  if (!pinBtn || !pinName || !pinRow || !nowEc || !pinEc) return;

  let lastPinState = '';
  let pinWasVisible = false;
  let feedbackTimer = 0;

  function normalizeEc(el) {
    const raw = el.textContent.trim();
    if (!raw) return;
    if (/^EC\s/i.test(raw)) return;

    const value = raw.replace(/^Energy Centroid\s*/i, '').trim();
    const next = value ? `EC ${value}` : '';
    if (raw !== next) el.textContent = next;
    if (value) el.setAttribute('aria-label', `Energy Centroid ${value}`);
  }

  function normalizePinnedName() {
    const raw = pinName.textContent.trim();
    let next = raw.replace(/^PIN\s*/i, '').trim();
    if (next === '—') next = '';

    if (raw !== next) pinName.textContent = next;

    const visible = Boolean(next);
    pinRow.hidden = !visible;

    if (visible && !pinWasVisible) {
      pinRow.classList.remove('fresh');
      void pinRow.offsetWidth;
      pinRow.classList.add('fresh');
      window.setTimeout(() => pinRow.classList.remove('fresh'), 320);
    }
    pinWasVisible = visible;
  }

  function syncPinButton() {
    const text = pinBtn.textContent.trim();
    let state = 'empty';
    let label = '現在の波形を比較基準として固定';

    if (text.includes('解除')) {
      state = 'locked';
      label = '固定した比較波形を解除';
    } else if (text.includes('置換')) {
      state = 'replace';
      label = '固定した比較波形を現在の波形へ入れ替え';
    }

    pinBtn.setAttribute('aria-label', label);

    if (state !== lastPinState) {
      pinBtn.dataset.state = state;
      lastPinState = state;
      pinBtn.classList.remove('state-change');
      void pinBtn.offsetWidth;
      pinBtn.classList.add('state-change');
      window.clearTimeout(feedbackTimer);
      feedbackTimer = window.setTimeout(() => pinBtn.classList.remove('state-change'), 280);
    }
  }

  function observeText(el, fn) {
    const observer = new MutationObserver(() => queueMicrotask(fn));
    observer.observe(el, { childList: true, subtree: true, characterData: true });
    fn();
  }

  observeText(pinBtn, syncPinButton);
  observeText(pinName, normalizePinnedName);
  observeText(nowEc, () => normalizeEc(nowEc));
  observeText(pinEc, () => normalizeEc(pinEc));
})();
