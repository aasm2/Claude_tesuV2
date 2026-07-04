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
  save(date, weight) {
    const list = this.all().filter((e) => e.date !== date); // 同じ日付は上書き
    list.push({ date, weight: Number(weight), updatedAt: Date.now() });
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
  add(date, name, kcal) {
    const list = this.all();
    list.push({ id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`, date, name, kcal: Math.round(kcal) });
    localStorage.setItem(MEAL_KEY, JSON.stringify(list));
  },
  remove(id) {
    localStorage.setItem(MEAL_KEY, JSON.stringify(this.all().filter((m) => m.id !== id)));
  },
};

/* ---------------- ユーティリティ ---------------- */
const $ = (sel) => document.querySelector(sel);
const pad = (n) => String(n).padStart(2, '0');
const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayISO = () => toISO(new Date());

/* ---------------- タブ切り替え ---------------- */
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const name = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
    document.querySelectorAll('.tab-panel').forEach((p) => {
      p.classList.toggle('is-active', p.id === `tab-${name}`);
    });
    if (name === 'meal') renderMealDay();
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

fileInput.addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  const url = URL.createObjectURL(file);
  preview.src = url;
  previewWrap.hidden = false;

  ocrStatus.hidden = false;
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
    ocrStatusText.textContent = entries.length > 1
      ? `${entries.length}件の記録が見つかりました。確認してください。`
      : '読み取り完了。確認してください。';
    ocrProgress.style.width = '100%';
  } catch (err) {
    console.error(err);
    ocrStatusText.textContent = '読み取りに失敗しました。手動で入力してください。';
    showConfirm([{ date: todayISO(), weight: '' }]);
  }
});

/* ---------------- 確認・保存 ---------------- */
const entryRows = $('#entry-rows');
const saveMsg = $('#save-msg');

function showConfirm(entries) {
  confirmCard.hidden = false;
  entryRows.innerHTML = '';
  entries.forEach((e) => entryRows.appendChild(buildRow(e.date, e.weight)));
  saveMsg.hidden = true;
  confirmCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function buildRow(date, weight) {
  const row = document.createElement('div');
  row.className = 'entry-row';
  row.innerHTML = `
    <input type="checkbox" checked aria-label="この記録を保存する" />
    <input type="date" value="${date}" />
    <input type="number" step="0.1" inputmode="decimal" placeholder="65.4" value="${weight === '' ? '' : weight}" />
  `;
  return row;
}

$('#manual-btn').addEventListener('click', () => {
  showConfirm([{ date: todayISO(), weight: '' }]);
});

$('#add-row-btn').addEventListener('click', () => {
  entryRows.appendChild(buildRow(todayISO(), ''));
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
    const date = r.querySelector('input[type=date]').value;
    const weight = parseFloat(r.querySelector('input[type=number]').value);
    if (!date) {
      flash('日付が空の行があります', 'var(--danger)');
      return;
    }
    if (!weight || weight < 10 || weight > 400) {
      flash(`体重を正しく入力してください（${date}）`, 'var(--danger)');
      return;
    }
    picked.push({ date, weight });
  }
  picked.forEach((e) => DB.save(e.date, e.weight));
  flash(
    picked.length === 1
      ? `保存しました: ${picked[0].date} / ${picked[0].weight.toFixed(1)}kg`
      : `${picked.length}件保存しました`,
    'var(--ok)'
  );
});

$('#clear-btn').addEventListener('click', () => {
  confirmCard.hidden = true;
  previewWrap.hidden = true;
  ocrStatus.hidden = true;
  ocrRawWrap.hidden = true;
  fileInput.value = '';
});

function flash(msg, color) {
  saveMsg.hidden = false;
  saveMsg.textContent = msg;
  saveMsg.style.color = color;
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

  meals.forEach((m) => {
    const row = document.createElement('div');
    row.className = 'list-row';
    row.innerHTML = `
      <div class="ld">${m.name}</div>
      <div><span class="lw">${m.kcal.toLocaleString()}</span><span class="diff"> kcal</span></div>
      <button class="ldel" data-id="${m.id}" aria-label="削除">🗑</button>
    `;
    row.querySelector('.ldel').addEventListener('click', () => {
      MealDB.remove(m.id);
      renderMealDay();
    });
    box.appendChild(row);
  });
}

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
    borderColor: '#22d3ee',
    backgroundColor: 'rgba(34,211,238,.12)',
    borderWidth: 2,
    tension: 0.3,
    fill: true,
    spanGaps: true,
    pointRadius: dates.length > 60 ? 0 : 3,
    pointBackgroundColor: '#0ea5a4',
  }];
  if (hasKcal) {
    datasets.push({
      type: 'bar',
      label: '摂取カロリー (kcal)',
      data: kcalData,
      yAxisID: 'y1',
      backgroundColor: 'rgba(251,146,60,.35)',
      borderRadius: 3,
    });
  }

  if (chart) chart.destroy();
  chart = new Chart($('#line-chart'), {
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: hasKcal, labels: { color: '#93a4bd', boxWidth: 12 } } },
      scales: {
        x: { ticks: { color: '#93a4bd', maxTicksLimit: 8 }, grid: { color: 'rgba(255,255,255,.05)' } },
        y: { ticks: { color: '#22d3ee' }, grid: { color: 'rgba(255,255,255,.05)' } },
        ...(hasKcal ? {
          y1: {
            position: 'right',
            beginAtZero: true,
            ticks: { color: '#fb923c' },
            grid: { drawOnChartArea: false },
          },
        } : {}),
      },
    },
  });

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
let calYear, calMonth; // calMonth: 0-11

function initCalState() {
  if (calYear === undefined) {
    const now = new Date();
    calYear = now.getFullYear();
    calMonth = now.getMonth();
  }
}

$('#cal-prev').addEventListener('click', () => { shiftMonth(-1); });
$('#cal-next').addEventListener('click', () => { shiftMonth(1); });
function shiftMonth(delta) {
  initCalState();
  calMonth += delta;
  if (calMonth < 0) { calMonth = 11; calYear--; }
  if (calMonth > 11) { calMonth = 0; calYear++; }
  renderCalendar();
}

function renderCalendar() {
  initCalState();
  $('#cal-title').textContent = `${calYear}年 ${calMonth + 1}月`;

  const sorted = DB.all();
  const byDate = {};
  const dirByDate = {}; // 前回記録日と比べた増減（'up' なら赤表示）
  sorted.forEach((e, i) => {
    byDate[e.date] = e.weight;
    if (i > 0) {
      const d = e.weight - sorted[i - 1].weight;
      dirByDate[e.date] = d > 0 ? 'up' : d < 0 ? 'down' : 'same';
    }
  });
  const kcalByDate = MealDB.totals();

  const cal = $('#calendar');
  cal.innerHTML = '';

  const dows = ['日', '月', '火', '水', '木', '金', '土'];
  dows.forEach((d) => {
    const el = document.createElement('div');
    el.className = 'cal-dow';
    el.textContent = d;
    cal.appendChild(el);
  });

  const firstDow = new Date(calYear, calMonth, 1).getDay();
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const today = todayISO();

  for (let i = 0; i < firstDow; i++) {
    const el = document.createElement('div');
    el.className = 'cal-cell empty';
    cal.appendChild(el);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const iso = `${calYear}-${pad(calMonth + 1)}-${pad(day)}`;
    const el = document.createElement('div');
    el.className = 'cal-cell' + (iso === today ? ' today' : '');
    const w = byDate[iso];
    const kc = kcalByDate[iso];
    const wCls = dirByDate[iso] === 'up' ? ' up' : '';
    el.innerHTML = `<span class="d">${day}</span>`
      + (w !== undefined ? `<span class="w${wCls}">${w.toFixed(1)}</span>` : '')
      + (kc !== undefined ? `<span class="kc">${kc.toLocaleString()}</span>` : '');
    cal.appendChild(el);
  }
}

/* =========================================================
   一覧 / CSV
   ========================================================= */
function renderList() {
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
    const row = document.createElement('div');
    row.className = 'list-row';
    row.innerHTML = `
      <div class="ld">${e.date}</div>
      <div><span class="lw">${e.weight.toFixed(1)}kg</span>${diffHtml}</div>
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

$('#export-btn').addEventListener('click', () => {
  const list = DB.all();
  if (list.length === 0) { alert('データがありません'); return; }
  const csv = 'date,weight\n' + list.map((e) => `${e.date},${e.weight}`).join('\n');
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
