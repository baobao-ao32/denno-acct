import {
  CATEGORIES,
  PAYMENT_METHODS,
  INCOME_SUBJECTS,
  EXPENSE_SUBJECTS,
  LIMITS,
} from "./masters.js";
import { API_BASE } from "./config.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// 領収書ファイルの制限 (サーバー側の検証と揃える)。WebP は報告書生成
// (python-pptx) との互換性のため受け付けない (2026-11-26 決定)。
const ALLOWED_FILE_TYPES = ["image/jpeg", "image/png", "application/pdf"];
const MAX_FILE_BYTES = 10 * 1024 * 1024;

// ---------- 共通ユーティリティ ----------

async function sha256Hex(blob) {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function isHeic(file) {
  return /image\/hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
}

let heicLibPromise = null;
function loadHeicLib() {
  if (!heicLibPromise) {
    heicLibPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      // 同梱版を使う (CDN には依存しない)。ライセンス表示は vendor/THIRD-PARTY-NOTICES.md
      s.src = "vendor/heic2any.min.js";
      s.onload = () => resolve(window.heic2any);
      s.onerror = () => reject(new Error("HEIC変換ライブラリの読み込みに失敗しました"));
      document.head.appendChild(s);
    });
  }
  return heicLibPromise;
}

async function convertHeicToJpeg(file) {
  const heic2any = await loadHeicLib();
  const out = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.92 });
  const blob = Array.isArray(out) ? out[0] : out;
  return new File([blob], file.name.replace(/\.hei[cf]$/i, ".jpg"), { type: "image/jpeg" });
}

function showMessage(text, kind = "") {
  const el = $("#message");
  el.textContent = text;
  el.className = kind;
}

const DEBUG = new URLSearchParams(location.search).has("debug");
function showPayload(payload) {
  if (!DEBUG) return; // ペイロード表示は ?debug=1 のときだけ
  $("#payload-preview").hidden = false;
  $("#payload-json").textContent = JSON.stringify(payload, null, 2);
}

function optionsHtml(items, placeholder) {
  const head = placeholder ? `<option value="">${placeholder}</option>` : "";
  return head + items.map((i) => `<option value="${i.id}">${i.name}</option>`).join("");
}

// ---------- タブ切り替え ----------

$("#tab-expense").addEventListener("click", () => switchTab("expense"));
$("#tab-income").addEventListener("click", () => switchTab("income"));
function switchTab(which) {
  $("#tab-expense").classList.toggle("active", which === "expense");
  $("#tab-income").classList.toggle("active", which === "income");
  $("#panel-expense").hidden = which !== "expense";
  $("#panel-income").hidden = which !== "income";
  showMessage("");
}

// ---------- 支出: 用途ブロック ----------

function useBlockHtml() {
  return `
    <div class="grid">
      <div class="field"><label class="label">用途名</label>
        <input type="text" class="u-name" placeholder="例: 学園祭参加のため"></div>
      <div class="field"><label class="label">金額（円）</label>
        <input type="number" class="u-amount" min="1" step="1" inputmode="numeric"></div>
      <div class="field"><label class="label">カテゴリ</label>
        <select class="u-category">${optionsHtml(CATEGORIES, "選択してください")}</select></div>
      <div class="field"><label class="label">報告科目</label>
        <select class="u-subject">${optionsHtml(EXPENSE_SUBJECTS, "選択してください")}</select></div>
      <div class="field"><label class="label">品目名</label>
        <input type="text" class="u-item" placeholder="例: 学園祭参加費"></div>
      <div class="field"><label class="label">メモ</label>
        <input type="text" class="u-memo"></div>
    </div>`;
}

function addUseBlock(card) {
  const uses = $(".uses", card);
  if ($$(".use-block", uses).length >= LIMITS.maxUsesPerReceipt) {
    showMessage(`用途は1件の領収書につき最大${LIMITS.maxUsesPerReceipt}件までです。それ以上は提出を分けてください。`, "error");
    return;
  }
  const div = document.createElement("div");
  div.className = "use-block";
  div.innerHTML = `<h4>用途</h4>${useBlockHtml()}
    <button type="button" class="sub danger remove-use">この用途を削除</button>`;
  $(".remove-use", div).addEventListener("click", () => {
    div.remove();
    refreshCard(card);
  });
  $$("input, select", div).forEach((el) => el.addEventListener("input", () => refreshCard(card)));
  uses.appendChild(div);
  refreshCard(card);
}

