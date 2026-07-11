'use strict';

/* =========================================================
   体重ログ - PWA
   - スクショ → Tesseract.js でOCR → 日付/体重を抽出
   - 確認・修正して localStorage に保存
   - 折れ線グラフ / カレンダー / 一覧で可視化
   ========================================================= */

const STORAGE_KEY = 'weight-entries-v1';

/* ---------------- データ層 ---------------- */
const DB = {
  all() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return arr.sort((a, b) => a.date.localeCompare(b.date));
    } catch {
      return [];
    }
  },
  save(date, weight, bodyFat) {
    const list = this.all().filter((e) => e.date !== date); // 同じ日付は上書き
    const entry = { date, weight: Number(weight), updatedAt: Date.now() };
    if (bodyFat !== '' && bodyFat != null && !Number.isNaN(Number(bodyFat))) {
      entry.bodyFat = Number(bodyFat);
    }
    list.push(entry);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  },
  remove(date) {
    const list = this.all().filter((e) => e.date !== date);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  },
};

const MEAL_KEY = 'meal-entries-v1';
const MealDB = {
  all() {
    try {
      return JSON.parse(localStorage.getItem(MEAL_KEY)) || [];
    } catch {
      return [];
    }
  },
  byDate(date) {
    return this.all().filter((m) => m.date === date);
  },
  // 日付ごとの合計kcal
  totals() {
    const t = {};
    this.all().forEach((m) => { t[m.date] = (t[m.date] || 0) + m.kcal; });
    return t;
  },
  add(date, name, kcal, opts = {}) {
    const list = this.all();
    const entry = { id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`, date, name, kcal: Math.round(kcal) };
    if (opts.photoId) entry.photoId = opts.photoId;
    if (opts.slot) entry.slot = opts.slot;       // 朝/昼/夜/間食
    if (opts.place) entry.place = opts.place;    // {type:'外食', label} / {type:'自炊'}
    list.push(entry);
    localStorage.setItem(MEAL_KEY, JSON.stringify(list));
    return entry;
  },
  update(id, fields) {
    const list = this.all();
    const m = list.find((e) => e.id === id);
    if (!m) return;
    if (fields.name != null) m.name = fields.name;
    if (fields.kcal != null) m.kcal = Math.round(fields.kcal);
    if ('slot' in fields) { if (fields.slot) m.slot = fields.slot; else delete m.slot; }
    if ('place' in fields) { if (fields.place) m.place = fields.place; else delete m.place; }
    localStorage.setItem(MEAL_KEY, JSON.stringify(list));
  },
  remove(id) {
    const target = this.all().find((m) => m.id === id);
    if (target && target.photoId && window.PhotoStore) PhotoStore.del(target.photoId).catch(() => {});
    localStorage.setItem(MEAL_KEY, JSON.stringify(this.all().filter((m) => m.id !== id)));
  },
};

// 日別の食事スコア（クロちゃんの点数）。同日は上書き。
const SCORE_KEY = 'meal-scores-v1';
const ScoreDB = {
  all() {
    try { return JSON.parse(localStorage.getItem(SCORE_KEY)) || {}; } catch { return {}; }
  },
  get(date) { return this.all()[date]; },
  set(date, score) {
    const m = this.all();
    m[date] = score;
    localStorage.setItem(SCORE_KEY, JSON.stringify(m));
  },
};

/* ---------------- ユーティリティ ---------------- */
const $ = (sel) => document.querySelector(sel);
const pad = (n) => String(n).padStart(2, '0');
const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayISO = () => toISO(new Date());
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- タブ切り替え ---------------- */
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const name = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
    document.querySelectorAll('.tab-panel').forEach((p) => {
      p.classList.toggle('is-active', p.id === `tab-${name}`);
    });
    if (name === 'meal') openMealTab();
    if (name === 'graph') renderGraph();
    if (name === 'calendar') renderCalendar();
    if (name === 'list') renderList();
  });
});

/* =========================================================
   OCR
   ========================================================= */
const fileInput = $('#file-input');
const preview = $('#preview');
const previewWrap = $('#preview-wrap');
const ocrStatus = $('#ocr-status');
const ocrStatusText = $('#ocr-status-text');
const ocrProgress = $('#ocr-progress');
const ocrRawWrap = $('#ocr-raw-wrap');
const ocrRaw = $('#ocr-raw');
const confirmCard = $('#confirm-card');
const ocrSpinner = ocrStatus.querySelector('.spinner');
const ocrProgressWrap = ocrStatus.querySelector('.progress');

fileInput.addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  const url = URL.createObjectURL(file);
  preview.src = url;
  previewWrap.hidden = false;

  ocrStatus.hidden = false;
  ocrSpinner.hidden = false;      // 読み取り中はスピナー表示
  ocrProgressWrap.hidden = false;
  ocrProgress.style.width = '0%';
  ocrStatusText.textContent = '準備中…';
  confirmCard.hidden = true;
  ocrRawWrap.hidden = true;

  try {
    const { data } = await Tesseract.recognize(file, 'eng+jpn', {
      // worker本体はローカル同梱。重いwasmコアと言語モデルは実行時にCDNから取得し
      // ブラウザ/Service Workerにキャッシュされる（画像は端末外に出ない）。
      workerPath: 'vendor/worker.min.js',
      corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.0.0',
      langPath: 'https://tessdata.projectnaptha.com/4.0.0',
      logger: (m) => {
        if (m.status === 'recognizing text') {
          ocrStatusText.textContent = '読み取り中…';
          ocrProgress.style.width = `${Math.round(m.progress * 100)}%`;
        } else {
          ocrStatusText.textContent = m.status === 'loading language traits' ? '言語データ読込中…' : m.status;
        }
      },
    });

    const text = data.text || '';
    ocrRaw.textContent = text;
    ocrRawWrap.hidden = false;

    const entries = OcrParse.parseOcrText(text);
    showConfirm(entries);
    ocrDone(entries.length > 1
      ? `✓ ${entries.length}件の記録が見つかりました。確認してください。`
      : '✓ 読み取り完了。確認してください。');
  } catch (err) {
    console.error(err);
    ocrDone('読み取りに失敗しました。手動で入力してください。');
    showConfirm([{ date: todayISO(), weight: '' }]);
  }
});

// 読み取り完了時: スピナーとプログレスバーを消して結果メッセージを出す
function ocrDone(msg) {
  ocrSpinner.hidden = true;
  ocrProgressWrap.hidden = true;
  ocrStatusText.textContent = msg;
}

/* ---------------- 確認・保存 ---------------- */
const entryRows = $('#entry-rows');
const saveMsg = $('#save-msg');

function showConfirm(entries) {
  confirmCard.hidden = false;
  entryRows.innerHTML = '';
  entries.forEach((e) => entryRows.appendChild(buildRow(e.date, e.weight, e.bodyFat)));
  saveMsg.hidden = true;
  confirmCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function buildRow(date, weight, bodyFat) {
  const row = document.createElement('div');
  row.className = 'entry-row';
  row.innerHTML = `
    <input type="checkbox" checked aria-label="この記録を保存する" />
    <input type="date" value="${date}" />
    <input type="number" step="0.1" inputmode="decimal" placeholder="65.4" value="${weight === '' || weight == null ? '' : weight}" />
    <input type="number" step="0.1" inputmode="decimal" placeholder="体脂肪" value="${bodyFat === '' || bodyFat == null ? '' : bodyFat}" />
  `;
  return row;
}

$('#manual-btn').addEventListener('click', () => {
  showConfirm([{ date: todayISO(), weight: '', bodyFat: '' }]);
});

$('#add-row-btn').addEventListener('click', () => {
  entryRows.appendChild(buildRow(todayISO(), '', ''));
});

$('#save-btn').addEventListener('click', () => {
  const rows = [...entryRows.querySelectorAll('.entry-row')]
    .filter((r) => r.querySelector('input[type=checkbox]').checked);
  if (rows.length === 0) {
    flash('保存する記録にチェックを入れてください', 'var(--danger)');
    return;
  }
  const picked = [];
  for (const r of rows) {
    const nums = r.querySelectorAll('input[type=number]');
    const date = r.querySelector('input[type=date]').value;
    const weight = parseFloat(nums[0].value);
    const fatRaw = nums[1].value;
    if (!date) {
      flash('日付が空の行があります', 'var(--danger)');
      return;
    }
    if (!weight || weight < 10 || weight > 400) {
      flash(`体重を正しく入力してください（${date}）`, 'var(--danger)');
      return;
    }
    const bodyFat = fatRaw === '' ? '' : parseFloat(fatRaw);
    if (bodyFat !== '' && (Number.isNaN(bodyFat) || bodyFat < 1 || bodyFat > 70)) {
      flash(`体脂肪率を正しく入力してください（${date}）`, 'var(--danger)');
      return;
    }
    picked.push({ date, weight, bodyFat });
  }
  picked.forEach((e) => DB.save(e.date, e.weight, e.bodyFat));
  // 保存できたら表示をリセットして、結果はトーストで知らせる
  resetAddTab();
  showToast(
    picked.length === 1
      ? `保存しました: ${picked[0].date} / ${picked[0].weight.toFixed(1)}kg`
      : `${picked.length}件保存しました`
  );
});

$('#clear-btn').addEventListener('click', resetAddTab);

// 体重タブの読み取り／確認まわりの表示を初期状態に戻す
function resetAddTab() {
  confirmCard.hidden = true;
  previewWrap.hidden = true;
  ocrStatus.hidden = true;
  ocrRawWrap.hidden = true;
  fileInput.value = '';
  entryRows.innerHTML = '';
}

function flash(msg, color) {
  saveMsg.hidden = false;
  saveMsg.textContent = msg;
  saveMsg.style.color = color;
}

// 画面下に一時的に出るトースト通知
let toastTimer = null;
function showToast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

/* =========================================================
   食事（カロリー記録・手動入力式）
   ========================================================= */
const mealDate = $('#meal-date');
const mealSearch = $('#meal-search');
const mealAmount = $('#meal-amount');
const mealResults = $('#meal-results');
mealDate.value = todayISO();

// カタカナ→ひらがな変換（検索用）
const toHira = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

mealSearch.addEventListener('input', () => {
  const q = toHira(mealSearch.value.trim().toLowerCase());
  mealResults.innerHTML = '';
  if (!q) return;
  const hits = FOODS.filter((f) => f.n.includes(mealSearch.value.trim()) || toHira(f.n).includes(q) || f.r.includes(q)).slice(0, 8);
  hits.forEach((f) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'meal-hit';
    row.innerHTML = `<span class="mh-name">${f.n}</span><span class="mh-kcal">${f.k} kcal</span>`;
    row.addEventListener('click', () => {
      const mult = parseFloat(mealAmount.value);
      const name = mult === 1 ? f.n : `${f.n} ×${mult}`;
      MealDB.add(mealDate.value, name, f.k * mult);
      mealSearch.value = '';
      mealResults.innerHTML = '';
      renderMealDay();
    });
    mealResults.appendChild(row);
  });
});

mealDate.addEventListener('change', renderMealDay);

// 食事タブを開くたびに「本当の今日」に合わせる（PWAが起動しっぱなしでも正しい日に記録するため）
function openMealTab() {
  mealDate.value = todayISO();
  renderMealDay();
}

// 記録先の日付を1日ずらす
function shiftMealDate(delta) {
  const d = new Date(`${mealDate.value || todayISO()}T00:00:00`);
  d.setDate(d.getDate() + delta);
  mealDate.value = toISO(d);
  renderMealDay();
}
$('#meal-prev').addEventListener('click', () => shiftMealDate(-1));
$('#meal-next').addEventListener('click', () => shiftMealDate(1));
$('#meal-today').addEventListener('click', () => { mealDate.value = todayISO(); renderMealDay(); });

/* ---- テキスト/クリップボードから取り込み ---- */
function renderImportPreview(res) {
  const box = $('#paste-preview');
  box.hidden = false;
  const date = res.date || mealDate.value || todayISO();
  const rows = [];
  const ctxBits = [];
  if (res.slot) ctxBits.push(res.slot);
  if (res.place) ctxBits.push(res.place.type === '外食' ? `外食(${res.place.label || ''})` : '自炊');
  if (ctxBits.length) rows.push(`<div class="paste-item"><span>区分</span><span>${escapeHtml(ctxBits.join('・'))}</span></div>`);
  res.items.forEach((i) => rows.push(`<div class="paste-item"><span>${escapeHtml(i.name)}</span><span>${i.kcal.toLocaleString()}kcal</span></div>`));
  if (res.weight != null) rows.push(`<div class="paste-item"><span>体重</span><span>${res.weight}kg</span></div>`);
  if (res.bodyFat != null) rows.push(`<div class="paste-item"><span>体脂肪率</span><span>${res.bodyFat}%</span></div>`);
  if (res.score != null) rows.push(`<div class="paste-item"><span>点数</span><span>${res.score}点</span></div>`);

  if (!rows.length) {
    box.innerHTML = '<p class="empty">読み取れませんでした。「料理名 カロリー」「体重 53.2」「点数 82」などの形式にしてください。</p>';
    return;
  }
  const total = res.items.reduce((s, i) => s + i.kcal, 0);
  box.innerHTML = `<p class="hint mini"><b>${date}</b> に保存します</p>`
    + rows.join('')
    + '<button id="paste-save" class="btn-primary btn-block">この内容で保存</button>';
  box.querySelector('#paste-save').addEventListener('click', () => {
    res.items.forEach((i) => MealDB.add(date, i.name, i.kcal, { slot: res.slot, place: res.place }));
    if (res.weight != null) DB.save(date, res.weight, res.bodyFat != null ? res.bodyFat : '');
    if (res.score != null) ScoreDB.set(date, res.score);
    $('#paste-text').value = '';
    box.hidden = true;
    box.innerHTML = '';
    mealDate.value = date;
    renderMealDay();
    const bits = [];
    if (res.items.length) bits.push(`食事${res.items.length}件`);
    if (res.weight != null) bits.push('体重');
    if (res.score != null) bits.push('点数');
    showToast(`${bits.join('・') || 'データ'}を保存しました`);
  });
}

$('#paste-parse').addEventListener('click', () => {
  renderImportPreview(OcrParse.parseMealTemplate($('#paste-text').value));
});

$('#clip-import').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (!text || !text.trim()) { showToast('クリップボードが空です'); return; }
    $('#paste-text').value = text;
    const details = document.querySelector('.paste-input');
    if (details) details.open = true;
    renderImportPreview(OcrParse.parseMealTemplate(text));
  } catch (err) {
    console.warn('clipboard読み取り失敗', err);
    showToast('クリップボードを読めませんでした。貼り付け欄に貼ってください');
    const details = document.querySelector('.paste-input');
    if (details) details.open = true;
  }
});

$('#free-add').addEventListener('click', () => {
  const name = $('#free-name').value.trim();
  const kcal = parseFloat($('#free-kcal').value);
  if (!name || !kcal || kcal <= 0 || kcal > 5000) return;
  MealDB.add(mealDate.value, name, kcal);
  $('#free-name').value = '';
  $('#free-kcal').value = '';
  renderMealDay();
});

function renderMealDay() {
  const date = mealDate.value || todayISO();
  $('#meal-day-title').textContent = date === todayISO() ? '今日の食事' : `${date} の食事`;
  const meals = MealDB.byDate(date);
  const box = $('#meal-list');
  box.innerHTML = '';
  $('#meal-empty').hidden = meals.length > 0;
  $('#meal-total').textContent = meals.reduce((s, m) => s + m.kcal, 0).toLocaleString();
  const score = ScoreDB.get(date);
  const scoreEl = $('#meal-score');
  scoreEl.hidden = score == null;
  if (score != null) scoreEl.textContent = `${score}点`;

  meals.forEach((m) => {
    const row = document.createElement('div');
    row.className = 'list-row meal-row';
    const thumb = m.photoId ? '<img class="meal-thumb" alt="写真" />' : '';
    row.innerHTML = `
      ${thumb}
      <div class="ld">${escapeHtml(m.name)}${mealTagHtml(m)}</div>
      <div><span class="lw">${m.kcal.toLocaleString()}</span><span class="diff"> kcal</span></div>
      <button class="ldel" data-id="${m.id}" aria-label="削除">🗑</button>
    `;
    row.querySelector('.ldel').addEventListener('click', (e) => {
      e.stopPropagation();
      MealDB.remove(m.id);
      renderMealDay();
    });
    row.querySelector('.ld').addEventListener('click', () => openMealEdit(m.id));
    if (m.photoId) {
      const img = row.querySelector('.meal-thumb');
      PhotoStore.get(m.photoId).then((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        img.src = url;
        img.addEventListener('click', () => openPhoto(url));
      }).catch(() => {});
    }
    box.appendChild(row);
  });
}

// 食事の時間帯・外食/自炊タグ（小さなラベル）
function mealTagHtml(m) {
  const bits = [];
  if (m.slot) bits.push(m.slot);
  if (m.place) bits.push(m.place.type === '外食' ? `外食${m.place.label ? `(${m.place.label})` : ''}` : '自炊');
  return bits.length ? `<span class="meal-tag">${escapeHtml(bits.join('・'))}</span>` : '';
}

// タブをコードから切り替える
function switchTab(name) {
  const btn = document.querySelector(`.tab[data-tab="${name}"]`);
  if (btn) btn.click();
}

/* ---- 食事の編集モーダル ---- */
let editingMealId = null;
function openMealEdit(id) {
  const m = MealDB.all().find((e) => e.id === id);
  if (!m) return;
  editingMealId = id;
  $('#me-name').value = m.name;
  $('#me-kcal').value = m.kcal;
  $('#me-slot').value = m.slot || '';
  $('#me-place').value = m.place ? m.place.type : '';
  $('#me-label').value = (m.place && m.place.label) || '';
  $('#me-label').parentElement.hidden = !(m.place && m.place.type === '外食');
  $('#meal-edit').hidden = false;
}
$('#me-place').addEventListener('change', () => {
  $('#me-label').parentElement.hidden = $('#me-place').value !== '外食';
});
$('#me-cancel').addEventListener('click', () => { $('#meal-edit').hidden = true; });
$('#me-save').addEventListener('click', () => {
  const name = $('#me-name').value.trim();
  const kcal = parseFloat($('#me-kcal').value);
  if (!name || !kcal || kcal <= 0 || kcal > 5000) { showToast('名前とカロリーを確認してください'); return; }
  const placeType = $('#me-place').value;
  const place = placeType === '外食'
    ? { type: '外食', label: $('#me-label').value.trim() }
    : placeType === '自炊' ? { type: '自炊' } : null;
  MealDB.update(editingMealId, { name, kcal, slot: $('#me-slot').value || null, place });
  $('#meal-edit').hidden = true;
  renderMealDay();
  if (document.querySelector('#tab-list.is-active')) renderList();
  showToast('更新しました');
});

/* ---- 写真で記録（食事・栄養表示） ---- */
const mpInput = $('#meal-photo-input');
const mpStatus = $('#meal-photo-status');
const mpStatusText = $('#meal-photo-status-text');
const mpConfirm = $('#meal-photo-confirm');
const mpPreview = $('#meal-photo-preview');
let mpBlob = null; // 保存対象の縮小済み画像

mpInput.addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  mpConfirm.hidden = true;
  mpStatus.hidden = false;
  mpStatusText.textContent = '画像を処理中…';
  try {
    mpBlob = await downscaleImage(file);
    mpPreview.src = URL.createObjectURL(mpBlob);
    // 栄養成分表示ならカロリーを読み取る（食事写真なら見つからず空欄のまま）
    mpStatusText.textContent = 'カロリーを読み取り中…';
    let kcal = null;
    try {
      const { data } = await Tesseract.recognize(mpBlob, 'eng+jpn', {
        workerPath: 'vendor/worker.min.js',
        corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.0.0',
        langPath: 'https://tessdata.projectnaptha.com/4.0.0',
      });
      kcal = OcrParse.extractKcal(data.text || '');
    } catch (err) {
      console.warn('kcal OCR失敗', err);
    }
    $('#mp-name').value = '';
    $('#mp-kcal').value = kcal == null ? '' : kcal;
    $('#mp-keep').checked = true;
    mpStatus.hidden = true;
    mpConfirm.hidden = false;
    mpStatusText.textContent = kcal != null ? `カロリー ${kcal}kcal を読み取りました` : '';
    mpConfirm.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    console.error(err);
    mpStatus.hidden = true;
    showToast('画像を読み込めませんでした');
  }
});

$('#mp-cancel').addEventListener('click', resetMealPhoto);

$('#mp-save').addEventListener('click', async () => {
  const name = $('#mp-name').value.trim() || '写真の記録';
  const kcal = parseFloat($('#mp-kcal').value);
  if (!kcal || kcal <= 0 || kcal > 5000) {
    showToast('カロリーを入力してください');
    return;
  }
  let photoId = null;
  if ($('#mp-keep').checked && mpBlob) {
    photoId = `p-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    try {
      await PhotoStore.put(photoId, mpBlob);
    } catch (err) {
      console.error('写真保存失敗', err);
      photoId = null;
    }
  }
  MealDB.add(mealDate.value, name, kcal, { photoId });
  resetMealPhoto();
  renderMealDay();
  showToast('記録しました');
});

