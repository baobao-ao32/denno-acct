// denno-acct v2 — 共通設定 (報告フォームと管理ページで共有)

// API の接続先 (方法B: ドメイン無し)。Worker をデプロイしたら、その
// workers.dev URL をここに入れる。例: "https://denno-acct-api.example.workers.dev"
// "" のままなら同一オリジンの相対パスで呼ぶ (方法A: 独自ドメイン構成用)。
// デプロイ時に書き換えるのはこのファイルだけ。
export const API_BASE = "".replace(/\/+$/, ""); // 末尾の "/" は自動で取り除く（URLが "//api/..." になると Worker が 404 を返すため）
