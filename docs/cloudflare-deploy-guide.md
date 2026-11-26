# Cloudflare デプロイ手順書（denno-acct v2）

フォーム（Pages）→ Pages Functions（BFF）→ GAS（台帳）をつなげて、提出が台帳に届くところまで持っていく手順。
リポジトリ: `baobao-ao32/denno-acct`、作業コピー: `~/workspace/denno-acct-repo`

API はフォームと同じ Pages プロジェクト内の Functions（`form/functions/api/[[path]].js`）で動かす。同一オリジンになるため、Pages にかける Cloudflare Access で `/api/*` もまとめて保護できる。独立 Worker（workers.dev）を公開する旧構成は、Access を迂回できてしまうため 2026-11-26 に廃止した。

## 前提

- アカウントは Cloudflare の無料プランで足りる（Pages の静的配信は無制限、Functions は Workers 無料枠と共通で 1 日 10 万リクエスト・1 回 CPU 10ms・メモリ 128MB）。
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
   - 再デプロイするときは、既存のデプロイを「編集」して新しいバージョンにすれば URL は変わらない。新しいデプロイを作ると URL が変わるので、その場合は Pages の環境変数 `GAS_ENDPOINT` も新しい URL に更新すること

## Step 3: API（Pages Functions）に接続情報を設定する

API 本体は Step 4 の Pages デプロイで一緒に上がる。先に接続情報を Pages プロジェクトの環境変数へ入れておく。

```bash
# リポジトリのルート (denno-acct-repo/) で実行する
npx wrangler pages secret put API_TOKEN --project-name denno-acct     # Step 2 と同じ値を入れる
npx wrangler pages secret put GAS_ENDPOINT --project-name denno-acct  # Step 2 で控えた Web アプリ URL
```

（ダッシュボードの Pages プロジェクト → Settings → Environment variables から入れても同じ。）

確認は Step 4 のあと: `https://denno-acct.pages.dev/api/health` を開いて
`{"ok":true,"gasConnected":true}` が返れば、Functions と GAS の接続設定は済んでいる。

## URL の行き先（取り違え注意）

| 設定 | 入れる値 | 場所 |
| --- | --- | --- |
| `API_BASE` | 常に `""`（同一オリジンの相対パス） | `form/config.js` の定数（書き換え不要） |
| `GAS_ENDPOINT` | GAS Web アプリの URL（`https://script.google.com/macros/s/.../exec`） | Pages プロジェクトの環境変数（Secret） |
| `API_TOKEN` | Step 2 で決めた共有トークン（両側で同じ値） | GAS のスクリプト プロパティと Pages の環境変数（Secret） |

`API_BASE` に GAS の URL を入れると、フォームがブラウザから GAS を直接叩くことになり、CORS で弾かれて「APIに接続できませんでした」になる（2026-11-25 に実際に起きた）。GAS の URL が入るのは `GAS_ENDPOINT` だけ。

## Step 4: フォームと API を Pages にデプロイする

リポジトリのルート（`denno-acct-repo/`）から実行する。

```bash
npx wrangler pages deploy form --project-name denno-acct
```

`form/` の中身がそのままサイトになり、`form/functions/` の Functions も同時にデプロイされる。
`https://denno-acct.pages.dev` でフォームが開け、`https://denno-acct.pages.dev/api/health` が返れば OK。

## Step 5: `/api/*` の接続

同一オリジン構成では追加の紐付けは要らない。フォームからの `fetch("/api/...")` がそのまま Functions に届く。旧構成（方法 A / 方法 B）の手順は廃止した。

## Step 6: 通しテスト

1. フォームを開き、収入 1 件をテスト提出する
2. 台帳スプレッドシートに取引行が増えたか確認する（増えなければ GAS まで届いていない）
3. 支出 1 件を領収書付きでテスト提出し、年度フォルダ → 「領収書」フォルダ → カテゴリフォルダにファイルが保存されたか確認する
4. 同じ領収書でもう 1 回提出し、「送信すると用途がこの取引に追加されます」と表示されるか確認する

## つまずきやすいところ

- **「APIに接続できませんでした」が出る**: `form/config.js` の `API_BASE` が `""` になっていない（GAS の `/exec` URL などが入っている）。`""` に直して Pages を再デプロイする（上の「URL の行き先」を参照）
- **401 が返る**: GAS の `API_TOKEN` と Pages の環境変数が食い違っている。両方を同じ値にし直す
- **`/api/*` が 404**: Functions がデプロイされていない。`form/functions/` を含んだ状態で Pages を再デプロイする（デプロイ元が `form/` であること）
- **提出しても台帳に何も増えない**: GAS の 302 リダイレクトで POST が消えている可能性がある。Functions の `forwardToGas` の fetch がリダイレクト先へ正しく再送できているか確認する。症状が出たらここを直す
- **Error 1102**: Functions の CPU 10ms 超え。領収書が大きい場合に疑う（通常の提出では起きないはず）

## 本番切替の直前にやること

- Cloudflare Access（Google ログイン）を Pages プロジェクトに有効化して、アクセスをサークル関係者に絞る（テスト期間は共有リンクのまま）。同一オリジン構成なので `/api/*` も自動で Access の対象になる。管理ページ（admin.html）はパス別ポリシーで会計・役員のみに絞る
- 旧 Worker（denno-acct-api）はもう使わないので、Cloudflare 側で削除しておく（公開エンドポイントを残さないため）
- テスト提出した行を台帳から void にして掃除する
