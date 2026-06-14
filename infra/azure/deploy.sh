#!/usr/bin/env bash
#
# Auxify — complete production deployment to Azure Container Apps.
#
# Provisions and wires EVERY resource the platform needs:
#   - Resource group
#   - Azure Container Registry (build api + web images in the cloud)
#   - Azure Database for PostgreSQL Flexible Server (+ pgvector) — persistence, KB/RAG
#   - Log Analytics workspace + Container Apps environment
#   - Container App: auxify-api  (public ingress :8787)
#   - Container App: auxify-web  (public ingress :3000)
#   - All app settings / secrets (AI provider keys, login, DB URL, CORS)
#
# RUN THIS FROM AZURE CLOUD SHELL (https://shell.azure.com) or any machine with
# `az` logged in and good Azure connectivity. From Cloud Shell, clone the repo:
#   git clone https://github.com/hellogaganchaudhary/auxifyai.git && cd auxifyai
#   bash infra/azure/deploy.sh
#
# Configure secrets by exporting them before running (or edit the defaults):
#   export APP_AUTH_PASSWORD='<your-app-login-password>'
#   export AWS_BEARER_TOKEN_BEDROCK='...'        # for Claude (Bedrock)
#   export AZURE_OPENAI_ENDPOINT='...'           # optional: GPT/image/voice
#   export AZURE_OPENAI_API_KEY='...'
#   ... (see the env block below)
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────────────────────────────────────
SUBSCRIPTION="${SUBSCRIPTION:-7929d7f2-0764-410e-bfaa-788c7fa40015}"   # ends in 15
LOCATION="${LOCATION:-centralindia}"
RG="${RG:-gaganainewaiauxify}"
ACR="${ACR:-gaganauxifyacr15}"
ENVIRONMENT="${ENVIRONMENT:-auxify-env}"
PG_SERVER="${PG_SERVER:-gaganauxifypg15}"
PG_DB="${PG_DB:-auxify}"
PG_ADMIN="${PG_ADMIN:-auxifyadmin}"
PG_PASSWORD="${PG_PASSWORD:-Auxify$(openssl rand -hex 6)!}"
IMAGE_TAG="${IMAGE_TAG:-v1}"

# Application login (single shared super-admin) + API credentials.
# Set APP_AUTH_PASSWORD in your shell before running; do NOT hardcode it here.
APP_AUTH_EMAIL="${APP_AUTH_EMAIL:-gaganchaudhary061506@gmail.com}"
APP_AUTH_PASSWORD="${APP_AUTH_PASSWORD:?set APP_AUTH_PASSWORD before running}"
APP_AUTH_SECRET="${APP_AUTH_SECRET:-$(openssl rand -hex 24)}"
DEV_API_KEY="${DEV_API_KEY:-$(openssl rand -hex 16)}"
DEV_API_TOKEN="${DEV_API_TOKEN:-$(openssl rand -hex 16)}"

# AI providers (leave blank to run with the built-in stub/echo model only).
AWS_BEARER_TOKEN_BEDROCK="${AWS_BEARER_TOKEN_BEDROCK:-}"
BEDROCK_REGION="${BEDROCK_REGION:-ap-south-1}"
AZURE_OPENAI_ENDPOINT="${AZURE_OPENAI_ENDPOINT:-}"
AZURE_OPENAI_API_KEY="${AZURE_OPENAI_API_KEY:-}"
AZURE_OPENAI_EASTUS2_ENDPOINT="${AZURE_OPENAI_EASTUS2_ENDPOINT:-}"
AZURE_OPENAI_EASTUS2_API_KEY="${AZURE_OPENAI_EASTUS2_API_KEY:-}"
AZURE_OPENAI_DEPLOYMENT_IMAGE="${AZURE_OPENAI_DEPLOYMENT_IMAGE:-}"
SERPER_API_KEY="${SERPER_API_KEY:-}"
TAVILY_API_KEY="${TAVILY_API_KEY:-}"

echo "▶ Subscription: $SUBSCRIPTION  |  RG: $RG  |  Region: $LOCATION"
az account set --subscription "$SUBSCRIPTION"

# ─────────────────────────────────────────────────────────────────────────────
# 1) Resource group + registry
# ─────────────────────────────────────────────────────────────────────────────
az group create -n "$RG" -l "$LOCATION" -o none
az acr create -g "$RG" -n "$ACR" --sku Basic --admin-enabled true -l "$LOCATION" -o none 2>/dev/null || true
ACR_LOGIN_SERVER=$(az acr show -n "$ACR" -g "$RG" --query loginServer -o tsv)

# ─────────────────────────────────────────────────────────────────────────────
# 2) Build images in the cloud (ACR build; no local Docker needed)
# ─────────────────────────────────────────────────────────────────────────────
echo "▶ Building API image…"
az acr build -r "$ACR" -t "auxify-api:$IMAGE_TAG" -f apps/api/Dockerfile .

# ─────────────────────────────────────────────────────────────────────────────
# 3) PostgreSQL Flexible Server (+ pgvector) for persistence + knowledge base
# ─────────────────────────────────────────────────────────────────────────────
echo "▶ Provisioning PostgreSQL (this takes several minutes)…"
az postgres flexible-server create \
  -g "$RG" -n "$PG_SERVER" -l "$LOCATION" \
  --admin-user "$PG_ADMIN" --admin-password "$PG_PASSWORD" \
  --sku-name Standard_B1ms --tier Burstable --storage-size 32 --version 16 \
  --public-access 0.0.0.0 --yes -o none 2>/dev/null || true
# Allow pgvector, then create the database + extension.
az postgres flexible-server parameter set -g "$RG" -s "$PG_SERVER" \
  --name azure.extensions --value vector -o none
