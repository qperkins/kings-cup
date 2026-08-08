#!/usr/bin/env bash
# Deploy latest image from GHCR. Never builds locally — pull failures fail loudly.
set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/kings-cup-backend}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
IMAGE="${IMAGE:-ghcr.io/qperkins/kings-cup-backend:latest}"
HEALTH_URL="${HEALTH_URL:-http://localhost:8000/health}"
HEALTH_RETRIES="${HEALTH_RETRIES:-30}"
HEALTH_INTERVAL="${HEALTH_INTERVAL:-2}"

cd "$REPO_DIR"

echo "==> Pulling latest code"
git fetch origin main
git checkout main
git reset --hard origin/main

echo "==> Stopping existing containers"
docker compose -f "$COMPOSE_FILE" down

echo "==> Pulling image from GHCR: $IMAGE"
if ! docker pull "$IMAGE"; then
  echo "ERROR: Failed to pull $IMAGE"
  echo "If this is the first deploy, make the GHCR package public (see DEPLOYMENT.md)."
  exit 1
fi

export BACKEND_IMAGE="$IMAGE"

echo "==> Starting containers"
docker compose -f "$COMPOSE_FILE" up -d

echo "==> Waiting for health check"
for ((i = 1; i <= HEALTH_RETRIES; i++)); do
  if docker compose -f "$COMPOSE_FILE" exec -T app curl -sf "$HEALTH_URL" >/dev/null; then
    echo "Health check passed"
    docker image prune -f
    exit 0
  fi
  echo "Attempt $i/$HEALTH_RETRIES — not healthy yet, retrying in ${HEALTH_INTERVAL}s..."
  sleep "$HEALTH_INTERVAL"
done

echo "ERROR: Health check failed after deploy"
docker compose -f "$COMPOSE_FILE" logs --tail=50
exit 1
