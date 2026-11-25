/**
 * denno-acct v2 — GAS 台帳コア（分割済み。GASプロジェクト内の全ファイルが1つの名前空間を共有する）
 * スプレッドシート読み書きの共通部品（ヘッダ名経由でのみ読み書きする）
 *
 * 必須 Script Properties:
 *   ROOT_FOLDER_ID          「会計」ルートフォルダの Drive ファイルID
 *   API_TOKEN               Worker がリクエストボディの token フィールドで送る共有トークン
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

/**
 * 新規作成したシートに見た目を付ける (列幅・書式・ヘッダ装飾・入力規則)。
 * テンプレートファイルは使わない。年度スプレッドシートはコードで生成する。
 * 書式は作成時に一度だけ適用する。後から人間が調整した列幅等は上書きしない。
 */
const SHEET_FORMATS = {
  "取引明細": {
    widths: [14, 16, 8, 14, 11, 18, 18, 12, 16, 11, 12, 20, 12, 13, 16, 11, 13, 18, 13, 14, 30, 34, 13, 20, 10, 20, 10, 18, 9, 18, 18],
    money: [19, 20],
    date: [5],
    datetime: [6, 7, 31],
    validations: { 27: ["未精算", "精算済み", "精算不要"] },
  },
  "サマリ": { widths: [42, 16], money: [2] },
  "収入": { widths: [24, 14, 16, 40], money: [2, 3] },
  "支出": { widths: [14, 24, 14, 40], money: [3] },
  "設定": { widths: [20, 40] },
  "APIログ": { widths: [38, 10, 40, 19, 14], datetime: [4] },
};

/** 設定タブの初期行 (テンプレートの代わりにコードで入れる)。 */
const SETTING_SEED_ROWS = [
  ["団体名", "電脳サークル"],
  ["前年度繰越金", 0],
  ["会計氏名", ""],
  ["会計学科", ""],
  ["代表氏名", ""],
  ["代表学科", ""],
];

function formatSheet_(sheet, name) {
  const spec = SHEET_FORMATS[name];
  if (!spec) return;
  const lastCol = sheet.getLastColumn();
  // ヘッダ行の装飾
  const header = sheet.getRange(1, 1, 1, lastCol);
  header.setFontWeight("bold");
  header.setBackground("#E8ECF3");
  // 列幅
  if (spec.widths) {
    spec.widths.forEach((w, i) => { sheet.setColumnWidth(i + 1, w); });
  }
  // 書式 (2行目から1001行目まで。後から追記される行にも効く)
  const applyFormat = (cols, format) => {
    (cols || []).forEach((c) => { sheet.getRange(2, c, 1000, 1).setNumberFormat(format); });
  };
  applyFormat(spec.money, "#,##0");
  applyFormat(spec.date, "yyyy-mm-dd");
  applyFormat(spec.datetime, "yyyy-mm-dd hh:mm:ss");
  // 入力規則 (プルダウン)
  if (spec.validations) {
    for (const col in spec.validations) {
      const rule = SpreadsheetApp.newDataValidation()
        .requireValueInList(spec.validations[col], true)
        .build();
      sheet.getRange(2, parseInt(col, 10), 1000, 1).setDataValidation(rule);
    }
  }
  // 設定タブの初期行
  if (name === "設定" && sheet.getLastRow() < 2) {
    sheet.getRange(2, 1, SETTING_SEED_ROWS.length, 2).setValues(SETTING_SEED_ROWS);
  }
}