function resetMealPhoto() {
  mpConfirm.hidden = true;
  mpStatus.hidden = true;
  mpInput.value = '';
  mpBlob = null;
}

/* ---- 写真ビューア ---- */
const photoModal = $('#photo-modal');
function openPhoto(url) {
  $('#photo-modal-img').src = url;
  photoModal.hidden = false;
}
photoModal.addEventListener('click', () => { photoModal.hidden = true; });

$('#meal-export').addEventListener('click', () => {
  const list = MealDB.all().sort((a, b) => a.date.localeCompare(b.date));
  if (list.length === 0) { alert('データがありません'); return; }
  const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const csv = 'date,name,kcal\n' + list.map((m) => `${m.date},${esc(m.name)},${m.kcal}`).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `meals-${todayISO()}.csv`;
  a.click();
});

/* =========================================================
   グラフ
   ========================================================= */
let chart = null;
const rangeSelect = $('#range-select');
rangeSelect.addEventListener('change', renderGraph);

function filteredEntries() {
  const days = Number(rangeSelect.value);
  let list = DB.all();
  if (days > 0) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutISO = toISO(cutoff);
    list = list.filter((e) => e.date >= cutISO);
  }
  return list;
}

function renderGraph() {
  const days = Number(rangeSelect.value);
  let cutISO = '';
  if (days > 0) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    cutISO = toISO(cutoff);
  }

  const wList = filteredEntries();
  const kcalTotals = MealDB.totals();
  const empty = $('#graph-empty');
  const statsBox = $('#graph-stats');

  // 体重と食事、両方の日付を統合した時間軸を作る
  const dateSet = new Set(wList.map((e) => e.date));
  Object.keys(kcalTotals).forEach((d) => { if (!cutISO || d >= cutISO) dateSet.add(d); });
  const dates = [...dateSet].sort();

  if (dates.length === 0) {
    empty.hidden = false;
    statsBox.innerHTML = '';
    if (chart) { chart.destroy(); chart = null; }
    return;
  }
  empty.hidden = true;

  const byDate = {};
  wList.forEach((e) => { byDate[e.date] = e.weight; });
  const labels = dates.map((d) => d.slice(5).replace('-', '/'));
  const weightData = dates.map((d) => byDate[d] ?? null);
  const kcalData = dates.map((d) => kcalTotals[d] ?? null);
  const hasKcal = kcalData.some((v) => v != null);

  const datasets = [{
    type: 'line',
    label: '体重 (kg)',
    data: weightData,
    yAxisID: 'y',
    borderColor: '#14b8a6',
    backgroundColor: 'rgba(20,184,166,.12)',
    borderWidth: 2,
    tension: 0.3,
    fill: true,
    spanGaps: true,
    pointRadius: dates.length > 60 ? 0 : 3,
    pointBackgroundColor: '#0f9d8f',
  }];
  if (hasKcal) {
    datasets.push({
      type: 'bar',
      label: '摂取カロリー (kcal)',
      data: kcalData,
      yAxisID: 'y1',
      backgroundColor: 'rgba(242,128,60,.35)',
      borderRadius: 3,
    });
  }

  // 点が多いときは横スクロールできるよう、1点あたり最低46pxで幅を広げる
  const scrollEl = $('.chart-scroll');
  const chartBox = $('.chart-box');
  const baseW = scrollEl.clientWidth || 320;
  const needW = Math.max(baseW, dates.length * 46);
  chartBox.style.width = `${needW}px`;
  const maxTicks = Math.max(6, Math.floor(needW / 70));

  if (chart) chart.destroy();
  chart = new Chart($('#line-chart'), {
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: hasKcal, labels: { color: '#6b7784', boxWidth: 12 } } },
      scales: {
        x: { ticks: { color: '#6b7784', maxTicksLimit: maxTicks }, grid: { color: 'rgba(0,0,0,.06)' } },
        y: { ticks: { color: '#0f9d8f' }, grid: { color: 'rgba(0,0,0,.06)' } },
        ...(hasKcal ? {
          y1: {
            position: 'right',
            beginAtZero: true,
            ticks: { color: '#f2803c' },
            grid: { drawOnChartArea: false },
          },
        } : {}),
      },
    },
  });

  // 横スクロール時は最新（右端）を最初に表示する
  scrollEl.scrollLeft = needW;

  const weights = wList.map((e) => e.weight);
  if (weights.length) renderStats(statsBox, weights);
  else statsBox.innerHTML = '';
}

