#!/bin/sh
set -e

# Usage:
#   ./server-update.sh /opt/panel/releases/panel-app_2025-12-13_001.tar.gz
#
# Assumptions:
# - This script is run on the server
# - Current directory contains docker-compose.yml and a .env file

ARCHIVE="$1"
if [ -z "$ARCHIVE" ]; then
  echo "Usage: $0 /path/to/panel-app_*.tar.gz"
  exit 1
fi

if [ ! -f "$ARCHIVE" ]; then
  echo "ERROR: archive not found: $ARCHIVE"
  exit 1
fi

echo "[update] tagging current image for rollback (best-effort)..."
if docker inspect panel-app >/dev/null 2>&1; then
  CURRENT_IMAGE_ID="$(docker inspect -f '{{.Image}}' panel-app || true)"
  if [ -n "$CURRENT_IMAGE_ID" ]; then
    TS="$(date +%Y%m%d_%H%M%S)"
    docker image tag "$CURRENT_IMAGE_ID" "panel-app:rollback-$TS" >/dev/null 2>&1 || true
    docker image tag "$CURRENT_IMAGE_ID" "panel-app:rollback" >/dev/null 2>&1 || true
    echo "[update] rollback tag: panel-app:rollback (and panel-app:rollback-$TS)"
  fi
fi

echo "[update] loading image from archive..."
gunzip -c "$ARCHIVE" | docker load

echo "[update] starting containers (no build)..."
docker compose up -d --no-build

echo "[update] waiting for health..."
TRIES=30
while [ $TRIES -gt 0 ]; do
  if docker inspect --format='{{.State.Health.Status}}' panel-app 2>/dev/null | grep -q healthy; then
    echo "[update] app is healthy"
    exit 0
  fi
  TRIES=$((TRIES-1))
  sleep 2
done

echo "[update] ERROR: app did not become healthy"
echo "[update] check logs: docker logs --tail=200 panel-app"
exit 1





