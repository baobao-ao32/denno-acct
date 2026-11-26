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

  // 値引き・ポイント利用額: 用途はレシート表記 (値引き前) の金額で受け取り、
  // ここで按分して実支払額ベースの用途金額に直す。以後の照合はすべて按分後で行う。
  const discount = receipt.discount == null ? 0 : Number(receipt.discount);
  const grossSum = receipt.uses.reduce((a, u) => a + u.amount, 0);
  if (!Number.isInteger(discount) || discount < 0 || (discount > 0 && discount >= grossSum)) {
    throw new Error("値引き・ポイント利用額が不正です（用途の合計金額より小さい必要があります）");
  }
  const netUses = applyDiscount_(receipt.uses, discount);
  const netSum = netUses.reduce((a, u) => a + u.amount, 0);

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
      const storedTotal = Number(existing["領収書全体の金額"] || 0);
      const existingSum = sumTransactionUses_(appendSs.getSheetByName("取引明細"), transactionId);
      if (storedTotal > 0 && receipt.receiptTotal !== storedTotal) {
        throw new Error("領収書全体の金額が、登録済みの金額（" + storedTotal.toLocaleString() + "円）と一致しません");
      }
      if (storedTotal > 0 && existingSum >= storedTotal) {
        throw new Error("この領収書は既に登録が完了しています（取引ID: " + transactionId + "）。追加の用途は登録できません");
      }
      // 途中提出を許可するため、追記は「登録済み + 今回分 <= 総額」なら通す
      if (existingSum + netSum > receipt.receiptTotal) {
        throw new Error("用途の金額が領収書全体の金額を超えています: 登録済み " + existingSum.toLocaleString() + "円 + 今回（値引き後） " + netSum.toLocaleString() + "円 > 領収書全体 " + receipt.receiptTotal.toLocaleString() + "円");
      }
      const rows = netUses.map((u, i) => buildLedgerRow_({
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
        discount: discount,
      }));
      appendRowsByHeader_(appendSs.getSheetByName("取引明細"), rows);
      appendLog_(appendSs.getSheetByName("APIログ"), p.clientRequestId, "expense", transactionId, "ok-appended");
      moveReceiptFileIfNeeded_(appendEnv, existing, netUses, props);
      recompute_(appendSs, appendFy, props);
      return { transactionId: transactionId, appended: true };
    }
  }

  // 新規取引。途中提出 (合計が総額未満) を許可する。ただし領収書なし
  // (証明不可) は追記で埋める手段が無いため、従来通り完全一致を要求する。
  if (netSum > receipt.receiptTotal) {
    throw new Error("用途の金額（値引き後）が領収書全体の金額を超えています: " + netSum.toLocaleString() + "円 > " + receipt.receiptTotal.toLocaleString() + "円");
  }
  if (receipt.proofImpossible && netSum !== receipt.receiptTotal) {
    throw new Error("領収書なしの支出は、用途の合計が支出金額と一致する必要があります: " + netSum.toLocaleString() + "円 != " + receipt.receiptTotal.toLocaleString() + "円");
  }
  const transactionId = "TX-" + Utilities.getUuid();
  const repCategoryId = representativeCategoryId_(netUses);
  let receiptUrl = "";
  let receiptPath = "";
  let receiptCategory = "";
  if (!receipt.proofImpossible && receipt.file) {
    const folder = env.categoryFolders[repCategoryId];
    // 保存名は取引IDプレフィックス付きの一意名にする。同名ファイル (IMG_0001.jpg 等) が
    // 同一フォルダに共存すると、ZIP解凍時に上書き・リネームされて台帳の保存パスと食い違うため。
    const savedName = transactionId + "_" + sanitizeFileName_(receipt.file.name);
    const blob = Utilities.newBlob(
      Utilities.base64Decode(receipt.file.base64),
      receipt.file.mimeType,
      savedName
    );
    const file = folder.createFile(blob);
    file.setDescription("denno-acct " + transactionId + " sha256:" + receipt.file.sha256);
    receiptUrl = file.getUrl();
    receiptPath = fiscalYearLabel_(fy) + "/領収書/" + CATEGORIES[repCategoryId] + "/" + savedName;
    receiptCategory = CATEGORIES[repCategoryId];
  }

  const rows = netUses.map((u, i) => buildLedgerRow_({
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
    discount: discount,
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
    "値引き額": o.discount || 0,
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

/**
 * 値引き・ポイント利用額を用途の金額比で按分し、按分後の用途一覧を返す。
 * 端数は金額の大きい用途から1円ずつ配る。どの用途も1円以上を保つ。
 */
function applyDiscount_(uses, discount) {
  if (!discount) return uses;
  const gross = uses.reduce((a, u) => a + u.amount, 0);
  const shares = uses.map((u) => Math.floor((discount * u.amount) / gross));
  let remainder = discount - shares.reduce((a, b) => a + b, 0);
  const order = uses.map((u, i) => i).sort((a, b) => uses[b].amount - uses[a].amount);
  let guard = 0;
  while (remainder > 0 && guard < 10000) {
    guard++;
    let progressed = false;
    for (const i of order) {
      if (remainder <= 0) break;
      if (shares[i] < uses[i].amount - 1) {
        shares[i]++;
        remainder--;
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return uses.map((u, i) => Object.assign({}, u, { amount: u.amount - shares[i] }));
}