function renderStats(box, data) {
  const latest = data[data.length - 1];
  const first = data[0];
  const min = Math.min(...data);
  const max = Math.max(...data);
  const diff = latest - first;
  const diffCls = diff > 0 ? 'up' : diff < 0 ? 'down' : '';
  const sign = diff > 0 ? '+' : '';

  box.innerHTML = `
    <div class="stat"><div class="v">${latest.toFixed(1)}</div><div class="l">最新 (kg)</div></div>
    <div class="stat"><div class="v ${diffCls}">${sign}${diff.toFixed(1)}</div><div class="l">期間増減</div></div>
    <div class="stat"><div class="v">${min.toFixed(1)}</div><div class="l">最小</div></div>
    <div class="stat"><div class="v">${max.toFixed(1)}</div><div class="l">最大</div></div>
  `;
}

/* =========================================================
   カレンダー
   ========================================================= */
// 表示する日付の範囲（週単位・連続）。開始=最古の記録の週(なければ4週前)、終了=今週の土曜。
function calRange(sorted) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let start;
  if (sorted.length) {
    start = new Date(`${sorted[0].date}T00:00:00`);
  } else {
    start = new Date(today);
    start.setDate(start.getDate() - 28);
  }
  const limit = new Date(today); // 過去は最大およそ18か月まで（DOM肥大防止）
  limit.setDate(limit.getDate() - 550);
  if (start < limit) start = limit;
  start.setDate(start.getDate() - start.getDay()); // その週の日曜へ
  // 終端は「今日」と「最新の記録」の遅い方の週の土曜まで
  let end = new Date(today);
  if (sorted.length) {
    const last = new Date(`${sorted[sorted.length - 1].date}T00:00:00`);
    if (last > end) end = last;
  }
  end.setDate(end.getDate() + (6 - end.getDay()));
  return { start, end };
}

