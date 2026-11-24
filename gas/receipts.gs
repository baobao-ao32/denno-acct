/**
 * denno-acct v2 — GAS 台帳コア（分割済み。GASプロジェクト内の全ファイルが1つの名前空間を共有する）
 * 領収書ファイルの扱い: 代表カテゴリ判定、ハッシュ照合、保存先フォルダの移動
 *
 * 必須 Script Properties:
 *   ROOT_FOLDER_ID          「会計」ルートフォルダの Drive ファイルID
 *   TEMPLATE_SPREADSHEET_ID 「テンプレート_会計記録」のスプレッドシートID
 *   API_TOKEN               Worker が Authorization: Bearer で送るトークン
 *
 * 原則 (v2設計):
 * - 保存するのはID、名前は表示するときに引く。台帳にはID列と表示名列の両方を書く
 * - 書き込みは headerMap (ヘッダ名→列番号) 経由のみ。列のベタ書きは禁止
 * - 訂正は行削除ではなく void フラグ + 理由
 * - 年度は4月スタート。収入の年度帰属は報告日、支出は購入日
 * - 複数カテゴリに跨る領収書は、金額割合が最大のカテゴリに帰属させる
 */

/** 用途一覧から、金額割合が最大のカテゴリIDを返す。 */
function representativeCategoryId_(uses) {
  const sums = {};
  for (const u of uses) sums[u.categoryId] = (sums[u.categoryId] || 0) + u.amount;
  let best = null;
  let bestAmount = -1;
  for (const id of CATEGORY_ORDER) {
    if ((sums[id] || 0) > bestAmount) { best = id; bestAmount = sums[id] || 0; }
  }
  return best;
}

/** 同じSHA256の領収書を持つ既存取引を探す。見つかればその取引IDと最大の明細番号を返す。 */
function findTransactionByHash_(ledger, sha256) {
  const rows = readAllRows_(ledger).filter((r) => r["領収書ファイルSHA256"] === sha256 && !r["取消フラグ"]);
  if (rows.length === 0) return null;
  let maxDetail = 0;
  for (const r of rows) {
    const m = String(r["明細ID"]).match(/-(\d+)$/);
    if (m) maxDetail = Math.max(maxDetail, parseInt(m[1], 10));
  }
  const first = rows[0];
  first._maxDetailIndex = maxDetail;
  return first;
}

/**
 * 用途の追記で代表カテゴリが変わった場合、領収書ファイルを正しいフォルダへ移動し、
 * 台帳の保存パス/保存カテゴリを更新する。
 */
function moveReceiptFileIfNeeded_(env, existing, newUses, props) {
  const ss = env.ss;
  const ledger = ss.getSheetByName("取引明細");
  const rows = readAllRows_(ledger).filter((r) => r["取引ID"] === existing["取引ID"] && !r["取消フラグ"]);
  const allUses = rows.map((r) => ({ categoryId: r["用途別カテゴリID"], amount: Number(r["用途別金額合計"] || 0) }));
  const newRepId = representativeCategoryId_(allUses);
  const oldCategoryName = existing["領収書保存カテゴリ"];
  if (CATEGORIES[newRepId] === oldCategoryName) return;

  const url = existing["領収書URL"];
  const match = url.match(/\/d\/([^\/]+)/);
  if (!match) return;
  const file = DriveApp.getFileById(match[1]);
  const newFolder = env.categoryFolders[newRepId];
  file.moveTo(newFolder);
  const fileName = file.getName();
  const newPath = fiscalYearLabel_(fiscalYearOf_(existing["購入日"])) + "/領収書/" + CATEGORIES[newRepId] + "/" + fileName;
  // 保存パス/カテゴリを書き換える (他列は触らない)
  rows.forEach((r, i) => {
    const map = headerMap_(ledger);
    ledger.getRange(r._row, map["領収書保存パス"], 1, 1).setValue(newPath);
    ledger.getRange(r._row, map["領収書保存カテゴリ"], 1, 1).setValue(CATEGORIES[newRepId]);
  });
}
