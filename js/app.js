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
  const list = filteredEntries();
  const empty = $('#graph-empty');
  const statsBox = $('#graph-stats');

  if (list.length === 0) {
    empty.hidden = false;
    statsBox.innerHTML = '';
    if (chart) { chart.destroy(); chart = null; }
    return;
  }
  empty.hidden = true;

  const labels = list.map((e) => e.date.slice(5).replace('-', '/'));
  const data = list.map((e) => e.weight);

  if (chart) chart.destroy();
  chart = new Chart($('#line-chart'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: '体重 (kg)',
        data,
        borderColor: '#22d3ee',
        backgroundColor: 'rgba(34,211,238,.12)',
        borderWidth: 2,
        tension: 0.3,
        fill: true,
        pointRadius: list.length > 60 ? 0 : 3,
        pointBackgroundColor: '#0ea5a4',
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#93a4bd', maxTicksLimit: 8 }, grid: { color: 'rgba(255,255,255,.05)' } },
        y: { ticks: { color: '#93a4bd' }, grid: { color: 'rgba(255,255,255,.05)' } },
      },
    },
  });

  renderStats(statsBox, data);
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

  const byDate = {};
  DB.all().forEach((e) => { byDate[e.date] = e.weight; });

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
    el.innerHTML = `<span class="d">${day}</span>` + (w !== undefined ? `<span class="w">${w.toFixed(1)}</span>` : '');
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
