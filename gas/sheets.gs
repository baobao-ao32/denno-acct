/**
 * denno-acct v2 — GAS 台帳コア（分割済み。GASプロジェクト内の全ファイルが1つの名前空間を共有する）
 * スプレッドシート読み書きの共通部品（ヘッダ名経由でのみ読み書きする）
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

/** ヘッダ名→列番号 (1始まり)。 */
function headerMap_(sheet) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const map = {};
  headers.forEach((h, i) => { if (h) map[h] = i + 1; });
  return map;
}

function appendRowsByHeader_(sheet, rows) {
  const map = headerMap_(sheet);
  const width = sheet.getLastColumn();
  const values = rows.map((obj) => {
    const row = new Array(width).fill("");
    for (const key in obj) {
      if (map[key]) row[map[key] - 1] = obj[key];
    }
    return row;
  });
  const start = sheet.getLastRow() + 1;
  sheet.getRange(start, 1, values.length, width).setValues(values);
  return start;
}

function readAllRows_(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const map = headerMap_(sheet);
  const raw = sheet.getRange(2, 1, last - 1, sheet.getLastColumn()).getValues();
  return raw.map((r, i) => {
    const obj = { _row: i + 2 };
    for (const key in map) obj[key] = r[map[key] - 1];
    return obj;
  });
}

function getSetting_(ss, key, defaultValue) {
  const sheet = ss.getSheetByName("設定");
  const rows = readAllRows_(sheet);
  for (const r of rows) {
    if (r["キー"] === key) return r["値"];
  }
  return defaultValue;
}
