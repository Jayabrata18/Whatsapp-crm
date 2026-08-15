#!/usr/bin/env bash
# Deploys the hub to Cloud Run. Run this yourself — it creates billable resources.
#
#   PROJECT_ID=my-project \
#   SA_EMAIL=hub@my-project.iam.gserviceaccount.com \
#   SHOPIFY_STORE_DOMAIN=urbnmyth.myshopify.com \
#   ./deploy.sh
#
# Secrets are read from Secret Manager, never baked into the image.
set -euo pipefail

SERVICE="${SERVICE:-urbnmyth-hub}"
REGION="${REGION:-asia-south1}"
PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
SA_EMAIL="${SA_EMAIL:?set SA_EMAIL (the service account shared with the CRM Sheet)}"
SHOPIFY_STORE_DOMAIN="${SHOPIFY_STORE_DOMAIN:?set SHOPIFY_STORE_DOMAIN}"

echo "Deploying ${SERVICE} to ${REGION} in ${PROJECT_ID}…"

gcloud run deploy "${SERVICE}" \
  --project "${PROJECT_ID}" \
  --source . \
  --region "${REGION}" \
  --allow-unauthenticated \
  --service-account "${SA_EMAIL}" \
  --set-env-vars "^@^SHOPIFY_STORE_DOMAIN=${SHOPIFY_STORE_DOMAIN}@CASHFREE_ENV=${CASHFREE_ENV:-TEST}@COD_FEE_INR=${COD_FEE_INR:-50}@TEMPLATE_LANG=${TEMPLATE_LANG:-en}@COD_GATEWAY_NAMES=${COD_GATEWAY_NAMES:-cash on delivery,cod}" \
  --set-secrets "META_ACCESS_TOKEN=meta-access-token:latest,META_PHONE_NUMBER_ID=meta-phone-number-id:latest,META_WABA_ID=meta-waba-id:latest,META_VERIFY_TOKEN=meta-verify-token:latest,META_APP_SECRET=meta-app-secret:latest,SHOPIFY_WEBHOOK_SECRET=shopify-webhook-secret:latest,SHOPIFY_ADMIN_TOKEN=shopify-admin-token:latest,CASHFREE_APP_ID=cashfree-app-id:latest,CASHFREE_SECRET_KEY=cashfree-secret-key:latest,SHEET_ID=sheet-id:latest,DASHBOARD_TOKEN=dashboard-token:latest"

URL="$(gcloud run services describe "${SERVICE}" \
  --project "${PROJECT_ID}" --region "${REGION}" --format='value(status.url)')"

cat <<EOF

Deployed: ${URL}

Paste these into the matching consoles:
  Meta      → ${URL}/webhook/meta      (verify token = META_VERIFY_TOKEN)
  Shopify   → ${URL}/webhook/shopify   (Order creation, JSON)
  Cashfree  → ${URL}/webhook/cashfree  (Payment Link events)
  Dashboard → ${URL}/dashboard?token=YOUR_DASHBOARD_TOKEN
EOF