function receiptFieldsHtml() {
  return `
    <div class="grid">
      <div class="field"><label class="label">購入日</label>
        <input type="date" class="r-date"></div>
      <div class="field"><label class="label">購入者氏名</label>
        <input type="text" class="r-buyer"></div>
      <div class="field"><label class="label">購入先</label>
        <input type="text" class="r-vendor"></div>
      <div class="field"><label class="label">支払方法</label>
        <select class="r-payment">${optionsHtml(PAYMENT_METHODS, "選択してください")}</select></div>
      <div class="field"><label class="label">領収書全体の金額（円）</label>
        <input type="number" class="r-total" min="1" step="1" inputmode="numeric"></div>
      <div class="field r-discount-field"><label class="label">値引き・ポイント利用額（円）</label>
        <input type="number" class="r-discount" min="0" step="1" inputmode="numeric" value="0"></div>
    </div>
    <div class="uses"></div>
    <button type="button" class="sub add-use">＋ 用途を追加</button>
    <div class="sum-check"></div>`;
}

function collectUses(card) {
  return $$(".use-block", card).map((b) => ({
    name: $(".u-name", b).value.trim(),
    amount: Number($(".u-amount", b).value || 0),
    categoryId: $(".u-category", b).value,
    subjectId: $(".u-subject", b).value,
    itemName: $(".u-item", b).value.trim(),
    memo: $(".u-memo", b).value.trim(),
  }));
}

function refreshCard(card) {
  const uses = collectUses(card);
  const sum = uses.reduce((a, u) => a + (u.amount || 0), 0);
  const discountEl = $(".r-discount", card);
  const discount = discountEl ? Number(discountEl.value || 0) : 0;
  const net = sum - discount;
  const totalInput = $(".r-total", card);
  const total = totalInput ? Number(totalInput.value || 0) : 0;
  // 追記モードでは、今回の用途合計は「領収書全体 − 登録済み合計」が目標になる。
  // 途中提出 (目標未満) も許可する。判定は値引き後の金額で行う。
  const registered = Number(card.dataset.registeredAmount || 0);
  const target = total - registered;
  const box = $(".sum-check", card);
  if (!box) return;
  if (discount > 0 && sum > 0 && discount > sum - uses.length) {
    box.textContent = "値引き・ポイント利用額が大きすぎます（各用途に1円以上残る範囲で入力してください）。";
    box.className = "sum-check ng";
  } else if (total > 0) {
    const diff = target - net;
    const netLabel = discount > 0
      ? `用途の合計（値引き後） ${net.toLocaleString()}円`
      : `用途の合計 ${net.toLocaleString()}円`;
    box.textContent = diff === 0
      ? `${netLabel} ＝ ${registered > 0 ? "残りの金額" : "領収書全体の金額"}。一致しています。`
      : diff > 0
        ? `${netLabel} / 目標 ${target.toLocaleString()}円（残り ${diff.toLocaleString()}円 — 途中提出もできます。残りは後から追記できます）`
        : `${netLabel} / 目標 ${target.toLocaleString()}円（${(-diff).toLocaleString()}円 超えています）`;
    box.className = "sum-check " + (diff >= 0 ? "ok" : "ng");
  } else {
    box.textContent = `用途の合計 ${net.toLocaleString()}円`;
    box.className = "sum-check";
  }
  validateExpense();
}

function bindCard(card) {
  $(".add-use", card).addEventListener("click", () => addUseBlock(card));
  $$("input, select", card).forEach((el) => el.addEventListener("input", () => refreshCard(card)));
  addUseBlock(card);
}

// ---------- 支出: 領収書あり ----------

const receipts = []; // { file, hash, card }

