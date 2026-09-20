#!/usr/bin/env bash
# Deploys the hub to Cloud Run. Run this yourself — it creates billable resources.
#
#   PROJECT_ID=my-project \
#   SA_EMAIL=hub@my-project.iam.gserviceaccount.com \
#   SHOPIFY_STORE_DOMAIN=urbnmyth.myshopify.com \
#   SHOPIFY_LOCATION_ID=gid://shopify/Location/123 \
#   SHADOWFAX_BASE_URL=https://api.shadowfax.in \
#   SELLER_LEGAL_NAME='Urbnmyth Apparel LLP' \
#   SELLER_ADDRESS='123 Park Street, Kolkata, West Bengal 700016' \
#   SELLER_GSTIN=19AAAAA0000A1Z5 \
#   DEFAULT_HSN=6109 \
#   JUDGEME_REVIEW_URL=https://judge.me/reviews/new \
#   ./deploy.sh
#
# Secrets are read from Secret Manager, never baked into the image. These must exist
# there first (see LAUNCH.md): meta-access-token, meta-phone-number-id, meta-waba-id,
# meta-verify-token, meta-app-secret, shopify-webhook-secret, shopify-admin-token,
# cashfree-app-id, cashfree-secret-key, sheet-id, dashboard-token, shadowfax-api-key,
# shadowfax-webhook-secret, internal-task-token.
set -euo pipefail

SERVICE="${SERVICE:-urbnmyth-hub}"
REGION="${REGION:-asia-south1}"
PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
SA_EMAIL="${SA_EMAIL:?set SA_EMAIL (the service account shared with the CRM Sheet)}"

# Every non-secret variable src/config.ts requires without a default. config.ts parses
# with Zod at import time and throws on the first missing one, so a value absent here
# is not a degraded feature — it is a container that crash-loops on boot.
SHOPIFY_STORE_DOMAIN="${SHOPIFY_STORE_DOMAIN:?set SHOPIFY_STORE_DOMAIN}"
SHOPIFY_LOCATION_ID="${SHOPIFY_LOCATION_ID:?set SHOPIFY_LOCATION_ID (the fulfillment location RTO stock is returned to)}"
SHADOWFAX_BASE_URL="${SHADOWFAX_BASE_URL:?set SHADOWFAX_BASE_URL}"
SELLER_LEGAL_NAME="${SELLER_LEGAL_NAME:?set SELLER_LEGAL_NAME (exactly as registered for GST)}"
SELLER_ADDRESS="${SELLER_ADDRESS:?set SELLER_ADDRESS (exactly as registered for GST)}"
SELLER_GSTIN="${SELLER_GSTIN:?set SELLER_GSTIN (15 characters; its first two must equal SELLER_STATE_CODE)}"
DEFAULT_HSN="${DEFAULT_HSN:?set DEFAULT_HSN (e.g. 6109 for knitted apparel)}"
JUDGEME_REVIEW_URL="${JUDGEME_REVIEW_URL:?set JUDGEME_REVIEW_URL}"

# The internal task token has to reach two places that must never disagree: the service
# (which checks it on every /internal/* call) and the three Cloud Scheduler jobs (which
# send it as a bearer header). Both are read from the one Secret Manager version below
# rather than from two separately-supplied values — a drift between them is a silent 401
# on every scheduled job, with nothing but a log line to say so.
INTERNAL_TASK_SECRET="${INTERNAL_TASK_SECRET:-internal-task-token}"
INTERNAL_TASK_TOKEN="$(gcloud secrets versions access latest \
  --project "${PROJECT_ID}" --secret "${INTERNAL_TASK_SECRET}")"

echo "Deploying ${SERVICE} to ${REGION} in ${PROJECT_ID}…"

