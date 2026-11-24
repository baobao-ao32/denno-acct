/**
 * denno-acct v2 — GAS 台帳コア（分割済み。GASプロジェクト内の全ファイルが1つの名前空間を共有する）
 * ペイロード検証（Worker側と同じルールをGASでも二重に検証する）
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

function validatePayload_(p) {
  if (!p || typeof p !== "object") return "payload is not an object";
  if (typeof p.clientRequestId !== "string" || !p.clientRequestId) return "clientRequestId is required";
  if (p.kind === "income") {
    if (!INCOME_SUBJECTS[p.subjectId]) return "unknown income subjectId";
    if (!isFinite(p.amount) || p.amount <= 0) return "amount must be positive";
    if (p.subjectId === "other_income" && !(typeof p.detail === "string" && p.detail.trim())) {
      return "detail is required for other_income";
    }
    return null;
  }
  if (p.kind === "expense") {
    if (!Array.isArray(p.receipts) || p.receipts.length === 0) return "receipts is required";
    if (p.receipts.length > MAX_RECEIPTS) return "too many receipts";
    for (const r of p.receipts) {
      if (!r.purchaseDate) return "purchaseDate is required";
      if (!r.buyerName) return "buyerName is required";
      if (!PAYMENT_METHODS[r.paymentMethodId]) return "unknown paymentMethodId";
      if (!isFinite(r.receiptTotal) || r.receiptTotal <= 0) return "receiptTotal must be positive";
      if (!Array.isArray(r.uses) || r.uses.length === 0) return "uses is required";
      if (r.uses.length > MAX_USES) return "too many uses";
      let sum = 0;
      for (const u of r.uses) {
        if (!u.name || !CATEGORIES[u.categoryId] || !EXPENSE_SUBJECTS[u.subjectId] || !u.itemName) {
          return "invalid use entry";
        }
        if (!isFinite(u.amount) || u.amount <= 0) return "use amount must be positive";
        sum += u.amount;
      }
      if (sum !== r.receiptTotal) return "use amounts do not sum to receiptTotal";
      if (r.proofImpossible) {
        if (!(typeof r.proofImpossibleReason === "string" && r.proofImpossibleReason.trim())) {
          return "proofImpossibleReason is required";
        }
      } else if (!r.file || !r.file.sha256 || !r.file.base64) {
        return "receipt file is required";
      }
    }
    return null;
  }
  if (p.action === "void") {
    if (!p.transactionId) return "transactionId is required";
    if (!p.reason) return "reason is required";
    return null;
  }
  if (p.action === "status") {
    if (!p.clientRequestId) return "clientRequestId is required";
    return null;
  }
  return "unknown request";
}
