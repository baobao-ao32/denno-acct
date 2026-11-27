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
//   GAS_ENDPOINT       GAS Web App の /exec URL
//   API_TOKEN          GAS の Script Properties の API_TOKEN と同じ値
//   ACCESS_TEAM_DOMAIN (本番) Cloudflare Access のチームドメイン (例: yourteam.cloudflareaccess.com)
//   ACCESS_AUD         (本番) Access アプリケーションの AUD タグ
//   ADMIN_EMAILS       (本番・任意) 管理APIを許可するメールアドレス (カンマ区切り)
// ACCESS_* を設定すると /api/admin/* は Access JWT の署名検証を必須にする。

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

function isValidClientRequestId(v) {
  // 申請IDは台帳にそのまま書かれるため、安全な文字種だけに制限する (GAS側と同一ルール)
  return typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
}

function validatePayload(p) {
  if (!p || typeof p !== "object") return "payload is not an object";
  if (!isValidClientRequestId(p.clientRequestId)) return "clientRequestId is invalid";
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

// ---- Cloudflare Access の JWT 検証 (管理APIの二重認可) ----
// Access のパス別ポリシーだけに頼らず、Functions 側でも署名付き JWT を検証する。
// これにより、ポリシーのパス照合をすり抜けるような経路や、保護対象外の
// デプロイ URL から叩かれても、管理APIは安全側に倒れる。
// 環境変数 ACCESS_TEAM_DOMAIN / ACCESS_AUD が未設定の間 (テスト期間) は検証を
// 行わない。本番切替時は必ず設定すること (手順書参照)。

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

let jwksCache = { keys: null, fetchedAt: 0 };

async function accessPublicKey(env, kid) {
  if (!jwksCache.keys || Date.now() - jwksCache.fetchedAt > 10 * 60 * 1000) {
    const res = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
    if (!res.ok) return null;
    const jwks = await res.json();
    jwksCache = { keys: jwks.keys || [], fetchedAt: Date.now() };
  }
  const jwk = jwksCache.keys.find((k) => k.kid === kid);
  if (!jwk) return null;
  return crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
}

async function verifyAccessJwt(env, request) {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
  } catch {
    return null;
  }
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(env.ACCESS_AUD)) return null;
  if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;
  if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
  const key = await accessPublicKey(env, header.kid);
  if (!key) return null;
  const ok = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    b64urlToBytes(parts[2]),
    new TextEncoder().encode(parts[0] + "." + parts[1])
  );
  return ok ? payload : null;
}

/** 管理APIの認可。許可なら { email }、拒否なら null を返す。 */
async function adminActor(env, request) {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return { email: "" };
  const payload = await verifyAccessJwt(env, request);
  if (!payload) return null;
  const email = payload.email || "";
  if (env.ADMIN_EMAILS) {
    const allowed = env.ADMIN_EMAILS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!allowed.includes(email.toLowerCase())) return null;
  }
  return { email };
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  // パスの正規化はしない。// を含むような不正なパスは、Access のパス照合を
  // すり抜ける経路になり得るため、そのまま 404 で落とす。
  if (url.pathname.includes("//")) {
    return json({ ok: false, error: "not found" }, 404);
  }

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
    if (!isValidClientRequestId(clientRequestId)) return json({ ok: false, error: "clientRequestId is invalid" }, 400);
    if (!env.GAS_ENDPOINT) return json({ ok: true, mock: true, found: false });
    return forwardToGas(env, { action: "status", clientRequestId });
  }

  // 管理用 (会計担当のみ)。Cloudflare Access のパス別ポリシーに加えて、
  // Functions 側でも Access JWT を検証する二重認可 (adminActor)。
  // 操作者のメールは GAS へ渡し、APIログ に監査記録として残す。
  if (url.pathname.startsWith("/api/admin/") && request.method === "POST") {
    const actor = await adminActor(env, request);
    if (!actor) return json({ ok: false, error: "forbidden" }, 403);
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
      return forwardToGas(env, { action: "recompute", fiscalYear: fy, actorEmail: actor.email });
    }
    if (url.pathname === "/api/admin/void") {
      if (!isNonEmptyString(body.transactionId)) return json({ ok: false, error: "transactionId is required" }, 400);
      if (!isNonEmptyString(body.reason)) return json({ ok: false, error: "reason is required" }, 400);
      return forwardToGas(env, { action: "void", transactionId: body.transactionId, reason: body.reason, actorEmail: actor.email });
    }
    if (url.pathname === "/api/admin/toggle-settled") {
      if (!isNonEmptyString(body.transactionId)) return json({ ok: false, error: "transactionId is required" }, 400);
      return forwardToGas(env, { action: "toggleSettled", transactionId: body.transactionId, actorEmail: actor.email });
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
