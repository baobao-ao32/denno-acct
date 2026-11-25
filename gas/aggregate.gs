/**
 * denno-acct v2 — GAS 台帳コア（分割済み。GASプロジェクト内の全ファイルが1つの名前空間を共有する）
 * 集計: 取引明細からサマリ/収入/支出タブを再計算する
 *
 * 必須 Script Properties:
 *   ROOT_FOLDER_ID          「会計」ルートフォルダの Drive ファイルID
 *   API_TOKEN               Worker が Authorization: Bearer で送るトークン
 *
 * 原則 (v2設計):
 * - 保存するのはID、名前は表示するときに引く。台帳にはID列と表示名列の両方を書く
 * - 書き込みは headerMap (ヘッダ名→列番号) 経由のみ。列のベタ書きは禁止
 * - 訂正は行削除ではなく void フラグ + 理由
 * - 年度は4月スタート。収入の年度帰属は報告日、支出は購入日
 * - 複数カテゴリに跨る領収書は、金額割合が最大のカテゴリに帰属させる
 */

/** 前年度の収入タブから、科目ごとの金額を {科目名: 金額} で返す。無ければ空。 */
function previousYearIncomeBySubject_(fy, props) {
  try {
    const root = DriveApp.getFolderById(props.getProperty("ROOT_FOLDER_ID"));
    const prevFolder = findChildFolder_(root, fiscalYearLabel_(fy - 1));
    if (!prevFolder) return {};
    const ssFile = findChildFile_(prevFolder, fiscalYearLabel_(fy - 1) + "会計記録");
    if (!ssFile) return {};
    const ss = SpreadsheetApp.openById(ssFile.getId());
    const sheet = ss.getSheetByName("収入");
    if (!sheet) return {};
    const out = {};
    readAllRows_(sheet).forEach((r) => {
      if (r["科目"] && r["科目"] !== "収入合計" && r["科目"] !== "前年度繰越金") {
        out[r["科目"]] = Number(r["金額"] || 0);
      }
    });
    return out;
  } catch (e) {
    return {};
  }
}

/**
 * 収入タブの既存の備考を {科目名: 備考} で返す。合計・繰越金の行は除く。
 * 備考は人間が書く欄のため、再計算で消さないよう先に読み取っておく。
 */
function readIncomeRemarks_(sheet) {
  const out = {};
  readAllRows_(sheet).forEach((r) => {
    if (r["科目"] && r["科目"] !== "収入合計" && r["科目"] !== "前年度繰越金") {
      out[r["科目"]] = r["備考"] || "";
    }
  });
  return out;
}

/**
 * 支出タブの既存の備考を {"大分類|科目": 備考} で返す。合計行は除く。
 * 大分類はグループ先頭行にしか書かれていないため、直前の値を引き継いで読む。
 */
function readExpenseRemarks_(sheet) {
  const out = {};
  let cat = "";
  readAllRows_(sheet).forEach((r) => {
    if (r["大分類"]) cat = r["大分類"];
    if (r["科目"] && r["科目"] !== "支出合計") {
      out[cat + "|" + r["科目"]] = r["備考"] || "";
    }
  });
  return out;
}

/**
 * 取引明細からサマリ/収入/支出タブを再計算して値で書き込む。
 * 繰越金は設定タブの「前年度繰越金」から読む (報告対象外として別行に置く)。
 * 収入・支出タブの備考は人間が書く欄のため、再計算の前後で保持する。
 */
function recompute_(ss, fy, props) {
  const ledger = ss.getSheetByName("取引明細");
  const rows = readAllRows_(ledger).filter((r) => !r["取消フラグ"]);
  const incomeRemarks = readIncomeRemarks_(ss.getSheetByName("収入"));
  const expenseRemarks = readExpenseRemarks_(ss.getSheetByName("支出"));

  let incomeTotal = 0;
  let expenseTotal = 0;
  let unprovable = 0;
  const incomeBySubject = {};
  const expenseByGroup = {}; // "大分類ID|科目ID" -> amount

  for (const r of rows) {
    if (r["種別"] === "income") {
      const amount = Number(r["用途別金額合計"] || 0);
      incomeTotal += amount;
      incomeBySubject[r["報告科目ID"]] = (incomeBySubject[r["報告科目ID"]] || 0) + amount;
    } else if (r["種別"] === "expense") {
      const amount = Number(r["用途別金額合計"] || 0);
      expenseTotal += amount;
      if (r["証明不可フラグ"]) unprovable += amount;
      const key = r["用途別カテゴリID"] + "|" + r["報告科目ID"];
      expenseByGroup[key] = (expenseByGroup[key] || 0) + amount;
    }
  }

  const carryover = Number(getSetting_(ss, "前年度繰越金", 0) || 0);
  const balance = incomeTotal - expenseTotal;
  const directCost = expenseTotal - unprovable;

  // --- サマリ ---
  const summary = ss.getSheetByName("サマリ");
  summary.clearContents();
  summary.getRange(1, 1, 1, 2).setValues([["項目", "金額"]]);
  summary.getRange(2, 1, 7, 2).setValues([
    ["収入合計", incomeTotal],
    ["支出合計", expenseTotal],
    ["差引収支", balance],
    ["領収証等による支出の証明ができない額", unprovable],
    ["直接経費額", directCost],
    ["前年度繰越金", carryover],
    ["年度末残高", carryover + balance],
  ]);

  // --- 収入 ---
  const prevIncome = previousYearIncomeBySubject_(fy, props);
  const incomeSheet = ss.getSheetByName("収入");
  incomeSheet.clearContents();
  incomeSheet.getRange(1, 1, 1, 4).setValues([INCOME_ROW_COLUMNS]);
  const incomeRows = [];
  for (const id of Object.keys(INCOME_SUBJECTS)) {
    const amount = incomeBySubject[id] || 0;
    const prev = prevIncome[INCOME_SUBJECTS[id]];
    incomeRows.push([
      INCOME_SUBJECTS[id],
      amount,
      prev === undefined ? "-" : amount - prev,
      incomeRemarks[INCOME_SUBJECTS[id]] || "",
    ]);
  }
  incomeRows.push(["前年度繰越金", carryover, "-", "報告対象外"]);
  incomeRows.push(["収入合計", incomeTotal, "-", ""]);
  incomeSheet.getRange(2, 1, incomeRows.length, 4).setValues(incomeRows);

  // --- 支出 ---
  const expenseSheet = ss.getSheetByName("支出");
  expenseSheet.clearContents();
  expenseSheet.getRange(1, 1, 1, 4).setValues([EXPENSE_ROW_COLUMNS]);
  const expenseRows = [];
  for (const catId of CATEGORY_ORDER) {
    for (const subId of Object.keys(EXPENSE_SUBJECTS)) {
      const amount = expenseByGroup[catId + "|" + subId];
      if (!amount) continue;
      expenseRows.push([CATEGORIES[catId], EXPENSE_SUBJECTS[subId], amount,
        expenseRemarks[CATEGORIES[catId] + "|" + EXPENSE_SUBJECTS[subId]] || ""]);
    }
  }
  // 大分類はグループ先頭行にのみ記入する (報告書の書式に合わせる)
  let lastCat = null;
  expenseRows.forEach((row) => {
    if (row[0] === lastCat) row[0] = "";
    else lastCat = row[0];
  });
  expenseRows.push(["", "支出合計", expenseTotal, ""]);
  expenseSheet.getRange(2, 1, expenseRows.length, 4).setValues(expenseRows);
}