$("#receipt-files").addEventListener("change", async (ev) => {
  showMessage("");
  const files = [...ev.target.files];
  if (receipts.length + files.length > LIMITS.maxReceiptsPerSubmission) {
    showMessage(`領収書は1回の提出で最大${LIMITS.maxReceiptsPerSubmission}件までです。`, "error");
    ev.target.value = "";
    return;
  }
  for (let file of files) {
    try {
      // ハッシュは変換前の元ファイルで取る。HEIC→JPEG変換結果は端末や
      // ブラウザでバイナリが微妙に変わるため、変換後のハッシュでは
      // 別端末からの分割提出 (追記) で同一領収書と判定できなくなる。
      const hash = await sha256Hex(file);
      if (receipts.some((r) => r.hash === hash)) {
        showMessage(`${file.name} は既に選択されています（同じ領収書ファイルです）。`, "error");
        continue;
      }
      if (isHeic(file)) {
        showMessage(`${file.name} をJPEGに変換しています…`);
        file = await convertHeicToJpeg(file);
      }
      if (!ALLOWED_FILE_TYPES.includes(file.type)) {
        showMessage(`${file.name} は対応していない形式です（JPEG / PNG / PDF のみ）。`, "error");
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        showMessage(`${file.name} が大きすぎます（1ファイル10MBまで）。`, "error");
        continue;
      }
      const card = document.createElement("div");
      card.className = "receipt-card";
      const preview = file.type.startsWith("image/")
        ? `<img class="preview" alt="領収書プレビュー">`
        : `<p class="hint">PDFファイルです（プレビューなし）</p>`;
      card.innerHTML = `<h3></h3>${preview}${receiptFieldsHtml()}
        <p class="hash">SHA-256: ${hash}</p>
        <p class="dup-notice sum-check ok" hidden></p>
        <p class="done-notice sum-check ok" hidden></p>
        <button type="button" class="sub danger remove-receipt">この領収書を取り消す</button>`;
      $("h3", card).textContent = file.name;
      if (file.type.startsWith("image/")) {
        $("img.preview", card).src = URL.createObjectURL(file);
      }
      // 先行する領収書の購入者氏名を引き継ぐ（入力の手間と表記ゆれの削減）
      const firstBuyer = receipts[0] && $(".r-buyer", receipts[0].card).value;
      $("#receipt-list").appendChild(card);
      bindCard(card);
      if (firstBuyer) $(".r-buyer", card).value = firstBuyer;
      const entry = { file, hash, card };
      receipts.push(entry);
      $(".remove-receipt", card).addEventListener("click", () => {
        const i = receipts.indexOf(entry);
        if (i >= 0) receipts.splice(i, 1);
        card.remove();
        validateExpense();
      });
      checkDuplicateReceipt(entry);
    } catch (e) {
      showMessage(`${file.name} の処理に失敗しました: ${e.message}`, "error");
    }
  }
  ev.target.value = "";
  showMessage("");
  validateExpense();
});

/** 登録済み領収書の事前照会。登録済みなら用途追記の提出になることを知らせる。 */
async function checkDuplicateReceipt(entry) {
  try {
    const res = await fetch(API_BASE + "/api/receipts/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sha256: entry.hash }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // 照会に失敗したまま静かに新規送信へ進むと、二重登録の検知が効かない。
      // 送信自体は止めないが、チェックできていないことを明示する。
      const notice = $(".dup-notice", entry.card);
      notice.hidden = false;
      notice.textContent =
        "登録状況の照会に失敗しました。この領収書が登録済みかどうか確認できていません（送信は可能ですが、重複にご注意ください）。";
      return;
    }
    if (!data.exists) return;
    entry.appendToTransactionId = data.transactionId;
    entry.duplicate = data;
    entry.card.dataset.registeredAmount = String(data.registeredAmount || 0);
    const notice = $(".dup-notice", entry.card);
    notice.hidden = false;
    if (data.receiptTotal > 0 && (data.registeredAmount || 0) >= data.receiptTotal) {
      // 登録が完了している領収書は、追記も再登録もできない
      entry.completed = true;
      notice.textContent =
        `この領収書は既に登録が完了しています（取引ID: ${data.transactionId}）。この領収書では送信できません。`;
    } else {
      notice.textContent =
        `この領収書は登録済みです（取引ID: ${data.transactionId}）。送信すると、用途がこの取引に追加されます。` +
        `値引き・ポイント利用額は最初の提出でのみ入力してください（追記時は0）。`;
    }
    // 既存取引の購入日・総額を引き継ぐ（ズレると別取引になってしまうため）
    if (data.purchaseDate && !$(".r-date", entry.card).value) {
      $(".r-date", entry.card).value = data.purchaseDate;
    }
    if (data.receiptTotal && !$(".r-total", entry.card).value) {
      $(".r-total", entry.card).value = data.receiptTotal;
    }
    // 購入者・購入先・支払方法も既存取引から引き継ぐ（追記側で変えると
    // 同一取引内で精算状態が混在するため、GAS側でも最初の登録を正とする）
    if (data.buyerName && !$(".r-buyer", entry.card).value) {
      $(".r-buyer", entry.card).value = data.buyerName;
    }
    if (data.vendor && !$(".r-vendor", entry.card).value) {
      $(".r-vendor", entry.card).value = data.vendor;
    }
    if (data.paymentMethodId && !$(".r-payment", entry.card).value) {
      $(".r-payment", entry.card).value = data.paymentMethodId;
    }
    refreshCard(entry.card);
  } catch {
    // 通信自体が失敗した場合も、照会できていないことを知らせる
    const notice = $(".dup-notice", entry.card);
    notice.hidden = false;
    notice.textContent =
      "登録状況の照会に失敗しました。この領収書が登録済みかどうか確認できていません（送信は可能ですが、重複にご注意ください）。";
  }
}

