# 音声カルテ（MOVACAL Voice Karte）

医師がiPhone/iPadで口述すると、AIが整形してMOVACALのカルテ・メモに書き込むWebアプリ（PWA）。

- 本番URL: https://movacal-voice-karte-fllm266yfa-an.a.run.app
- 配置先: Google Cloud Run（プロジェクト `movacal-shuunou` / リージョン `asia-northeast1`）
- 認証: Google Workspace（`@yamato-clinic.org` のみ）
- AI: Vertex AI（東京リージョン、APIキー不要。Cloud Run のサービスアカウントで認証）

## 構成

| ファイル | 役割 |
|---|---|
| `server.js` | APIサーバー。認証、Gemini整形、MOVACAL書き込みの振り分け |
| `movacal.js` | MOVACAL WebAPIクライアント（認証・カルテ取得・追記・メモ登録） |
| `public/app.js` | 画面のロジック（録音、ログイン、診療所選択、登録） |
| `public/index.html` / `style.css` | 画面 |
| `public/setup.js` | ブックマークレット生成（患者ID・診療所の自動取得） |
| `clinics.json` | 全診療所のID・コード（**機密・リポジトリには無い**） |
| `user-clinics.json` | ユーザーごとの既定診療所（**リポジトリには無い**） |

## できること

1. 録音 → Geminiが文字起こし＆プロブレムリスト形式（`# 問題名` / `内容：` / `方針：`）に整形
2. 画面で内容を確認・修正
   - 口述の冒頭で「仙台北の、ID 00986の患者です」と話すと、診療所と患者IDを自動で読み取る
   - 登録前に `getPatient.php` で患者を照会し、氏名・年齢・性別を表示（該当なし・未確認・画面と音声の食い違いがある間は登録不可）
3. 書き込み先を選んでMOVACALへ登録
   - **カルテ本文** … その日の既存カルテの `A/P)` の直後に追記（診察完了のカルテには追記しない）
   - **メモ** … メモとして登録（登録者名は「やまと音声カルテ」）
   - **オンコール** … オンコールメモ（診療タイプ48）として新規カルテ作成

## 開発（MOCKモード）

> 修正の進め方・どこを直せば何が変わるかは **[DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md)** を参照してください。

**認証情報は不要です。** MOVACALにもGeminiにも接続せず、ダミー応答で画面を一通り動かせます。

```bash
npm install
MOCK=1 npm start
# → http://localhost:8080 を開く
```

MOCKモードでの挙動:

- ログイン不要（そのまま画面が出ます）
- 診療所は `clinics.example.json` の12院（コードはダミー）
- 録音ボタンを押すと、固定のサンプル文が返ります（実際の音声は解析しません）
- 「登録して実行」は成功応答を返すだけで、MOVACALには**一切書き込みません**
- ORCA IDに `9999` を入れて「カルテ本文」で登録すると、「診察完了で追記できない」エラー画面を確認できます

## 本番デプロイ（管理者のみ）

⚠️ `bash deploy.sh` は**使わないでください**（環境変数が消えます）。

```bash
gcloud run deploy movacal-voice-karte \
  --project movacal-shuunou \
  --source . \
  --region asia-northeast1 \
  --allow-unauthenticated
```

`--project` は必須です（省略すると別プロジェクトに新しいサービスが作られます）。
環境変数のフラグを付けなければ既存の設定は保持されます。個別に変えるときは:

```bash
gcloud run services update movacal-voice-karte \
  --project movacal-shuunou --region asia-northeast1 \
  --update-env-vars 'KEY=VALUE'
```

## 主な環境変数

| 変数 | 用途 |
|---|---|
| `VERTEX_PROJECT` | Vertex AI のプロジェクト（本番は `movacal-shuunou`）。**必須** |
| `VERTEX_LOCATION` | Vertex AI のリージョン（既定 `asia-northeast1`＝東京） |
| `GEMINI_MODEL` | 整形に使うモデル（既定 `gemini-2.5-flash`） |
| `USE_VERTEX` / `GEMINI_API_KEY` | 緊急用。`USE_VERTEX=0` のときだけAPIキー方式で動く |
| `GOOGLE_CLIENT_ID` / `ALLOWED_HD` | Googleサインインと許可ドメイン |
| `MOVACAL_PROVIDER` / `MOVACAL_PASSWORD` / `MOVACAL_PRIVATE_KEY` | MOVACAL認証 |
| `MOVACAL_BASIC_AUTH_USER` / `_PASS` | MOVACALのBasic認証（全院共通） |
| `CLINICS_JSON` / `USER_CLINICS_JSON` | 診療所レジストリ（本番はこちらが優先） |
| `MOCK` | `1` で開発用モックモード |

## ログ確認

```bash
gcloud run services logs read movacal-voice-karte \
  --project movacal-shuunou --region asia-northeast1 --limit 100
```
