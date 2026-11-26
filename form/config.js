// denno-acct v2 — 共通設定 (報告フォームと管理ページで共有)

// API の接続先。API は同一オリジンの Pages Functions (form/functions/api/)
// で動くため、常に "" (相対パス) でよい。デプロイ時の書き換えは不要。
// 旧構成 (独立 Worker を workers.dev で呼ぶ方法B) は、無認証で迂回可能な
// 公開エンドポイントになるため 2026-11-26 に廃止した。
export const API_BASE = "".replace(/\/+$/, ""); // 末尾の "/" は自動で取り除く（URLが "//api/..." になると 404 になるため）
