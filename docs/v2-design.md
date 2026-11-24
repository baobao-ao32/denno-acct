# 電脳サークル会計ツール v2 設計たたき台

作成: 2026-11-16 / 前提: v1（Googleフォーム + GAS転記）は破壊してよい。実データは数件のみで移行は安い。

## 1. 問題の本質（なぜ作り直すか）

v1の根本欠陥は3つに集約される。

1. **表示文字列がそのままデータになっている**
Googleフォームは選択肢を「人間向けラベル文字列」でしか保存しない。そのためGAS側で
`USAGE_CATEGORY.fromInput` のような前方一致・表記揺れ吸収の文字列パースが必要になる。
ラベルを変えたらデータの意味が変わる、という逆転が起きている。
2. **スキーマの所有者がフォーム**
質問タイトル = シートのヘッダ名 = GASのスキーマ。フォームを1文字直すとGASが止まる。
入力UIがDBスキーマを握っている。
3. **購入（支出）しか表現できない**
`AccountingApplication` は buyer / vendor / receiptTotal 前提。収入・取消・訂正の概念が無い。

v2の原則は1つだけ: **保存するのはID、名前は表示するときに引く。**
入力はどこから来ても構造化JSONでコアに入る。文字列パースは境界（移行時の1回）以外に存在させない。

## 2. 破壊するもの / 残すもの

### 破壊する
- Googleフォーム本体と、回答シートへの自動記録という入力経路
- `main.gs` の onFormSubmit トリガー / retryUnpostedResponses
- `application_builder.gs`（フォーム行 → アプリケーション変換）
- `schema/response_schema.gs` / `response_sheet.gs`（重複定義もろとも）
- `USAGE_CATEGORY.fromInput` の前方一致マッチ全般
- 購入専用の `AccountingApplication` 型

### 残して進化させる（実績のある部品）
- `processApplication_` の中核フロー（検証 → ロック → 年度環境保証 → 領収書コピー → 台帳追記）
- 明細IDによる冪等な追記（`appendLedgerRows_` の既存IDスキップ）
- 年度別 Drive フォルダ + 領収書のカテゴリ別コピー（`fiscal_accounting.gs` / `receipt.gs`）
- API登録ログ + `clientRequestId` による冪等性（`api.gs`）
- 台帳としての Sheets（会計担当が見る・引き継ぐ先として残す。ただし「DB」ではなく「帳簿ビュー」として扱う）

## 3. ドメインモデル v2

取引（Transaction）を収入・支出で統一する。用語も購入前提から中立化する。

```json
{
"clientRequestId": "discord:<messageId or interactionId>",
"kind": "expense",
"date": "2026-11-16",
"actorName": "山田太郎",
"counterparty": "Amazon",
"paymentMethodId": "advance",
"totalAmount": 1234,
"lines": [
{ "categoryId": "operation", "title": "学園祭展示物の制作",
"itemName": "電子部品", "amount": 1234, "memo": ""}
],
"receipts": [ { "url": "https://cdn.discordapp.com/...", "filename": "receipt.jpg"}],
"source": { "type": "discord", "userId": "...", "guildId": "...", "channelId": "...", "messageId": "..."}
}
```

- `kind`: `expense` | `income`
- `actorName`: 支出なら購入者、収入なら受取担当者
- `counterparty`: 支出なら購入先、収入なら支払元（部費徴収なら「部員」等）
- 領収書: 支出は必須、収入は任意（証憑）。検証ルールを kind で分ける
- 年度は `date` から導出するだけ。入力では持たない（上書き手段としてAPIに `fiscalYearOverride` は残してよい）

### マスタ（IDと表示名の分離）

コード内定数として一元管理する。表示名の変更はデータに影響しない。

| 種別 | categoryId | 表示名 |
|---|---|---|
| 支出 | operation | サークル運営 |
| 支出 | practice | 制作練習 |
| 支出 | event | 参加出展 |
| 収入 | dues | 部費 |
| 収入 | subsidy | 補助金・助成金 |
| 収入 | sales | 頒布・売上 |
| 収入 | other_income | その他収入 |
| 共通 | unknown | 未分類（移行・例外用） |

| paymentMethodId | 表示名 | 対象 |
|---|---|---|
| club_funds | 部費から直接 | 支出 |
| advance | 個人で立て替え | 支出 |
| cash | 現金 | 収入 |
| bank_transfer | 銀行振込 | 収入 |
| other | その他 | 共通 |

台帳には v1 と同じく **ID列と表示名列の両方** を書く（例: カテゴリID / カテゴリ名）。
人間は名前を読み、集計や判定はIDだけを見る。

## 4. 入力経路

### 4.1 Discord（第一の入力）
- スラッシュコマンド `/kaikei` から開始する対話フロー
1. 種別・カテゴリ・支払方法はセレクトメニューで選ぶ（選択肢は label と value が分離しているので、value=ID がそのまま保存できる。文字列パースが構造的に不要）
2. 日付・金額・品目・用途名・メモはモーダルのテキスト入力
3. 領収書はメッセージへの添付で受ける
- 明細は「1登録 = 1明細」を基本にし、複数明細は「明細を追加」ボタンで同じ取引に足す
（v1の用途5件同時入力は、実データでも用途1のみが大半。モーダルの入力欄上限にも収まる）
- BotはHTTPインタラクション方式（Cloudflare Workers想定）で常駐サーバ不要にする
- Bot → GAS API へ上記JSONをPOST。`clientRequestId` はインタラクション/メッセージIDから決定的に作り、再送で二重登録しない
- 添付ファイルは「受信直後に」GAS側が `UrlFetchApp` でCDN URLから取得してDriveへ保存する（v1に無かった処理。Discord CDNのURLは失効するため後回しにしない）

