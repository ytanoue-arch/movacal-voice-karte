# 開発の進め方（DXチーム向け）

## 役割分担

| | 担当 |
|---|---|
| コードの改修・PR作成 | DXチーム |
| レビュー・マージ・本番デプロイ | 田上 |
| MOVACAL認証情報・患者データの取り扱い | 田上のみ |

DXチームは **MOCKモード**で開発・動作確認します。MOVACALの認証情報（`clinics.json` の `code` 等）は配布されません。
実データでの最終確認とデプロイは田上が行います。

## 作業の流れ

```bash
git checkout -b fix/短い説明        # ブランチを切る
MOCK=1 npm start                    # 画面で確認しながら直す
node --check server.js              # 構文チェック（JSファイルを触ったら必ず）
git commit -m "変更内容"
git push -u origin fix/短い説明
gh pr create                        # PRを作成 → 田上がレビュー
```

## ⚠️ このプロジェクト特有の注意点

知らないと確実にハマる点です。**必ず目を通してください。**

### デプロイ関連

- **`deploy.sh` は使わない。** `.env` の読み込みが壊れており、実行すると本番の環境変数が全部消えます
- `gcloud` コマンドでは **`--project movacal-shuunou` を必ず付ける**。省略すると既定プロジェクトに解決され、別の空サービスが作られます（実際に事故あり）
- `--set-env-vars` は**全置換**なので使わない。個別変更は `--update-env-vars`

### ブックマークレット（`public/setup.js`）

- ここを変更すると、**全端末でブックマークの作り直しが必要**になります。影響が大きいので変更は慎重に
- 患者IDはSafariのタブ名「患者名(ID)」から取得しています。本文の `ID:` は画面によって出ないため補助的な扱い
- IDは**英数字**（`ttttt` のようなテスト患者もある）。先頭の `0` を落とさないこと（`00101` ≠ `101`）

### MOVACAL API（`movacal.js`）

- 日付範囲の取得は **28日以内**のチャンクに分ける（月をまたぐと `400001`）
- `get_type=2` は一部の院でエラーになるため **`get_type=1` のみ**使う
- メモ登録の `user_id` は**院ごとに異なる**。`getUserData.php` で自動解決している
- `getDiagdata.php` は該当なしのとき **200＋空ボディ**を返す（仕様書は204。空を想定した処理が必要）
- `editDiagObjective.php`（カルテ追記）は仕様書上「開発中」表記。挙動が変わる可能性あり

### UI（`public/app.js`）

- 診療所の優先順位: ブックマークで開いた院 → 端末の記憶（localStorage） → マスター既定（`user-clinics.json`）
- 画面の変更はデプロイ後に**Safariの再読み込み**で反映されます（ブックマークの作り直しは不要）

## やってはいけないこと

- `clinics.json` / `user-clinics.json` / `.env` を**コミットしない**（`.gitignore` 済み。サンプルは `*.example.json`）
- 本番VM（`prescription-ocr-vm`）への接続 — 患者データがあるため権限対象外です
- 患者の実データを使ったテスト — MOCKモードを使ってください
- 認証情報をチャットやドキュメントに貼らない

## 困ったら

デプロイやMOVACAL側でエラーが出た場合は、ログを取って田上に共有してください。

```bash
gcloud run services logs read movacal-voice-karte \
  --project movacal-shuunou --region asia-northeast1 --limit 100
```