gcloud run deploy "${SERVICE}" \
  --project "${PROJECT_ID}" \
  --source . \
  --region "${REGION}" \
  --allow-unauthenticated \
  --service-account "${SA_EMAIL}" \
  --max-instances=1 \
  --set-env-vars "^@^SHOPIFY_STORE_DOMAIN=${SHOPIFY_STORE_DOMAIN}@SHOPIFY_LOCATION_ID=${SHOPIFY_LOCATION_ID}@SHADOWFAX_BASE_URL=${SHADOWFAX_BASE_URL}@SELLER_LEGAL_NAME=${SELLER_LEGAL_NAME}@SELLER_ADDRESS=${SELLER_ADDRESS}@SELLER_GSTIN=${SELLER_GSTIN}@SELLER_STATE_CODE=${SELLER_STATE_CODE:-19}@DEFAULT_HSN=${DEFAULT_HSN}@JUDGEME_REVIEW_URL=${JUDGEME_REVIEW_URL}@CASHFREE_ENV=${CASHFREE_ENV:-TEST}@COD_FEE_INR=${COD_FEE_INR:-50}@TEMPLATE_LANG=${TEMPLATE_LANG:-en}@COD_GATEWAY_NAMES=${COD_GATEWAY_NAMES:-cash on delivery,cod}" \
  --set-secrets "META_ACCESS_TOKEN=meta-access-token:latest,META_PHONE_NUMBER_ID=meta-phone-number-id:latest,META_WABA_ID=meta-waba-id:latest,META_VERIFY_TOKEN=meta-verify-token:latest,META_APP_SECRET=meta-app-secret:latest,SHOPIFY_WEBHOOK_SECRET=shopify-webhook-secret:latest,SHOPIFY_ADMIN_TOKEN=shopify-admin-token:latest,CASHFREE_APP_ID=cashfree-app-id:latest,CASHFREE_SECRET_KEY=cashfree-secret-key:latest,SHEET_ID=sheet-id:latest,DASHBOARD_TOKEN=dashboard-token:latest,SHADOWFAX_API_KEY=shadowfax-api-key:latest,SHADOWFAX_WEBHOOK_SECRET=shadowfax-webhook-secret:latest,INTERNAL_TASK_TOKEN=${INTERNAL_TASK_SECRET}:latest"
# --max-instances=1 is not a knob to relax later without re-checking the rest of the
# design: the gapless invoice series (InvoicingService) numbers invoices off the last
# sequence already in the sheet, and CancellationService.approve/ReportingService.generate
# guard themselves with an in-process Mutex — both are only correct with exactly one
# instance in flight. Two instances would let two requests interleave past every one of
# those guards and produce duplicate invoice numbers or a double-cancel.
# One exception is inherent and cannot be configured away: max-instances is enforced per
# *revision*, so during a traffic migration the outgoing and incoming revisions can both
# serve for a few seconds, each with its own in-process mutexes and neither aware of the
# other — deploy when the shop is quiet, and re-check the invoice register afterwards.

URL="$(gcloud run services describe "${SERVICE}" \
  --project "${PROJECT_ID}" --region "${REGION}" --format='value(status.url)')"

echo "Registering Cloud Scheduler jobs…"

# Every job carries the internal task token as a bearer header — the same check
# createInternalRouter applies to every /internal/* route.
gcloud scheduler jobs create http "${SERVICE}-sync-shipments" \
  --project "${PROJECT_ID}" \
  --location "${REGION}" \
  --schedule "0 */4 * * *" \
  --time-zone "Asia/Kolkata" \
  --uri "${URL}/internal/sync-shipments" \
  --http-method POST \
  --headers "Authorization=Bearer ${INTERNAL_TASK_TOKEN}"

gcloud scheduler jobs create http "${SERVICE}-rating-sweep" \
  --project "${PROJECT_ID}" \
  --location "${REGION}" \
  --schedule "0 11 * * *" \
  --time-zone "Asia/Kolkata" \
  --uri "${URL}/internal/rating-sweep" \
  --http-method POST \
  --headers "Authorization=Bearer ${INTERNAL_TASK_TOKEN}"

gcloud scheduler jobs create http "${SERVICE}-drain-effects" \
  --project "${PROJECT_ID}" \
  --location "${REGION}" \
  --schedule "*/5 * * * *" \
  --time-zone "Asia/Kolkata" \
  --uri "${URL}/internal/drain-effects" \
  --http-method POST \
  --headers "Authorization=Bearer ${INTERNAL_TASK_TOKEN}"

# Campaign tick — left commented out until Plan 2 builds /internal/campaign-tick.
# gcloud scheduler jobs create http "${SERVICE}-campaign-tick" \
#   --project "${PROJECT_ID}" \
#   --location "${REGION}" \
#   --schedule "*/15 * * * *" \
#   --time-zone "Asia/Kolkata" \
#   --uri "${URL}/internal/campaign-tick" \
#   --http-method POST \
#   --headers "Authorization=Bearer ${INTERNAL_TASK_TOKEN}"

cat <<EOF

Deployed: ${URL}

Paste these into the matching consoles:
  Meta       → ${URL}/webhook/meta       (verify token = META_VERIFY_TOKEN)
  Shopify    → ${URL}/webhook/shopify    (Order creation, JSON)
  Cashfree   → ${URL}/webhook/cashfree   (Payment Link events)
  Shadowfax  → ${URL}/webhook/shadowfax  (shipment status updates)
  Dashboard  → ${URL}/dashboard?token=YOUR_DASHBOARD_TOKEN
EOF
