/**
 * denno-acct v2 — GAS 台帳コア（分割済み。GASプロジェクト内の全ファイルが1つの名前空間を共有する）
 * 取引の登録: 収入・支出の台帳追記（冪等性と用途追記を含む）
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

function registerExpense_(p, props) {
  // 冪等性: 同じ申請の再送は、既存の取引IDを返すだけで二重登録しない。
  // (年度が領収書ごとに異なる場合があるため、全年度のログを確認する)
  const root = DriveApp.getFolderById(props.getProperty("ROOT_FOLDER_ID"));
  const prior = [];
  const folders = root.getFolders();
  while (folders.hasNext()) {
    const f = folders.next();
    const ssFile = findChildFile_(f, f.getName() + "会計記録");
    if (!ssFile) continue;
    const ss = SpreadsheetApp.openById(ssFile.getId());
    const log = ss.getSheetByName("APIログ");
    if (!log) continue;
    readAllRows_(log).forEach((r) => {
      if (r["申請ID"] === p.clientRequestId && r["種別"] === "expense") prior.push(r["取引ID"]);
    });
  }
  if (prior.length > 0) {
    return {
      ok: true,
      applicationId: p.clientRequestId,
      receipts: prior.map((t) => ({ transactionId: t, appended: false })),
      duplicate: true,
    };
  }

  const results = [];
  for (const receipt of p.receipts) {
    results.push(registerOneReceipt_(receipt, p, props));
  }
  return { ok: true, applicationId: p.clientRequestId, receipts: results };
}

function registerOneReceipt_(receipt, p, props) {
  const fy = fiscalYearOf_(receipt.purchaseDate);
  const env = ensureFiscalEnv_(fy, props);
  const ss = env.ss;
  const ledger = ss.getSheetByName("取引明細");
  const now = new Date();

  // 既存領収書への用途追記 (ファイルのハッシュで照合)
  if (!receipt.proofImpossible && receipt.file && receipt.file.sha256) {
    let appendEnv = env;
    let appendSs = ss;
    let appendFy = fy;
    let existing = findTransactionByHash_(ledger, receipt.file.sha256);
    if (!existing) {
      // 購入日の入力ミス等で年度がズレていても重複登録しないよう、全年度から探す
      const found = findReceiptByHashAllYears_(props, receipt.file.sha256);
      if (found) {
        appendEnv = ensureFiscalEnv_(found.fy, props);
        appendSs = appendEnv.ss;
        appendFy = found.fy;
        existing = findTransactionByHash_(appendSs.getSheetByName("取引明細"), receipt.file.sha256);
      }
    }
    if (existing) {
      const transactionId = existing["取引ID"];
      const existingSum = sumTransactionUses_(appendSs.getSheetByName("取引明細"), transactionId);
      const newSum = receipt.uses.reduce((a, u) => a + u.amount, 0);
      if (existingSum + newSum !== receipt.receiptTotal) {
        throw new Error("use amounts do not complete receiptTotal: registered " + existingSum + " + new " + newSum + " != " + receipt.receiptTotal);
      }
      const rows = receipt.uses.map((u, i) => buildLedgerRow_({
        transactionId: transactionId,
        detailIndex: existing._maxDetailIndex + i + 1,
        kind: "expense",
        clientRequestId: p.clientRequestId,
        purchaseDate: existing["購入日"] || receipt.purchaseDate,
        submittedAt: p.submittedAt,
        now: now,
        buyerName: receipt.buyerName,
        vendor: receipt.vendor,
        paymentMethodId: receipt.paymentMethodId,
        use: u,
        receiptTotal: receipt.receiptTotal,
        receiptUrl: existing["領収書URL"],
        receiptPath: existing["領収書保存パス"],
        receiptCategory: existing["領収書保存カテゴリ"],
        sha256: receipt.file.sha256,
        proofImpossible: false,
        proofImpossibleReason: "",
      }));
      appendRowsByHeader_(appendSs.getSheetByName("取引明細"), rows);
      appendLog_(appendSs.getSheetByName("APIログ"), p.clientRequestId, "expense", transactionId, "ok-appended");
      moveReceiptFileIfNeeded_(appendEnv, existing, receipt.uses, props);
      recompute_(appendSs, appendFy, props);
      return { transactionId: transactionId, appended: true };
    }
  }

  // 新規取引 (用途の合計が領収書全体の金額と完全一致すること)
  const useSum = receipt.uses.reduce((a, u) => a + u.amount, 0);
  if (useSum !== receipt.receiptTotal) {
    throw new Error("use amounts do not sum to receiptTotal: " + useSum + " != " + receipt.receiptTotal);
  }
  const transactionId = "TX-" + Utilities.getUuid();
  const repCategoryId = representativeCategoryId_(receipt.uses);
  let receiptUrl = "";
  let receiptPath = "";
  let receiptCategory = "";
  if (!receipt.proofImpossible && receipt.file) {
    const folder = env.categoryFolders[repCategoryId];
    const blob = Utilities.newBlob(
      Utilities.base64Decode(receipt.file.base64),
      receipt.file.mimeType,
      receipt.file.name
    );
    const file = folder.createFile(blob);
    file.setDescription("denno-acct " + transactionId + " sha256:" + receipt.file.sha256);
    receiptUrl = file.getUrl();
    receiptPath = fiscalYearLabel_(fy) + "/領収書/" + CATEGORIES[repCategoryId] + "/" + receipt.file.name;
    receiptCategory = CATEGORIES[repCategoryId];
  }

  const rows = receipt.uses.map((u, i) => buildLedgerRow_({
    transactionId: transactionId,
    detailIndex: i + 1,
    kind: "expense",
    clientRequestId: p.clientRequestId,
    purchaseDate: receipt.purchaseDate,
    submittedAt: p.submittedAt,
    now: now,
    buyerName: receipt.buyerName,
    vendor: receipt.vendor,
    paymentMethodId: receipt.paymentMethodId,
    use: u,
    receiptTotal: receipt.receiptTotal,
    receiptUrl: receiptUrl,
    receiptPath: receiptPath,
    receiptCategory: receiptCategory,
    sha256: receipt.proofImpossible ? "" : receipt.file.sha256,
    proofImpossible: !!receipt.proofImpossible,
    proofImpossibleReason: receipt.proofImpossibleReason || "",
  }));
  appendRowsByHeader_(ledger, rows);
  appendLog_(ss.getSheetByName("APIログ"), p.clientRequestId, "expense", transactionId, "ok");
  recompute_(ss, fy, props);
  return { transactionId: transactionId, appended: false };
}

function buildLedgerRow_(o) {
  return {
    "取引ID": o.transactionId,
    "明細ID": o.transactionId + "-" + o.detailIndex,
    "種別": o.kind,
    "申請ID": o.clientRequestId,
    "購入日": o.purchaseDate,
    "報告年月日時間": o.submittedAt || o.now.toISOString(),
    "記録実行時刻": o.now,
    "購入者氏名": o.buyerName,
    "購入先": o.vendor,
    "支払方法ID": o.paymentMethodId,
    "支払方法名": PAYMENT_METHODS[o.paymentMethodId] || "",
    "用途名": o.use.name,
    "用途別カテゴリID": o.use.categoryId,
    "用途別カテゴリ名": CATEGORIES[o.use.categoryId] || "",
    "用途別品目名": o.use.itemName,
    "報告科目ID": o.use.subjectId,
    "報告科目名": EXPENSE_SUBJECTS[o.use.subjectId] || "",
    "用途別メモ": o.use.memo || "",
    "用途別金額合計": o.use.amount,
    "領収書全体の金額": o.receiptTotal,
    "領収書URL": o.receiptUrl,
    "領収書保存パス": o.receiptPath,
    "領収書保存カテゴリ": o.receiptCategory,
    "領収書ファイルSHA256": o.sha256,
    "証明不可フラグ": o.proofImpossible ? "TRUE" : "",
    "証明不可理由": o.proofImpossibleReason,
    "精算状態": o.paymentMethodId === "direct" ? "精算不要" : "未精算",
    "会計担当メモ": "",
    "取消フラグ": "",
    "取消理由": "",
    "取消日時": "",
  };
}
