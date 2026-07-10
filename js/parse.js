'use strict';

/* =========================================================
   OCRテキストから日付・体重を抽出するロジック
   （app.js と Node のテストで共用）

   対応フォーマット例:
   - 体脂肪計アプリ履歴: 「07/03/2026 … 53.3kg … 23.4 BMI」が複数行
   - ヘルスケア系:       「2026年6月20日 68.3 kg」「体重 65.4kg」など
   ========================================================= */
(function () {
  const pad = (n) => String(n).padStart(2, '0');
  const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  function normalize(text) {
    return text
      // 丸囲み数字 ①〜⑳ と ⓪ を普通の数字に（体組成計の数字がこう誤認されやすい）
      .replace(/[①-⑳⓪]/g, (c) => {
        const cp = c.codePointAt(0);
        return cp === 0x24EA ? '0' : String(cp - 0x2460 + 1); // ①=1 … ⑳=20
      })
      // 全角数字 → 半角
      .replace(/[０-９]/g, (c) => String(c.codePointAt(0) - 0xFF10))
      .replace(/[，]/g, '.')
      // O/o は数字に隣接していれば 0 の誤読とみなして補正する
      .replace(/(?<=\d)[Oo]|[Oo](?=[\d.])/g, '0');
  }

  function iso(y, m, d) {
    if (m < 1 || m > 12 || d < 1 || d > 31) return '';
    return `${y}-${pad(m)}-${pad(d)}`;
  }

  function dateFrom(text, now) {
    // 2026/06/27, 2026-06-27, 2026年6月27日
    let m = text.match(/(20\d{2})\s*[\/\-.年]\s*(\d{1,2})\s*[\/\-.月]\s*(\d{1,2})/);
    if (m) return iso(+m[1], +m[2], +m[3]);

    // 07/03/2026（月/日/年）。先頭が13以上なら 日/月/年 とみなす
    m = text.match(/(\d{1,2})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(20\d{2})/);
    if (m) {
      let mm = +m[1];
      let dd = +m[2];
      if (mm > 12 && dd <= 12) { const t = mm; mm = dd; dd = t; }
      return iso(+m[3], mm, dd);
    }

    // 6月27日 / 6/27（年なし。未来日になるなら前年とみなす）
    m = text.match(/(\d{1,2})\s*[\/月]\s*(\d{1,2})\s*日?/);
    if (m) {
      const mm = +m[1];
      const dd = +m[2];
      if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
        let y = now.getFullYear();
        if (new Date(y, mm - 1, dd) > now) y -= 1;
        return iso(y, mm, dd);
      }
    }
    return '';
  }

  // 「数字 + k」を体重とみなす（kg が kd/k9 等に誤読されても拾える）。20〜200のみ。
  function kgValue(text) {
    const m = text.match(/(\d{2,3})[.,](\d)\s*[kﾋｷ]/i);
    if (!m) return null;
    const v = parseFloat(`${m[1]}.${m[2]}`);
    return v >= 20 && v <= 200 ? v : null;
  }

  /**
   * 行単位の体重候補。
   * - 「%」を含む行は体脂肪率・筋肉量など別指標なので除外
   * - 「数字+k」（kg等）を体重とする。単位が読めなくても BMI 行なら先頭の妥当な数値を採用
   */
  function weightFromLine(line) {
    if (/%/.test(line)) return null;
    const v = kgValue(line);
    if (v != null) return v;
    // 単位が完全に読めなかった場合の保険（BMI 行のみ・体重は先頭側に来る）
    if (/bmi/i.test(line)) {
      const re = /(\d{2,3})[.,](\d)/g;
      let m;
      while ((m = re.exec(line)) !== null) {
        const x = parseFloat(`${m[1]}.${m[2]}`);
        if (x >= 20 && x <= 200) return x;
      }
    }
    return null;
  }

  // フォールバック: 画面全体から1件だけ推定（従来ロジック）
  function weightFromWhole(text) {
    const candidates = [];
    let m;
    const reKg = /(\d{2,3})[.,](\d)\s*[kﾋｷ]/gi;
    while ((m = reKg.exec(text)) !== null) {
      candidates.push(parseFloat(`${m[1]}.${m[2]}`));
    }
    if (candidates.length === 0) {
      const reLabel = /(?:体重|weight|たいじゅう)\D{0,6}(\d{2,3}[.,]\d)/gi;
      while ((m = reLabel.exec(text)) !== null) {
        candidates.push(parseFloat(m[1].replace(',', '.')));
      }
    }
    if (candidates.length === 0) {
      // 妥当な体重レンジの小数を拾う（%付きは除外）
      const reNum = /\b(\d{2,3}[.,]\d)\b(?!\s*%)/g;
      while ((m = reNum.exec(text)) !== null) {
        const v = parseFloat(m[1].replace(',', '.'));
        if (v >= 20 && v <= 200) candidates.push(v);
      }
    }
    const valid = candidates.filter((v) => v >= 20 && v <= 200);
    return valid.length ? valid[0] : null;
  }

  // 「08:31:17」「7:29」などの時刻を 0:00 からの分に変換する
  function timeFrom(text) {
    const m = text.match(/\b([0-2]?\d):([0-5]\d)(?::[0-5]\d)?\b/);
    if (!m) return null;
    const h = +m[1];
    if (h > 23) return null;
    return h * 60 + +m[2];
  }

  const TARGET_MIN = 7 * 60; // 朝7:00

  // 行から妥当な範囲のパーセント値を1つ取る
  function percentIn(text, lo, hi) {
    if (!text) return null;
    const re = /(\d{1,2}(?:[.,]\d)?)\s*[%％]/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const v = parseFloat(m[1].replace(',', '.'));
      if (v >= lo && v <= hi) return v;
    }
    return null;
  }

  // Tesseract は日本語の字間に空白を入れることがある（「体 脂 肪 率」）ので空白を無視して判定
  const FAT_LABEL = /体\s*脂\s*肪\s*率/;

  /**
   * 詳細画面のOCRから「体脂肪率」を日付ごとに拾う。
   * レイアウト上、値（32.0%）はラベル「体脂肪率」の前の行に来ることが多いので
   * 前行→同行→次行の順で 3〜60% の値を探し、直上の日付に紐づける。
   */
  function bodyFatByDate(lines, now) {
    const map = {};
    for (let i = 0; i < lines.length; i++) {
      if (!FAT_LABEL.test(lines[i])) continue;
      const bf = percentIn(lines[i - 1], 3, 60)
        ?? percentIn(lines[i], 3, 60)
        ?? percentIn(lines[i + 1], 3, 60);
      if (bf == null) continue;
      let d = '';
      for (let j = i; j >= 0; j--) {
        const dd = dateFrom(lines[j], now);
        if (dd) { d = dd; break; }
      }
      if (d && map[d] == null) map[d] = bf;
    }
    return map;
  }

  /**
   * OCRテキスト全体を解析し、{date, weight} の配列を返す。
   * 履歴画面のように複数の記録が写っていれば全件返す。
   * 同じ日付が複数ある場合は、測定時刻が朝7:00に最も近いものを採用する。
   * 何も取れなくても、手修正用に1行（今日・体重空欄）は返す。
   */
  function parseOcrText(text, now) {
    now = now || new Date();
    const cleaned = normalize(text);
    const lines = cleaned.split(/\r?\n/).map((s) => s.trim());
    const fatByDate = bodyFatByDate(lines, now);
    const entries = [];
    let pendingDate = '';
    let pendingTime = null;
    let lastEntry = null;

    for (const line of lines) {
      if (!line) continue;
      const date = dateFrom(line, now);
      const weight = weightFromLine(line);
      // 日付・体重を含む行の数字を時刻と誤認しないように、それ以外の行だけ時刻判定する
      const time = (date || weight != null) ? null : timeFrom(line);

      if (date && weight != null) {
        lastEntry = { date, weight, time: timeFrom(line) };
        entries.push(lastEntry);
        pendingDate = '';
        pendingTime = null;
      } else if (date) {
        pendingDate = date;
        pendingTime = null;
      } else if (weight != null) {
        if (pendingDate) {
          lastEntry = { date: pendingDate, weight, time: pendingTime };
          entries.push(lastEntry);
          pendingDate = '';
          pendingTime = null;
        }
      } else if (time != null) {
        // 時刻だけの行: 直近の記録（まだ時刻なし）か、次に来る体重に紐づける
        if (lastEntry && lastEntry.time == null && !pendingDate) {
          lastEntry.time = time;
        } else {
          pendingTime = time;
        }
      }
    }

    if (entries.length) {
      // 同じ日付が複数 → 朝7:00に最も近い時刻のものを採用（時刻なしは最後の手段）
      const best = {};
      for (const e of entries) {
        const dist = e.time == null ? Infinity : Math.abs(e.time - TARGET_MIN);
        if (!best[e.date] || dist < best[e.date].dist) {
          best[e.date] = { weight: e.weight, dist };
        }
      }
      return Object.keys(best).sort().map((date) => ({
        date,
        weight: best[date].weight,
        bodyFat: fatByDate[date] ?? '',
      }));
    }

    const w = weightFromWhole(cleaned);
    const date = dateFrom(cleaned, now) || toISO(now);
    return [{
      date,
      weight: w == null ? '' : w,
      bodyFat: fatByDate[date] ?? '',
    }];
  }

  /**
   * 栄養成分表示の写真OCRから「エネルギー ○○ kcal」を拾う。
   * 直接 kcal に付いた数字を最優先し、無ければ「エネルギー/熱量」付近の数字。
   */
  function extractKcal(text) {
    const c = normalize(text);
    let m;
    const reKcal = /(\d{1,4})\s*(?:kcal|ｋｃａｌ|キロカロリー)/ig;
    while ((m = reKcal.exec(c)) !== null) {
      const v = +m[1];
      if (v >= 1 && v <= 4000) return v;
    }
    m = c.match(/(?:エネルギー|熱量|カロリー)\D{0,8}(\d{1,4})/i);
    if (m) {
      const v = +m[1];
      if (v >= 1 && v <= 4000) return v;
    }
    return null;
  }

  /**
   * 貼り付け/クリップボードのテキストを解析する。
   * - 1行目の `#体重ログ` などの目印行は無視
   * - 日付行（任意）
   * - `体重 53.2` / `体脂肪 31.8` / `点数 82` の行
   * - それ以外は `料理名 カロリー` の食事行
   * 戻り値: { date, items:[{name,kcal}], weight, bodyFat, score }
   */
  function parseMealTemplate(text) {
    const lines = normalize(String(text || '')).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    let date = null;
    let weight = null;
    let bodyFat = null;
    let score = null;
    let slot = null;   // 朝/昼/夜/間食
    let place = null;  // {type:'外食', label:'鳥貴族'} または {type:'自炊'}
    const items = [];
    const num = (s) => parseFloat(String(s).replace(',', '.'));
    for (const raw of lines) {
      if (/^#?\s*体重ログ/.test(raw)) continue; // 目印行

      const tm = raw.match(/^時\s*間\s*帯[\s:：]*(朝|昼|夜|間食)/);
      if (tm) { slot = tm[1]; continue; }
      const gm = raw.match(/^外\s*食[\s:：]*(.+)$/);
      if (gm) { place = { type: '外食', label: gm[1].trim() }; continue; }
      if (/^自\s*炊\s*$/.test(raw)) { place = { type: '自炊' }; continue; }

      const dl = raw.match(/^(?:日付|date)?\s*[:：]?\s*(20\d{2})[\/\-.](\d{1,2})[\/\-.](\d{1,2})\s*(?:[(（][^)）]*[)）])?\s*$/i);
      if (dl) { if (date === null) date = `${dl[1]}-${pad(+dl[2])}-${pad(+dl[3])}`; continue; }

      let wm = raw.match(/^体\s*重[\s:：]*(\d{2,3}(?:[.,]\d)?)/);
      if (wm) { const v = num(wm[1]); if (v >= 20 && v <= 200) weight = v; continue; }

      const fm = raw.match(/^体\s*脂\s*肪(?:率)?[\s:：]*(\d{1,2}(?:[.,]\d)?)/);
      if (fm) { const v = num(fm[1]); if (v >= 3 && v <= 60) bodyFat = v; continue; }

      const sm = raw.match(/^点\s*数[\s:：]*(\d{1,3})/);
      if (sm) { const v = +sm[1]; if (v >= 0 && v <= 100) score = v; continue; }

      let line = raw.replace(/^\s*(?:[-・*•‣▪]|\d{1,2}[.)、])\s*/, ''); // 箇条書き・番号を除去
      if (/^(合計|総カロリー|トータル|total)/i.test(line)) continue; // 合計行は除外
      const km = line.match(/(\d{1,4})\s*(?:kcal|ｋｃａｌ|キロカロリー)?\s*$/i);
      if (!km) continue;
      const kcal = +km[1];
      if (!(kcal >= 1 && kcal <= 5000)) continue;
      const name = line.slice(0, km.index).replace(/[\s:：,，、\-–—]+$/, '').trim();
      if (!name) continue;
      items.push({ name, kcal });
    }
    return { date, items, weight, bodyFat, score, slot, place };
  }

  const api = { parseOcrText, extractKcal, parseMealTemplate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalThis.OcrParse = api;
})();
