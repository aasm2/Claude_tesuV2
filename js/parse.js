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

  // O/o は数字に隣接していれば 0 の誤読とみなして補正する
  function normalize(text) {
    return text.replace(/[，]/g, '.').replace(/(?<=\d)[Oo]|[Oo](?=[\d.])/g, '0');
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

  // 行から kg 付きの体重らしい数値(20〜200)を1つ取る
  function kgValue(text) {
    const m = text.match(/(\d{2,3}[.,]\d)\s*(?:kg|キロ|ｋｇ)/i);
    if (!m) return null;
    const v = parseFloat(m[1].replace(',', '.'));
    return v >= 20 && v <= 200 ? v : null;
  }

  /**
   * 行単位の体重候補。
   * - 「BMI」と同じ行の kg 値は最優先（体重の隣にBMIが並ぶアプリが多い）
   * - 「%」を含む行は体脂肪率・筋肉量など別指標の可能性が高いので除外
   */
  function weightFromLine(line) {
    const v = kgValue(line);
    if (v == null) return null;
    if (/bmi/i.test(line)) return v;
    if (/%/.test(line)) return null;
    return v;
  }

  // フォールバック: 画面全体から1件だけ推定（従来ロジック）
  function weightFromWhole(text) {
    const candidates = [];
    let m;
    const reKg = /(\d{2,3}[.,]\d)\s*(?:kg|キロ|ｋｇ)/gi;
    while ((m = reKg.exec(text)) !== null) {
      candidates.push(parseFloat(m[1].replace(',', '.')));
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

  /**
   * OCRテキスト全体を解析し、{date, weight} の配列を返す。
   * 履歴画面のように複数の記録が写っていれば全件返す。
   * 同じ日付が複数ある場合は、測定時刻が朝7:00に最も近いものを採用する。
   * 何も取れなくても、手修正用に1行（今日・体重空欄）は返す。
   */
  function parseOcrText(text, now) {
    now = now || new Date();
    const cleaned = normalize(text);
    const entries = [];
    let pendingDate = '';
    let pendingTime = null;
    let lastEntry = null;

    for (const raw of cleaned.split(/\r?\n/)) {
      const line = raw.trim();
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
      return Object.keys(best).sort().map((date) => ({ date, weight: best[date].weight }));
    }

    const w = weightFromWhole(cleaned);
    return [{
      date: dateFrom(cleaned, now) || toISO(now),
      weight: w == null ? '' : w,
    }];
  }

  const api = { parseOcrText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalThis.OcrParse = api;
})();
