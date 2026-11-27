# Third-party notices — form/vendor/

## heic2any.min.js

HEIC/HEIF 画像のブラウザ側 JPEG 変換に使う。npm パッケージ heic2any 0.0.4 の
`dist/heic2any.min.js` を無改変で同梱している。

真正なファイルの SHA-256 (npm 配布物の値):
`0963cfa50e9e1e7e6af929a40a81e3e898a673f1270eafa6917dd137e4968164`
2026-11-27 に配置し、同梱ファイルの SHA-256 がこの値と一致することを確認済み。

このファイルは複数のライセンスのコンポーネントを含む:

- **heic2any** — MIT License. Copyright (c) 2020 Alex Corvi.
  https://github.com/alexcorvi/heic2any
- **libheif** (JS にコンパイルされ同梱) — GNU Lesser General Public License v3.0 (LGPL-3.0).
  Copyright struktur AG and contributors.
  ソース: https://github.com/strukturag/libheif
- **libde265** (libheif の HEVC デコーダ、同梱) — LGPL-3.0.
  Copyright struktur AG and contributors.
  ソース: https://github.com/strukturag/libde265
- **gifshot** — MIT License. Copyright (c) 2017 Yahoo Inc.

LGPL-3.0 について: 本プロジェクトでは libheif / libde265 を無改変のまま、
独立したファイル (このフォルダの heic2any.min.js) として読み込む。
利用者は上記ソースから自らビルドした版に差し替えることができる。
ライセンス全文: https://www.gnu.org/licenses/lgpl-3.0.html
（LGPL-3.0 は GPL-3.0 https://www.gnu.org/licenses/gpl-3.0.html を前提とする）
