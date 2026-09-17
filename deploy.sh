#!/usr/bin/env bash
set -euo pipefail

# Cloud Run デプロイ（音声カルテ v2）
#   1) cp .env.example .env して値を埋める
#   2) gcloud auth login / gcloud config set project <PROJECT>
#   3) ./deploy.sh

SERVICE="${SERVICE:-movacal-voice-karte}"
REGION="${REGION:-asia-northeast1}"
PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source <(grep -v '^[[:space:]]*#' .env | grep -v '^[[:space:]]*$')
  set +a
else
  echo "⚠️  .env が見つかりません。.env.example をコピーして埋めてください。" >&2
  exit 1
fi

: "${GEMINI_API_KEY:?GEMINI_API_KEY が未設定}"
: "${MOVACAL_PROVIDER:?MOVACAL_PROVIDER が未設定}"
: "${MOVACAL_PASSWORD:?MOVACAL_PASSWORD が未設定}"
: "${MOVACAL_PRIVATE_KEY:?MOVACAL_PRIVATE_KEY が未設定}"
: "${MOVACAL_CLINIC_ID:?MOVACAL_CLINIC_ID が未設定}"
: "${MOVACAL_CLINIC_CODE:?MOVACAL_CLINIC_CODE が未設定}"

if [[ -z "${GOOGLE_CLIENT_ID:-}" && -z "${APP_TOKEN:-}" ]]; then
  echo "⚠️  GOOGLE_CLIENT_ID か APP_TOKEN のどちらかは必須です。" >&2
  exit 1
fi

echo "▶ deploy: ${SERVICE} (project=${PROJECT}, region=${REGION})"

# '@@' 区切りでカンマを含む値も安全に渡す
ENVS="^@@^GEMINI_API_KEY=${GEMINI_API_KEY}@@GEMINI_MODEL=${GEMINI_MODEL:-gemini-2.5-flash}"
ENVS+="@@MOVACAL_PROVIDER=${MOVACAL_PROVIDER}@@MOVACAL_PASSWORD=${MOVACAL_PASSWORD}@@MOVACAL_PRIVATE_KEY=${MOVACAL_PRIVATE_KEY}"
ENVS+="@@MOVACAL_CLINIC_ID=${MOVACAL_CLINIC_ID}@@MOVACAL_CLINIC_CODE=${MOVACAL_CLINIC_CODE}@@MOVACAL_DIAG_DEPT=${MOVACAL_DIAG_DEPT:-01}"
ENVS+="@@MOVACAL_USER_NAME=${MOVACAL_USER_NAME:-音声カルテ}"
[[ -n "${GOOGLE_CLIENT_ID:-}" ]] && ENVS+="@@GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}"
[[ -n "${ALLOWED_HD:-}" ]] && ENVS+="@@ALLOWED_HD=${ALLOWED_HD}"
[[ -n "${ALLOWED_EMAILS:-}" ]] && ENVS+="@@ALLOWED_EMAILS=${ALLOWED_EMAILS}"
[[ -n "${APP_TOKEN:-}" ]] && ENVS+="@@APP_TOKEN=${APP_TOKEN}"
[[ -n "${MOVACAL_USER_ID:-}" ]] && ENVS+="@@MOVACAL_USER_ID=${MOVACAL_USER_ID}"
[[ -n "${MOVACAL_BASIC_AUTH:-}" ]] && ENVS+="@@MOVACAL_BASIC_AUTH=${MOVACAL_BASIC_AUTH}"

gcloud run deploy "${SERVICE}" \
  --source . \
  --project "${PROJECT}" \
  --region "${REGION}" \
  --platform managed \
  --allow-unauthenticated \
  --memory 512Mi \
  --timeout 120 \
  --set-env-vars "${ENVS}"

echo "✅ 完了。URL:"
gcloud run services describe "${SERVICE}" --project "${PROJECT}" --region "${REGION}" --format='value(status.url)'

# 【本番推奨】秘密情報は Secret Manager へ（例）:
#   echo -n "$GEMINI_API_KEY" | gcloud secrets create gemini-api-key --data-file=-
#   --set-secrets "GEMINI_API_KEY=gemini-api-key:latest,MOVACAL_PRIVATE_KEY=movacal-private-key:latest,..."
# さらに強固にするなら Cloud Run の前段に Identity-Aware Proxy(IAP) を置き、
# Workspace のグループ/ドメインでアクセス制御する構成も可（README 参照）。