let calMode = 'weight'; // 'weight' | 'meal'
let calView = 'month';  // 'month' | 'week'
let weekStart = null;   // 週表示の開始日（日曜）

function weekStartOf(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - x.getDay());
  return x;
}

document.querySelectorAll('#cal-seg .seg-btn').forEach((b) => {
  b.addEventListener('click', () => {
    calMode = b.dataset.mode;
    document.querySelectorAll('#cal-seg .seg-btn').forEach((x) => x.classList.toggle('is-on', x === b));
    renderCalendar();
  });
});
document.querySelectorAll('#cal-view-seg .seg-btn').forEach((b) => {
  b.addEventListener('click', () => {
    calView = b.dataset.view;
    document.querySelectorAll('#cal-view-seg .seg-btn').forEach((x) => x.classList.toggle('is-on', x === b));
    renderCalendar();
  });
});

function shiftWeek(days) {
  weekStart.setDate(weekStart.getDate() + days);
  renderCalendar();
}
$('#week-prev').addEventListener('click', () => shiftWeek(-7));
$('#week-next').addEventListener('click', () => shiftWeek(7));
$('#week-today').addEventListener('click', () => { weekStart = weekStartOf(new Date()); renderCalendar(); });

// 週表示は左右スワイプで前週/翌週へ
{
  let swX = null;
  let swY = null;
  const wrap = document.querySelector('.cal-wrap');
  wrap.addEventListener('touchstart', (e) => { swX = e.touches[0].clientX; swY = e.touches[0].clientY; }, { passive: true });
  wrap.addEventListener('touchend', (e) => {
    if (calView !== 'week' || swX == null) return;
    const dx = e.changedTouches[0].clientX - swX;
    const dy = e.changedTouches[0].clientY - swY;
    swX = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) shiftWeek(dx < 0 ? 7 : -7);
  }, { passive: true });
}

