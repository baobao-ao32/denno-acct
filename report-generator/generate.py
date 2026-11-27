# -*- coding: utf-8 -*-
"""
Report generator prototype (Layer 2).

Fills the OFFICIAL templates (copied, never edited in place):
- templates/report-template.xlsx   -> out/<FY>年度_<org>_収支報告書.xlsx
- templates/receipts-template.pptx -> out/<FY>年度_<org>_領収証等一覧.pptx

Layout is never rebuilt: values go into the template's existing cells/slides,
receipt images are placed onto the template's blank pages. Output stays
editable .xlsx/.pptx; PDF conversion is a manual step AFTER human review
(per the official guide and Aoba's requirement).

Aggregation rules implemented here (from report-data-spec-2026-11-24.md):
- Income grouped by subject; delta vs prev-year same subject ("-" if none)
- Expenses grouped by (大分類, 科目); 大分類 in fixed order 運営費/制作練習費/参加出展費
- Unprovable amount = expense transactions with no receipt
- A receipt spanning categories goes under its largest-share line's subject
- Receipt pages: shelf-packed like last year's deck — portraits full-height
  side by side, landscapes full-width stacked, minimal margins, no captions

Usage:
    python generate.py                    # uses sample_data.py, writes to out/
    python generate.py --data sample_data.py
    python generate.py --input <年度フォルダ>  # real data: extracted fiscal-year
                                          # folder (会計記録.xlsx + 領収書/).
                                          # Runs consistency checks first;
                                          # fatal problems abort generation.
"""
import argparse
import glob
import importlib.util
import os
import re
import shutil
import subprocess
import sys
import types
from collections import OrderedDict

from PIL import Image, ImageDraw, ImageFont, ImageOps
from openpyxl import load_workbook
from pptx import Presentation
from pptx.enum.text import PP_ALIGN
from pptx.util import Cm, Pt, Emu

BASE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE_XLSX = os.path.join(BASE, "templates", "report-template.xlsx")
TEMPLATE_PPTX = os.path.join(BASE, "templates", "receipts-template.pptx")
OUT_DIR = os.path.join(BASE, "out")
RECEIPT_IMG_DIR = os.path.join(BASE, "out", "receipt-images")

CATEGORY_REPORT_NAME = {"operation": "運営費", "practice": "制作練習費", "event": "参加出展費"}
CATEGORY_ORDER = ["operation", "practice", "event"]
MAX_INCOME_ROWS = 6
MAX_EXPENSE_ROWS = 15


