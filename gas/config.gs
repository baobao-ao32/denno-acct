/**
 * denno-acct v2 — GAS 台帳コア（分割済み。GASプロジェクト内の全ファイルが1つの名前空間を共有する）
 * 設定とマスタ定義（IDと表示名、台帳ヘッダ、各種上限）
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

const CATEGORIES = {
  operation: "運営費",
  practice: "制作練習費",
  event: "参加出展費",
};
const CATEGORY_ORDER = ["operation", "practice", "event"];

const PAYMENT_METHODS = {
  direct: "部費から直接",
  advance: "個人で立て替え",
};

const INCOME_SUBJECTS = {
  gakuyu_grant: "工学部学友会分配金",
  gakuyu_officer: "工学部学友会役員報酬",
  dues: "会費収入",
  sales: "頒布・売上",
  nogaku_grant: "農学部学友会分配金",
  other_income: "その他収入",
};

const EXPENSE_SUBJECTS = {
  consumables: "消耗品費",
  supplies: "用品費",
  materials: "材料費",
  printing: "印刷製本費",
  books: "図書資料費",
  communication: "通信費",
  rent: "賃借料",
  facility: "施設利用料",
  transport: "運搬費・配送料",
  registration: "参加費登録料",
  insurance: "保険料",
  storage: "保管料",
  medical: "医療費",
  fuel: "燃料費",
  lecturer: "講師料",
  outsourcing: "委託費",
  admission: "入館料",
  other: "その他",
};

const LEDGER_HEADERS = [
  "取引ID", "明細ID", "種別", "申請ID",
  "購入日", "報告年月日時間", "記録実行時刻",
  "購入者氏名", "購入先", "支払方法ID", "支払方法名",
  "用途名", "用途別カテゴリID", "用途別カテゴリ名",
  "用途別品目名", "報告科目ID", "報告科目名", "用途別メモ",
  "用途別金額合計", "領収書全体の金額",
  "領収書URL", "領収書保存パス", "領収書保存カテゴリ",
  "領収書ファイルSHA256", "証明不可フラグ", "証明不可理由",
  "精算状態", "会計担当メモ", "取消フラグ", "取消理由", "取消日時",
];

const INCOME_ROW_COLUMNS = ["科目", "金額", "前年度比較増減", "備考"];
const EXPENSE_ROW_COLUMNS = ["大分類", "科目", "金額", "備考"];

const MAX_RECEIPTS = 5;
const MAX_USES = 10;
