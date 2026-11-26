/**
 * denno-acct v2 — GAS 台帳コア（分割済み。GASプロジェクト内の全ファイルが1つの名前空間を共有する）
 * エントリポイント: doPost / doGet、認証、リクエスト振り分け
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

function doGet() {
  return json_({ ok: true, service: "denno-acct v2 ledger" });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
    const props = PropertiesService.getScriptProperties();
    const token = props.getProperty("API_TOKEN");
    // GAS の doPost は HTTP ヘッダを読めないため、トークンはボディで受け取る
    let payload;
    try {
      payload = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      return json_({ ok: false, error: "invalid JSON" }, 400);
    }
    if (!token || payload.token !== token) {
      return json_({ ok: false, error: "unauthorized" }, 401);
    }
    const error = validatePayload_(payload);
    if (error) return json_({ ok: false, error: error }, 400);

    if (payload.kind === "income") {
      return json_(registerIncome_(payload, props));
    }
    if (payload.kind === "expense") {
      return json_(registerExpense_(payload, props));
    }
    if (payload.action === "checkReceipt") {
      return json_(checkReceipt_(payload, props));
    }
    if (payload.action === "void") {
      return json_(voidTransaction_(payload, props));
    }
    if (payload.action === "recompute") {
      return json_(recomputeAction_(payload, props));
    }
    if (payload.action === "toggleSettled") {
      return json_(toggleSettled_(payload, props));
    }
    if (payload.action === "status") {
      return json_(status_(payload, props));
    }
    return json_({ ok: false, error: "unknown request" }, 400);
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) }, 500);
  } finally {
    lock.releaseLock();
  }
}

function json_(obj, status) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