// ---------- 支出: 領収書なし ----------

const noReceiptCard = $("#no-receipt-card");
noReceiptCard.innerHTML = `
  <h3>領収書なしの支出</h3>
  ${receiptFieldsHtml().replace("領収書全体の金額（円）", "支出金額（円）")}
  <div class="field" style="margin-top:12px">
    <label class="label">領収証等による証明ができない理由</label>
    <textarea class="r-noreceipt-reason" rows="2" placeholder="例: 自動販売機での購入のため領収書が発行されない"></textarea>
  </div>`;
// 領収書なしの支出に値引きの概念は無いため、値引き欄は取り除く
const noReceiptDiscountField = $(".r-discount-field", noReceiptCard);
if (noReceiptDiscountField) noReceiptDiscountField.remove();
bindCard(noReceiptCard);

$$('input[name="receipt-mode"]').forEach((r) =>
  r.addEventListener("change", () => {
    const without = $('input[name="receipt-mode"]:checked').value === "without";
    $("#expense-with").hidden = without;
    $("#expense-without").hidden = !without;
    validateExpense();
  })
);

// ---------- 支出: 検証と送信 ----------

function validateReceiptCard(card, label, requireExact) {
  const errors = [];
  if (!$(".r-date", card).value) errors.push(`${label}: 購入日が未入力です`);
  if (!$(".r-buyer", card).value.trim()) errors.push(`${label}: 購入者氏名が未入力です`);
  if (!$(".r-vendor", card).value.trim()) errors.push(`${label}: 購入先が未入力です`);
  if (!$(".r-payment", card).value) errors.push(`${label}: 支払方法が未選択です`);
  const total = Number($(".r-total", card).value || 0);
  if (total <= 0) errors.push(`${label}: 金額が未入力です`);
  else if (!Number.isInteger(total)) errors.push(`${label}: 金額は整数で入力してください`);
  const uses = collectUses(card);
  if (uses.length === 0) errors.push(`${label}: 用途がありません`);
  uses.forEach((u, i) => {
    if (!u.name) errors.push(`${label}: 用途${i + 1}の用途名が未入力です`);
    if (u.amount <= 0) errors.push(`${label}: 用途${i + 1}の金額が未入力です`);
    else if (!Number.isInteger(u.amount)) errors.push(`${label}: 用途${i + 1}の金額は整数で入力してください`);
    if (!u.categoryId) errors.push(`${label}: 用途${i + 1}のカテゴリが未選択です`);
    if (!u.subjectId) errors.push(`${label}: 用途${i + 1}の報告科目が未選択です`);
    if (!u.itemName) errors.push(`${label}: 用途${i + 1}の品目名が未入力です`);
  });
  const sum = uses.reduce((a, u) => a + u.amount, 0);
  const discountEl = $(".r-discount", card);
  const discount = discountEl ? Number(discountEl.value || 0) : 0;
  if (discount < 0 || !Number.isInteger(discount) || (discount > 0 && sum > 0 && discount > sum - uses.length)) {
    errors.push(`${label}: 値引き・ポイント利用額が不正です（各用途に1円以上残る範囲で入力してください）`);
  }
  const target = total - Number(card.dataset.registeredAmount || 0);
  if (total > 0 && requireExact && sum - discount !== target) {
    errors.push(`${label}: 用途の合計（${(sum - discount).toLocaleString()}円）が金額（${target.toLocaleString()}円）と一致しません`);
  }
  if (total > 0 && !requireExact && sum - discount > target) {
    errors.push(`${label}: 用途の合計（値引き後 ${(sum - discount).toLocaleString()}円）が目標額（${target.toLocaleString()}円）を超えています`);
  }
  return errors;
}

