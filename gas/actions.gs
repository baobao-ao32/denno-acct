/**
 * denno-acct v2 — GAS 台帳コア（分割済み。GASプロジェクト内の全ファイルが1つの名前空間を共有する）
 * 取消 (void) と状態照会 (status)、APIログ
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

function voidTransaction_(p, props) {
  // 取引が属する年度は、まず全年度を走査する代わりに「設定」から直近の年度を使う。
  // 簡易実装: ルート直下の年度フォルダを全て走査して取引IDを探す。
  const root = DriveApp.getFolderById(props.getProperty("ROOT_FOLDER_ID"));
  const folders = root.getFolders();
  while (folders.hasNext()) {
    const f = folders.next();
    const ssFile = findChildFile_(f, f.getName() + "会計記録");
    if (!ssFile) continue;
    const ss = SpreadsheetApp.openById(ssFile.getId());
    const ledger = ss.getSheetByName("取引明細");
    if (!ledger) continue;
    const rows = readAllRows_(ledger).filter((r) => r["取引ID"] === p.transactionId && !r["取消フラグ"]);
    if (rows.length === 0) continue;
    const now = new Date();
    rows.forEach((r) => {
      const map = headerMap_(ledger);
      ledger.getRange(r._row, map["取消フラグ"], 1, 1).setValue("TRUE");
      ledger.getRange(r._row, map["取消理由"], 1, 1).setValue(p.reason);
      ledger.getRange(r._row, map["取消日時"], 1, 1).setValue(now);
    });
    const fy = parseInt(f.getName(), 10);
    recompute_(ss, fy, props);
    return { ok: true, transactionId: p.transactionId, voided: rows.length };
  }
  return { ok: false, error: "transaction not found" };
}

function status_(p, props) {
  const root = DriveApp.getFolderById(props.getProperty("ROOT_FOLDER_ID"));
  const folders = root.getFolders();
  while (folders.hasNext()) {
    const f = folders.next();
    const ssFile = findChildFile_(f, f.getName() + "会計記録");
    if (!ssFile) continue;
    const ss = SpreadsheetApp.openById(ssFile.getId());
    const log = ss.getSheetByName("APIログ");
    if (!log) continue;
    const entry = findLogEntry_(log, p.clientRequestId);
    if (entry) return { ok: true, applicationId: p.clientRequestId, transactionId: entry["取引ID"], result: entry["結果"] };
  }
  return { ok: false, error: "not found" };
}

function findLogEntry_(log, clientRequestId) {
  const rows = readAllRows_(log);
  for (const r of rows) {
    if (r["申請ID"] === clientRequestId) return r;
  }
  return null;
}

function appendLog_(log, clientRequestId, kind, transactionId, result) {
  appendRowsByHeader_(log, [{
    "申請ID": clientRequestId,
    "種別": kind,
    "取引ID": transactionId,
    "受信日時": new Date(),
    "結果": result,
  }]);
}