// その日の食事を「朝 自炊」「夜 外食(店名)」の行にまとめる
function mealDaySummary(meals) {
  const lines = [];
  for (const slot of ['朝', '昼', '夜', '間食']) {
    const ms = meals.filter((m) => m.slot === slot);
    if (!ms.length) continue;
    const withPlace = ms.find((m) => m.place);
    let p = '';
    if (withPlace) p = withPlace.place.type === '外食' ? `外食${withPlace.place.label ? `(${withPlace.place.label})` : ''}` : '自炊';
    lines.push(p ? `${slot} ${p}` : slot);
  }
  if (!lines.length && meals.length) lines.push('記録');
  return lines;
}

// 月の区切りをやめ、週が連続する縦スクロールのカレンダーを描く
function renderCalendar() {
  const sorted = DB.all();
  const byDate = {};
  const dirByDate = {}; // 前回記録日と比べた増減（'up' なら赤ラベル）
  sorted.forEach((e, i) => {
    byDate[e.date] = e.weight;
    if (i > 0) {
      const d = e.weight - sorted[i - 1].weight;
      dirByDate[e.date] = d > 0 ? 'up' : d < 0 ? 'down' : 'same';
    }
  });
  const kcalByDate = MealDB.totals();
  const scoreByDate = ScoreDB.all();

  const cal = $('#calendar');
  cal.innerHTML = '';

  // 表示範囲: 月ビュー=全期間連続 / 週ビュー=選択中の1週間
  const isWeek = calView === 'week';
  let start, end;
  if (isWeek) {
    if (!weekStart) weekStart = weekStartOf(new Date());
    start = new Date(weekStart);
    end = new Date(weekStart);
    end.setDate(end.getDate() + 6);
    $('#week-label').textContent =
      `${start.getMonth() + 1}/${start.getDate()} 〜 ${end.getMonth() + 1}/${end.getDate()}`;
  } else {
    ({ start, end } = calRange(sorted));
  }
  $('#week-nav').hidden = !isWeek;
  $('#cal-hint').textContent = isWeek ? '左右スワイプで前後の週へ' : 'スクロールで過去・未来へ連続表示';
  document.querySelector('.cal-scroll').classList.toggle('week', isWeek);

  const today = todayISO();
  const weighted = [];
  let shownMonth = '';
  let weekIndex = -1;

  const cur = new Date(start);
  while (cur <= end) {
    if (cur.getDay() === 0) {
      weekIndex++;
      const mk = `${cur.getFullYear()}-${cur.getMonth()}`;
      if (!isWeek && mk !== shownMonth) {
        shownMonth = mk;
        const h = document.createElement('div');
        h.className = 'cal-month';
        h.textContent = `${cur.getFullYear()}年 ${cur.getMonth() + 1}月`;
        cal.appendChild(h);
      }
    }
    const iso = toISO(cur);
    const dow = cur.getDay();
    const el = document.createElement('div');
    el.className = 'cal-cell'
      + (isWeek ? ' wk' : '')
      + (iso === today ? ' today' : '')
      + (dow === 0 ? ' sun' : dow === 6 ? ' sat' : '');
    if (calMode === 'meal') {
      const dayMeals = MealDB.byDate(iso);
      const lines = mealDaySummary(dayMeals).map((l) => `<span class="ml">${escapeHtml(l)}</span>`).join('');
      el.innerHTML = `<span class="d">${cur.getDate()}</span>${lines}`;
      if (dayMeals.length) {
        el.classList.add('has-meal');
        const dateISO = iso;
        el.addEventListener('click', () => {
          switchTab('meal'); // ※タブ切替は日付を今日に戻すので、先に切替えてから目的の日へ
          mealDate.value = dateISO;
          renderMealDay();
        });
      }
    } else {
      const kc = kcalByDate[iso];
      const sc = scoreByDate[iso];
      el.innerHTML = `<span class="d">${cur.getDate()}</span>`
        + (sc != null ? `<span class="cs">${sc}点</span>` : '')
        + (kc !== undefined ? `<span class="kc">${kc.toLocaleString()}</span>` : '');
    }
    cal.appendChild(el);
    if (calMode !== 'meal' && byDate[iso] !== undefined) {
      weighted.push({ el, w: byDate[iso], weekRow: weekIndex, up: dirByDate[iso] === 'up' });
    }
    cur.setDate(cur.getDate() + 1);
  }

  drawCalGraph(weighted);
  // 月ビューは最新（今日）が見えるよう一番下までスクロール
  if (!isWeek) {
    const sc = document.querySelector('.cal-scroll');
    if (sc) sc.scrollTop = sc.scrollHeight;
  }
}

