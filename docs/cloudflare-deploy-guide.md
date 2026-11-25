# Cloudflare デプロイ手順書（denno-acct v2）

フォーム（Pages）→ Worker（BFF）→ GAS（台帳）をつなげて、提出が台帳に届くところまで持っていく手順。
リポジトリ: `baobao-ao32/denno-acct`、作業コピー: `~/workspace/denno-acct-repo`

## 前提

- アカウントは Cloudflare の無料プランで足りる（Pages の静的配信は無制限、Worker は 1 日 10 万リクエスト・1 回 CPU 10ms・メモリ 128MB）。
- Node.js と wrangler が要る。clasp 用に Node が入っているなら `npx wrangler` で使える。
- GAS 側は先に最新コードを `clasp push` しておくこと（コミット `6f9c1bb` 以降）。

## Step 1: Cloudflare アカウントを作る

1. https://dash.cloudflare.com でサインアップ（メールアドレスのみ。無料プランにカード登録は不要）
2. ダッシュボードに入れれば OK。ここでは課金設定に触らない

## Step 2: GAS 側を仕上げる

1. 作業コピーで `git pull`（最新コミットを取り込む）
2. `cd gas && clasp push`
3. GAS エディタ → プロジェクトの設定 → スクリプト プロパティに 2 つ設定する
   - `ROOT_FOLDER_ID` — Drive「会計」フォルダの ID
   - `API_TOKEN` — 任意の長いランダム文字列。生成例: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
4. GAS エディタ → デプロイ → 新しいデプロイ → 種類「ウェブアプリ」
   - 実行ユーザー: 自分
   - アクセスできるユーザー: 全員（認証はトークンで行うため）
   - デプロイして出てきた URL（`https://script.google.com/macros/s/.../exec`）を控える。これが `GAS_ENDPOINT`

## Step 3: Worker をデプロイする

```bash
cd worker
npx wrangler login          # ブラウザで Cloudflare にログインして許可する
npx wrangler deploy         # https://denno-acct-api.<サブドメイン>.workers.dev が発行される
npx wrangler secret put API_TOKEN     # Step 2 と同じ値を入れる
npx wrangler secret put GAS_ENDPOINT  # Step 2 で控えた Web アプリ URL
```

確認: `https://denno-acct-api.<サブドメイン>.workers.dev/api/health` を開いて
`{"ok":true,"gasConnected":true}` が返れば、Worker と GAS の接続設定は済んでいる。

## Step 4: フォームを Pages にデプロイする

```bash
npx wrangler pages deploy ../form --project-name denno-acct
```

`https://denno-acct.pages.dev` でフォームが開ければ OK。ただしこの時点では `/api/*` が繋がっていないので、提出はモック応答のままだ。

## Step 5: `/api/*` を繋げる（ここが関門）

フォームは `/api/submit` のような相対パスで呼ぶ設計で、Worker には CORS 対応がまだ無い。
そのため、フォームと Worker は**同じオリジン**で動かす必要がある。方法は 2 つ。

### 方法 A: 独自ドメイン + ルート割当（設計どおり）

**決定 (2026-11-25): 方法 B を採用する。** 当初は方法 A を選んだが、ドメイン費用を避けるため同日中に方法 B へ変更した。Worker には CORS 対応を追加済み、フォーム側は `form/app.js` の `API_BASE` に Worker の workers.dev URL を入れる。

サークル用のドメインが Cloudflare の DNS にある場合に使う。

1. Pages プロジェクトにカスタムドメインを設定する
2. `worker/wrangler.toml` のコメントアウトされている routes を有効化する

```toml
routes = [{ pattern = "acct.example.jp/api/*", zone_name = "example.jp" }]
```

3. `cd worker && npx wrangler deploy` で再デプロイ

### 方法 B: ドメイン無しで workers.dev を直接呼ぶ

ドメインが無い場合の現実的な方法。Worker 側に CORS 対応を足し、フォーム側の呼び先を変える。

1. `worker/worker.js` に CORS を追加する（`json()` のヘッダに `Access-Control-Allow-Origin` を足し、`OPTIONS` リクエストに 204 を返す）
2. `form/app.js` の `fetch("/api/receipts/check", ...)` と `fetch("/api/submit", ...)` を
   `fetch("https://denno-acct-api.<サブドメイン>.workers.dev/api/...", ...)` に書き換える
3. 両方を再デプロイする

## Step 6: 通しテスト

1. フォームを開き、収入 1 件をテスト提出する
2. 台帳スプレッドシートに取引行が増えたか確認する（増えなければ GAS まで届いていない）
3. 支出 1 件を領収書付きでテスト提出し、年度フォルダ → 「領収書」フォルダ → カテゴリフォルダにファイルが保存されたか確認する
4. 同じ領収書でもう 1 回提出し、「送信すると用途がこの取引に追加されます」と表示されるか確認する

## つまずきやすいところ

- **401 が返る**: GAS の `API_TOKEN` と Worker の Secret が食い違っている。両方を同じ値にし直す
- **`/api/*` が 404**: Step 5 の紐付けができていない。Pages と Worker が別オリジンのまま
- **ブラウザのコンソールに CORS エラー**: 方法 B を選んだのに Worker の CORS 追加が漏れている
- **提出しても台帳に何も増えない**: GAS の 302 リダイレクトで POST が消えている可能性がある。`forwardToGas` の fetch がリダイレクト先へ正しく再送できているか確認する。症状が出たらここを直す
- **Error 1102**: Worker の CPU 10ms 超え。領収書が大きい場合に疑う（通常の提出では起きないはず）

## 本番切替の直前にやること

- Cloudflare Access（Google ログイン）を有効化して、フォームへのアクセスをサークル関係者に絞る（テスト期間は共有リンクのまま）
- テスト提出した行を台帳から void にして掃除する