def load_data(path):
    spec = importlib.util.spec_from_file_location("sample_data", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ---------------------------------------------------------------- aggregation
def aggregate(data):
    income = OrderedDict()  # keyed by subject_id (stable across years)
    for inc in data.INCOME:
        row = income.setdefault(inc["subject_id"],
                                {"subject": inc["subject"], "amount": 0})
        row["amount"] += inc["amount"]
    expenses = OrderedDict()
    unprovable = 0
    receipts = []  # one entry per receipt-bearing transaction
    for tx in data.TRANSACTIONS:
        total = sum(line["amount"] for line in tx["lines"])
        for line in tx["lines"]:
            # 集計キーは報告科目ID（サンプルデータ等、IDが無い場合は表示名で代用）
            key = (line["category_id"], line.get("subject_id") or line["subject"])
            row = expenses.setdefault(key, {"amount": 0})
            row["amount"] += line["amount"]
        if not tx.get("receipt"):
            unprovable += total
        else:
            # 代表カテゴリは GAS と同じ「カテゴリ別合計が最大」で決める
            # (単一明細の最大ではない)。科目は代表カテゴリ内の最大明細から取る。
            rep_id = _representative_category(tx["lines"])
            primary = max((l for l in tx["lines"] if l["category_id"] == rep_id),
                          key=lambda line: line["amount"])
            receipts.append({
                "date": tx["date"],
                "counterparty": tx["counterparty"],
                "category_id": rep_id,
                "subject": expense_subject_name(primary.get("subject_id"), primary["subject"]),
                "amount": total,
                "lines": tx["lines"],
                "image_paths": tx.get("image_paths"),
            })
    income_total = sum(r["amount"] for r in income.values())
    expense_total = sum(r["amount"] for r in expenses.values())
    return {
        "income": income, "expenses": expenses,
        "income_total": income_total, "expense_total": expense_total,
        "balance": income_total - expense_total,
        "unprovable": unprovable,
        "direct_expense": expense_total - unprovable,
        "receipts": receipts,
    }


# ---------------------------------------------------------------- receipt images
def _font(size, bold=False):
    for path in ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
                 "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
                 "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                pass
    return ImageFont.load_default()


def make_receipt_image(receipt, idx, path):
    """Synthetic receipt stand-in (sample data has no real receipt files)."""
    portrait = idx % 2 == 0
    w, h = (760, 1060) if portrait else (1060, 720)
    img = Image.new("RGB", (w, h), "white")
    d = ImageDraw.Draw(img)
    d.rectangle([14, 14, w - 14, h - 14], outline="black", width=3)
    f_big, f_mid, f_small = _font(64, True), _font(40), _font(34)
    d.text((w // 2, 70), "領収書", font=f_big, fill="black", anchor="ma")
    d.text((40, 170), receipt["counterparty"], font=f_mid, fill="black")
    d.text((40, 230), receipt["date"], font=f_small, fill="black")
    d.line([(40, 300), (w - 40, 300)], fill="black", width=2)
    y = 340
    for line in receipt["lines"]:
        d.text((40, y), f'{line["item"]}（{line["subject"]}）', font=f_small, fill="black")
        d.text((w - 40, y), f'¥{line["amount"]:,}',
               font=f_small, fill="black", anchor="ra")
        y += 60
    d.line([(40, y + 10), (w - 40, y + 10)], fill="black", width=2)
    d.text((40, y + 40), "合計", font=f_mid, fill="black")
    d.text((w - 40, y + 40), f'¥{receipt["amount"]:,}',
           font=f_mid, fill="black", anchor="ra")
    d.text((40, y + 120), "※ 試作用のサンプル領収証です", font=f_small, fill="gray")
    img.save(path)
    return path


# ---------------------------------------------------------------- xlsx
def generate_xlsx(data, agg):
    fy = data.FISCAL_YEAR
    out = os.path.join(OUT_DIR, f"{fy}年度_{data.ORG_NAME}_収支報告書.xlsx")
    wb = load_workbook(TEMPLATE_XLSX)
    ws = wb.active
    ws["B2"] = f"{fy}年度 {data.ORG_NAME} 収支報告書"

    # 収入の部: rows 14-19, 科目(C) / 金額(F) / 前年度比較増減(I) / 備考(L)
    if len(agg["income"]) > MAX_INCOME_ROWS:
        print(f"WARNING: income subjects ({len(agg['income'])}) exceed template rows ({MAX_INCOME_ROWS})")
    for i, (subject_id, row) in enumerate(agg["income"].items()):
        r = 14 + i
        prev = data.PREV_YEAR_INCOME.get(subject_id, None)
        # 前年度実績が 0円だった場合も増減は金額そのものになる (GASの収入タブと同じ)。
        # "-" は前年度データ自体が無いときだけ。
        delta = "-" if prev is None else row["amount"] - prev
        ws.cell(row=r, column=3, value=row["subject"])
        ws.cell(row=r, column=6, value=row["amount"])
        ws.cell(row=r, column=9, value=delta)
        remark = getattr(data, "INCOME_REMARKS", {}).get(subject_id)
        if remark:
            ws.cell(row=r, column=12, value=remark)

    # 支出の部: rows 24-38, 大分類(C) / 科目(E) / 金額(H) / 備考(K)
    ordered = sorted(agg["expenses"].items(),
                     key=lambda kv: (CATEGORY_ORDER.index(kv[0][0]), list(agg["expenses"]).index(kv[0])))
    if len(ordered) > MAX_EXPENSE_ROWS:
        print(f"WARNING: expense (category, subject) groups ({len(ordered)}) exceed template rows ({MAX_EXPENSE_ROWS})")
    last_cat = None
    for i, ((cat_id, subject), row) in enumerate(ordered):
        r = 24 + i
        if cat_id != last_cat:
            ws.cell(row=r, column=3, value=CATEGORY_REPORT_NAME[cat_id])
            last_cat = cat_id
        ws.cell(row=r, column=5, value=expense_subject_name(subject, subject))
        ws.cell(row=r, column=8, value=row["amount"])
        remark = getattr(data, "EXPENSE_REMARKS", {}).get(
            (CATEGORY_REPORT_NAME[cat_id], expense_subject_name(subject, subject)))
        if remark:
            ws.cell(row=r, column=11, value=remark)

    # サマリ: H6 収入合計はテンプレに数式が無いベタ値のため値を書き込む
    ws["H6"] = agg["income_total"]
    ws["H8"] = agg["unprovable"]
    # 署名: L43/L44 はラベル（会計/代表）、氏名は右隣のセルに書く
    ws["M43"] = f'{data.REPORT_META["accountant"]}（{data.REPORT_META["accountant_dept"]}）'
    ws["M44"] = f'{data.REPORT_META["representative"]}（{data.REPORT_META["representative_dept"]}）'
    # MS Officeで開いたときに数式（H7/H9/合計行）を再計算させる
    wb.calculation.fullCalcOnLoad = True
    wb.save(out)
    return out


# ---------------------------------------------------------------- pptx
def _slide_rid(prs, slide):
    for rel in prs.part.rels.values():
        if rel.target_part is slide.part:
            return rel.rId
    raise KeyError("slide rel not found")


def _reorder_slides(prs, ordered):
    sldIdLst = prs.slides._sldIdLst
    by_rid = {el.rId: el for el in sldIdLst}
    for el in list(sldIdLst):
        sldIdLst.remove(el)
    for slide in ordered:
        sldIdLst.append(by_rid[_slide_rid(prs, slide)])


def _delete_slide(prs, slide):
    sldIdLst = prs.slides._sldIdLst
    rid = _slide_rid(prs, slide)
    for el in list(sldIdLst):
        if el.rId == rid:
            sldIdLst.remove(el)
    prs.part.drop_rel(rid)


def _set_cover(prs, data):
    slide = prs.slides[0]
    margin = Cm(1.0)
    for shape in slide.shapes:
        if not shape.has_text_frame:
            continue
        texts = [run.text for para in shape.text_frame.paragraphs for run in para.runs]
        is_target = any("yyyy" in t for t in texts) or \
            any(t.strip() == "団体名" for t in texts)
        for para in shape.text_frame.paragraphs:
            for run in para.runs:
                if "yyyy" in run.text:
                    run.text = run.text.replace("yyyy", str(data.FISCAL_YEAR))
                if run.text.strip() == "団体名":
                    run.text = data.ORG_NAME
        if is_target:
            # テンプレのボックス幅が狭く、実フォントでは文字が切れる/崩れる。
            # ボックスをスライド幅いっぱいに広げ、テキスト自体を中央揃えに
            # することで、レンダラやフォント差異に強くする (Aoba 2026-11-26)。
            shape.left = margin
            shape.width = prs.slide_width - 2 * margin
            shape.text_frame.word_wrap = True
            for para in shape.text_frame.paragraphs:
                para.alignment = PP_ALIGN.CENTER


def _layout_pages(receipts):
    """Shelf-pack receipt images the way last year's hand-made deck did:
    portrait receipts stand full-height side by side, landscape documents
    stack full-width, margins/gutters minimal. Returns a list of pages;
    each page is a list of (img_path, left, top, width, height) in EMU.
    Receipt order (date, subject) is preserved.
    """
    margin = Cm(0.6)
    gutter = Cm(0.3)
    usable_w = prs_slide_width - 2 * margin
    usable_h = prs_slide_height - 2 * margin

    # Flatten receipts to individual images (a multi-page PDF receipt
    # contributes one image per page, in order).
    flat = []  # (img_path, iw, ih)
    for receipt in receipts:
        for img_path in receipt["image_paths"]:
            with Image.open(img_path) as im:
                flat.append((img_path, im.size[0], im.size[1]))

    # Build rows: a portrait row holds portraits at full usable height;
    # a landscape image gets its own row at full usable width.
    rows = []  # {"kind": "portrait"|"landscape", "height": emu, "items": [(path, w, h)]}
    for img_path, iw, ih in flat:
        if iw >= ih:  # landscape: full width, height capped at usable_h
            w = usable_w
            h = int(usable_w * ih / iw)
            if h > usable_h:
                h = usable_h
                w = int(usable_h * iw / ih)
            rows.append({"kind": "landscape", "height": h, "items": [(img_path, w, h)]})
        else:  # portrait: full height, share the row while width allows
            h = usable_h
            w = int(usable_h * iw / ih)
            if rows and rows[-1]["kind"] == "portrait" and \
                    sum(it[1] for it in rows[-1]["items"]) + gutter * len(rows[-1]["items"]) + w <= usable_w:
                rows[-1]["items"].append((img_path, w, h))
            else:
                rows.append({"kind": "portrait", "height": h, "items": [(img_path, w, h)]})

    # Paginate. Rows stack top-to-bottom, centred horizontally. Special
    # case (seen in last year's deck): a lone portrait followed by
    # landscape documents shares one page — portrait full-height on the
    # left, landscapes stacked in the remaining right column.
    pages = []
    i = 0
    while i < len(rows):
        row = rows[i]
        if row["kind"] == "portrait" and len(row["items"]) == 1 and \
                i + 1 < len(rows) and rows[i + 1]["kind"] == "landscape":
            img_path, pw, ph = row["items"][0]
            page = [(img_path, margin, margin, pw, ph)]
            right_x = margin + pw + gutter
            right_w = usable_w - pw - gutter
            y = margin
            j = i + 1
            while j < len(rows) and rows[j]["kind"] == "landscape":
                lp, lw, lh = rows[j]["items"][0]
                w2 = right_w
                h2 = int(right_w * lh / lw)
                if h2 > usable_h:
                    h2 = usable_h
                    w2 = int(usable_h * lw / lh)
                if y + h2 > margin + usable_h:
                    break
                page.append((lp, right_x + (right_w - w2) // 2, y, w2, h2))
                y += h2 + gutter
                j += 1
            pages.append(page)
            i = j
            continue
        page, y = [], margin
        while i < len(rows):
            row = rows[i]
            if row["kind"] == "portrait" and len(row["items"]) == 1 and \
                    i + 1 < len(rows) and rows[i + 1]["kind"] == "landscape":
                break  # handled by the combined-page case above
            if y + row["height"] > margin + usable_h:
                break
            row_w = sum(it[1] for it in row["items"]) + gutter * (len(row["items"]) - 1)
            x = margin + (usable_w - row_w) // 2
            for img_path, w, h in row["items"]:
                page.append((img_path, x, y, w, h))
                x += w + gutter
            y += row["height"] + gutter
            i += 1
        pages.append(page)
    return pages


def _place_receipts(slide, placements):
    for img_path, left, top, w, h in placements:
        slide.shapes.add_picture(img_path, left, top, width=w, height=h)


prs_slide_width = None
prs_slide_height = None


def generate_pptx(data, agg):
    global prs_slide_width, prs_slide_height
    fy = data.FISCAL_YEAR
    out = os.path.join(OUT_DIR, f"{fy}年度_{data.ORG_NAME}_領収証等一覧.pptx")
    prs = Presentation(TEMPLATE_PPTX)
    prs_slide_width, prs_slide_height = prs.slide_width, prs.slide_height
    _set_cover(prs, data)

    # Sample data has no real files: synthesise stand-in images.
    # (Real input sets image_paths in the loader, PDFs already converted.)
    for i, receipt in enumerate(agg["receipts"]):
        if not receipt.get("image_paths"):
            receipt["image_paths"] = [make_receipt_image(
                receipt, i, os.path.join(RECEIPT_IMG_DIR, f"receipt-{receipt['date']}-{i}.png"))]

    # Template layout: 0 cover, 1 divider 運営費, 2 blank, 3 divider 制作練習費,
    # 4 blank, 5 divider 参加出展費, 6 blank
    divider_idx = {"operation": 1, "practice": 3, "event": 5}
    blank_idx = {"operation": 2, "practice": 4, "event": 6}
    blank_layout = prs.slides[2].slide_layout

    ordered = [prs.slides[0]]
    to_delete = []
    for cat_id in CATEGORY_ORDER:
        group = [r for r in agg["receipts"] if r["category_id"] == cat_id]
        group.sort(key=lambda r: (r["date"], r["subject"]))
        ordered.append(prs.slides[divider_idx[cat_id]])
        if not group:
            to_delete.append(prs.slides[blank_idx[cat_id]])
            continue
        pages = _layout_pages(group)
        first_page = prs.slides[blank_idx[cat_id]]
        _place_receipts(first_page, pages[0])
        ordered.append(first_page)
        for page in pages[1:]:
            new_slide = prs.slides.add_slide(blank_layout)
            _place_receipts(new_slide, page)
            ordered.append(new_slide)
    for slide in to_delete:
        _delete_slide(prs, slide)
    _reorder_slides(prs, ordered)
    prs.save(out)
    return out


# ---------------------------------------------------------------- real input
INCOME_SUBJECT_IDS = {
    "工学部学友会分配金": "gakuyu_grant",
    "工学部学友会役員報酬": "gakuyu_officer",
    "会費収入": "dues",
    "頒布・売上": "sales",
    "農学部学友会分配金": "nogaku_grant",
    "その他収入": "other_income",
}
SUMMARY_UNPROVABLE_KEY = "領収証等による支出の証明ができない額"

# GAS EXPENSE_SUBJECTS (config.gs) の写し: 報告科目ID -> 表示名。
# 集計は報告科目ID基準で行い、表示名はここから引く。スプレッドシート上の
# 報告科目名だけが手で書き換えられても、GAS の集計と食い違わないようにするため。
EXPENSE_SUBJECT_NAMES = {
    "consumables": "消耗品費",
    "supplies": "用品費",
    "materials": "材料費",
    "printing": "印刷製本費",
    "books": "図書資料費",
    "communication": "通信費",
    "rent": "賃借料",
    "facility": "施設利用料",
    "transport": "運搬費・配送料",
    "registration": "参加費登録料",
    "insurance": "保険料",
    "storage": "保管料",
    "medical": "医療費",
    "fuel": "燃料費",
    "lecturer": "講師料",
    "outsourcing": "委託費",
    "admission": "入館料",
    "other": "その他",
}


def expense_subject_name(subject_id, fallback=""):
    return EXPENSE_SUBJECT_NAMES.get(subject_id) or fallback or subject_id or ""


def _norm_date(v):
    if v is None:
        return ""
    if hasattr(v, "strftime"):
        return v.strftime("%Y-%m-%d")
    return str(v)[:10]


def _truthy(v):
    return v is True or (isinstance(v, str) and v.strip().upper() == "TRUE")


def _num(v):
    try:
        return int(v or 0)
    except (TypeError, ValueError):
        return 0


def _sheet_dicts(ws):
    rows = list(ws.iter_rows(values_only=True))
    if not rows:
        return []
    headers = [str(h) if h is not None else "" for h in rows[0]]
    out = []
    for r in rows[1:]:
        if r is None or all(c is None or c == "" for c in r):
            continue
        out.append({headers[i]: r[i] for i in range(min(len(headers), len(r)))})
    return out


def _representative_category(lines):
    """Mirror of GAS representativeCategoryId_ (ties go to the earlier
    category in CATEGORY_ORDER)."""
    sums = {}
    for line in lines:
        sums[line["category_id"]] = sums.get(line["category_id"], 0) + line["amount"]
    best, best_amount = None, -1
    for cid in CATEGORY_ORDER:
        if sums.get(cid, 0) > best_amount:
            best, best_amount = cid, sums.get(cid, 0)
    return best


def _convert_pdf(pdf_path, work_dir, stem):
    prefix = os.path.join(work_dir, stem)
    subprocess.run(["pdftoppm", "-png", "-r", "150", pdf_path, prefix],
                   check=True, capture_output=True)

    def page_no(p):
        m = re.search(r"-(\d+)\.png$", p)
        return int(m.group(1)) if m else 0

    return sorted(glob.glob(prefix + "-*.png"), key=page_no)


def _normalized_image(path, work_dir, stem):
    """EXIF Orientation を実ピクセルへ反映したコピーを work_dir に作って返す。

    スマホ写真は「横長ピクセル + 回転タグ」で縦長を表すことが多い。そのまま
    だとレイアウトの縦横判定を誤り、PowerPoint 上でも横倒しになるため、
    回転タグがある画像だけ転置済みコピー (PNG) を使う。タグが無い/通常向き
    の画像は元のパスをそのまま返す。
    """
    try:
        with Image.open(path) as im:
            orientation = im.getexif().get(274)
            if orientation in (None, 1):
                return path
            transposed = ImageOps.exif_transpose(im)
            out = os.path.join(work_dir, f"exif-{stem}.png")
            transposed.save(out)
            return out
    except Exception:
        return path


def load_fiscal_folder(folder):
    """Load an extracted fiscal-year folder:
        <folder>/<FY>年度会計記録.xlsx   (Sheets export inside the Drive zip)
        <folder>/領収書/<大分類>/*        (receipt files, original names)
    Returns (data, checks) where data mirrors sample_data's namespace and
    checks = {"errors": [...], "warnings": [...], "infos": [...]}.
    Errors are fatal: the caller must not generate reports from bad input.
    """
    errors, warnings, infos = [], [], []

    def find_book(base):
        hits = sorted(glob.glob(os.path.join(base, "*会計記録.xlsx")))
        return hits[0] if hits else None

    base, book = folder, find_book(folder)
    if not book:
        for sub in sorted(glob.glob(os.path.join(folder, "*"))):
            if os.path.isdir(sub) and find_book(sub):
                base, book = sub, find_book(sub)
                break
    if not book:
        raise SystemExit(f"会計記録.xlsx が見つかりません: {folder}")
    m = re.search(r"(\d{4})年度", os.path.basename(book))
    if not m:
        raise SystemExit(f"ファイル名から年度を読み取れません: {book}")
    fy = int(m.group(1))

    wb = load_workbook(book, data_only=True)
    for sheet in ("取引明細", "設定", "サマリ", "収入", "支出"):
        if sheet not in wb.sheetnames:
            errors.append(f"スプレッドシートに「{sheet}」タブがありません")

    settings = {}
    if "設定" in wb.sheetnames:
        for row in wb["設定"].iter_rows(values_only=True):
            if row and row[0] and len(row) > 1:
                settings[str(row[0])] = row[1]

    ledger = _sheet_dicts(wb["取引明細"]) if "取引明細" in wb.sheetnames else []

    income = []
    txs = OrderedDict()
    void_count = 0
    for r in ledger:
        if _truthy(r.get("取消フラグ")):
            void_count += 1
            continue
        if r.get("種別") == "income":
            income.append({
                "subject_id": r.get("報告科目ID") or "",
                "subject": r.get("報告科目名") or "",
                "amount": _num(r.get("用途別金額合計")),
            })
        elif r.get("種別") == "expense":
            tx = txs.setdefault(r.get("取引ID"), {
                "date": _norm_date(r.get("購入日")),
                "counterparty": r.get("購入先") or "",
                "receipt_total": _num(r.get("領収書全体の金額")),
                "saved_path": r.get("領収書保存パス") or "",
                "saved_category": r.get("領収書保存カテゴリ") or "",
                "proof": _truthy(r.get("証明不可フラグ")),
                "lines": [],
            })
            tx["lines"].append({
                "category_id": r.get("用途別カテゴリID") or "",
                "subject_id": r.get("報告科目ID") or "",
                "subject": r.get("報告科目名") or "",
                "item": r.get("用途別品目名") or "",
                "amount": _num(r.get("用途別金額合計")),
            })
    if void_count:
        infos.append(f"取消（void）行 {void_count} 件を除外しました")

    # --- per-transaction checks + receipt image resolution
    work_dir = os.path.join(OUT_DIR, "receipt-images")
    os.makedirs(work_dir, exist_ok=True)
    referenced = set()
    transactions = []
    for txid, tx in txs.items():
        total = sum(line["amount"] for line in tx["lines"])
        if not tx["proof"] and not tx["receipt_total"]:
            errors.append(f"{txid}: 領収書全体の金額が記録されていません")
        if tx["receipt_total"] and total != tx["receipt_total"]:
            errors.append(
                f"{txid}: 用途合計 {total:,}円 が領収書全体の金額 "
                f"{tx['receipt_total']:,}円 と一致しません")
        if tx["proof"]:
            transactions.append({"date": tx["date"], "counterparty": tx["counterparty"],
                                 "lines": tx["lines"], "receipt": False})
            continue
        if not tx["saved_path"]:
            errors.append(f"{txid}: 領収書保存パスが空です"
                          "（領収書が無い取引は証明不可フラグが必要です）")
            transactions.append({"date": tx["date"], "counterparty": tx["counterparty"],
                                 "lines": tx["lines"], "receipt": True, "image_paths": []})
            continue
        rel = tx["saved_path"].split("/", 1)[1] if "/" in tx["saved_path"] else tx["saved_path"]
        local = os.path.join(base, *rel.split("/"))
        image_paths = []
        if not os.path.exists(local):
            errors.append(f"{txid}: 領収書ファイルが見つかりません: {tx['saved_path']}")
        else:
            referenced.add(os.path.normpath(local))
            parts = rel.split("/")
            folder_cat = parts[1] if len(parts) >= 3 and parts[0] == "領収書" else None
            rep_name = CATEGORY_REPORT_NAME.get(_representative_category(tx["lines"]))
            if folder_cat and rep_name and folder_cat != rep_name:
                errors.append(
                    f"{txid}: 領収書の保存先フォルダ「{folder_cat}」が代表カテゴリ"
                    f"「{rep_name}」と一致しません")
            if tx["saved_category"] and folder_cat and tx["saved_category"] != folder_cat:
                errors.append(
                    f"{txid}: 台帳の保存カテゴリ「{tx['saved_category']}」が"
                    f"フォルダ「{folder_cat}」と一致しません")
            if local.lower().endswith(".pdf"):
                try:
                    image_paths = _convert_pdf(local, work_dir, f"pdf-{txid}")
                    if not image_paths:
                        errors.append(f"{txid}: PDFから画像を生成できませんでした: {tx['saved_path']}")
                except Exception as e:
                    errors.append(f"{txid}: PDF変換に失敗しました ({e}): {tx['saved_path']}")
            else:
                image_paths = [_normalized_image(local, work_dir, txid)]
        transactions.append({"date": tx["date"], "counterparty": tx["counterparty"],
                             "lines": tx["lines"], "receipt": True,
                             "image_paths": image_paths})

    # --- orphan receipt files (on disk but not in the ledger)
    receipt_root = os.path.join(base, "領収書")
    if os.path.isdir(receipt_root):
        for path in glob.glob(os.path.join(receipt_root, "**", "*"), recursive=True):
            if not os.path.isfile(path):
                continue
            # void 済み領収書の退避先は孤児扱いしない
            if os.path.relpath(path, receipt_root).split(os.sep)[0] == "取消済み":
                continue
            if os.path.normpath(path) not in referenced:
                warnings.append(
                    f"台帳に記録の無い領収書ファイル: {os.path.relpath(path, base)}")
    else:
        warnings.append("領収書フォルダがありません")

    # --- prev-year income deltas from the 収入 tab (computed by GAS)
    prev_income = {}
    income_tab = {}
    income_remarks = {}
    if "収入" in wb.sheetnames:
        for row in _sheet_dicts(wb["収入"]):
            name = row.get("科目")
            if not name or name in ("収入合計", "前年度繰越金"):
                continue
            income_tab[name] = _num(row.get("金額"))
            delta = row.get("前年度比較増減")
            sid = INCOME_SUBJECT_IDS.get(name)
            if sid and isinstance(delta, (int, float)):
                prev_income[sid] = _num(row.get("金額")) - int(delta)
            # GAS の集計タブに書かれた備考は報告書へ転記する
            if sid and row.get("備考"):
                income_remarks[sid] = row["備考"]

    data = types.SimpleNamespace(
        FISCAL_YEAR=fy,
        ORG_NAME=settings.get("団体名") or "電脳サークル",
        INCOME=income,
        PREV_YEAR_INCOME=prev_income,
        INCOME_REMARKS=income_remarks,
        EXPENSE_REMARKS={},
        TRANSACTIONS=transactions,
        REPORT_META={
            "accountant": settings.get("会計氏名") or "",
            "accountant_dept": settings.get("会計学科") or "",
            "representative": settings.get("代表氏名") or "",
            "representative_dept": settings.get("代表学科") or "",
        },
    )

    # --- cross-check the GAS aggregate tabs against the raw ledger
    agg = aggregate(data)
    if "サマリ" in wb.sheetnames:
        summary = {row.get("項目"): row.get("金額")
                   for row in _sheet_dicts(wb["サマリ"]) if row.get("項目")}

        def cmp_summary(label, mine):
            tab_val = summary.get(label)
            if tab_val is None:
                warnings.append(f"サマリに「{label}」がありません")
            elif _num(tab_val) != mine:
                errors.append(
                    f"集計不一致: {label} タブ={_num(tab_val):,}円 / 明細再計算={mine:,}円")

        cmp_summary("収入合計", agg["income_total"])
        cmp_summary("支出合計", agg["expense_total"])
        cmp_summary(SUMMARY_UNPROVABLE_KEY, agg["unprovable"])
        cmp_summary("直接経費額", agg["direct_expense"])
    mine_income = {}
    for row in agg["income"].values():
        mine_income[row["subject"]] = row["amount"]
    for name, amount in income_tab.items():
        if mine_income.get(name, 0) != amount:
            errors.append(
                f"集計不一致: 収入「{name}」 タブ={amount:,}円 / "
                f"明細再計算={mine_income.get(name, 0):,}円")
    if "支出" in wb.sheetnames:
        tab_groups, last_cat = {}, ""
        for row in _sheet_dicts(wb["支出"]):
            if row.get("大分類"):
                last_cat = row["大分類"]
            subject = row.get("科目")
            if subject and subject != "支出合計":
                tab_groups[(last_cat, subject)] = _num(row.get("金額"))
                # GAS の集計タブに書かれた備考は報告書へ転記する
                if row.get("備考"):
                    data.EXPENSE_REMARKS[(last_cat, subject)] = row["備考"]
        mine_groups = {(CATEGORY_REPORT_NAME[cid], expense_subject_name(subject, subject)): row["amount"]
                       for (cid, subject), row in agg["expenses"].items()}
        for key in set(tab_groups) | set(mine_groups):
            if tab_groups.get(key, 0) != mine_groups.get(key, 0):
                errors.append(
                    f"集計不一致: 支出 {key[0]}／{key[1]} "
                    f"タブ={tab_groups.get(key, 0):,}円 / 明細再計算={mine_groups.get(key, 0):,}円")

    # --- template row limits
    if len(agg["income"]) > MAX_INCOME_ROWS:
        errors.append(
            f"収入科目が {len(agg['income'])} 件で、報告書の上限 {MAX_INCOME_ROWS} 行を超えています")
    if len(agg["expenses"]) > MAX_EXPENSE_ROWS:
        errors.append(
            f"支出グループが {len(agg['expenses'])} 件で、報告書の上限 {MAX_EXPENSE_ROWS} 行を超えています")

    infos.append(f"取引 {len(transactions)} 件 / 領収書 {len(agg['receipts'])} 件 / "
                 f"証明できない額 {agg['unprovable']:,}円")
    return data, {"errors": errors, "warnings": warnings, "infos": infos}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", default=None)
    parser.add_argument("--input", default=None,
                        help="年度フォルダ（解凍済み）から実データで生成する")
    args = parser.parse_args()
    os.makedirs(OUT_DIR, exist_ok=True)
    os.makedirs(RECEIPT_IMG_DIR, exist_ok=True)
    if args.input:
        data, checks = load_fiscal_folder(args.input)
        print("--- 検査結果 ---")
        for e in checks["errors"]:
            print("ERROR:", e)
        for w in checks["warnings"]:
            print("WARN:", w)
        for i in checks["infos"]:
            print("INFO:", i)
        if checks["errors"]:
            print(f"検査で {len(checks['errors'])} 件の致命的な問題が見つかったため、生成を中止しました")
            sys.exit(2)
        print("検査OK。生成します")
    else:
        data = load_data(args.data or os.path.join(BASE, "sample_data.py"))
    agg = aggregate(data)
    xlsx = generate_xlsx(data, agg)
    pptx = generate_pptx(data, agg)
    print(f"income_total={agg['income_total']:,}  expense_total={agg['expense_total']:,}"
          f"  balance={agg['balance']:,}  unprovable={agg['unprovable']:,}"
          f"  direct_expense={agg['direct_expense']:,}")
    print(f"income subjects={len(agg['income'])}  expense groups={len(agg['expenses'])}"
          f"  receipts={len(agg['receipts'])}")
    print("wrote", xlsx)
    print("wrote", pptx)


if __name__ == "__main__":
    main()
