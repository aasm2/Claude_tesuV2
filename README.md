# 体重ログ 📉

スクショから体重を読み取って、**折れ線グラフ**と**カレンダー**で可視化する個人用 PWA（Webアプリ）です。

- 🔒 **完全プライベート** — データは iPhone のブラウザ内（localStorage）にのみ保存。サーバーに送信しません。
- 📷 **スクショ → OCR** — ヘルスケア／体組成計アプリの画面を選ぶと、日付と体重を自動で読み取り（[Tesseract.js](https://tesseract.projectnaptha.com/) によるブラウザ内OCR）。読み取り結果は**保存前に確認・修正**できます。
- 🍚 **食事のカロリー記録** — 内蔵の食品辞書（約120品目・1人前の目安）から検索してタップで記録。手入力も可。写真の外部送信は一切なし。
- 📈 **可視化** — 体重の折れ線＋摂取カロリーの棒グラフ（[Chart.js](https://www.chartjs.org/)・2軸）、月別カレンダー（体重とkcalを日別表示）、一覧、CSV出力。
- 📱 **ホーム画面に追加**してネイティブアプリのように使えます（PWA）。

## 使い方（iPhone）

このアプリは「どこかに公開」してから iPhone の Safari で開きます。一番簡単なのは **GitHub Pages**。

### GitHub Pages で公開する

1. GitHub のリポジトリ → **Settings** → **Pages**
2. **Build and deployment** → Source = `Deploy from a branch`
3. Branch を `claude/practical-bohr-043u42`（または公開用ブランチ）／フォルダ `/ (root)` にして **Save**
4. 数十秒後に表示される URL（例: `https://<ユーザー名>.github.io/claude_tesuv2/`）を iPhone の **Safari** で開く
5. 共有ボタン →「**ホーム画面に追加**」

### 記録する

1. 「**追加**」タブ →「📷 スクショを選ぶ」→ 体重が写ったスクショを選択
2. 自動で日付・体重を読み取り → 内容を確認（違っていたら直す）→「**保存**」
3. 「**グラフ**」「**カレンダー**」タブで推移を確認

> 初回のOCR時だけ、文字認識用のデータ（日本語・英語モデル）をダウンロードします。
> 以降はキャッシュされ、オフラインでも動作します。**画像そのものは端末の外に出ません。**

## ローカルで試す

```bash
# このフォルダで簡易サーバーを起動（localStorage / Service Worker は file:// では動かないため）
python3 -m http.server 8000
# ブラウザで http://localhost:8000 を開く
```

## 構成

```
index.html              画面とタブ
css/styles.css          スタイル（ダークテーマ）
js/app.js               データ保存・食事記録・グラフ・カレンダー・一覧
js/parse.js             OCRテキストの日付・体重抽出（テスト共用）
js/foods.js             食品カロリー辞書（約120品目）
vendor/                 Chart.js / Tesseract.js（ローカル同梱）
icons/                  アプリアイコン
manifest.webmanifest    PWA 設定
sw.js                   Service Worker（オフライン対応）
```

## データについて

- 保存先はブラウザの `localStorage`（体重: `weight-entries-v1` / 食事: `meal-entries-v1`）。
- バックアップは「一覧」タブの **CSV出力**（体重）と「食事」タブの **食事CSV出力** から。
- ブラウザのデータを消去すると記録も消えるので、定期的なCSV出力をおすすめします。
- 1日1件（同じ日付に保存すると上書き）。
