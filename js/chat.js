'use strict';

/* =========================================================
   クロちゃんチャット（アプリ内AI連携 / Claude API 直接呼び出し）
   - APIキーはこの端末の localStorage にのみ保存
   - 返信に #体重ログ ブロックがあれば、その場で保存できる
   ========================================================= */

const AI_KEY = 'anthropic-api-key';
const AI_MODEL_KEY = 'ai-model';
const getApiKey = () => (localStorage.getItem(AI_KEY) || '').trim();
const getAiModel = () => localStorage.getItem(AI_MODEL_KEY) || 'claude-opus-5';

// クロちゃんのキャラ設定 + アプリ取り込み用フォーマット指示
function buildKuroSystem() {
  const today = todayISO();
  return `あなたは「クロちゃん」という、親しみやすくて的確な食事・体重管理のパートナーです。ユーザーの減量とボディメイクを、優しく前向きに、でも甘やかしすぎずサポートします。タメ口まじりのフレンドリーな口調で、絵文字は控えめに。

今日の日付は ${today} です。日付が明示されない食事・体重の報告は今日として扱ってください。

ユーザーが食べたものや体重・体脂肪を報告したら、次の2つを返します：
1. ひとことフィードバック（1〜3文。褒める・気をつける点・ちょっとした提案など）
2. アプリ取り込み用の「#体重ログ」ブロック（下記フォーマット厳守）。カロリーは1品ずつ推定し、点数は栄養バランス・量・時間帯などから0〜100点で採点。

「#体重ログ」ブロックのフォーマット（該当する行だけ、余計な記号なし）:
#体重ログ
${today}
時間帯 朝/昼/夜/間食
外食 店名        （外食のとき。自炊なら「自炊」の1行）
料理名 カロリー   （食べた品ごとに1行。例: 焼き鳥5本 450）
体重 数字         （体重の報告があれば）
体脂肪 数字       （体脂肪率の報告があれば）
点数 数字         （食事の報告があれば必ず入れる）

ルール:
- カロリーや体重は半角数字のみ（「約」や単位を付けない）。
- 料理名とカロリーは半角スペースで区切る。
- 体重・体脂肪だけの報告なら、食事の行と点数は省略。
- ただの雑談や質問には普通に会話で答え、「#体重ログ」ブロックは食事・体重の記録があるときだけ出す。`;
}

const chatMessages = []; // {role:'user'|'assistant', content:string}
let chatBusy = false;

function chatEl(id) { return document.getElementById(id); }

// APIキーの有無でチャット欄／未設定案内を切り替える
function refreshChatKeyState() {
  const has = !!getApiKey();
  const nokey = chatEl('chat-nokey');
  const log = chatEl('chat-log');
  const row = document.querySelector('.chat-input-row');
  if (!nokey || !log || !row) return;
  nokey.hidden = has;
  log.hidden = !has;
  row.hidden = !has;
}

function scrollChatToBottom() {
  const log = chatEl('chat-log');
  if (log) log.scrollTop = log.scrollHeight;
}

// チャットの吹き出しを描く
function renderChat() {
  const log = chatEl('chat-log');
  if (!log) return;
  log.innerHTML = '';
  if (!chatMessages.length) {
    log.innerHTML = '<p class="chat-hello">クロちゃんに、食べたものや体重を話しかけてみて 🐾</p>';
    return;
  }
  chatMessages.forEach((m) => {
    const b = document.createElement('div');
    b.className = `chat-bubble ${m.role}`;
    b.textContent = m.content;
    log.appendChild(b);
    if (m.role === 'assistant') {
      const parsed = OcrParse.parseMealTemplate(m.content);
      if (parsed && (parsed.items.length || parsed.weight != null || parsed.score != null)) {
        log.appendChild(buildChatSaveCard(parsed));
      }
    }
  });
  scrollChatToBottom();
}

// #体重ログ を検出したときの「この内容で保存」カード
function buildChatSaveCard(res) {
  const date = res.date || mealDate.value || todayISO();
  const box = document.createElement('div');
  box.className = 'chat-save';
  const rows = [];
  const ctx = [];
  if (res.slot) ctx.push(res.slot);
  if (res.place) ctx.push(res.place.type === '外食' ? `外食(${res.place.label || ''})` : '自炊');
  if (ctx.length) rows.push(`<div class="paste-item"><span>区分</span><span>${escapeHtml(ctx.join('・'))}</span></div>`);
  res.items.forEach((i) => rows.push(`<div class="paste-item"><span>${escapeHtml(i.name)}</span><span>${i.kcal.toLocaleString()}kcal</span></div>`));
  if (res.weight != null) rows.push(`<div class="paste-item"><span>体重</span><span>${res.weight}kg</span></div>`);
  if (res.bodyFat != null) rows.push(`<div class="paste-item"><span>体脂肪率</span><span>${res.bodyFat}%</span></div>`);
  if (res.score != null) rows.push(`<div class="paste-item"><span>点数</span><span>${res.score}点</span></div>`);
  box.innerHTML = `<p class="hint mini"><b>${date}</b> に保存できます</p>${rows.join('')}`
    + '<button class="btn-primary btn-block chat-save-btn">この内容で保存</button>';
  box.querySelector('.chat-save-btn').addEventListener('click', (e) => {
    res.items.forEach((i) => MealDB.add(date, i.name, i.kcal, { slot: res.slot, place: res.place }));
    if (res.weight != null) DB.save(date, res.weight, res.bodyFat != null ? res.bodyFat : '');
    if (res.score != null) ScoreDB.set(date, res.score);
    if (res.items.length) { mealDate.value = date; renderMealDay(); }
    const bits = [];
    if (res.items.length) bits.push(`食事${res.items.length}件`);
    if (res.weight != null) bits.push('体重');
    if (res.score != null) bits.push('点数');
    showToast(`${bits.join('・') || 'データ'}を保存しました`);
    e.target.textContent = '✓ 保存しました';
    e.target.disabled = true;
    e.target.classList.add('done');
  });
  return box;
}

