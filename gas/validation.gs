/**
 * denno-acct v2 — GAS 台帳コア（分割済み。GASプロジェクト内の全ファイルが1つの名前空間を共有する）
 * ペイロード検証（Worker側と同じルールをGASでも二重に検証する）
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

function isValidDateString_(v) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const parts = v.split("-").map(Number);
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  return d.getFullYear() === parts[0] && d.getMonth() === parts[1] - 1 && d.getDate() === parts[2];
}

function isValidClientRequestId_(v) {
  // 申請IDは台帳にそのまま書かれるため、数式インジェクション等の余地を
  // 断つよう安全な文字種だけに制限する (フォームは crypto.randomUUID() を使用)
  return typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
}

function validatePayload_(p) {
  if (!p || typeof p !== "object") return "payload is not an object";
  // clientRequestId の必須チェックは提出系 (income/expense/status) の中でのみ行う。
  // checkReceipt や管理系アクションは clientRequestId を持たないため、
  // ここで一律に必須化するとそれらが全て失敗する。
  if (p.kind === "income") {
    if (!isValidClientRequestId_(p.clientRequestId)) return "clientRequestId is invalid";
    if (!INCOME_SUBJECTS[p.subjectId]) return "unknown income subjectId";
    if (!Number.isInteger(p.amount) || p.amount <= 0) return "amount must be a positive integer";
    if (p.subjectId === "other_income" && !(typeof p.detail === "string" && p.detail.trim())) {
      return "detail is required for other_income";
    }
    return null;
  }
  if (p.kind === "expense") {
    if (!isValidClientRequestId_(p.clientRequestId)) return "clientRequestId is invalid";
    if (!Array.isArray(p.receipts) || p.receipts.length === 0) return "receipts is required";
    if (p.receipts.length > MAX_RECEIPTS) return "too many receipts";
    for (const r of p.receipts) {
      if (!isValidDateString_(r.purchaseDate)) return "purchaseDate must be a valid YYYY-MM-DD date";
      if (!r.buyerName) return "buyerName is required";
      if (!r.vendor) return "vendor is required";
      if (!PAYMENT_METHODS[r.paymentMethodId]) return "unknown paymentMethodId";
      if (!Number.isInteger(r.receiptTotal) || r.receiptTotal <= 0) return "receiptTotal must be a positive integer";
      if (!Array.isArray(r.uses) || r.uses.length === 0) return "uses is required";
      if (r.uses.length > MAX_USES) return "too many uses";
      let sum = 0;
      for (const u of r.uses) {
        if (!u.name || !CATEGORIES[u.categoryId] || !EXPENSE_SUBJECTS[u.subjectId] || !u.itemName) {
          return "invalid use entry";
        }
        if (!Number.isInteger(u.amount) || u.amount <= 0) return "use amount must be a positive integer";
        sum += u.amount;
      }
      const discount = r.discount == null ? 0 : Number(r.discount);
      // 按分で各用途に1円以上残すため、値引きの上限は 合計 - 用途数
      if (!Number.isInteger(discount) || discount < 0 || discount > sum - r.uses.length) {
        return "invalid discount";
      }
      // 合計の完全一致は登録時に取引単位で検証する (分割提出の追記があるため、ここでは超過のみ弾く)
      if (sum - discount > r.receiptTotal) return "use amounts exceed receiptTotal";
      if (r.proofImpossible) {
        if (!(typeof r.proofImpossibleReason === "string" && r.proofImpossibleReason.trim())) {
          return "proofImpossibleReason is required";
        }
      } else if (!r.file || !r.file.sha256 || !r.file.base64) {
        return "receipt file is required";
      } else {
        if (["image/jpeg", "image/png", "application/pdf"].indexOf(r.file.mimeType) < 0) {
          return "unsupported file type";
        }
        if (!r.file.name || /[\/\\]/.test(r.file.name) || r.file.name.indexOf("..") >= 0) {
          return "invalid file name";
        }
        // Base64 の長さで概算し、約10MBを超えるファイルは弾く
        if (r.file.base64.length > 14000000) return "file too large";
      }
    }
    return null;
  }
  if (p.action === "checkReceipt") {
    if (!/^[0-9a-f]{64}$/.test(p.sha256 || "")) return "sha256 must be 64 hex chars";
    return null;
  }
  if (p.action === "void") {
    if (!p.transactionId) return "transactionId is required";
    if (!p.reason) return "reason is required";
    return null;
  }
  if (p.action === "status") {
    if (!isValidClientRequestId_(p.clientRequestId)) return "clientRequestId is invalid";
    return null;
  }
  if (p.action === "recompute") {
    if (!Number.isInteger(p.fiscalYear) || p.fiscalYear < 2000 || p.fiscalYear > 2100) {
      return "fiscalYear is invalid";
    }
    return null;
  }
  if (p.action === "toggleSettled") {
    if (!p.transactionId) return "transactionId is required";
    return null;
  }
  return "unknown request";
}