function validateExpense() {
  const without = $('input[name="receipt-mode"]:checked').value === "without";
  let errors = [];
  if (without) {
    errors = validateReceiptCard(noReceiptCard, "領収書なし支出", true);
    if (!$(".r-noreceipt-reason", noReceiptCard).value.trim()) {
      errors.push("証明できない理由が未入力です");
    }
  } else {
    if (receipts.length === 0) errors = ["領収書ファイルが選択されていません"];
    receipts.forEach((r, i) => {
      if (r.done) return; // 送信済みの領収書は再検証しない
      errors = errors.concat(validateReceiptCard(r.card, `領収書${i + 1}（${r.file.name}）`));
      if (r.completed) {
        errors.push(`領収書${i + 1}（${r.file.name}）: 既に登録が完了しているため送信できません`);
      } else if (r.duplicate) {
        const total = Number($(".r-total", r.card).value || 0);
        if (total > 0 && total !== r.duplicate.receiptTotal) {
          errors.push(
            `領収書${i + 1}（${r.file.name}）: 領収書全体の金額が登録済みの金額` +
            `（${Number(r.duplicate.receiptTotal).toLocaleString()}円）と一致しません`);
        }
      }
    });
  }
  $("#submit-expense").disabled = errors.length > 0;
  return errors;
}

function receiptPayload(card) {
  return {
    purchaseDate: $(".r-date", card).value,
    buyerName: $(".r-buyer", card).value.trim(),
    vendor: $(".r-vendor", card).value.trim(),
    paymentMethodId: $(".r-payment", card).value,
    receiptTotal: Number($(".r-total", card).value || 0),
    discount: $(".r-discount", card) ? Number($(".r-discount", card).value || 0) : 0,
    uses: collectUses(card),
  };
}

$("#submit-expense").addEventListener("click", async () => {
  const btn = $("#submit-expense");
  // 照会の完了を待つ間に連打されると二重送信になるため、最初に無効化する
  if (btn.disabled) return;
  btn.disabled = true;
  btn.classList.add("loading");
  const without0 = $('input[name="receipt-mode"]:checked').value === "without";
  if (!without0) {
    // 送信直前に重複照会を取り直す（ファイル選択後に登録状況が
    // 変わっていると、古い照会結果では弾けないため）
    await Promise.all(receipts.filter((r) => !r.done).map((r) => checkDuplicateReceipt(r)));
  }
  const errors = validateExpense();
  if (errors.length) {
    showMessage(errors.join("\n"), "error");
    btn.disabled = false;
    btn.classList.remove("loading");
    return;
  }
  if (without0) {
    const payload = {
      clientRequestId: crypto.randomUUID(),
      kind: "expense",
      submittedAt: new Date().toISOString(),
      receipts: [{
        ...receiptPayload(noReceiptCard),
        file: null,
        proofImpossible: true,
        proofImpossibleReason: $(".r-noreceipt-reason", noReceiptCard).value.trim(),
      }],
    };
    await submitPayload(payload, btn);
    return;
  }
  // 領収書は1件ずつ個別に送信する。途中で失敗しても成功分は「送信済み」として
  // 残り、失敗分だけを直して再送信できる（まとめて送ると部分コミットが起き、
  // 成功分の再送が「登録完了済み」で阻害されるため）。
  btn.classList.add("loading");
  btn.disabled = true;
  const failed = [];
  let sentCount = 0;
  try {
    for (const r of receipts) {
      if (r.done) {
        sentCount++;
        continue;
      }
      const payload = {
        clientRequestId: crypto.randomUUID(),
        kind: "expense",
        submittedAt: new Date().toISOString(),
        receipts: [{
          ...receiptPayload(r.card),
          file: {
            name: r.file.name,
            mimeType: r.file.type,
            sha256: r.hash,
            base64: await blobToBase64(r.file),
          },
          proofImpossible: false,
        }],
      };
      showPayload(payload);
      try {
        const res = await fetch(API_BASE + "/api/submit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok) {
          r.done = true;
          sentCount++;
          const txid = data.receipts && data.receipts[0] ? data.receipts[0].transactionId : "";
          const note = $(".done-notice", r.card);
          if (note) {
            note.hidden = false;
            note.textContent = `送信済み${txid ? `（取引ID: ${txid}）` : ""}。この領収書は再送信されません。`;
          }
          $$("input, select, textarea, button", r.card).forEach((el) => { el.disabled = true; });
        } else {
          failed.push(`${r.file.name}: ${data.error || res.status}`);
        }
      } catch (e) {
        failed.push(`${r.file.name}: APIに接続できませんでした`);
      }
    }
  } finally {
    btn.classList.remove("loading");
    btn.disabled = false;
  }
  if (failed.length === 0) {
    showMessage(`報告が完了しました（領収書 ${sentCount} 件）。`, "success");
    resetForms();
  } else if (sentCount > 0) {
    showMessage(
      "一部の領収書を送信できませんでした。送信済みの領収書はそのまま残っています。直して再送信してください。\n" +
      failed.join("\n"),
      "error"
    );
  } else {
    showMessage("送信に失敗しました:\n" + failed.join("\n"), "error");
  }
  validateExpense();
});

