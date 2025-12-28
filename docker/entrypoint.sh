#!/bin/sh
set -e

# Ensure DATABASE_URL exists in production; Prisma needs it for migrations/runtime
if [ -z "$DATABASE_URL" ]; then
  echo "ERROR: DATABASE_URL is not set"
  exit 1
fi

echo "[entrypoint] running prisma migrate deploy..."
pnpm -s db:migrate || {
  echo "ERROR: prisma migrate deploy failed"
  exit 1
}

echo "[entrypoint] starting app..."
exec "$@"





