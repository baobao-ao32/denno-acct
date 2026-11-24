// 電脳サークル会計 v2 — Cloudflare Worker (BFF)
// 役割: ブラウザからの提出を受け、APIトークンを付けて GAS Web App へ転送する。
// トークンは Worker の Secret (API_TOKEN) に置き、ブラウザ側には露出させない。
// GAS_ENDPOINT が未設定の間はモック応答を返す（フォームの皮の確認用）。

const MAX_RECEIPTS = 5;
const MAX_USES = 10;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function validateUse(u) {
  return (
    u &&
    isNonEmptyString(u.name) &&
    Number.isFinite(u.amount) && u.amount > 0 &&
    isNonEmptyString(u.categoryId) &&
    isNonEmptyString(u.subjectId) &&
    isNonEmptyString(u.itemName)
  );
}

function validatePayload(p) {
  if (!p || typeof p !== "object") return "payload is not an object";
  if (!isNonEmptyString(p.clientRequestId)) return "clientRequestId is required";
  if (p.kind === "income") {
    if (!isNonEmptyString(p.subjectId)) return "subjectId is required";
    if (!Number.isFinite(p.amount) || p.amount <= 0) return "amount must be positive";
    if (p.subjectId === "other_income" && !isNonEmptyString(p.detail)) {
      return "detail is required for other_income";
    }
    return null;
  }
  if (p.kind === "expense") {
    if (!Array.isArray(p.receipts) || p.receipts.length === 0) return "receipts is required";
    if (p.receipts.length > MAX_RECEIPTS) return `too many receipts (max ${MAX_RECEIPTS})`;
    for (const r of p.receipts) {
      if (!isNonEmptyString(r.purchaseDate)) return "purchaseDate is required";
      if (!isNonEmptyString(r.buyerName)) return "buyerName is required";
      if (!isNonEmptyString(r.paymentMethodId)) return "paymentMethodId is required";
      if (!Number.isFinite(r.receiptTotal) || r.receiptTotal <= 0) return "receiptTotal must be positive";
      if (!Array.isArray(r.uses) || r.uses.length === 0) return "uses is required";
      if (r.uses.length > MAX_USES) return `too many uses (max ${MAX_USES})`;
      if (!r.uses.every(validateUse)) return "invalid use entry";
      const sum = r.uses.reduce((a, u) => a + u.amount, 0);
      if (sum !== r.receiptTotal) return "use amounts do not sum to receiptTotal";
      if (r.proofImpossible) {
        if (!isNonEmptyString(r.proofImpossibleReason)) return "proofImpossibleReason is required";
      } else if (!r.file || !isNonEmptyString(r.file.sha256) || !isNonEmptyString(r.file.base64)) {
        return "receipt file is required";
      }
    }
    return null;
  }
  return "unknown kind";
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return json({ ok: true, gasConnected: Boolean(env.GAS_ENDPOINT) });
    }

    if (url.pathname === "/api/submit" && request.method === "POST") {
      let payload;
      try {
        payload = await request.json();
      } catch {
        return json({ ok: false, error: "invalid JSON" }, 400);
      }
      const error = validatePayload(payload);
      if (error) return json({ ok: false, error }, 400);

      if (!env.GAS_ENDPOINT) {
        // GAS未接続: モック応答。フォームの動作確認専用で、台帳には何も書かれない。
        return json({ ok: true, mock: true, applicationId: `mock-${payload.clientRequestId.slice(0, 8)}` });
      }

      const res = await fetch(env.GAS_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.API_TOKEN}`,
        },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      return json(data, res.ok ? 200 : 502);
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};
