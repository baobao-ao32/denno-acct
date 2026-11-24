// マスタ定義。保存するのはID、表示名はここから引く（v2設計の原則）。
// 科目マスタの初期値は分配金規則・別表第1と会計報告書概要の例に基づく。

export const CATEGORIES = [
  { id: "operation", name: "運営費", reportName: "運営費" },
  { id: "practice", name: "制作練習費", reportName: "制作練習費" },
  { id: "event", name: "参加出展費", reportName: "参加出展費" },
];

export const PAYMENT_METHODS = [
  { id: "direct", name: "部費から直接" },
  { id: "advance", name: "個人で立て替え" },
];

export const INCOME_SUBJECTS = [
  { id: "gakuyu_grant", name: "工学部学友会分配金" },
  { id: "gakuyu_officer", name: "工学部学友会役員報酬" },
  { id: "dues", name: "会費収入" },
  { id: "sales", name: "頒布・売上" },
  { id: "nogaku_grant", name: "農学部学友会分配金" },
  { id: "other_income", name: "その他収入", requiresDetail: true },
];

export const EXPENSE_SUBJECTS = [
  { id: "consumables", name: "消耗品費" },
  { id: "supplies", name: "用品費" },
  { id: "materials", name: "材料費" },
  { id: "printing", name: "印刷製本費" },
  { id: "books", name: "図書資料費" },
  { id: "communication", name: "通信費" },
  { id: "rent", name: "賃借料" },
  { id: "facility", name: "施設利用料" },
  { id: "transport", name: "運搬費・配送料" },
  { id: "registration", name: "参加費登録料" },
  { id: "insurance", name: "保険料" },
  { id: "storage", name: "保管料" },
  { id: "medical", name: "医療費" },
  { id: "fuel", name: "燃料費" },
  { id: "lecturer", name: "講師料" },
  { id: "outsourcing", name: "委託費" },
  { id: "admission", name: "入館料" },
  { id: "other", name: "その他" },
];

export const LIMITS = {
  maxReceiptsPerSubmission: 5,
  maxUsesPerReceipt: 10,
};
