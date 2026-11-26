/**
 * denno-acct v2 — GAS 台帳コア（分割済み。GASプロジェクト内の全ファイルが1つの名前空間を共有する）
 * 年度判定（4月スタート）と年度環境の保証（フォルダ/コード生成/ヘッダ検証）
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

/**
 * 4月スタートの年度を返す。date は "YYYY-MM-DD"、ISO日時文字列、または Date。
 * 注意: Date の getFullYear()/getMonth() はスクリプトのタイムゾーンに依存するため使わない。
 * "YYYY-MM-DD" はそのままの年月で判定し、ISO日時は JST (+09:00) に直してから年月を取る。
 * (例: 2026-04-01 00:30 JST の提出は ISO では 2026-03-31T15:30Z になるが、年度は 2026年度)
 */
function fiscalYearOf_(date) {
  let y;
  let m;
  if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    y = parseInt(date.slice(0, 4), 10);
    m = parseInt(date.slice(5, 7), 10);
  } else {
    const d = new Date(date);
    const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
    y = jst.getUTCFullYear();
    m = jst.getUTCMonth() + 1;
  }
  return m >= 4 ? y : y - 1;
}

function fiscalYearLabel_(fy) {
  return fy + "年度";
}

function findChildFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : null;
}

function findChildFile_(parent, name) {
  const it = parent.getFilesByName(name);
  return it.hasNext() ? it.next() : null;
}

/**
 * 年度環境を保証する。フォルダ・スプレッドシート・領収書フォルダを作るか、既存のものを返す。
 * スプレッドシートはテンプレートをコピーせず、コードで生成する (書式込み)。
 * ヘッダが期待と違う場合は例外を投げる。
 */
function ensureFiscalEnv_(fy, props) {
  const root = DriveApp.getFolderById(props.getProperty("ROOT_FOLDER_ID"));
  const label = fiscalYearLabel_(fy);
  let yearFolder = findChildFolder_(root, label);
  if (!yearFolder) yearFolder = root.createFolder(label);

  let receiptRoot = findChildFolder_(yearFolder, "領収書");
  if (!receiptRoot) receiptRoot = yearFolder.createFolder("領収書");
  const categoryFolders = {};
  for (const id of CATEGORY_ORDER) {
    let f = findChildFolder_(receiptRoot, CATEGORIES[id]);
    if (!f) f = receiptRoot.createFolder(CATEGORIES[id]);
    categoryFolders[id] = f;
  }

  const ssName = label + "会計記録";
  let ssFile = findChildFile_(yearFolder, ssName);
  let ss;
  if (!ssFile) {
    ss = createFiscalSpreadsheet_(ssName, yearFolder);
  } else {
    ss = SpreadsheetApp.openById(ssFile.getId());
    ensureTabs_(ss);
  }
  return { yearFolder: yearFolder, receiptRoot: receiptRoot, categoryFolders: categoryFolders, ss: ss };
}

/** 年度スプレッドシートをコードで生成する。テンプレートファイルは不要。 */
function createFiscalSpreadsheet_(name, yearFolder) {
  const ss = SpreadsheetApp.create(name);
  DriveApp.getFileById(ss.getId()).moveTo(yearFolder);
  ensureTabs_(ss);
  // SpreadsheetApp.create が作る既定シート (空) が残っていれば除去する
  for (const sheet of ss.getSheets()) {
    if (TAB_NAMES.indexOf(sheet.getName()) === -1 && sheet.getLastRow() === 0) {
      ss.deleteSheet(sheet);
    }
  }
  return ss;
}

const TAB_NAMES = ["取引明細", "サマリ", "収入", "支出", "設定", "APIログ"];

function ensureTabs_(ss) {
  ensureSheetWithHeaders_(ss, "取引明細", LEDGER_HEADERS);
  ensureSheetWithHeaders_(ss, "サマリ", ["項目", "金額"]);
  ensureSheetWithHeaders_(ss, "収入", INCOME_ROW_COLUMNS);
  ensureSheetWithHeaders_(ss, "支出", EXPENSE_ROW_COLUMNS);
  ensureSheetWithHeaders_(ss, "設定", ["キー", "値"]);
  ensureSheetWithHeaders_(ss, "APIログ", ["申請ID", "種別", "取引ID", "受信日時", "結果"]);
}

function ensureSheetWithHeaders_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    formatSheet_(sheet, name);
    return sheet;
  }
  const actual = sheet.getRange(1, 1, 1, Math.max(headers.length, sheet.getLastColumn())).getValues()[0];
  for (let i = 0; i < headers.length; i++) {
    if (actual[i] === headers[i]) continue;
    // 末尾への列追加だけは移行として許可する。その位置以降が全部空なら、
    // 不足分のヘッダを書き足す (例: 「値引き額」列の追加)。
    const restEmpty = actual.slice(i).every((v) => v === "" || v == null);
    if ((actual[i] === "" || actual[i] == null) && restEmpty) {
      sheet.getRange(1, i + 1, 1, headers.length - i).setValues([headers.slice(i)]);
      return sheet;
    }
    throw new Error("header mismatch in sheet " + name + ": expected '" + headers[i] + "' at column " + (i + 1) + ", got '" + actual[i] + "'");
  }
  return sheet;
}