// Claude API 呼び出し（ブラウザ直叩き）
async function callClaude() {
  const model = getAiModel();
  const body = {
    model,
    max_tokens: 2048,
    system: buildKuroSystem(),
    messages: chatMessages.map((m) => ({ role: m.role, content: m.content })),
  };
  // opus / sonnet は effort を下げてコスト・レイテンシを抑える（haiku は effort 非対応）
  if (model.startsWith('claude-opus') || model.startsWith('claude-sonnet')) {
    body.output_config = { effort: 'low' };
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': getApiKey(),
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      const err = await res.json();
      msg = err && err.error && err.error.message ? err.error.message : JSON.stringify(err).slice(0, 200);
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

async function sendChat() {
  if (chatBusy) return;
  const input = chatEl('chat-input');
  const text = (input.value || '').trim();
  if (!text) return;
  if (!getApiKey()) { showToast('先に設定でAPIキーを登録してください'); return; }

  chatMessages.push({ role: 'user', content: text });
  input.value = '';
  renderChat();

  chatBusy = true;
  const log = chatEl('chat-log');
  const typing = document.createElement('div');
  typing.className = 'chat-bubble assistant typing';
  typing.textContent = 'クロちゃんが考え中…';
  log.appendChild(typing);
  scrollChatToBottom();

  try {
    const reply = await callClaude();
    chatMessages.push({ role: 'assistant', content: reply || '(空の返信でした)' });
    renderChat();
  } catch (err) {
    console.error('chat error', err);
    typing.remove();
    chatMessages.push({ role: 'assistant', content: `⚠️ うまく話せませんでした: ${err.message}` });
    renderChat();
  } finally {
    chatBusy = false;
  }
}

/* ---- 配線 ---- */
(function setupChat() {
  const send = chatEl('chat-send');
  const input = chatEl('chat-input');
  if (send) send.addEventListener('click', sendChat);
  if (input) {
    input.addEventListener('keydown', (e) => {
      // Enter=送信 / Shift+Enter=改行（スマホでは送信ボタン推奨）
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendChat(); }
    });
  }
  // 記録タブを開くたびにキー状態を反映
  const recTab = document.querySelector('.tab[data-tab="record"]');
  if (recTab) recTab.addEventListener('click', () => { refreshChatKeyState(); renderChat(); });

  // 「設定（APIキー）を開く」→ 一覧・設定タブへ切替え、AIカードまでスクロール
  const openSettings = chatEl('chat-open-settings');
  if (openSettings) {
    openSettings.addEventListener('click', () => {
      if (typeof switchTab === 'function') switchTab('list');
      setTimeout(() => {
        const card = chatEl('ai-settings-card');
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
        const inp = chatEl('api-key-input');
        if (inp) inp.focus({ preventScroll: true });
      }, 80);
    });
  }

  // 設定：APIキー・モデルの保存
  const keySave = chatEl('api-key-save');
  if (keySave) {
    keySave.addEventListener('click', () => {
      const raw = (chatEl('api-key-input').value || '').trim();
      const model = chatEl('ai-model').value;
      // マスク表示（••）のまま保存されたらキーは変更しない
      const isMask = raw && /^[•]+$/.test(raw);
      if (!isMask) {
        if (raw) localStorage.setItem(AI_KEY, raw); else localStorage.removeItem(AI_KEY);
      }
      localStorage.setItem(AI_MODEL_KEY, model);
      refreshChatKeyState();
      updateAiSettings();
      showToast(getApiKey() ? '設定を保存しました' : 'APIキーを削除しました');
    });
  }
  refreshChatKeyState();
  renderChat();
})();

// 設定画面の表示を現在値に合わせる（renderList / updateSettingsInputs から呼ぶ）
function updateAiSettings() {
  const inp = chatEl('api-key-input');
  const sel = chatEl('ai-model');
  const status = chatEl('api-key-status');
  if (sel) sel.value = getAiModel();
  if (inp) inp.value = getApiKey() ? '••••••••••••' : '';
  if (status) status.textContent = getApiKey() ? '✓ キー登録済み。記録タブでクロちゃんと話せます。' : '未登録です。';
}