### 4.2 Webフォーム（第一の入力に決定 / 2026-11-16 Aoba判断）
DiscordのUIはこの用途には不自由なため、HTMLフォームを第一の入力とする。Discordは後付けの補助経路に格下げ。

配置は **Cloudflare（Pagesで静的フォーム + WorkerをAPIプロキシ）/ バックエンドはGAS** のハイブリッドとする。
GASのHtmlServiceでWebページを作ることもできるが、採用しない。理由:

- GAS Webアプリは CORS ヘッダを返せないため、別オリジンのブラウザから `doPost` API を直接 fetch できない。
  Workerがサーバ側でGASを叩いて結果を返すことで、この問題と302リダイレクト追随の問題を両方消せる
- APIトークンをブラウザに出さない。トークンはWorkerのSecretに置き、ブラウザ → Worker → GAS の経路でのみ使う
- HtmlServiceは iframe サンドボックス内で動き、画面遷移・レイアウト・ファイルアップロードに制約が多い。
  明細行の追加/削除、領収書プレビュー、入力途中チェックといったフォームUXは通常のHTML/JSの方が格段に作りやすい
- デプロイ: GASはバージョン付きデプロイの差し替えが煩雑。Cloudflareはgit pushで即反映・ロールバックも容易
- 認証は Cloudflare Access（Googleログインでサークルメンバーのみ許可）を前段に置く。
  GAS単体の「Googleアカウントで実行者メールが取れる」利点は、Accessでも概ね代替できる

構成:
```
ブラウザ ──(HTTPS, Accessで認証)──> Cloudflare Pages（フォームHTML/JS）
                                        │ fetch(JSON)
                                        ▼
                                   Cloudflare Worker（検証・トークン付与・CORS）
                                        │ POST JSON（サーバ間）
                                        ▼
                                   GAS doPost（台帳コア: Sheets / Drive）
```
- フォームは `<select value="categoryId">表示名</select>` でJSONを組み立てる。文字列パースは発生しない
- 明細行はJSで自由に追加/削除できる（v1の「最大5件・セクション複製」は廃止。上限は設けず、現実的には検証で弾く）
- 領収書アップロード: ブラウザ → Worker → GAS（base64またはmultipart中継）。写真数MB級ならGAS側の上限でも実用範囲
- 将来GASを別バックエンドに替えたくなっても、差し替え先はWorkerの転送先だけで、フォームは無変更で済む

### 4.3 Discord（補助経路・後付け）
- 当面は「登録完了の通知をチャンネルに流す」程度から始めてよい
- 本格入力として足す場合も、叩く先は同じWorker/GAS API。フォームと二重実装にしない

## 5. GAS側 v2

- `doPost` のaction拡張: `register`（v2 JSON）/ `status` / `summary` / `void`
- `void`（取消）: 行を消さず、取消フラグ + 理由 + 取消日時を記録する。会計の訂正は「消す」ではなく「打ち消す」
- 台帳シートは年度別スプレッドシート内に新シート「取引明細」を作る（収入・支出を種別列で統一）
- 列はID系を左、表示名系を右に寄せ、列追加は末尾のみという v1 の教訓を仕様として明記する
- 書き込みは headerMap 経由に統一し、`appendTableObjects_` の「1列目からベタ書き」を廃止する
- 集計: 各年度シートに「集計」シートを生成し、収入合計 / 支出合計 / 残高 / カテゴリ別合計（ID基準）を出す
- `年度会計簿一覧` にも年度ごとの収入・支出・残高を持たせ、年度をまたいだ閲覧をここで提供する
- v1のバグ（upsertのたびに作成日時を上書き）も合わせて直し、作成日時と更新日時を分ける
- 重複関数定義（response系3関数）の解消、検証ロジックは単一の `validateTransaction_` に集約

## 6. 移行手順（実データ数件前提）

1. v2コア + 台帳をテスト用スプレッドシートで構築し、サンプルJSONで検証
2. Cloudflare Pages/Worker にフォームを載せ、テスト用GASへ接続
3. 一度きりの移行スクリプト: 旧回答シートを読み、カテゴリ名の完全一致でIDに変換して v2コアへ流す
（文字列パースが登場するのはこの1回だけ、とする）
4. 旧フォームをクローズし、旧スプレッドシートは「」に改名して読み取り専用で保管
5. 本番切替。以後の入力はDiscord / Webのみ

## 7. 決定事項 / 残る論点

決定済み（2026-11-16）:
- 入力はHTMLフォーム優先。配置は Cloudflare（Pages + Worker）/ GASは台帳コアとして残す（4.2節）
- Discordは補助経路に格下げ

残る論点:
1. **台帳の形**: 収入・支出を1シートに統一（推奨）か、v1同様に支出明細＋収入明細の2シートか
2. **認証の粒度**: Cloudflare Access で Google アカウント制限（推奨）か、まずはサークル内共有リンクのみで始めるか

## 8. 試作（2026-11-16）

上記2つの決定を待たずに作れる部分を、動く形のたたき台にした。
`form.html`（フォーム本体。カテゴリ・支払方法はIDで送る、明細行は自由に追加・削除、領収書はbase64でJSONに載せる）、
`worker.js`（CORS吸収＋トークン付与＋GASへ中継）、`README-prototype.md`（動かし方と未実装部分）。
GAS側の v2 受け口はまだ未実装で、フォームの `WORKER_URL` もプレースホルダ。詳細と次の手順は README-prototype.md を参照。