// カレンダーの上に体重の折れ線グラフ(SVG)を重ねて描く
function drawCalGraph(items) {
  const svg = $('#cal-graph');
  svg.innerHTML = '';
  const wrap = svg.parentElement;
  const W = wrap.clientWidth;
  const H = wrap.clientHeight;
  if (!items.length || !W) return;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  const ws = items.map((it) => it.w);
  const min = Math.min(...ws);
  const span = (Math.max(...ws) - min) || 1;
  const NS = 'http://www.w3.org/2000/svg';

  items.forEach((it) => {
    const el = it.el;
    it.x = el.offsetLeft + el.offsetWidth / 2;
    const frac = (it.w - min) / span; // 0(最小)〜1(最大)
    it.y = el.offsetTop + el.offsetHeight * 0.82 - frac * (el.offsetHeight * 0.46);
  });

  // 折れ線は同じ週(行)の中だけ結ぶ
  const rows = {};
  items.forEach((it) => { (rows[it.weekRow] = rows[it.weekRow] || []).push(it); });
  Object.values(rows).forEach((row) => {
    if (row.length < 2) return;
    row.sort((a, b) => a.x - b.x);
    const pl = document.createElementNS(NS, 'polyline');
    pl.setAttribute('points', row.map((p) => `${p.x},${p.y}`).join(' '));
    pl.setAttribute('class', 'cg-line');
    svg.appendChild(pl);
  });

  // 点と体重ラベル（前日比プラスは赤）
  items.forEach((it) => {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', it.x);
    c.setAttribute('cy', it.y);
    c.setAttribute('r', '3.5');
    c.setAttribute('class', 'cg-dot');
    svg.appendChild(c);
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', it.x);
    t.setAttribute('y', it.y - 6);
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('class', 'cg-label' + (it.up ? ' up' : ''));
    t.textContent = it.w.toFixed(1);
    svg.appendChild(t);
  });
}


