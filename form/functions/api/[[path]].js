// 電脳サークル会計 v2 — Cloudflare Pages Functions (BFF)
// 役割: ブラウザからの提出を受け、APIトークンを付けて GAS Web App へ転送する。
// トークンは Pages プロジェクトの環境変数 (Secret) に置き、ブラウザには露出させない。
// GAS_ENDPOINT が未設定の間はモック応答を返す（フォームの皮の確認用）。
//
// 配置 (2026-11-26 外部レビュー3-1 を受けて Worker から移行):
// フォームと同じ Pages プロジェクト内に置くことで API が同一オリジンになり、
// Pages にかける Cloudflare Access の保護対象に /api/* も含められる。
// 独立した workers.dev の公開エンドポイントと CORS "*" は廃止した。
// 必要な環境変数 (Pages プロジェクトの Settings → Environment variables):
//   GAS_ENDPOINT  GAS Web App の /exec URL
//   API_TOKEN     GAS の Script Properties の API_TOKEN と同じ値

const MAX_RECEIPTS = 5;
const MAX_USES = 10;
const ALLOWED_FILE_TYPES = ["image/jpeg", "image/png", "application/pdf"];
const MAX_FILE_BASE64_LENGTH = 14000000; // 約10MB (Base64 は元データの約4/3倍)

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
    Number.isInteger(u.amount) && u.amount > 0 &&
    isNonEmptyString(u.categoryId) &&
    isNonEmptyString(u.subjectId) &&
    isNonEmptyString(u.itemName)
  );
}

function isValidDateString(v) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function validateFile(f) {
  if (!f || !isNonEmptyString(f.sha256) || !isNonEmptyString(f.base64)) {
    return "receipt file is required";
  }
  if (!ALLOWED_FILE_TYPES.includes(f.mimeType)) return "unsupported file type";
  if (!isNonEmptyString(f.name) || /[\/\\]/.test(f.name) || f.name.includes("..")) {
    return "invalid file name";
  }
  if (f.base64.length > MAX_FILE_BASE64_LENGTH) return "file too large";
  return null;
}

function validatePayload(p) {
  if (!p || typeof p !== "object") return "payload is not an object";
  if (!isNonEmptyString(p.clientRequestId)) return "clientRequestId is required";
  if (p.kind === "income") {
    if (!isNonEmptyString(p.subjectId)) return "subjectId is required";
    if (!Number.isInteger(p.amount) || p.amount <= 0) return "amount must be a positive integer";
    if (p.subjectId === "other_income" && !isNonEmptyString(p.detail)) {
      return "detail is required for other_income";
    }
    return null;
  }
  if (p.kind === "expense") {
    if (!Array.isArray(p.receipts) || p.receipts.length === 0) return "receipts is required";
    if (p.receipts.length > MAX_RECEIPTS) return `too many receipts (max ${MAX_RECEIPTS})`;
    for (const r of p.receipts) {
      if (!isValidDateString(r.purchaseDate)) return "purchaseDate must be a valid YYYY-MM-DD date";
      if (!isNonEmptyString(r.buyerName)) return "buyerName is required";
      if (!isNonEmptyString(r.vendor)) return "vendor is required";
      if (!isNonEmptyString(r.paymentMethodId)) return "paymentMethodId is required";
      if (!Number.isInteger(r.receiptTotal) || r.receiptTotal <= 0) return "receiptTotal must be a positive integer";
      if (!Array.isArray(r.uses) || r.uses.length === 0) return "uses is required";
      if (r.uses.length > MAX_USES) return `too many uses (max ${MAX_USES})`;
      if (!r.uses.every(validateUse)) return "invalid use entry";
      const sum = r.uses.reduce((a, u) => a + u.amount, 0);
      const discount = r.discount == null ? 0 : r.discount;
      // 按分で各用途に1円以上残すため、値引きの上限は 合計 - 用途数
      if (!Number.isInteger(discount) || discount < 0 || discount > sum - r.uses.length) {
        return "invalid discount";
      }
      // 完全一致は GAS が取引単位で検証する (分割提出の追記があるため、ここでは超過のみ弾く)
      if (sum - discount > r.receiptTotal) return "use amounts exceed receiptTotal";
      if (r.proofImpossible) {
        if (!isNonEmptyString(r.proofImpossibleReason)) return "proofImpossibleReason is required";
      } else {
        const fileError = validateFile(r.file);
        if (fileError) return fileError;
      }
    }
    return null;
  }
  return "unknown kind";
}

async function forwardToGas(env, payload) {
  // GAS の doPost は HTTP ヘッダを読めないため、トークンはボディに入れる
  const res = await fetch(env.GAS_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ...payload, token: env.API_TOKEN }),
  });
  // GAS は異常時にも HTTP 200 で HTML エラーページを返すことがある。
  // JSON として読めない応答は握りつぶさず、502 として明示的に返す。
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return json({ ok: false, error: "GAS returned an invalid response" }, 502);
  }
  return json(data, res.ok ? 200 : 502);
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  url.pathname = url.pathname.replace(/\/{2,}/g, "/"); // "//api/submit" のような指定ミスを吸収する

  if (url.pathname === "/api/health") {
    return json({ ok: true, gasConnected: Boolean(env.GAS_ENDPOINT) });
  }

  // 領収書ファイルの事前照会 (登録済みなら用途の追記になる)
  if (url.pathname === "/api/receipts/check" && request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "invalid JSON" }, 400);
    }
    if (!/^[0-9a-f]{64}$/.test(body.sha256 || "")) {
      return json({ ok: false, error: "sha256 must be 64 hex chars" }, 400);
    }
    if (!env.GAS_ENDPOINT) return json({ ok: true, mock: true, exists: false });
    return forwardToGas(env, { action: "checkReceipt", sha256: body.sha256 });
  }

  // 提出の状態照会
  if (url.pathname === "/api/status" && request.method === "GET") {
    const clientRequestId = url.searchParams.get("clientRequestId");
    if (!clientRequestId) return json({ ok: false, error: "clientRequestId is required" }, 400);
    if (!env.GAS_ENDPOINT) return json({ ok: true, mock: true, found: false });
    return forwardToGas(env, { action: "status", clientRequestId });
  }

  // 管理用 (会計担当のみ。アクセス制御は Pages 側の Cloudflare Access で行う)
  if (url.pathname.startsWith("/api/admin/") && request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "invalid JSON" }, 400);
    }
    if (!env.GAS_ENDPOINT) return json({ ok: false, error: "GAS not connected" }, 503);
    if (url.pathname === "/api/admin/recompute") {
      const fy = Number(body.fiscalYear);
      if (!Number.isInteger(fy) || fy < 2000 || fy > 2100) {
        return json({ ok: false, error: "fiscalYear is invalid" }, 400);
      }
      return forwardToGas(env, { action: "recompute", fiscalYear: fy });
    }
    if (url.pathname === "/api/admin/void") {
      if (!isNonEmptyString(body.transactionId)) return json({ ok: false, error: "transactionId is required" }, 400);
      if (!isNonEmptyString(body.reason)) return json({ ok: false, error: "reason is required" }, 400);
      return forwardToGas(env, { action: "void", transactionId: body.transactionId, reason: body.reason });
    }
    if (url.pathname === "/api/admin/toggle-settled") {
      if (!isNonEmptyString(body.transactionId)) return json({ ok: false, error: "transactionId is required" }, 400);
      return forwardToGas(env, { action: "toggleSettled", transactionId: body.transactionId });
    }
    return json({ ok: false, error: "not found" }, 404);
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

    return forwardToGas(env, payload);
  }

  return json({ ok: false, error: "not found" }, 404);
}
