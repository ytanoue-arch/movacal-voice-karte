# 音声カルテ（MOVACAL）v2 — iPhone/iPad PWA + ブックマークレット + Cloud Run

MOVACALのカルテを開いた状態でブックマークレットをタップ → 患者ID（ORCA ID）を引き継いで音声アプリ起動 →
口述を録音 → Gemini が **SOAP形式（主観/客観/評価/計画）** に整形 → ポップアップで編集 →
**コピー** または **メモ / カルテ本文へ API 自動登録**。実行後は端末上の下書きを削除します。

## なぜブックマークレットか（iOSの制約）

iPhone/iPad の Safari には拡張機能がなく、別オリジンのWebアプリ/PWAから**他ページ（MOVACAL）のDOMや患者IDを読み取ることはできません**。
唯一の手段が**ブックマークレット**で、これは「開いているMOVACALページのコンテキスト」で動くため患者IDを取得できます。
書き戻し（メモ/カルテ登録）はDOM操作ではなく **WebAPI** で行うので、患者IDさえ取得できれば自動登録できます。

```
MOVACAL カルテ画面 (Safari)
   │  ブックマークレットをタップ（ORCA ID を読み取り）
   ▼
音声カルテ PWA  …  /?orcaId=XXXX
   │  録音(audio/mp4)→Base64
   ▼
Cloud Run (Node/Express)
   ├─ GET  /api/config    認証方式の通知
   ├─ POST /api/dictate   Gemini で SOAP 整形 → { note }
   └─ POST /api/register  target=karte → postDiagObjective.php
                          target=memo  → postMemo.php
```

## セキュリティ / チーム利用（Google Workspace）

- 既定は **Google Workspace ドメイン制限のサインイン**。フロントは Google Identity Services でサインインし、ID トークンをサーバーが検証。`hd`（ドメイン）と任意のメール許可リストで制御します。GWS を共有するチーム全員がそのまま使えます。
- セットアップ用に**共有トークン**（`APP_TOKEN`）のフォールバックも用意。
- メモ登録の記録者名・監査ログにはサインインしたユーザーを使用（本文は記録しません）。
- セキュリティヘッダ（CSP/nosniff/Referrer-Policy 等）と HTTPS 必須。
- **PHI の取り扱い**：音声は文字起こし後に保持しません。整形結果は端末メモリのみで、コピー/登録の完了・破棄で削除（localStorage 等に保存しません）。サーバーは本文をログに残しません。
- **本番のさらなる強化**：Cloud Run 前段に Identity-Aware Proxy(IAP) を置き、Workspace のグループ/ドメインで制御。秘密情報は Secret Manager（`deploy.sh` 末尾参照）。

## セットアップ

```bash
cp .env.example .env   # 値を埋める（Google認証 or APP_TOKEN）
npm install
npm start              # http://localhost:8080
```

### Google サインインの準備（推奨）

1. Google Cloud コンソール → 認証情報 → **OAuth クライアント ID（ウェブ）** を作成。
2. 「承認済みの JavaScript 生成元」に Cloud Run の URL（`https://xxx.run.app`）を追加。
3. 取得したクライアントIDを `.env` の `GOOGLE_CLIENT_ID` に、施設ドメインを `ALLOWED_HD` に設定。

## デプロイ（Cloud Run / asia-northeast1）

```bash
./deploy.sh
```

- 認証方式（Google / token / open）はサーバーの env から自動判定し、フロントへ通知します。
- `.gcloudignore` は `.env` を除外（秘密はイメージに焼かない）。

## iPhone / iPad で使う

1. デプロイ後の URL の **`/setup.html`** を Safari で開き、表示されるブックマークレットを登録（手順はページに記載）。
2. MOVACAL でカルテを開く → ブックマーク「音声カルテ」をタップ。
3. 初回は Google サインイン。録音同意にチェック → 録音（マイク許可が必要。iOS設定アプリ側の許可も確認）。
4. ポップアップで内容を確認・編集 → 「カルテ本文」か「メモ」を選んで登録、または「コピー」。
5. 「ホーム画面に追加」でアプリ化も可能。

## 患者IDが取得できない場合

MOVACAL のカルテ URL に `orca_id=…` が含まれていれば自動取得します。含まれない画面構成なら、`public/setup.html` 内のブックマークレットの読み取り箇所（DOMセレクタ）を実画面に合わせて調整してください。それまではアプリ側で ID を手入力できます。

## 全診療所対応（マルチクリニック）

- 認証（`MOVACAL_PROVIDER` / `MOVACAL_PASSWORD` / `MOVACAL_PRIVATE_KEY`）は**全院共通**。呼び出しごとに `clinic_id` / `clinic_code` を切り替えます。
- 各院の対応表は **`clinics.json`**（サーバー側のみ）で管理します。`id` と `code` の両方が埋まった院だけがアプリの診療所セレクタに出ます。
- 確認済み8院（日吉/武蔵小杉/登米/白石/大崎/栗原/名取/郡山）は記入済み。残り（一関/仙台北/あゆみ仙台/高知/訪問看護）は MOVACAL から連絡されている `clinic_id` / `clinic_code` を `clinics.json` に追記してください。
- **セキュリティ**：`clinic_code` はサーバー側でのみ保持し、ブラウザには診療所名と ID しか返しません（`/api/clinics`）。登録時もクライアントから来た code は信頼せず、サーバーが ID から引き直します。
- env で渡したい場合は `CLINICS_JSON`（JSON文字列）で上書き可。Secret Manager にも載せられます。
- まず1院（日吉）で疎通確認 → 問題なければ各院コードを足して展開、が安全です。

## カルテ書式（SOAP）の調整

`server.js` の `FORMAT_PROMPT` に S/O/A/P の定義があります。頻出薬剤名・施設定型を足すと精度が上がります。

## トラブルシューティング

- **録音不可**：HTTPSか、Safari と iOS設定アプリのマイク許可を確認。録音はボタン押下起点が必須。
- **整形が空/失敗**：`GEMINI_API_KEY` / `GEMINI_MODEL` を確認（Dockerfile でモデル固定済み）。
- **サインインできない**：`GOOGLE_CLIENT_ID` と OAuth の「承認済み生成元」、`ALLOWED_HD` を確認。
- **403**：許可ドメイン/メール外のアカウント。`ALLOWED_HD` / `ALLOWED_EMAILS` を確認。
- **登録 401（MOVACAL）**：`credential.php` の署名は既存 Python 実装の移植。動作中の shoruibox/prescription 系と key/message を突き合わせ。必要なら `MOVACAL_BASIC_AUTH`。
- **登録 400**：`orca_id` / `clinic_*` / `diag_type`（カルテ）または `user_name` 必須（メモ）を確認。
