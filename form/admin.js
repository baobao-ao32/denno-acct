// denno-acct v2 — 会計管理ページ (再計算・取消・精算状態の変更)
import { API_BASE } from "./config.js";

const $ = (s, r) => (r || document).querySelector(s);

function showMessage(text, kind) {
  const el = $("#message");
  el.textContent = text || "";
  el.className = kind || "";
}

async function callAdmin(path, body, button) {
  button.disabled = true;
  button.classList.add("loading");
  try {
    const res = await fetch(API_BASE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || "失敗しました");
    return data;
  } finally {
    button.disabled = false;
    button.classList.remove("loading");
  }
}

$("#do-recompute").addEventListener("click", async (ev) => {
  const fy = Number($("#recompute-year").value || 0);
  if (!Number.isInteger(fy) || fy < 2000 || fy > 2100) {
    showMessage("年度を正しく入力してください。", "error");
    return;
  }
  try {
    await callAdmin("/api/admin/recompute", { fiscalYear: fy }, ev.currentTarget);
    showMessage(`${fy}年度の集計を再計算しました。`, "ok");
  } catch (e) {
    showMessage("再計算に失敗しました: " + e.message, "error");
  }
});

$("#do-void").addEventListener("click", async (ev) => {
  const transactionId = $("#void-transaction").value.trim();
  const reason = $("#void-reason").value.trim();
  if (!transactionId) {
    showMessage("取引IDを入力してください。", "error");
    return;
  }
  if (!reason) {
    showMessage("取消理由を入力してください。", "error");
    return;
  }
  if (!confirm(`取引 ${transactionId} を取り消します。よろしいですか？`)) return;
  try {
    const data = await callAdmin("/api/admin/void", { transactionId, reason }, ev.currentTarget);
    showMessage(`取引 ${transactionId} を取り消しました（${data.voided} 行）。`, "ok");
  } catch (e) {
    showMessage("取消に失敗しました: " + e.message, "error");
  }
});

$("#do-toggle").addEventListener("click", async (ev) => {
  const transactionId = $("#toggle-transaction").value.trim();
  if (!transactionId) {
    showMessage("取引IDを入力してください。", "error");
    return;
  }
  try {
    const data = await callAdmin("/api/admin/toggle-settled", { transactionId }, ev.currentTarget);
    showMessage(`取引 ${transactionId} の精算状態を「${data.settled}」にしました。`, "ok");
  } catch (e) {
    showMessage("精算状態の変更に失敗しました: " + e.message, "error");
  }
});