/* =========================================================
   一覧 / CSV
   ========================================================= */
let listMode = 'weight'; // 'weight' | 'meal'
let mealSelect = false;       // 複数選択モード
const selMeals = new Set();   // 選択中の食事ID

function updateDelBar() {
  $('#meal-del-bar').hidden = !mealSelect;
  $('#meal-del-exec').textContent = `削除（${selMeals.size}件）`;
  $('#list-select').hidden = listMode !== 'meal' || mealSelect;
}

document.querySelectorAll('#list-seg .seg-btn').forEach((b) => {
  b.addEventListener('click', () => {
    listMode = b.dataset.mode;
    mealSelect = false;
    selMeals.clear();
    document.querySelectorAll('#list-seg .seg-btn').forEach((x) => x.classList.toggle('is-on', x === b));
    renderList();
  });
});

$('#list-select').addEventListener('click', () => {
  mealSelect = true;
  selMeals.clear();
  renderList();
});
$('#meal-del-cancel').addEventListener('click', () => {
  mealSelect = false;
  selMeals.clear();
  renderList();
});
$('#meal-del-exec').addEventListener('click', () => {
  if (!selMeals.size) { showToast('削除する項目を選んでください'); return; }
  if (!confirm(`${selMeals.size}件の食事を削除しますか？`)) return;
  [...selMeals].forEach((id) => MealDB.remove(id));
  mealSelect = false;
  selMeals.clear();
  renderList();
  showToast('削除しました');
});

