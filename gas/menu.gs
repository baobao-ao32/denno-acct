/**
 * denno-acct v2 — GAS 台帳コア（分割済み。GASプロジェクト内の全ファイルが1つの名前空間を共有する）
 * スプレッドシートのカスタムメニュー「会計」: 再計算・取消 (void)・精算状態の変更
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
 *
 * このプロジェクトは単体 (スタンドアロン) のため、年度スプレッドシートへは
 * 直接メニューを埋め込めない。ensureFiscalEnv_ が年度スプシごとに onOpen の
 * インストール型トリガーを登録し、開くたびに dennoMenuOnOpen_ がメニューを出す。
 * 既存の年度スプシへ後付けする場合は installMenuTriggersForAllYears を
 * エディタから一度だけ実行する。
 */

const MENU_HANDLER_ = "dennoMenuOnOpen_";

/** onOpen トリガーのハンドラ。開かれたスプレッドシートに「会計」メニューを出す。 */
function dennoMenuOnOpen_(e) {
  try {
    SpreadsheetApp.getUi()
      .createMenu("会計")
      .addItem("集計を再計算", "dennoMenuRecompute_")
      .addItem("選択行の取引を取消", "dennoMenuVoid_")
      .addItem("選択行の精算状態を変更", "dennoMenuToggleSettled_")
      .addToUi();
  } catch (err) {
    console.log("menu open failed: " + err);
  }
}

/** 年度スプシに onOpen トリガーが無ければ登録する。失敗しても呼び出し側は止めない。 */
function ensureMenuTrigger_(ss) {
  try {
    const exists = ScriptApp.getProjectTriggers().some(
      (t) => t.getHandlerFunction() === MENU_HANDLER_ && t.getSourceId() === ss.getId()
    );
    if (!exists) {
      ScriptApp.newTrigger(MENU_HANDLER_).forSpreadsheet(ss).onOpen().create();
    }
  } catch (err) {
    console.log("menu trigger setup failed: " + err);
  }
}

/** 既存の全年度スプシへメニュートリガーを後付けする (エディタから手動実行)。 */
function installMenuTriggersForAllYears() {
  const props = PropertiesService.getScriptProperties();
  const root = DriveApp.getFolderById(props.getProperty("ROOT_FOLDER_ID"));
  const folders = root.getFolders();
  while (folders.hasNext()) {
    const f = folders.next();
    if (!/^(\d{4})年度$/.test(f.getName())) continue;
    const ssFile = findChildFile_(f, f.getName() + "会計記録");
    if (!ssFile) continue;
    ensureMenuTrigger_(SpreadsheetApp.openById(ssFile.getId()));
  }
}

/** スプレッドシート名「○○年度会計記録」から年度を取る。取れなければ null。 */
function fiscalYearFromSpreadsheet_(ss) {
  const m = ss.getName().match(/^(\d{4})年度会計記録$/);
  return m ? parseInt(m[1], 10) : null;
}

/** 取引明細タブで選択中の行の取引IDを返す。問題があれば警告して null。 */
function selectedTransactionId_(ss, ui) {
  const sheet = ss.getActiveSheet();
  if (sheet.getName() !== "取引明細") {
    ui.alert("「取引明細」タブで対象の行を選んでください。");
    return null;
  }
  const row = sheet.getActiveCell().getRow();
  if (row < 2) {
    ui.alert("ヘッダではなく、取引の行を選んでください。");
    return null;
  }
  const map = headerMap_(sheet);
  const transactionId = sheet.getRange(row, map["取引ID"]).getValue();
  if (!transactionId) {
    ui.alert("取引IDが空の行です。");
    return null;
  }
  return transactionId;
}

function dennoMenuRecompute_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();
  const fy = fiscalYearFromSpreadsheet_(ss);
  if (!fy) {
    ui.alert("年度を判定できませんでした（スプレッドシート名: " + ss.getName() + "）");
    return;
  }
  recompute_(ss, fy, PropertiesService.getScriptProperties());
  ss.toast("集計を再計算しました。", "会計");
}

function dennoMenuVoid_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();
  const transactionId = selectedTransactionId_(ss, ui);
  if (!transactionId) return;
  const fy = fiscalYearFromSpreadsheet_(ss);
  if (!fy) {
    ui.alert("年度を判定できませんでした（スプレッドシート名: " + ss.getName() + "）");
    return;
  }
  const ledger = ss.getSheetByName("取引明細");
  const active = readAllRows_(ledger).filter((r) => r["取引ID"] === transactionId && !r["取消フラグ"]);
  if (active.length === 0) {
    ui.alert("この取引は既に取消済みか、存在しません。");
    return;
  }
  const res = ui.prompt(
    "取引の取消",
    "取引 " + transactionId + " を取り消します。取消理由を入力してください。\n（領収書ファイルは「領収書/取消済み」フォルダへ移動します）",
    ui.ButtonSet.OK_CANCEL
  );
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const reason = res.getResponseText().trim();
  if (!reason) {
    ui.alert("取消理由が必要です。");
    return;
  }
  const n = applyVoid_(ss, fy, transactionId, reason, PropertiesService.getScriptProperties());
  ss.toast(n + "行を取り消しました。", "会計");
}

function dennoMenuToggleSettled_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();
  const transactionId = selectedTransactionId_(ss, ui);
  if (!transactionId) return;
  const ledger = ss.getSheetByName("取引明細");
  const rows = readAllRows_(ledger).filter((r) => r["取引ID"] === transactionId && !r["取消フラグ"]);
  if (rows.length === 0) {
    ui.alert("この取引は既に取消済みか、存在しません。");
    return;
  }
  const current = rows[0]["精算状態"];
  if (current === "精算不要") {
    ui.alert("この取引は「精算不要」（直接支払い）のため、精算状態は変更しません。");
    return;
  }
  const next = current === "精算済み" ? "未精算" : "精算済み";
  const map = headerMap_(ledger);
  rows.forEach((r) => {
    ledger.getRange(r._row, map["精算状態"], 1, 1).setValue(next);
  });
  ss.toast("取引 " + transactionId + " の精算状態を「" + next + "」にしました。", "会計");
}
