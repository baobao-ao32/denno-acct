/**
 * denno-acct v2 — GAS 台帳コア（分割済み。GASプロジェクト内の全ファイルが1つの名前空間を共有する）
 * 取引の登録: 収入・支出の台帳追記（冪等性と用途追記を含む）
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
 * denno-acct v2 — GAS 台帳コア（分割済み。GASプロジェクト内の全ファイルが1つの名前空間を共有する）
 * 取引の登録: 収入・支出の台帳追記（冪等性と用途追記を含む）
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

function registerIncome_(p, props) {
  const fy = fiscalYearOf_(p.submittedAt || new Date());
  const env = ensureFiscalEnv_(fy, props);
  const ss = env.ss;

  const log = ss.getSheetByName("APIログ");
  const existing = findLogEntry_(log, p.clientRequestId);
  if (existing) {
    return { ok: true, applicationId: p.clientRequestId, transactionId: existing["取引ID"], duplicate: true };
  }

  const transactionId = "TX-" + Utilities.getUuid();
  const now = new Date();
  const detail = p.subjectId === "other_income" ? p.detail : "";
  const row = {
    "取引ID": transactionId,
    "明細ID": transactionId + "-1",
    "種別": "income",
    "申請ID": p.clientRequestId,
    "購入日": "",
    // ISO文字列 (UTC) のまま書くと記録実行時刻 (JST表示) と9時間ズレて見えるため Date に直す
    "報告年月日時間": p.submittedAt ? new Date(p.submittedAt) : now,
    "記録実行時刻": now,
    "購入者氏名": "",
    "購入先": "",
    "支払方法ID": "",
    "支払方法名": "",
    "用途名": sanitizeCellText_(detail),
    "用途別カテゴリID": "",
    "用途別カテゴリ名": "",
    "用途別品目名": "",
    "報告科目ID": p.subjectId,
    "報告科目名": INCOME_SUBJECTS[p.subjectId],
    "用途別メモ": "",
    "用途別金額合計": p.amount,
    "領収書全体の金額": "",
    "領収書URL": "",
    "領収書保存パス": "",
    "領収書保存カテゴリ": "",
    "領収書ファイルSHA256": "",
    "証明不可フラグ": "",
    "証明不可理由": "",
    "精算状態": "",
    "会計担当メモ": "",
    "取消フラグ": "",
    "取消理由": "",
    "取消日時": "",
  };
  appendRowsByHeader_(ss.getSheetByName("取引明細"), [row]);
  appendLog_(log, p.clientRequestId, "income", transactionId, "ok");
  recompute_(ss, fy, props);
  return { ok: true, applicationId: p.clientRequestId, transactionId: transactionId };
}