function renderList() {
  updateDelBar();
  if (listMode === 'meal') { renderMealList(); return; }
  const list = DB.all().slice().reverse(); // 新しい順
  const box = $('#list');
  const empty = $('#list-empty');
  box.innerHTML = '';

  if (list.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  list.forEach((e, idx) => {
    const prev = list[idx + 1]; // 一つ前(時系列で前日側)
    let diffHtml = '';
    if (prev) {
      const d = e.weight - prev.weight;
      const cls = d > 0 ? 'up' : d < 0 ? 'down' : '';
      const sign = d > 0 ? '+' : '';
      diffHtml = `<span class="diff ${cls}">${sign}${d.toFixed(1)}</span>`;
    }
    const fatHtml = e.bodyFat != null ? `<span class="lfat">体脂肪 ${e.bodyFat.toFixed(1)}%</span>` : '';
    const row = document.createElement('div');
    row.className = 'list-row';
    row.innerHTML = `
      <div class="ld">${e.date}</div>
      <div><span class="lw">${e.weight.toFixed(1)}kg</span>${diffHtml}${fatHtml}</div>
      <button class="ldel" data-date="${e.date}" aria-label="削除">🗑</button>
    `;
    box.appendChild(row);
  });

  box.querySelectorAll('.ldel').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (confirm(`${btn.dataset.date} の記録を削除しますか？`)) {
        DB.remove(btn.dataset.date);
        renderList();
      }
    });
  });
}

// 日付ごとにグループした食事一覧（タップで編集・選択モードでまとめて削除）
function renderMealList() {
  updateDelBar();
  const box = $('#list');
  const empty = $('#list-empty');
  box.innerHTML = '';
  const meals = MealDB.all().slice().sort((a, b) => b.date.localeCompare(a.date));
  if (meals.length === 0) { empty.hidden = false; return; }
  empty.hidden = true;

  const scores = ScoreDB.all();
  let curDate = '';
  meals.forEach((m) => {
    if (m.date !== curDate) {
      curDate = m.date;
      const total = MealDB.byDate(curDate).reduce((s, x) => s + x.kcal, 0);
      const sc = scores[curDate];
      const h = document.createElement('div');
      h.className = 'meal-date-head';
      h.innerHTML = `<span>${curDate}</span><span>${total.toLocaleString()}kcal${sc != null ? ` ・ ${sc}点` : ''}</span>`;
      box.appendChild(h);
    }
    const row = document.createElement('div');
    row.className = 'list-row meal-row';
    const check = mealSelect ? `<input type="checkbox" class="msel" ${selMeals.has(m.id) ? 'checked' : ''} />` : '';
    const del = mealSelect ? '' : '<button class="ldel" aria-label="削除">🗑</button>';
    row.innerHTML = `
      ${check}
      <div class="ld">${escapeHtml(m.name)}${mealTagHtml(m)}</div>
      <div><span class="lw">${m.kcal.toLocaleString()}</span><span class="diff"> kcal</span></div>
      ${del}
    `;
    if (mealSelect) {
      const cb = row.querySelector('.msel');
      const toggle = () => {
        if (selMeals.has(m.id)) selMeals.delete(m.id); else selMeals.add(m.id);
        cb.checked = selMeals.has(m.id);
        updateDelBar();
      };
      cb.addEventListener('click', (e) => { e.stopPropagation(); toggle(); cb.checked = selMeals.has(m.id); });
      row.addEventListener('click', toggle);
    } else {
      row.querySelector('.ldel').addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`「${m.name}」を削除しますか？`)) { MealDB.remove(m.id); renderList(); }
      });
      row.querySelector('.ld').addEventListener('click', () => openMealEdit(m.id));
    }
    box.appendChild(row);
  });
}

$('#export-btn').addEventListener('click', () => {
  if (listMode === 'meal') { $('#meal-export').click(); return; }
  const list = DB.all();
  if (list.length === 0) { alert('データがありません'); return; }
  const csv = 'date,weight,bodyFat\n' + list.map((e) => `${e.date},${e.weight},${e.bodyFat ?? ''}`).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `weight-${todayISO()}.csv`;
  a.click();
});

/* =========================================================
   Service Worker 登録（PWA）
   ========================================================= */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW登録失敗', e));
  });
}
