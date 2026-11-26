# -*- coding: utf-8 -*-
"""
Sample data for the report generator prototype (fiscal 2025).

This stands in for the Layer-1 aggregation output: in production the same
structure comes from the GAS summary (per fiscal year: transactions +
prev-year subject totals + report metadata). The generator never hardcodes
totals; it aggregates from TRANSACTIONS below.

ASSUMPTIONS (open questions from the spec, decided here ONLY for the prototype):
- Org formal name: "電脳サークル" (placeholder; confirm the registered name)
- No carryover (繰越金) income subject in this sample
- Expense report subjects are chosen from the master list in the spec
- Signatories are the guide's own example names (placeholder)
- One receipt-less expense (lost receipt) tests the "unprovable amount" line

Transactions are grounded in the real response-sheet rows Aoba shared on
2026-11-16 (農工祭模擬店, フィラメント, シリコングリス, チャック袋,
エプロン, ポスター台, 出展者タグ, テーブル/電源レンタル, 出店料).
"""

FISCAL_YEAR = 2025
ORG_NAME = "電脳サークル"  # TODO: confirm the officially registered name

REPORT_META = {
    "accountant": "田中 太郎", "accountant_dept": "生命工学科",
    "representative": "佐藤 花子", "representative_dept": "生命工学科",
}

# Prev-year (2024) income totals per subject, for 前年度比較増減.
PREV_YEAR_INCOME = {
    "gakuyu_grant": 40000,
    "dues": 30000,
    "sales": 0,  # no counterpart last year -> "-"
}

# category_id -> (大分類 report name, sort order)
CATEGORY_ORDER = [
    ("operation", "運営費"),
    ("practice", "制作練習費"),
    ("event", "参加出展費"),
]

# Each transaction: one receipt (or none) per transaction.
# lines: [{category_id, subject, title, item, amount}]
TRANSACTIONS = [
    dict(date="2025-04-12", kind="expense", counterparty="Amazon",
         lines=[dict(category_id="operation", subject="消耗品費",
                     title="事務用品の購入", item="文房具", amount=3200)],
         receipt=True),
    dict(date="2025-05-20", kind="expense", counterparty="さくらインターネット",
         lines=[dict(category_id="operation", subject="通信費",
                     title="Webサイト運用", item="レンタルサーバ・ドメイン", amount=13200)],
         receipt=True),
    dict(date="2025-06-08", kind="expense", counterparty="Amazon",
         lines=[dict(category_id="practice", subject="材料費",
                     title="3Dプリンタ消耗品の補充", item="フィラメント×5・シリコングリス", amount=18400)],
         receipt=True),
    dict(date="2025-07-15", kind="expense", counterparty="大学会館",
         lines=[dict(category_id="operation", subject="施設利用料",
                     title="勉強会の会場レンタル", item="会議室レンタル", amount=6000)],
         receipt=True),
    dict(date="2025-09-03", kind="expense", counterparty="秋月電子通商",
         lines=[dict(category_id="practice", subject="材料費",
                     title="プロジェクトXの制作", item="電子部品", amount=6200)],
         receipt=True),
    dict(date="2025-10-25", kind="expense", counterparty="東京農工大学",
         lines=[dict(category_id="event", subject="出展料",
                     title="農工祭模擬店", item="農工祭模擬店出店料", amount=15000)],
         receipt=True),
    # One receipt spanning two categories: largest share (印刷製本費 2500)
    # decides the receipt's section, per the official guide.
    dict(date="2025-11-01", kind="expense", counterparty="コンビニプリント",
         lines=[dict(category_id="event", subject="印刷製本費",
                     title="農工祭展示物の制作", item="ポスター台", amount=2500),
                dict(category_id="practice", subject="材料費",
                     title="農工祭展示物の制作", item="チャック袋×2", amount=1800)],
         receipt=True),
    dict(date="2025-11-02", kind="expense", counterparty="レンタルショップ",
         lines=[dict(category_id="event", subject="運搬費",
                     title="農工祭出展", item="テーブルレンタル・電源レンタル", amount=9800)],
         receipt=True),
    dict(date="2025-11-02", kind="expense", counterparty="文房具店",
         lines=[dict(category_id="event", subject="印刷製本費",
                     title="農工祭出展", item="出展者タグ・エプロン", amount=4300)],
         receipt=True),
    dict(date="2025-12-10", kind="expense", counterparty="書店",
         lines=[dict(category_id="practice", subject="図書資料費",
                     title="勉強のための購入", item="専門書", amount=5400)],
         receipt=True),
    # Receipt lost: counts toward the "unprovable" amount.
    dict(date="2026-01-18", kind="expense", counterparty="ホームセンター",
         lines=[dict(category_id="operation", subject="消耗品費",
                     title="事務用品の購入", item="電池・布", amount=2000)],
         receipt=False, unprovable_reason="レシート紛失"),
    dict(date="2026-02-14", kind="expense", counterparty="文房具店",
         lines=[dict(category_id="operation", subject="消耗品費",
                     title="事務用品の購入", item="電池", amount=3000)],
         receipt=True),
]

INCOME = [
    dict(date="2025-04-01", subject_id="gakuyu_grant", subject="工学部学友会分配金",
         counterparty="工学部学友会", amount=50000),
    dict(date="2025-04-20", subject_id="dues", subject="会費収入",
         counterparty="部員", amount=18000),
    dict(date="2025-10-15", subject_id="dues", subject="会費収入",
         counterparty="部員", amount=18000),
    dict(date="2025-11-03", subject_id="sales", subject="頒布・売上",
         counterparty="農工祭来場者", amount=12400),
]
