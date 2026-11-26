// 廃止 (2026-11-26): 独立 Worker は Pages Functions へ移行した。
// 実装は form/functions/api/[[path]].js にある。
//
// 理由 (外部レビュー3-1): workers.dev の公開 URL が分かれば無認証で API を
// 叩けてしまい、Pages 側に Cloudflare Access をかけても迂回される。
// Pages Functions ならフォームと同一オリジンになり、/api/* も Access の
// 保護対象に含められる (独自ドメイン費用もゼロのまま)。
// このファイルは履歴として残しているだけで、デプロイ対象ではない。
