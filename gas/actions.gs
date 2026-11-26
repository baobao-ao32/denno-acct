/**
 * denno-acct v2 — GAS 台帳コア（分割済み。GASプロジェクト内の全ファイルが1つの名前空間を共有する）
 * 取消 (void) と状態照会 (status)、APIログ
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

function voidTransaction_(p, props) {
  // 取引が属する年度を探すため、ルート直下の年度フォルダを全て走査する。
  const root = DriveApp.getFolderById(props.getProperty("ROOT_FOLDER_ID"));
  const folders = root.getFolders();
  while (folders.hasNext()) {
    const f = folders.next();
    const m = f.getName().match(/^(\d{4})年度$/);
    if (!m) continue;
    const ssFile = findChildFile_(f, f.getName() + "会計記録");
    if (!ssFile) continue;
    const ss = SpreadsheetApp.openById(ssFile.getId());
    if (!ss.getSheetByName("取引明細")) continue;
    const count = applyVoid_(ss, parseInt(m[1], 10), p.transactionId, p.reason, props);
    if (count > 0) return { ok: true, transactionId: p.transactionId, voided: count };
  }
  return { ok: false, error: "transaction not found" };
}

/**
 * 取引に取消フラグを立て、領収書ファイルを「領収書/取消済み」へ移動し、再計算する。
 * API (voidTransaction_) とスプレッドシートのカスタムメニューの両方から使う。
 * 取消対象が無ければ 0 を返す。
 */
function applyVoid_(ss, fy, transactionId, reason, props) {
  const ledger = ss.getSheetByName("取引明細");
  const rows = readAllRows_(ledger).filter((r) => r["取引ID"] === transactionId && !r["取消フラグ"]);
  if (rows.length === 0) return 0;
  // 領収書ファイルの移動 (失敗しても取消自体は成立させる)
  let newPath = null;
  try {
    newPath = moveReceiptToVoidFolder_(fy, rows, props);
  } catch (err) {
    console.log("receipt move on void failed: " + err);
  }
  const now = new Date();
  const map = headerMap_(ledger);
  rows.forEach((r) => {
    ledger.getRange(r._row, map["取消フラグ"], 1, 1).setValue("TRUE");
    ledger.getRange(r._row, map["取消理由"], 1, 1).setValue(sanitizeCellText_(reason || ""));
    ledger.getRange(r._row, map["取消日時"], 1, 1).setValue(now);
    if (newPath) ledger.getRange(r._row, map["領収書保存パス"], 1, 1).setValue(newPath);
  });
  recompute_(ss, fy, props);
  return rows.length;
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

/** 管理用 (管理用ページから): 指定年度の集計を再計算する。 */
function recomputeAction_(p, props) {
  const fy = Number(p.fiscalYear);
  const env = ensureFiscalEnv_(fy, props);
  recompute_(env.ss, fy, props);
  return { ok: true, fiscalYear: fy };
}

/** 管理用 (管理用ページから): 取引の精算状態を 未精算 ⇔ 精算済み で切り替える。 */
function toggleSettled_(p, props) {
  const root = DriveApp.getFolderById(props.getProperty("ROOT_FOLDER_ID"));
  const folders = root.getFolders();
  while (folders.hasNext()) {
    const f = folders.next();
    if (!/^(\d{4})年度$/.test(f.getName())) continue;
    const ssFile = findChildFile_(f, f.getName() + "会計記録");
    if (!ssFile) continue;
    const ss = SpreadsheetApp.openById(ssFile.getId());
    const ledger = ss.getSheetByName("取引明細");
    if (!ledger) continue;
    const rows = readAllRows_(ledger).filter((r) => r["取引ID"] === p.transactionId && !r["取消フラグ"]);
    if (rows.length === 0) continue;
    if (rows[0]["種別"] !== "expense") {
      return { ok: false, error: "収入の取引は精算状態を変更できません" };
    }
    const current = rows[0]["精算状態"];
    if (current === "精算不要") {
      return { ok: false, error: "この取引は精算不要（直接支払い）のため変更できません" };
    }
    const next = current === "精算済み" ? "未精算" : "精算済み";
    const map = headerMap_(ledger);
    rows.forEach((r) => {
      ledger.getRange(r._row, map["精算状態"], 1, 1).setValue(next);
    });
    return { ok: true, transactionId: p.transactionId, settled: next };
  }
  return { ok: false, error: "transaction not found" };
}