// ---------- 収入 ----------

const incomeSubjectSel = $("#income-subject");
incomeSubjectSel.innerHTML = optionsHtml(INCOME_SUBJECTS, "選択してください");
incomeSubjectSel.addEventListener("change", () => {
  const subject = INCOME_SUBJECTS.find((s) => s.id === incomeSubjectSel.value);
  $("#income-detail-field").hidden = !(subject && subject.requiresDetail);
  validateIncome();
});
$("#income-amount").addEventListener("input", validateIncome);
$("#income-detail").addEventListener("input", validateIncome);

function validateIncome() {
  const subject = INCOME_SUBJECTS.find((s) => s.id === incomeSubjectSel.value);
  const amount = Number($("#income-amount").value || 0);
  let ok = !!subject && amount > 0 && Number.isInteger(amount);
  if (ok && subject.requiresDetail) ok = $("#income-detail").value.trim().length > 0;
  $("#submit-income").disabled = !ok;
  return ok;
}
validateIncome();
validateExpense();

$("#submit-income").addEventListener("click", async () => {
  if (!validateIncome()) return;
  const payload = {
    clientRequestId: crypto.randomUUID(),
    kind: "income",
    submittedAt: new Date().toISOString(),
    subjectId: incomeSubjectSel.value,
    amount: Number($("#income-amount").value || 0),
    detail: $("#income-detail").value.trim(),
  };
  await submitPayload(payload, $("#submit-income"));
});

function resetForms() {
  receipts.length = 0;
  $("#receipt-list").innerHTML = "";
  $$("input, select, textarea", noReceiptCard).forEach((el) => { el.value = ""; });
  $$(".use-block", noReceiptCard).forEach((b, i) => { if (i > 0) b.remove(); });
  incomeSubjectSel.value = "";
  $("#income-amount").value = "";
  $("#income-detail").value = "";
  $("#income-detail-field").hidden = true;
  validateExpense();
  validateIncome();
}

// ---------- 送信 ----------

async function submitPayload(payload, btn) {
  showPayload(payload); // 皮の段階では常にペイロードを確認できるようにする
  if (btn) {
    btn.classList.add("loading");
    btn.disabled = true;
  }
  try {
    const res = await fetch(API_BASE + "/api/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) {
      showMessage(
        data.mock
          ? `受け付けました（モック応答）。申請ID: ${data.applicationId}\n※まだ台帳には記録されていません。GAS接続後に有効になります。`
          : `報告が完了しました。申請ID: ${data.applicationId}`,
        "success"
      );
      resetForms();
    } else {
      showMessage(`送信に失敗しました: ${data.error || res.status}`, "error");
    }
  } catch (e) {
    showMessage(
      "APIに接続できませんでした（ローカルプレビュー中は正常です）。送信ペイロードは下部に表示されています。",
      "error"
    );
  } finally {
    if (btn) {
      btn.classList.remove("loading");
      // disabled は検証結果に基づいて戻す (成功時はリセット済みフォームで再判定される)
      validateExpense();
      validateIncome();
    }
  }
}