az postgres flexible-server db create -g "$RG" -s "$PG_SERVER" -d "$PG_DB" -o none 2>/dev/null || true
DATABASE_URL="postgresql://$PG_ADMIN:$PG_PASSWORD@$PG_SERVER.postgres.database.azure.com:5432/$PG_DB?sslmode=require"

# ─────────────────────────────────────────────────────────────────────────────
# 4) Container Apps environment
# ─────────────────────────────────────────────────────────────────────────────
az extension add --name containerapp --upgrade -y -o none 2>/dev/null || true
az provider register --namespace Microsoft.App -o none 2>/dev/null || true
az provider register --namespace Microsoft.OperationalInsights -o none 2>/dev/null || true
az containerapp env create -g "$RG" -n "$ENVIRONMENT" -l "$LOCATION" -o none 2>/dev/null || true

ACR_USER=$(az acr credential show -n "$ACR" --query username -o tsv)
ACR_PASS=$(az acr credential show -n "$ACR" --query "passwords[0].value" -o tsv)

# ─────────────────────────────────────────────────────────────────────────────
# 5) API container app
# ─────────────────────────────────────────────────────────────────────────────
echo "▶ Deploying API container app…"
az containerapp create -g "$RG" -n auxify-api \
  --environment "$ENVIRONMENT" \
  --image "$ACR_LOGIN_SERVER/auxify-api:$IMAGE_TAG" \
  --registry-server "$ACR_LOGIN_SERVER" --registry-username "$ACR_USER" --registry-password "$ACR_PASS" \
  --target-port 8787 --ingress external \
  --min-replicas 1 --max-replicas 3 --cpu 1 --memory 2Gi \
  --secrets "db-url=$DATABASE_URL" "auth-pass=$APP_AUTH_PASSWORD" "auth-secret=$APP_AUTH_SECRET" \
            "dev-key=$DEV_API_KEY" "dev-token=$DEV_API_TOKEN" "bedrock-token=$AWS_BEARER_TOKEN_BEDROCK" \
            "aoai-key=$AZURE_OPENAI_API_KEY" "aoai-img-key=$AZURE_OPENAI_EASTUS2_API_KEY" \
            "serper=$SERPER_API_KEY" "tavily=$TAVILY_API_KEY" \
  --env-vars \
    "API_HOST=0.0.0.0" "API_PORT=8787" \
    "DATABASE_URL=secretref:db-url" \
    "APP_AUTH_EMAIL=$APP_AUTH_EMAIL" "APP_AUTH_PASSWORD=secretref:auth-pass" "APP_AUTH_SECRET=secretref:auth-secret" \
    "DEV_API_KEY=secretref:dev-key" "DEV_API_TOKEN=secretref:dev-token" \
    "AWS_BEARER_TOKEN_BEDROCK=secretref:bedrock-token" "BEDROCK_REGION=$BEDROCK_REGION" \
    "AZURE_OPENAI_ENDPOINT=$AZURE_OPENAI_ENDPOINT" "AZURE_OPENAI_API_KEY=secretref:aoai-key" \
    "AZURE_OPENAI_EASTUS2_ENDPOINT=$AZURE_OPENAI_EASTUS2_ENDPOINT" "AZURE_OPENAI_EASTUS2_API_KEY=secretref:aoai-img-key" \
    "AZURE_OPENAI_DEPLOYMENT_IMAGE=$AZURE_OPENAI_DEPLOYMENT_IMAGE" \
    "SERPER_API_KEY=secretref:serper" "TAVILY_API_KEY=secretref:tavily" \
  -o none

API_FQDN=$(az containerapp show -g "$RG" -n auxify-api --query "properties.configuration.ingress.fqdn" -o tsv)
API_URL="https://$API_FQDN"
echo "▶ API live at: $API_URL"

# ─────────────────────────────────────────────────────────────────────────────
# 6) Web container app — built with the API URL baked in (NEXT_PUBLIC_*)
# ─────────────────────────────────────────────────────────────────────────────
echo "▶ Building Web image (API URL baked in)…"
az acr build -r "$ACR" -t "auxify-web:$IMAGE_TAG" -f apps/web/Dockerfile \
  --build-arg "NEXT_PUBLIC_API_BASE_URL=$API_URL" \
  --build-arg "NEXT_PUBLIC_API_KEY=$DEV_API_KEY" .

echo "▶ Deploying Web container app…"
az containerapp create -g "$RG" -n auxify-web \
  --environment "$ENVIRONMENT" \
  --image "$ACR_LOGIN_SERVER/auxify-web:$IMAGE_TAG" \
  --registry-server "$ACR_LOGIN_SERVER" --registry-username "$ACR_USER" --registry-password "$ACR_PASS" \
  --target-port 3000 --ingress external \
  --min-replicas 1 --max-replicas 3 --cpu 1 --memory 2Gi \
  -o none

WEB_FQDN=$(az containerapp show -g "$RG" -n auxify-web --query "properties.configuration.ingress.fqdn" -o tsv)
WEB_URL="https://$WEB_FQDN"

# ─────────────────────────────────────────────────────────────────────────────
# 7) Lock API CORS to the web origin
# ─────────────────────────────────────────────────────────────────────────────
az containerapp update -g "$RG" -n auxify-api \
  --set-env-vars "API_CORS_ORIGIN=$WEB_URL" -o none

echo ""
echo "════════════════════════════════════════════════════════════"
echo "  ✅ Auxify is live"
echo "  Web : $WEB_URL"
echo "  API : $API_URL/health"
echo "  Login: $APP_AUTH_EMAIL"
echo "  DB   : $PG_SERVER.postgres.database.azure.com / $PG_DB"
echo "  (Postgres admin password: $PG_PASSWORD )"
echo "════════════════════════════════════════════════════════════"
